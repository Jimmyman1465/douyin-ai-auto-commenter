const repository = require('../auto-campaign/repository');
const { runWorker, verifyUnknown } = require('../auto-campaign/worker');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeBatchResults(jobs, response) {
  if (!response || !Array.isArray(response.results)) return null;
  const byId = new Map();
  for (const result of response.results) {
    const awemeId = String(result?.awemeId || '');
    if (awemeId && !byId.has(awemeId)) byId.set(awemeId, result);
  }
  return jobs.map(job => byId.get(String(job.awemeId)) || null);
}

async function markBatchUnknown(jobs, cfg, adapter, message) {
  let unresolved = false;
  for (const job of jobs) {
    const current = repository.getJob(job.id);
    if (current?.status !== 'sending') continue;
    repository.transitionJob(job.id, 'unknown', {
      errorCode: 'UNKNOWN_AFTER_DISPATCH',
      errorMessage: message,
    });
    const checked = await verifyUnknown(repository.getJob(job.id), cfg, adapter);
    if (checked.status === 'unknown') unresolved = true;
  }
  return unresolved;
}

async function runBatchWorker(runId, cfg, adapter, options = {}) {
  if (typeof adapter.publishBatch !== 'function' || cfg.limits.bridge_batch_size <= 1) {
    return runWorker(runId, cfg, adapter, options);
  }
  if (typeof adapter.supportsBatch === 'function' && !await adapter.supportsBatch()) {
    return runWorker(runId, cfg, adapter, options);
  }

  const now = options.now || (() => Date.now());
  const sleeper = options.sleep || sleep;
  const random = options.random || Math.random;
  const startedAt = now();
  let sentThisRun = 0;
  let stopReason = null;
  let lastSendAt = repository.lastDispatchAt(cfg.account_uid);

  repository.recoverExpiredSending(runId, now());
  if (repository.listActiveSending(runId, now()).length) {
    return { stopReason: 'sending_result_pending', stats: repository.countStatuses(runId) };
  }
  if (repository.listJobs(runId, ['unknown']).length) {
    return runWorker(runId, cfg, adapter, options);
  }

  async function waitWithHeartbeat(totalMs) {
    let remaining = totalMs;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 30000);
      await sleeper(chunk);
      remaining -= chunk;
      const run = repository.getRun(runId);
      if (!run || run.stopRequested) return false;
      if (!repository.refreshAccountLock(cfg.account_uid, runId)) return false;
    }
    return true;
  }

  while (!stopReason) {
    const run = repository.getRun(runId);
    if (!run || run.stopRequested) { stopReason = run?.stopReason || 'stop_requested'; break; }
    if (now() - startedAt >= cfg.limits.run_timeout_minutes * 60000) { stopReason = 'run_timeout'; break; }

    const remainingRun = cfg.limits.max_send_per_run - sentThisRun;
    const remainingDay = cfg.limits.max_send_per_day - repository.sentToday(cfg.account_uid, now());
    if (remainingRun <= 0) { stopReason = 'run_quota_reached'; break; }
    if (remainingDay <= 0) { stopReason = 'daily_quota_reached'; break; }

    const pending = repository.listJobs(runId, ['pending', 'retryable']);
    if (!pending.length) break;
    const batchSize = Math.min(cfg.limits.bridge_batch_size, remainingRun, remainingDay, pending.length);
    const waitMs = Math.max(0, cfg.limits.min_interval_seconds * 1000 - (now() - lastSendAt));
    if (waitMs && !await waitWithHeartbeat(waitMs)) {
      const stopped = repository.getRun(runId);
      stopReason = stopped?.stopRequested ? (stopped.stopReason || 'stop_requested') : 'account_lock_lost';
      break;
    }

    const maxBatchDuration = Math.max(
      120000,
      (batchSize - 1) * cfg.limits.max_interval_seconds * 1000 + 60000,
    );
    if (!repository.refreshAccountLock(cfg.account_uid, runId, maxBatchDuration)) {
      stopReason = 'account_lock_lost';
      break;
    }

    const jobs = [];
    for (let i = 0; i < batchSize; i++) {
      const claimed = repository.claimNext(runId, maxBatchDuration);
      if (!claimed) break;
      const permit = repository.markDispatchedIfAllowed(claimed.id, runId, maxBatchDuration);
      if (!permit.allowed) {
        repository.transitionJob(claimed.id, 'pending');
        stopReason = permit.reason || 'job_not_dispatchable';
        break;
      }
      jobs.push(permit.job);
    }
    if (!jobs.length) break;

    try {
      const response = await adapter.publishBatch(
        jobs.map(job => ({ awemeId: job.awemeId, text: cfg.fixed_comment })),
        {
          intervalMinMs: cfg.limits.min_interval_seconds * 1000,
          intervalMaxMs: cfg.limits.max_interval_seconds * 1000,
          timeout: maxBatchDuration,
          random,
        },
      );
      const results = normalizeBatchResults(jobs, response);
      if (!results) {
        stopReason = await markBatchUnknown(jobs, cfg, adapter, '批处理返回格式无法确认')
          ? 'unknown_result_requires_review' : null;
        continue;
      }

      for (let index = 0; index < jobs.length; index++) {
        const job = jobs[index];
        const result = results[index];
        if (!result) {
          repository.transitionJob(job.id, 'unknown', {
            errorCode: 'UNKNOWN_AFTER_DISPATCH',
            errorMessage: '批处理未返回该任务结果',
          });
          const checked = await verifyUnknown(repository.getJob(job.id), cfg, adapter);
          if (checked.status === 'unknown') stopReason = 'unknown_result_requires_review';
        } else if (result.status === 'succeeded' && result.cid) {
          repository.transitionJob(job.id, 'succeeded', { platformCommentId: result.cid });
          sentThisRun++;
          lastSendAt = now();
        } else if (result.status === 'not_started') {
          repository.rollbackConfirmedUnstarted(job.id);
        } else if (result.status === 'blocked') {
          repository.transitionJob(job.id, 'blocked', {
            errorCode: result.errorCode || 'CONTENT_REJECTED',
            errorMessage: result.errorMessage || '平台阻断批处理',
          });
          stopReason = result.errorCode || 'CONTENT_REJECTED';
        } else {
          repository.transitionJob(job.id, 'unknown', {
            errorCode: result.errorCode || 'UNKNOWN_AFTER_DISPATCH',
            errorMessage: result.errorMessage || '批处理发送结果不确定',
          });
          const checked = await verifyUnknown(repository.getJob(job.id), cfg, adapter);
          if (checked.status === 'unknown') stopReason = 'unknown_result_requires_review';
        }
      }
    } catch (error) {
      const unresolved = await markBatchUnknown(jobs, cfg, adapter, error.message);
      if (unresolved) stopReason = 'unknown_result_requires_review';
    }
  }

  return { stopReason, stats: repository.countStatuses(runId) };
}

module.exports = { normalizeBatchResults, runBatchWorker };
