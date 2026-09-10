const repository = require('../auto-campaign/repository');
const { buildReport } = require('../auto-campaign/reporter');
const { assertCurrentAccount, finalOutcome } = require('../auto-campaign/orchestrator');
const { runBatchWorker } = require('./batch-worker');

function targetCandidate(target) {
  return {
    awemeId: String(target.awemeId),
    sourceKeyword: 'explicit_target',
    authorId: '',
    authorName: '',
    description: target.resolvedUrl || target.source || String(target.awemeId),
    publishedAt: 0,
    likeCount: 0,
    commentCount: 0,
  };
}

async function runQuickComment(cfg, targets, adapter, options = {}) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('目标列表为空');
  if (!cfg.runtime.dry_run) await assertCurrentAccount(cfg, adapter);
  const run = repository.createRun(cfg);
  const audit = options.audit;
  let locked = false;
  audit?.startOperation('quick_comment', {
    run_id: run.id,
    target_count: targets.length,
    dry_run: cfg.runtime.dry_run,
  });
  try {
    if (!cfg.runtime.dry_run) {
      const lock = repository.acquireAccountLock(cfg.account_uid, run.id);
      if (!lock.acquired) {
        const error = new Error(`账号已有运行中的正式任务: ${lock.holderRunId}`);
        error.code = 'ACCOUNT_LOCKED';
        error.exitCode = 3;
        throw error;
      }
      locked = true;
    }
    let accepted = 0;
    let duplicateJobs = 0;
    for (const target of targets) {
      const candidate = targetCandidate(target);
      const verdict = { decision: 'accepted', score: 1, reason: 'explicit_target' };
      repository.upsertTarget(run.id, candidate, verdict);
      const queued = repository.enqueueJob(run.id, cfg.account_alias, candidate.awemeId, cfg.content_hash);
      if (queued.inserted) accepted++;
      else duplicateJobs++;
    }

    let worker = { stopReason: null, stats: repository.countStatuses(run.id) };
    if (!cfg.runtime.dry_run) {
      worker = await runBatchWorker(run.id, cfg, adapter, options.workerOptions);
    }
    const finalStatus = cfg.runtime.dry_run ? 'succeeded' : finalOutcome(worker);
    repository.finishRun(run.id, finalStatus, worker.stopReason, {
      candidates: targets.length,
      accepted,
      duplicate_jobs: duplicateJobs,
      ...worker.stats,
    });
    const report = buildReport(run.id);
    audit?.endOperation(finalStatus === 'succeeded' ? 'success' : 'error', {
      run_id: run.id,
      accepted,
      duplicate_jobs: duplicateJobs,
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

module.exports = { runQuickComment, targetCandidate };
