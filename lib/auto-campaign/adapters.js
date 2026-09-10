const { escapeExpression } = require('../commands/helpers');

function createDouyinAdapter(ctx) {
  return {
    async getCurrentAccountUid() {
      const data = await ctx.loggedCall(
        'auto_campaign_account_preflight',
        {},
        'window.__bridge._getMyUid()',
      );
      const uid = data && typeof data === 'object' ? (data.uid || data.user_id) : data;
      return uid == null ? '' : String(uid);
    },

    async search(keyword, count) {
      const items = [];
      for (let offset = 0; offset < count; offset += 20) {
        const pageSize = Math.min(20, count - offset);
        const expr = `window.__bridge.search('${escapeExpression(keyword)}', ${offset}, ${pageSize})`;
        const data = await ctx.loggedCall('auto_campaign_search', { keyword, offset, count: pageSize }, expr);
        const page = (data?.data || []).filter(item => item?.aweme_info);
        items.push(...page);
        if (page.length < pageSize) break;
      }
      return items;
    },

    async publish(awemeId, text) {
      // 节奏由 auto-campaign worker 统一负责；post 仅执行一次，不在 adapter 内重试。
      return ctx.cmdPost([String(awemeId), text, '--no-throttle']);
    },

    async verifyPublished({ awemeId, text, accountUid, since }) {
      if (!accountUid) return { verified: false, conclusive: false, reason: 'account_uid_missing' };
      const comments = [];
      let cursor = 0;
      for (let page = 0; page < 3; page++) {
        const expr = `window.__bridge.getComments('${escapeExpression(String(awemeId))}', ${cursor}, 20)`;
        const data = await ctx.loggedCall('auto_campaign_verify', { aweme_id: awemeId, cursor }, expr);
        comments.push(...(data?.comments || []));
        if (!data?.has_more) break;
        cursor = data.cursor || cursor + 20;
      }
      const exact = comments.filter(comment => {
        const created = Number(comment.create_time || comment.time || 0);
        const createdMs = created > 1e12 ? created : created * 1000;
        const uidMatches = String(comment.user?.uid || comment.user?.uid_str || '') === String(accountUid);
        return uidMatches && comment.text === text && (!since || createdMs >= since - 120000);
      });
      if (exact.length === 1) return { verified: true, commentId: exact[0].cid };
      return { verified: false, conclusive: false, matches: exact.length };
    },
  };
}

module.exports = { createDouyinAdapter };
