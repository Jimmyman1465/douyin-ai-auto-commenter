// lib/commands/dedup.js — 检查一段文本是否曾经发过（v3 P3）
//
// 用法：
//   node cli.js dedup "<候选回复文本>"
//
// 返回：{ duplicate: bool, match: { id, replyText, postedAt, awemeId } | null }
// 退出码：duplicate=true → exit 1（方便脚本判断），由 cli.js 主入口根据 result 处理；
// 这里只返回结构化结果。

const corpus = require('../memory/corpus');

async function cmdDedup(ctx, args) {
  const text = args[0];
  if (!text) throw new Error('用法: node cli.js dedup "<候选回复文本>"');

  ctx.audit.startOperation('dedup', { text_len: text.length });
  const match = corpus.findByText(text);
  const out = {
    duplicate: !!match,
    text,
    match: match ? {
      id: match.id,
      reply_text: match.replyText,
      posted_at: match.postedAt ? new Date(match.postedAt).toISOString() : null,
      aweme_id: match.awemeId,
      outcome: match.outcome,
    } : null,
  };
  ctx.audit.endOperation('success', { duplicate: out.duplicate }, null);
  return out;
}

module.exports = cmdDedup;
