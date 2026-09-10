const crypto = require('crypto');
const { getDb } = require('../memory/db');

const JOB_STATUSES = new Set([
  'pending', 'sending', 'succeeded', 'retryable', 'failed',
  'blocked', 'unknown', 'skipped',
]);

function parseJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function rowToRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignName: row.campaign_name,
    accountAlias: row.account_alias,
    accountUid: row.account_uid || null,
    configHash: row.config_hash,
    contentHash: row.content_hash,
    dryRun: !!row.dry_run,
    status: row.status,
    stopRequested: !!row.stop_requested,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    stopReason: row.stop_reason,
    stats: parseJson(row.stats_json, {}),
  };
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    accountAlias: row.account_alias,
    accountUid: row.account_uid || null,
    awemeId: row.aweme_id,
    contentHash: row.content_hash,
    dryRun: !!row.dry_run,
    status: row.status,
    attempts: row.attempts,
    dispatchStartedAt: row.dispatch_started_at,
    leaseUntil: row.lease_until,
    platformCommentId: row.platform_comment_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createRun(cfg) {
  const db = getDb();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO auto_campaign_runs
      (id, campaign_name, account_alias, account_uid, config_hash, content_hash, dry_run, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(id, cfg.campaign_name, cfg.account_alias, cfg.account_uid || null,
    cfg.config_hash, cfg.content_hash, cfg.runtime.dry_run ? 1 : 0, now);
  return getRun(id);
}

function getRun(id) {
  return rowToRun(getDb().prepare('SELECT * FROM auto_campaign_runs WHERE id = ?').get(id));
}

function latestRun() {
  return rowToRun(getDb().prepare('SELECT * FROM auto_campaign_runs ORDER BY started_at DESC LIMIT 1').get());
}

function requestStop(id, reason = 'stop_requested') {
  getDb().prepare(`
    UPDATE auto_campaign_runs SET stop_requested = 1, stop_reason = COALESCE(stop_reason, ?)
    WHERE id = ?
  `).run(reason, id);
  return getRun(id);
}

function finishRun(id, status, stopReason = null, stats = null) {
  getDb().prepare(`
    UPDATE auto_campaign_runs
    SET status = ?, finished_at = ?, stop_reason = COALESCE(?, stop_reason),
        stats_json = COALESCE(?, stats_json)
    WHERE id = ?
  `).run(status, Date.now(), stopReason, stats ? JSON.stringify(stats) : null, id);
  return getRun(id);
}

function upsertTarget(runId, candidate, verdict) {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO auto_campaign_targets
      (run_id, aweme_id, source_keyword, author_id, description, published_at,
       like_count, comment_count, relevance_score, decision, decision_reason, discovered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, aweme_id) DO UPDATE SET
      source_keyword = excluded.source_keyword,
      author_id = excluded.author_id,
      description = excluded.description,
      published_at = excluded.published_at,
      like_count = excluded.like_count,
      comment_count = excluded.comment_count,
      relevance_score = excluded.relevance_score,
      decision = excluded.decision,
      decision_reason = excluded.decision_reason
  `).run(runId, candidate.awemeId, candidate.sourceKeyword, candidate.authorId,
    candidate.description, candidate.publishedAt, candidate.likeCount, candidate.commentCount,
    verdict.score, verdict.decision, verdict.reason, now);
}

function enqueueJob(runId, accountAlias, awemeId, contentHash) {
  const now = Date.now();
  const run = getRun(runId);
  if (!run) throw new Error(`运行不存在: ${runId}`);
  const info = getDb().prepare(`
    INSERT OR IGNORE INTO auto_campaign_jobs
      (run_id, account_alias, account_uid, aweme_id, content_hash, dry_run, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(runId, accountAlias, run.accountUid, awemeId, contentHash, run.dryRun ? 1 : 0, now, now);
  return { inserted: info.changes > 0, job: getJobByKey(run.accountUid, awemeId, contentHash, run.dryRun) };
}

function getJob(id) {
  return rowToJob(getDb().prepare('SELECT * FROM auto_campaign_jobs WHERE id = ?').get(id));
}

function getJobByKey(accountUid, awemeId, contentHash, dryRun = false) {
  return rowToJob(getDb().prepare(`
    SELECT * FROM auto_campaign_jobs
    WHERE account_uid IS ? AND aweme_id = ? AND content_hash = ? AND dry_run = ?
  `).get(accountUid || null, awemeId, contentHash, dryRun ? 1 : 0));
}

function listJobs(runId, statuses = null) {
  const db = getDb();
  if (!statuses || !statuses.length) {
    return db.prepare('SELECT * FROM auto_campaign_jobs WHERE run_id = ? ORDER BY id').all(runId).map(rowToJob);
  }
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM auto_campaign_jobs WHERE run_id = ? AND status IN (${placeholders}) ORDER BY id
  `).all(runId, ...statuses).map(rowToJob);
}

function recoverExpiredSending(runId, now = Date.now()) {
  const db = getDb();
  return db.transaction(() => {
    const undispatched = db.prepare(`
      UPDATE auto_campaign_jobs
      SET status = 'pending', lease_until = NULL, updated_at = ?
      WHERE run_id = ? AND status = 'sending' AND lease_until < ?
        AND dispatch_started_at IS NULL
    `).run(now, runId, now).changes;
    const ambiguous = db.prepare(`
      UPDATE auto_campaign_jobs
      SET status = 'unknown', lease_until = NULL, error_code = 'LOST_AFTER_DISPATCH',
          error_message = '发送已开始但结果丢失', updated_at = ?
      WHERE run_id = ? AND status = 'sending' AND lease_until < ?
        AND dispatch_started_at IS NOT NULL
    `).run(now, runId, now).changes;
    return { undispatched, ambiguous };
  })();
}

function listActiveSending(runId, now = Date.now()) {
  return listJobs(runId, ['sending']).filter(job => job.leaseUntil == null || job.leaseUntil > now);
}

function lastDispatchAt(accountUid) {
  if (!accountUid) return 0;
  return getDb().prepare(`
    SELECT MAX(dispatch_started_at) AS ts FROM auto_campaign_jobs
    WHERE account_uid = ? AND dispatch_started_at IS NOT NULL
  `).get(accountUid).ts || 0;
}

function claimNext(runId, leaseMs = 120000) {
  const db = getDb();
  const now = Date.now();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM auto_campaign_jobs
      WHERE run_id = ? AND dry_run = 0 AND status IN ('pending', 'retryable')
      ORDER BY id LIMIT 1
    `).get(runId);
    if (!row) return null;
    db.prepare(`
      UPDATE auto_campaign_jobs
      SET status = 'sending', lease_until = ?,
          dispatch_started_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'retryable')
    `).run(now + leaseMs, now, row.id);
    return getJob(row.id);
  })();
}

function markDispatchedIfAllowed(id, runId) {
  const db = getDb();
  return db.transaction(() => {
    const run = db.prepare(`
      SELECT status, stop_requested, stop_reason, dry_run, account_uid
      FROM auto_campaign_runs WHERE id = ?
    `).get(runId);
    if (!run || run.status !== 'running' || run.stop_requested || run.dry_run) {
      return {
        allowed: false,
        reason: run?.stop_reason || (run?.dry_run ? 'dry_run_never_dispatches' : (run ? 'run_not_active' : 'run_not_found')),
      };
    }
    const now = Date.now();
    const lock = db.prepare(`
      SELECT run_id, lease_until FROM auto_campaign_account_locks WHERE account_uid = ?
    `).get(run.account_uid);
    if (!lock || lock.run_id !== runId || lock.lease_until <= now) {
      return { allowed: false, reason: 'account_lock_lost' };
    }
    const result = db.prepare(`
      UPDATE auto_campaign_jobs
      SET dispatch_started_at = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND run_id = ? AND status = 'sending' AND dispatch_started_at IS NULL
    `).run(now, now, id, runId);
    if (result.changes === 1) {
      db.prepare(`
        UPDATE auto_campaign_account_locks SET lease_until = ?, updated_at = ?
        WHERE account_uid = ? AND run_id = ?
      `).run(now + 120000, now, run.account_uid, runId);
    }
    return {
      allowed: result.changes === 1,
      reason: result.changes === 1 ? null : 'job_not_dispatchable',
      job: result.changes === 1 ? getJob(id) : null,
    };
  })();
}

function acquireAccountLock(accountUid, runId, leaseMs = 120000, now = Date.now()) {
  const db = getDb();
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT run_id, lease_until FROM auto_campaign_account_locks WHERE account_uid = ?
    `).get(accountUid);
    if (current && current.lease_until > now) {
      return { acquired: false, holderRunId: current.run_id, leaseUntil: current.lease_until };
    }
    db.prepare(`
      INSERT INTO auto_campaign_account_locks(account_uid, run_id, lease_until, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_uid) DO UPDATE SET
        run_id = excluded.run_id, lease_until = excluded.lease_until, updated_at = excluded.updated_at
    `).run(accountUid, runId, now + leaseMs, now);
    return { acquired: true, holderRunId: runId, leaseUntil: now + leaseMs };
  })();
}

function refreshAccountLock(accountUid, runId, leaseMs = 120000, now = Date.now()) {
  const result = getDb().prepare(`
    UPDATE auto_campaign_account_locks
    SET lease_until = ?, updated_at = ?
    WHERE account_uid = ? AND run_id = ?
  `).run(now + leaseMs, now, accountUid, runId);
  return result.changes === 1;
}

function releaseAccountLock(accountUid, runId) {
  return getDb().prepare(`
    DELETE FROM auto_campaign_account_locks WHERE account_uid = ? AND run_id = ?
  `).run(accountUid, runId).changes === 1;
}

function prepareResume(runId) {
  const db = getDb();
  return db.transaction(() => {
    const run = db.prepare('SELECT * FROM auto_campaign_runs WHERE id = ?').get(runId);
    if (!run) throw new Error(`运行不存在: ${runId}`);
    if (run.dry_run) throw new Error('dry-run 运行不可恢复为正式发送；请新建正式运行');
    const nonResumable = db.prepare(`
      SELECT error_code FROM auto_campaign_jobs
      WHERE run_id = ? AND status = 'blocked'
        AND COALESCE(error_code, 'UNKNOWN_BLOCK') NOT IN ('AUTH_EXPIRED', 'CHALLENGE_REQUIRED', 'RATE_LIMITED')
      LIMIT 1
    `).get(runId);
    if (nonResumable) {
      throw new Error(`存在不可自动恢复的阻断任务: ${nonResumable.error_code || 'UNKNOWN_BLOCK'}`);
    }
    const now = Date.now();
    db.prepare(`
      UPDATE auto_campaign_jobs
      SET status = 'pending', lease_until = NULL, dispatch_started_at = NULL,
          error_code = NULL, error_message = NULL, updated_at = ?
      WHERE run_id = ? AND status = 'blocked'
        AND error_code IN ('AUTH_EXPIRED', 'CHALLENGE_REQUIRED', 'RATE_LIMITED')
    `).run(now, runId);
    db.prepare(`
      UPDATE auto_campaign_runs
      SET status = 'running', stop_requested = 0, stop_reason = NULL, finished_at = NULL
      WHERE id = ?
    `).run(runId);
    return getRun(runId);
  })();
}

function transitionJob(id, status, fields = {}) {
  if (!JOB_STATUSES.has(status)) throw new Error(`invalid job status: ${status}`);
  const current = getJob(id);
  if (!current) throw new Error(`任务不存在: ${id}`);
  if (current.status === 'unknown' && !['unknown', 'succeeded'].includes(status)) {
    throw new Error(`禁止将 unknown 任务转换为 ${status}`);
  }
  if (current.status === 'succeeded' && status !== 'succeeded') {
    throw new Error(`禁止将 succeeded 任务转换为 ${status}`);
  }
  const message = fields.errorMessage ? String(fields.errorMessage).slice(0, 300) : null;
  getDb().prepare(`
    UPDATE auto_campaign_jobs SET
      status = ?, platform_comment_id = COALESCE(?, platform_comment_id),
      error_code = ?, error_message = ?, lease_until = NULL, updated_at = ?
    WHERE id = ?
  `).run(status, fields.platformCommentId || null, fields.errorCode || null, message, Date.now(), id);
  return getJob(id);
}

function countStatuses(runId) {
  const out = { pending: 0, sending: 0, succeeded: 0, retryable: 0, failed: 0, blocked: 0, unknown: 0, skipped: 0, total: 0 };
  const rows = getDb().prepare(`
    SELECT status, count(*) n FROM auto_campaign_jobs WHERE run_id = ? GROUP BY status
  `).all(runId);
  for (const row of rows) out[row.status] = row.n;
  out.total = Object.entries(out).filter(([k]) => k !== 'total').reduce((n, [, v]) => n + v, 0);
  return out;
}

function sentToday(accountUid, now = Date.now()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return getDb().prepare(`
    SELECT count(*) n
    FROM auto_campaign_jobs jobs
    JOIN auto_campaign_runs runs ON runs.id = jobs.run_id
    WHERE runs.account_uid = ? AND jobs.status = 'succeeded' AND jobs.updated_at >= ?
  `).get(accountUid, start.getTime()).n;
}

module.exports = {
  JOB_STATUSES, createRun, getRun, latestRun, requestStop, finishRun,
  upsertTarget, enqueueJob, getJob, getJobByKey, listJobs,
  recoverExpiredSending, claimNext, markDispatchedIfAllowed, transitionJob,
  acquireAccountLock, refreshAccountLock, releaseAccountLock, prepareResume,
  countStatuses, sentToday, listActiveSending, lastDispatchAt,
};
