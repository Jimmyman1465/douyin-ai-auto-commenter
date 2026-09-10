const fs = require('fs');
const os = require('os');
const path = require('path');

function withTempDb(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-quick-comment-'));
    const old = process.env.DOUYIN_STORAGE_DIR;
    process.env.DOUYIN_STORAGE_DIR = path.join(tmp, 'storage');
    Object.keys(require.cache)
      .filter(key => key.includes(path.join('lib', 'auto-campaign'))
        || key.includes(path.join('lib', 'quick-comment'))
        || key.endsWith(path.join('lib', 'memory', 'db.js')))
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
    campaign_name: 'quick',
    account_alias: 'primary',
    account_uid: 'me',
    keywords: ['AI'],
    fixed_comment: '固定文案',
    comment_version: 'v1',
    filters: { max_video_age_days: 0 },
    limits: { min_interval_seconds: 1, max_send_per_run: 10, max_send_per_day: 20 },
    runtime: { dry_run: false },
    ...overrides,
  });
}

describe('quick-comment input parsing', () => {
  it('accepts ids, direct URLs, share text, and deduplicates without losing 19-digit precision', async () => {
    const { resolveInputText } = require('../lib/quick-comment/input-parser');
    const targets = await resolveInputText(`
# comment
7655315645270140130
https://www.douyin.com/video/7655315645270140130
复制打开 https://www.douyin.com/video/7657506425620000001。 看视频
`);
    expect(targets.map(item => item.awemeId)).toEqual([
      '7655315645270140130',
      '7657506425620000001',
    ]);
  });

  it('resolves a v.douyin.com short link once and rejects non-Douyin links', async () => {
    const { resolveTarget } = require('../lib/quick-comment/input-parser');
    let calls = 0;
    const target = await resolveTarget('https://v.douyin.com/abc/', {
      fetchImpl: async () => {
        calls++;
        return { url: 'https://www.douyin.com/video/7655315645270140130' };
      },
    });
    expect(calls).toBe(1);
    expect(target.awemeId).toBe('7655315645270140130');
    await expect(resolveTarget('https://example.com/video/7655315645270140130')).rejects.toThrow(/仅支持/);
  });

  it('reports the failing input line', async () => {
    const { resolveInputText } = require('../lib/quick-comment/input-parser');
    await expect(resolveInputText('7655315645270140130\nnot-a-target')).rejects.toThrow(/第 2 行/);
  });
});

describe('quick-comment orchestration', () => {
  it('dry-run queues explicit targets without account preflight or publish', withTempDb(async () => {
    const { runQuickComment } = require('../lib/quick-comment/orchestrator');
    let preflights = 0;
    let publishes = 0;
    const report = await runQuickComment(config({ runtime: { dry_run: true } }), [
      { awemeId: '7655315645270140130', source: '7655315645270140130' },
    ], {
      getCurrentAccountUid: async () => { preflights++; return 'me'; },
      publish: async () => { publishes++; },
      verifyPublished: async () => ({ verified: false }),
    });
    expect(preflights).toBe(0);
    expect(publishes).toBe(0);
    expect(report.run.status).toBe('succeeded');
    expect(report.stats).toMatchObject({ pending: 1, total: 1 });
  }));

  it('preflights once and publishes different videos serially', withTempDb(async () => {
    const { runQuickComment } = require('../lib/quick-comment/orchestrator');
    let preflights = 0;
    const published = [];
    const report = await runQuickComment(config(), [
      { awemeId: '7655315645270140130', source: 'one' },
      { awemeId: '7657506425620000001', source: 'two' },
    ], {
      getCurrentAccountUid: async () => { preflights++; return 'me'; },
      publish: async id => { published.push(id); return { cid: `c-${id}` }; },
      verifyPublished: async () => ({ verified: false }),
    }, { workerOptions: { sleep: async () => {}, now: (() => { let n = 100000; return () => (n += 1000); })() } });
    expect(preflights).toBe(1);
    expect(published).toEqual(['7655315645270140130', '7657506425620000001']);
    expect(report.run.status).toBe('succeeded');
    expect(report.stats.succeeded).toBe(2);
  }));

  it('uses one browser-side batch call for multiple videos', withTempDb(async () => {
    const { runQuickComment } = require('../lib/quick-comment/orchestrator');
    let preflights = 0;
    let singlePublishes = 0;
    const batches = [];
    const report = await runQuickComment(config({ limits: {
      min_interval_seconds: 1,
      max_interval_seconds: 1,
      bridge_batch_size: 5,
      max_send_per_run: 10,
      max_send_per_day: 20,
    } }), [
      { awemeId: '7655315645270140130', source: 'one' },
      { awemeId: '7657506425620000001', source: 'two' },
    ], {
      getCurrentAccountUid: async () => { preflights++; return 'me'; },
      publish: async () => { singlePublishes++; },
      publishBatch: async items => {
        batches.push(items);
        return { results: items.map(item => ({ awemeId: item.awemeId, status: 'succeeded', cid: `c-${item.awemeId}` })) };
      },
      verifyPublished: async () => ({ verified: false }),
    }, { workerOptions: { sleep: async () => {} } });
    expect(preflights).toBe(1);
    expect(singlePublishes).toBe(0);
    expect(batches).toHaveLength(1);
    expect(batches[0].map(item => item.awemeId)).toEqual(['7655315645270140130', '7657506425620000001']);
    expect(report.stats).toMatchObject({ succeeded: 2, total: 2 });
  }));

  it('rolls confirmed not-started batch items back without consuming an attempt', withTempDb(async () => {
    const { runQuickComment } = require('../lib/quick-comment/orchestrator');
    const report = await runQuickComment(config({ limits: {
      min_interval_seconds: 1,
      max_interval_seconds: 1,
      bridge_batch_size: 5,
      max_send_per_run: 10,
      max_send_per_day: 20,
    } }), [
      { awemeId: '7655315645270140130', source: 'one' },
      { awemeId: '7657506425620000001', source: 'two' },
    ], {
      getCurrentAccountUid: async () => 'me',
      publishBatch: async items => ({ results: [
        { awemeId: items[0].awemeId, status: 'blocked', errorCode: 'CHALLENGE_REQUIRED' },
        { awemeId: items[1].awemeId, status: 'not_started' },
      ] }),
      verifyPublished: async () => ({ verified: false }),
    }, { workerOptions: { sleep: async () => {} } });
    expect(report.run).toMatchObject({ status: 'blocked', stopReason: 'CHALLENGE_REQUIRED' });
    expect(report.jobs[0]).toMatchObject({ status: 'blocked', attempts: 1 });
    expect(report.jobs[1]).toMatchObject({ status: 'pending', attempts: 0 });
  }));

  it('splits a larger queue into bounded browser batches', withTempDb(async () => {
    const { runQuickComment } = require('../lib/quick-comment/orchestrator');
    const targets = Array.from({ length: 23 }, (_, index) => ({
      awemeId: String(7655315645270140100n + BigInt(index)),
      source: `target-${index}`,
    }));
    const batchSizes = [];
    const report = await runQuickComment(config({ limits: {
      min_interval_seconds: 1,
      max_interval_seconds: 1,
      bridge_batch_size: 10,
      max_send_per_run: 100,
      max_send_per_day: 100,
    } }), targets, {
      getCurrentAccountUid: async () => 'me',
      publishBatch: async items => {
        batchSizes.push(items.length);
        return { results: items.map(item => ({ awemeId: item.awemeId, status: 'succeeded', cid: `c-${item.awemeId}` })) };
      },
      verifyPublished: async () => ({ verified: false }),
    }, { workerOptions: { sleep: async () => {} } });
    expect(batchSizes).toEqual([10, 10, 3]);
    expect(report.stats).toMatchObject({ succeeded: 23, total: 23 });
  }));

  it('uses existing idempotency across runs and does not post the duplicate again', withTempDb(async () => {
    const { runQuickComment } = require('../lib/quick-comment/orchestrator');
    const target = [{ awemeId: '7655315645270140130', source: 'one' }];
    let publishes = 0;
    const adapter = {
      getCurrentAccountUid: async () => 'me',
      publish: async () => ({ cid: `c-${++publishes}` }),
      verifyPublished: async () => ({ verified: false }),
    };
    await runQuickComment(config(), target, adapter, { workerOptions: { sleep: async () => {} } });
    const second = await runQuickComment(config(), target, adapter, { workerOptions: { sleep: async () => {} } });
    expect(publishes).toBe(1);
    expect(second.stats.total).toBe(0);
    expect(second.run.stats.duplicate_jobs).toBe(1);
  }));
});

describe('quick-comment browser adapter', () => {
  it('serializes a whole batch into one bridge request with a long transport timeout', async () => {
    const { createDouyinAdapter } = require('../lib/auto-campaign/adapters');
    const calls = [];
    const adapter = createDouyinAdapter({
      loggedCall: async (...args) => { calls.push(args); return { results: [] }; },
    });
    await adapter.publishBatch([
      { awemeId: '7655315645270140130', text: "含'引号的文案" },
      { awemeId: '7657506425620000001', text: '第二条' },
    ], { intervalMinMs: 1000, intervalMaxMs: 2000, timeout: 90000 });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('quick_comment_batch');
    expect(calls[0][2]).toContain('window.__bridge.publishBatch(');
    expect(calls[0][2]).toContain("含'引号的文案");
    expect(calls[0][3]).toEqual({ timeout: 90000 });
  });
});
