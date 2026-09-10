const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempDb(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-campaign-'));
    const old = process.env.DOUYIN_STORAGE_DIR;
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    Object.keys(require.cache)
      .filter(key => key.includes(path.join('lib', 'auto-campaign')) || key.endsWith(path.join('lib', 'memory', 'db.js')))
      .forEach(key => delete require.cache[key]);
    try {
      await fn();
    } finally {
      try { require('../lib/memory/db').closeDb(); } catch (_) {}
      if (old == null) delete process.env.DOUYIN_STORAGE_DIR;
      else process.env.DOUYIN_STORAGE_DIR = old;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function config(overrides = {}) {
  const { validateConfig } = require('../lib/auto-campaign/config');
  return validateConfig({
    campaign_name: 'ai',
    account_alias: 'primary',
    account_uid: 'me',
    keywords: ['AI', '人工智能'],
    fixed_comment: '固定文案',
    comment_version: 'v1',
    filters: { max_video_age_days: 0, relevance_threshold: 0.34 },
    limits: { min_interval_seconds: 1, max_send_per_run: 10, max_send_per_day: 20 },
    runtime: { dry_run: false },
    ...overrides,
  });
}

describe('auto-campaign config/filter', () => {
  it('validates and exposes only redacted copy metadata', () => {
    const { configSummary } = require('../lib/auto-campaign/config');
    const cfg = config();
    expect(cfg.content_hash).toHaveLength(64);
    expect(configSummary(cfg).fixed_comment).toMatchObject({ version: 'v1', length: 4 });
    expect(JSON.stringify(configSummary(cfg))).not.toContain('固定文案');
  });

  it('rejects invisible copy controls and an unimplemented LLM filter mode', () => {
    expect(() => config({ fixed_comment: `可见\u0000隐藏` })).toThrow(/控制字符/);
    expect(() => config({ filters: { use_llm_for_borderline: true } })).toThrow(/暂未实现/);
  });

  it('deduplicates videos across keywords and produces readable decisions', () => {
    const { dedupeCandidates, scoreCandidate } = require('../lib/auto-campaign/filter');
    const cfg = config();
    const items = dedupeCandidates([
      { keyword: 'AI', items: [{ aweme_info: { aweme_id: 'v1', desc: 'AI Agent 实战', create_time: 1, statistics: {} } }] },
      { keyword: '人工智能', items: [{ aweme_info: { aweme_id: 'v1', desc: '重复', create_time: 1, statistics: {} } }] },
    ]);
    expect(items).toHaveLength(1);
    expect(scoreCandidate(items[0], cfg).decision).toBe('accepted');
    expect(scoreCandidate({ ...items[0], description: '' }, cfg).reason).toBe('missing_required_fields');
  });

  it('never accepts a video with no AI term even at threshold zero', () => {
    const { scoreCandidate } = require('../lib/auto-campaign/filter');
    const cfg = config({ filters: { max_video_age_days: 0, relevance_threshold: 0 } });
    expect(scoreCandidate({ awemeId: 'v-no-ai', description: '美食分享', authorId: 'a' }, cfg)).toMatchObject({
      decision: 'skipped', reason: 'no_relevant_term',
    });
  });
});

describe('auto-campaign persistence and worker', () => {
  it('dry-run searches and queues but performs zero writes', withTempDb(async () => {
    const { runCampaign } = require('../lib/auto-campaign/orchestrator');
    let publishes = 0;
    const adapter = {
      search: async () => [{ aweme_info: { aweme_id: 'v1', desc: 'AI Agent', create_time: 1, statistics: {} } }],
      publish: async () => { publishes++; },
      verifyPublished: async () => ({ verified: false }),
    };
    const report = await runCampaign(config({ runtime: { dry_run: true } }), adapter);
    expect(publishes).toBe(0);
    expect(report.stats.pending).toBe(1);
    expect(report.run.status).toBe('succeeded');
  }));

  it('deduplicates by account + video + content hash across runs', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const cfg = config();
    const r1 = repository.createRun(cfg);
    expect(repository.enqueueJob(r1.id, cfg.account_alias, 'v1', cfg.content_hash).inserted).toBe(true);
    repository.finishRun(r1.id, 'succeeded');
    const r2 = repository.createRun(cfg);
    expect(repository.enqueueJob(r2.id, cfg.account_alias, 'v1', cfg.content_hash).inserted).toBe(false);
  }));

  it('deduplicates the same real UID even when the alias changes', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const first = config({ account_alias: 'primary' });
    const second = config({ account_alias: 'renamed' });
    const r1 = repository.createRun(first);
    expect(repository.enqueueJob(r1.id, first.account_alias, 'v1', first.content_hash).inserted).toBe(true);
    const r2 = repository.createRun(second);
    expect(repository.enqueueJob(r2.id, second.account_alias, 'v1', second.content_hash).inserted).toBe(false);
  }));

  it('dry-run records do not block a later live job', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const dry = config({ runtime: { dry_run: true } });
    const live = config({ runtime: { dry_run: false } });
    const r1 = repository.createRun(dry);
    expect(repository.enqueueJob(r1.id, dry.account_alias, 'v1', dry.content_hash).inserted).toBe(true);
    repository.finishRun(r1.id, 'succeeded');
    const r2 = repository.createRun(live);
    expect(repository.enqueueJob(r2.id, live.account_alias, 'v1', live.content_hash).inserted).toBe(true);
  }));

  it('never claims or resumes a dry-run job into a POST', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { resumeCampaign } = require('../lib/auto-campaign/orchestrator');
    const dry = config({ runtime: { dry_run: true } });
    const live = config({ runtime: { dry_run: false } });
    const run = repository.createRun(dry);
    repository.enqueueJob(run.id, dry.account_alias, 'v1', dry.content_hash);
    expect(repository.claimNext(run.id)).toBeNull();
    let publishes = 0;
    await expect(resumeCampaign(run.id, live, {
      getCurrentAccountUid: async () => live.account_uid,
      publish: async () => { publishes++; },
      verifyPublished: async () => ({ verified: false }),
    })).rejects.toThrow(/dry-run/);
    expect(publishes).toBe(0);
  }));

  it('allows only one live sender lock per actual account UID', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const cfg = config();
    const r1 = repository.createRun(cfg);
    const r2 = repository.createRun({ ...cfg, campaign_name: 'second' });
    expect(repository.acquireAccountLock(cfg.account_uid, r1.id).acquired).toBe(true);
    expect(repository.acquireAccountLock(cfg.account_uid, r2.id)).toMatchObject({
      acquired: false,
      holderRunId: r1.id,
    });
    repository.releaseAccountLock(cfg.account_uid, r1.id);
    expect(repository.acquireAccountLock(cfg.account_uid, r2.id).acquired).toBe(true);
  }));

  it('atomically refuses dispatch after a stop request', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const cfg = config();
    const run = repository.createRun(cfg);
    const job = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    repository.acquireAccountLock(cfg.account_uid, run.id);
    repository.claimNext(run.id);
    repository.acquireAccountLock(cfg.account_uid, run.id);
    repository.requestStop(run.id, 'operator_stop');
    expect(repository.markDispatchedIfAllowed(job.id, run.id)).toEqual({
      allowed: false,
      reason: 'operator_stop',
    });
    expect(repository.getJob(job.id).dispatchStartedAt).toBeNull();
    expect(repository.getJob(job.id).attempts).toBe(0);
  }));

  it('counts an attempt only at the atomic dispatch permit', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const cfg = config();
    const run = repository.createRun(cfg);
    const job = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    repository.acquireAccountLock(cfg.account_uid, run.id);
    expect(repository.claimNext(run.id).attempts).toBe(0);
    expect(repository.markDispatchedIfAllowed(job.id, run.id).allowed).toBe(true);
    expect(repository.getJob(job.id)).toMatchObject({ attempts: 1 });
    expect(repository.getJob(job.id).dispatchStartedAt).not.toBeNull();
  }));

  it('explicit resume clears a manual stop and only retry-safe platform blocks', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const cfg = config();
    const run = repository.createRun(cfg);
    const auth = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    repository.transitionJob(auth.id, 'blocked', { errorCode: 'AUTH_EXPIRED' });
    repository.requestStop(run.id, 'AUTH_EXPIRED');
    repository.finishRun(run.id, 'blocked');
    expect(repository.prepareResume(run.id)).toMatchObject({ status: 'running', stopRequested: false });
    expect(repository.getJob(auth.id)).toMatchObject({ status: 'pending', attempts: 0 });
  }));

  it('never requeues unknown or non-resumable blocked jobs', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const cfg = config();
    const run = repository.createRun(cfg);
    const unknown = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    repository.transitionJob(unknown.id, 'unknown', { errorCode: 'UNKNOWN_AFTER_DISPATCH' });
    expect(() => repository.transitionJob(unknown.id, 'pending')).toThrow(/禁止/);
    const blocked = repository.enqueueJob(run.id, cfg.account_alias, 'v2', cfg.content_hash).job;
    repository.transitionJob(blocked.id, 'blocked', { errorCode: 'CONTENT_REJECTED' });
    repository.finishRun(run.id, 'blocked');
    expect(() => repository.prepareResume(run.id)).toThrow(/不可自动恢复/);
    expect(repository.getJob(unknown.id).status).toBe('unknown');
  }));

  it('publishes serially and marks success', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { runWorker } = require('../lib/auto-campaign/worker');
    const cfg = config();
    const run = repository.createRun(cfg);
    repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash);
    repository.enqueueJob(run.id, cfg.account_alias, 'v2', cfg.content_hash);
    repository.acquireAccountLock(cfg.account_uid, run.id);
    const order = [];
    await runWorker(run.id, cfg, {
      publish: async id => { order.push(id); return { cid: 'c-' + id }; },
      verifyPublished: async () => ({ verified: false }),
    }, { sleep: async () => {}, now: (() => { let n = 100000; return () => (n += 1000); })() });
    expect(order).toEqual(['v1', 'v2']);
    expect(repository.countStatuses(run.id).succeeded).toBe(2);
  }));

  it('timeout after dispatch becomes unknown, verifies once, and never reposts', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { runWorker } = require('../lib/auto-campaign/worker');
    const cfg = config();
    const run = repository.createRun(cfg);
    repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash);
    repository.acquireAccountLock(cfg.account_uid, run.id);
    let publishes = 0;
    let verifies = 0;
    const result = await runWorker(run.id, cfg, {
      publish: async () => { publishes++; throw new Error('Request timeout'); },
      verifyPublished: async () => { verifies++; return { verified: false, conclusive: false }; },
    }, { sleep: async () => {} });
    expect(publishes).toBe(1);
    expect(verifies).toBe(1);
    expect(result.stopReason).toBe('unknown_result_requires_review');
    expect(repository.countStatuses(run.id).unknown).toBe(1);
  }));

  it('honors a stop request received while waiting between sends', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { runWorker } = require('../lib/auto-campaign/worker');
    const cfg = config();
    const run = repository.createRun(cfg);
    repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash);
    repository.enqueueJob(run.id, cfg.account_alias, 'v2', cfg.content_hash);
    repository.acquireAccountLock(cfg.account_uid, run.id);
    let now = 100000;
    let publishes = 0;
    const result = await runWorker(run.id, cfg, {
      publish: async () => ({ cid: 'c' + (++publishes) }),
      verifyPublished: async () => ({ verified: false }),
    }, {
      now: () => now,
      sleep: async ms => {
        now += ms;
        repository.requestStop(run.id, 'test_stop');
      },
    });
    expect(publishes).toBe(1);
    expect(result.stopReason).toBe('test_stop');
    expect(repository.countStatuses(run.id)).toMatchObject({ succeeded: 1, pending: 1 });
  }));

  it('unknown verification can promote to succeeded without another POST', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { runWorker } = require('../lib/auto-campaign/worker');
    const cfg = config();
    const run = repository.createRun(cfg);
    const job = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    repository.transitionJob(job.id, 'unknown', { errorCode: 'UNKNOWN_AFTER_DISPATCH' });
    let publishes = 0;
    await runWorker(run.id, cfg, {
      publish: async () => { publishes++; },
      verifyPublished: async () => ({ verified: true, commentId: 'confirmed-cid' }),
    }, { sleep: async () => {} });
    expect(publishes).toBe(0);
    expect(repository.getJob(job.id)).toMatchObject({ status: 'succeeded', platformCommentId: 'confirmed-cid' });
  }));

  it('an inconclusive unknown blocks resume before any pending POST', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { resumeCampaign } = require('../lib/auto-campaign/orchestrator');
    const cfg = config();
    const run = repository.createRun(cfg);
    const unknown = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    repository.transitionJob(unknown.id, 'unknown', { errorCode: 'UNKNOWN_AFTER_DISPATCH' });
    repository.enqueueJob(run.id, cfg.account_alias, 'v2', cfg.content_hash);
    repository.finishRun(run.id, 'blocked');
    let publishes = 0;
    const report = await resumeCampaign(run.id, cfg, {
      getCurrentAccountUid: async () => cfg.account_uid,
      publish: async () => { publishes++; },
      verifyPublished: async () => ({ verified: false, conclusive: false }),
    }, { workerOptions: { sleep: async () => {} } });
    expect(publishes).toBe(0);
    expect(report.run.status).toBe('blocked');
    expect(report.stats).toMatchObject({ unknown: 1, pending: 1 });
  }));

  it('recovers expired leases safely based on dispatch marker', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { getDb } = require('../lib/memory/db');
    const cfg = config();
    const run = repository.createRun(cfg);
    const a = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    const b = repository.enqueueJob(run.id, cfg.account_alias, 'v2', cfg.content_hash).job;
    getDb().prepare("UPDATE auto_campaign_jobs SET status='sending', lease_until=1 WHERE id=?").run(a.id);
    getDb().prepare("UPDATE auto_campaign_jobs SET status='sending', lease_until=1, dispatch_started_at=1 WHERE id=?").run(b.id);
    expect(repository.recoverExpiredSending(run.id, 2)).toEqual({ undispatched: 1, ambiguous: 1 });
    expect(repository.getJob(a.id).status).toBe('pending');
    expect(repository.getJob(b.id).status).toBe('unknown');
  }));

  it('blocks resume while a dispatched sending lease is still unresolved', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { getDb } = require('../lib/memory/db');
    const { resumeCampaign } = require('../lib/auto-campaign/orchestrator');
    const cfg = config();
    const run = repository.createRun(cfg);
    const sending = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    const pending = repository.enqueueJob(run.id, cfg.account_alias, 'v2', cfg.content_hash).job;
    getDb().prepare("UPDATE auto_campaign_jobs SET status='sending', lease_until=?, dispatch_started_at=? WHERE id=?").run(Date.now() + 60000, Date.now(), sending.id);
    repository.finishRun(run.id, 'stopped');
    let publishes = 0;
    const report = await resumeCampaign(run.id, cfg, {
      getCurrentAccountUid: async () => cfg.account_uid,
      publish: async () => { publishes++; },
      verifyPublished: async () => ({ verified: false }),
    }, { workerOptions: { sleep: async () => {} } });
    expect(publishes).toBe(0);
    expect(report.run.status).toBe('blocked');
    expect(repository.getJob(pending.id).status).toBe('pending');
  }));

  it('maps unresolved sending to scheduler exit code 3', withTempDb(async () => {
    const { applyRunExitCode } = require('../lib/commands/autoCampaign');
    const previous = process.exitCode;
    process.exitCode = 0;
    applyRunExitCode({ run: { status: 'blocked', stopReason: 'sending_result_pending' }, stats: { sending: 1, unknown: 0, blocked: 0 }, jobs: [] });
    expect(process.exitCode).toBe(3);
    process.exitCode = previous;
  }));

  it('never retries an explicitly blocked error even when safeToRetry is true', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { runWorker } = require('../lib/auto-campaign/worker');
    const cfg = config();
    const run = repository.createRun(cfg);
    const job = repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash).job;
    repository.acquireAccountLock(cfg.account_uid, run.id);
    let publishes = 0;
    const error = Object.assign(new Error('rate limited'), { code: 'RATE_LIMITED', safeToRetry: true });
    await runWorker(run.id, cfg, {
      publish: async () => { publishes++; throw error; },
      verifyPublished: async () => ({ verified: false }),
    }, { sleep: async () => {} });
    expect(publishes).toBe(1);
    expect(repository.getJob(job.id).status).toBe('blocked');
  }));

  it('fails closed on missing or mismatched browser account UID', withTempDb(async () => {
    const { runCampaign } = require('../lib/auto-campaign/orchestrator');
    let searches = 0;
    let publishes = 0;
    await expect(runCampaign(config(), {
      getCurrentAccountUid: async () => 'different-account',
      search: async () => { searches++; return []; },
      publish: async () => { publishes++; },
      verifyPublished: async () => ({ verified: false }),
    })).rejects.toMatchObject({ code: 'ACCOUNT_UID_MISMATCH', exitCode: 3 });
    expect(searches).toBe(0);
    expect(publishes).toBe(0);
  }));

  it('explicitly resumes pending work after a manual stop', withTempDb(async () => {
    const repository = require('../lib/auto-campaign/repository');
    const { resumeCampaign } = require('../lib/auto-campaign/orchestrator');
    const cfg = config();
    const run = repository.createRun(cfg);
    repository.enqueueJob(run.id, cfg.account_alias, 'v1', cfg.content_hash);
    repository.requestStop(run.id, 'operator_stop');
    repository.finishRun(run.id, 'stopped');
    let publishes = 0;
    const report = await resumeCampaign(run.id, cfg, {
      getCurrentAccountUid: async () => cfg.account_uid,
      publish: async () => ({ cid: `c-${++publishes}` }),
      verifyPublished: async () => ({ verified: false }),
    }, { workerOptions: { sleep: async () => {} } });
    expect(publishes).toBe(1);
    expect(report.run.status).toBe('succeeded');
  }));

  it('marks a circuit breaker run failed and exposes scheduler exit code 5', withTempDb(async () => {
    const { runCampaign } = require('../lib/auto-campaign/orchestrator');
    const { applyRunExitCode } = require('../lib/commands/autoCampaign');
    const cfg = config({ limits: {
      min_interval_seconds: 1,
      max_send_per_run: 10,
      max_send_per_day: 20,
      max_consecutive_failures: 1,
    } });
    const failure = new Error('server rejected request');
    failure.code = 'SERVER_ERROR';
    const report = await runCampaign(cfg, {
      getCurrentAccountUid: async () => cfg.account_uid,
      search: async () => [{ aweme_info: { aweme_id: 'v1', desc: 'AI Agent', create_time: 1, statistics: {} } }],
      publish: async () => { throw failure; },
      verifyPublished: async () => ({ verified: false }),
    }, { workerOptions: { sleep: async () => {} } });
    expect(report.run).toMatchObject({ status: 'failed', stopReason: 'circuit_breaker' });
    const previous = process.exitCode;
    process.exitCode = 0;
    applyRunExitCode(report);
    expect(process.exitCode).toBe(5);
    process.exitCode = previous;
  }));

  it('migrates v8 and v9 databases to v11 idempotently', withTempDb(async () => {
    const storage = process.env.DOUYIN_STORAGE_DIR;
    fs.mkdirSync(storage, { recursive: true });
    const Database = require('better-sqlite3');
    const memory = require('../lib/memory/db');
    for (const version of [8, 9]) {
      const legacy = new Database(path.join(storage, `legacy-v${version}.db`));
      if (version === 9) legacy.exec('CREATE TABLE auto_campaign_runs (id TEXT PRIMARY KEY)');
      legacy.pragma(`user_version = ${version}`);
      memory.migrate(legacy);
      memory.migrate(legacy);
      expect(legacy.pragma('user_version', { simple: true })).toBe(11);
      expect(legacy.prepare('PRAGMA table_info(auto_campaign_runs)').all().map(c => c.name)).toContain('account_uid');
      expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auto_campaign_account_locks'").get()).toBeTruthy();
      legacy.close();
    }
    const v10 = new Database(path.join(storage, 'legacy-v10.db'));
    v10.exec(`
      CREATE TABLE auto_campaign_runs (id TEXT PRIMARY KEY, account_uid TEXT);
      CREATE TABLE auto_campaign_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, account_alias TEXT,
        account_uid TEXT, aweme_id TEXT, content_hash TEXT, dry_run INTEGER DEFAULT 0,
        status TEXT, attempts INTEGER DEFAULT 0, dispatch_started_at INTEGER,
        lease_until INTEGER, platform_comment_id TEXT, error_code TEXT, error_message TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      INSERT INTO auto_campaign_runs VALUES ('r','uid-1');
      INSERT INTO auto_campaign_jobs(run_id,account_alias,account_uid,aweme_id,content_hash,dry_run,status,created_at,updated_at)
        VALUES ('r','old','uid-1','v1','h',0,'sending',1,1);
      UPDATE auto_campaign_jobs SET dispatch_started_at=10, lease_until=999 WHERE id=1;
      INSERT INTO auto_campaign_jobs(run_id,account_alias,account_uid,aweme_id,content_hash,dry_run,status,created_at,updated_at)
        VALUES ('r','new','uid-1','v1','h',0,'sending',2,2);
      INSERT INTO auto_campaign_jobs(run_id,account_alias,account_uid,aweme_id,content_hash,dry_run,status,created_at,updated_at)
        VALUES ('r','new','uid-1','v2','h',0,'pending',3,3);
      INSERT INTO auto_campaign_jobs(run_id,account_alias,account_uid,aweme_id,content_hash,dry_run,status,created_at,updated_at)
        VALUES ('r','new','uid-1','v2','h',0,'succeeded',4,4);
      INSERT INTO auto_campaign_jobs(run_id,account_alias,account_uid,aweme_id,content_hash,dry_run,status,created_at,updated_at)
        VALUES ('r','new','uid-1','v3','h',0,'pending',5,5);
      INSERT INTO auto_campaign_jobs(run_id,account_alias,account_uid,aweme_id,content_hash,dry_run,status,created_at,updated_at)
        VALUES ('r','new','uid-1','v3','h',0,'unknown',6,6);
    `);
    v10.pragma('user_version = 10');
    const memoryV10 = require('../lib/memory/db');
    memoryV10.migrate(v10);
    memoryV10.migrate(v10);
    expect(v10.prepare("SELECT aweme_id,status,dispatch_started_at FROM auto_campaign_jobs ORDER BY aweme_id").all()).toEqual([
      { aweme_id: 'v1', status: 'sending', dispatch_started_at: 10 },
      { aweme_id: 'v2', status: 'succeeded', dispatch_started_at: null },
      { aweme_id: 'v3', status: 'unknown', dispatch_started_at: null },
    ]);
    v10.close();
  }));
});
