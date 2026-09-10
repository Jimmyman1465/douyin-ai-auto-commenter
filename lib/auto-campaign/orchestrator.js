const { configSummary } = require('./config');
const { dedupeCandidates, scoreCandidate } = require('./filter');
const repository = require('./repository');
const { runWorker } = require('./worker');
const { buildReport } = require('./reporter');

function campaignError(message, code, exitCode) {
  const error = new Error(message);
  error.code = code;
  error.exitCode = exitCode;
  return error;
}

async function assertCurrentAccount(cfg, adapter) {
  if (typeof adapter.getCurrentAccountUid !== 'function') {
    throw campaignError('无法读取浏览器当前登录账号 UID，已禁止发送', 'AUTH_EXPIRED', 3);
  }
  let currentUid;
  try {
    currentUid = String(await adapter.getCurrentAccountUid() || '');
  } catch (error) {
    throw campaignError(`读取浏览器登录 UID 失败: ${error.message}`, 'AUTH_EXPIRED', 3);
  }
  if (!currentUid || currentUid !== String(cfg.account_uid)) {
    throw campaignError(
      `浏览器登录 UID 与配置不一致（current=${currentUid || 'missing'}）`,
      'ACCOUNT_UID_MISMATCH',
      3,
    );
  }
}

function acquireLock(cfg, runId) {
  const lock = repository.acquireAccountLock(cfg.account_uid, runId);
  if (!lock.acquired) {
    throw campaignError(`账号已有运行中的正式任务: ${lock.holderRunId}`, 'ACCOUNT_LOCKED', 3);
  }
}

function finalOutcome(worker) {
  if (worker.stats.unknown > 0 || worker.stats.blocked > 0 || worker.stats.sending > 0) return 'blocked';
  if (worker.stopReason === 'circuit_breaker' || worker.stats.failed > 0) return 'failed';
  if (worker.stats.pending > 0 && !['run_quota_reached', 'daily_quota_reached'].includes(worker.stopReason)) {
    return 'stopped';
  }
  return 'succeeded';
}

async function runCampaign(cfg, adapter, options = {}) {
  if (!cfg.runtime.dry_run) await assertCurrentAccount(cfg, adapter);
  const run = repository.createRun(cfg);
  let locked = false;
  const audit = options.audit;
  audit?.startOperation('auto_campaign', {
    run_id: run.id,
    config: configSummary(cfg),
  });
  try {
    if (!cfg.runtime.dry_run) {
      acquireLock(cfg, run.id);
      locked = true;
    }
    const groups = [];
    for (const keyword of cfg.keywords) {
      const items = await adapter.search(keyword, cfg.limits.max_candidates_per_keyword);
      groups.push({ keyword, items });
    }
    const candidates = dedupeCandidates(groups);
    let accepted = 0;
    let duplicateJobs = 0;
    for (const candidate of candidates) {
      const verdict = scoreCandidate(candidate, cfg, options.now?.() || Date.now());
      repository.upsertTarget(run.id, candidate, verdict);
      if (verdict.decision !== 'accepted') continue;
      const queued = repository.enqueueJob(run.id, cfg.account_alias, candidate.awemeId, cfg.content_hash);
      if (queued.inserted) accepted++;
      else duplicateJobs++;
    }

    let worker = { stopReason: null, stats: repository.countStatuses(run.id) };
    if (!cfg.runtime.dry_run) {
      worker = await runWorker(run.id, cfg, adapter, options.workerOptions);
    }
    const finalStatus = cfg.runtime.dry_run ? 'succeeded' : finalOutcome(worker);
    repository.finishRun(run.id, finalStatus, worker.stopReason, {
      candidates: candidates.length,
      accepted,
      duplicate_jobs: duplicateJobs,
      ...worker.stats,
    });
    const report = buildReport(run.id);
    audit?.endOperation(finalStatus === 'succeeded' ? 'success' : 'error', {
      run_id: run.id,
      candidates: candidates.length,
      accepted,
      statuses: report.stats,
    }, null, worker.stopReason);
    return report;
  } catch (error) {
    repository.finishRun(run.id, 'failed', error.message, repository.countStatuses(run.id));
    audit?.endOperation('error', { run_id: run.id }, null, error.message);
    throw error;
  } finally {
    if (locked) repository.releaseAccountLock(cfg.account_uid, run.id);
  }
}

async function resumeCampaign(runId, cfg, adapter, options = {}) {
  const run = repository.getRun(runId);
  if (!run) throw new Error(`运行不存在: ${runId}`);
  if (run.dryRun) throw campaignError('dry-run 运行不可恢复为正式发送；请新建正式运行', 'DRY_RUN_RESUME', 2);
  if (run.contentHash !== cfg.content_hash || run.accountAlias !== cfg.account_alias
      || run.accountUid !== cfg.account_uid) {
    throw campaignError('恢复配置与原运行的账号或固定文案不一致', 'CONFIG_MISMATCH', 2);
  }
  await assertCurrentAccount(cfg, adapter);
  acquireLock(cfg, runId);
  try {
    repository.prepareResume(runId);
    const worker = await runWorker(runId, cfg, adapter, options.workerOptions);
    const stats = repository.countStatuses(runId);
    repository.finishRun(runId, finalOutcome({ ...worker, stats }), worker.stopReason, stats);
    return buildReport(runId);
  } finally {
    repository.releaseAccountLock(cfg.account_uid, runId);
  }
}

module.exports = { assertCurrentAccount, finalOutcome, runCampaign, resumeCampaign };
