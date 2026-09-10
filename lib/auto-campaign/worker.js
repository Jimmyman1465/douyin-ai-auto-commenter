const repository = require('./repository');
const riskControl = require('../risk-control');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function classifyError(error) {
  const message = String(error?.message || error || '');
  const explicit = error?.code;
  if (explicit) {
    return {
      code: explicit,
      blocked: ['AUTH_EXPIRED', 'CHALLENGE_REQUIRED', 'RATE_LIMITED', 'CONTENT_REJECTED', 'CONTRACT_CHANGED'].includes(explicit),
      retryable: !!error.safeToRetry,
      ambiguous: !!error.ambiguous,
    };
  }
  if (/login|登录|unauthori|认证|cookie/i.test(message)) return { code: 'AUTH_EXPIRED', blocked: true };
  if (/captcha|challenge|验证码|滑块/i.test(message)) return { code: 'CHALLENGE_REQUIRED', blocked: true };
  if (/status_code=(8|2053)|频繁|rate.?limit/i.test(message)) return { code: 'RATE_LIMITED', blocked: true };
  if (/content|文案|rejected|审核/i.test(message)) return { code: 'CONTENT_REJECTED', blocked: true };
  if (/timeout|ECONNRESET|socket hang up|network/i.test(message)) {
    return { code: 'UNKNOWN_AFTER_DISPATCH', blocked: true, ambiguous: true };
  }
  return { code: 'UNKNOWN_AFTER_DISPATCH', blocked: true, ambiguous: true };
}

async function verifyUnknown(job, cfg, adapter) {
  try {
    const result = await adapter.verifyPublished({
      awemeId: job.awemeId,
      text: cfg.fixed_comment,
      accountUid: cfg.account_uid,
      since: job.dispatchStartedAt,
    });
    if (result?.verified) {
      return repository.transitionJob(job.id, 'succeeded', {
        platformCommentId: result.commentId,
      });
    }
    return repository.transitionJob(job.id, 'unknown', {
      errorCode: 'VERIFY_INCONCLUSIVE',
      errorMessage: '只读核验未能唯一确认评论；禁止自动重发',
    });
  } catch (error) {
    return repository.transitionJob(job.id, 'unknown', {
      errorCode: 'VERIFY_ERROR',
      errorMessage: error.message,
    });
  }
}

async function runWorker(runId, cfg, adapter, options = {}) {
  const now = options.now || (() => Date.now());
  const sleeper = options.sleep || sleep;
  const startedAt = now();
  let lastSendAt = repository.lastDispatchAt(cfg.account_uid);
  let sentThisRun = 0;
  let consecutiveFailures = 0;
  let stopReason = null;

  const initialRun = repository.getRun(runId);
  if (!initialRun) throw new Error(`运行不存在: ${runId}`);
  if (initialRun.dryRun) throw new Error('dry-run 运行禁止进入发送 worker');

  async function waitWithLockHeartbeat(totalMs) {
    let remaining = totalMs;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 30000);
      await sleeper(chunk);
      remaining -= chunk;
      const currentRun = repository.getRun(runId);
      if (currentRun?.stopRequested) return false;
      if (!repository.refreshAccountLock(cfg.account_uid, runId)) return false;
    }
    return true;
  }

  repository.recoverExpiredSending(runId, now());
  if (repository.listActiveSending(runId, now()).length) {
    return { stopReason: 'sending_result_pending', stats: repository.countStatuses(runId) };
  }
  for (const unknown of repository.listJobs(runId, ['unknown'])) {
    const checked = await verifyUnknown(unknown, cfg, adapter);
    if (checked.status === 'unknown') {
      stopReason = 'unknown_result_requires_review';
      break;
    }
  }

  while (!stopReason) {
    const run = repository.getRun(runId);
    if (!run || run.stopRequested) { stopReason = run?.stopReason || 'stop_requested'; break; }
    if (now() - startedAt >= cfg.limits.run_timeout_minutes * 60000) { stopReason = 'run_timeout'; break; }
    if (sentThisRun >= cfg.limits.max_send_per_run) { stopReason = 'run_quota_reached'; break; }
    if (repository.sentToday(cfg.account_uid, now()) >= cfg.limits.max_send_per_day) {
      stopReason = 'daily_quota_reached';
      break;
    }

    const job = repository.claimNext(runId);
    if (!job) break;
    const configuredWait = Math.max(0, cfg.limits.min_interval_seconds * 1000 - (now() - lastSendAt));
    const waitMs = Math.max(configuredWait, riskControl.msUntilNextWrite());
    if (waitMs && !await waitWithLockHeartbeat(waitMs)) {
      repository.transitionJob(job.id, 'pending');
      const stopped = repository.getRun(runId);
      stopReason = stopped?.stopRequested ? (stopped.stopReason || 'stop_requested') : 'account_lock_lost';
      break;
    }
    const afterWait = repository.getRun(runId);
    if (afterWait?.stopRequested || now() - startedAt >= cfg.limits.run_timeout_minutes * 60000) {
      repository.transitionJob(job.id, 'pending');
      stopReason = afterWait?.stopRequested ? (afterWait.stopReason || 'stop_requested') : 'run_timeout';
      break;
    }

    const dispatch = repository.markDispatchedIfAllowed(job.id, runId);
    if (!dispatch.allowed) {
      repository.transitionJob(job.id, 'pending');
      stopReason = dispatch.reason || 'stop_requested';
      break;
    }
    lastSendAt = now();
    try {
      const result = await adapter.publish(job.awemeId, cfg.fixed_comment);
      repository.transitionJob(job.id, 'succeeded', { platformCommentId: result?.cid });
      sentThisRun++;
      consecutiveFailures = 0;
    } catch (error) {
      const kind = classifyError(error);
      const current = repository.getJob(job.id);
      if (kind.ambiguous) {
        repository.transitionJob(job.id, 'unknown', {
          errorCode: kind.code,
          errorMessage: error.message,
        });
        const checked = await verifyUnknown(repository.getJob(job.id), cfg, adapter);
        if (checked.status === 'unknown') stopReason = 'unknown_result_requires_review';
      } else if (kind.blocked) {
        repository.transitionJob(job.id, 'blocked', {
          errorCode: kind.code,
          errorMessage: error.message,
        });
        stopReason = kind.code;
      } else if (kind.retryable && current.attempts < cfg.limits.max_attempts) {
        repository.transitionJob(job.id, 'retryable', {
          errorCode: kind.code,
          errorMessage: error.message,
        });
      } else {
        repository.transitionJob(job.id, 'failed', {
          errorCode: kind.code,
          errorMessage: error.message,
        });
        consecutiveFailures++;
        if (consecutiveFailures >= cfg.limits.max_consecutive_failures) stopReason = 'circuit_breaker';
      }
    }
  }
  return { stopReason, stats: repository.countStatuses(runId) };
}

module.exports = { classifyError, verifyUnknown, runWorker };
