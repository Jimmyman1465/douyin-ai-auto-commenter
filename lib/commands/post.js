// lib/commands/post.js — 发表评论/回复

const { escapeExpression, getFlag } = require('./helpers');

/**
 * 发表评论或回复
 * @param {object} ctx - { bridge, audit, loggedCall }
 * @param {string[]} args - [aweme_id, text, --reply-to <cid>, --reply-to-reply <rrid>, --at <uid> <sec_uid>]
 */
async function cmdPost(ctx, args) {
  const awemeId = args[0];
  const text = args[1];
  if (!awemeId || !text) throw new Error('用法: node cli.js post <aweme_id> "内容" [--reply-to <cid>]');
  const replyTo = getFlag(args, '--reply-to', null);
  const rrid = getFlag(args, '--reply-to-reply', null);

  // @ 提及支持
  let atUid = null, atSecUid = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--at') { atUid = args[++i]; atSecUid = args[++i]; }
  }

  let mentions = 'null';
  if (atUid && atSecUid) {
    const atPos = text.indexOf('@');
    if (atPos >= 0) {
      let charEnd = atPos + 1;
      while (charEnd < text.length && text[charEnd] !== ' ') charEnd++;
      const byteStart = Buffer.byteLength(text.substring(0, atPos), 'utf8');
      const byteEnd = Buffer.byteLength(text.substring(0, charEnd), 'utf8');
      mentions = JSON.stringify([{
        start: byteStart, end: byteEnd,
        user_id: atUid, sec_uid: atSecUid, type: 0,
      }]);
    }
  }

  ctx.audit.startOperation('post', { aweme_id: awemeId, text, reply_to: replyTo });
  const expr = `window.__bridge.publish('${escapeExpression(awemeId)}', '${escapeExpression(text)}', ${replyTo ? `'${escapeExpression(replyTo)}'` : 'null'}, ${rrid ? `'${escapeExpression(rrid)}'` : 'null'}, ${mentions})`;
  const data = await ctx.loggedCall('post', { aweme_id: awemeId, text }, expr);

  // 检查 status_code（非 0 即为失败）
  if (data.status_code !== undefined && data.status_code !== 0) {
    const err = new Error(`status_code=${data.status_code} — 评论可能被拦截，请更换内容重试`);
    ctx.audit.endOperation('error', { status_code: data.status_code }, null, err.message);
    throw err;
  }

  if (!data.comment) {
    const err = new Error('发布失败 — 服务器未返回评论数据');
    ctx.audit.endOperation('error', {}, null, err.message);
    throw err;
  }

  const result = {
    cid: data.comment?.cid || '',
    text: data.comment?.text || text,
    time: data.comment?.create_time || 0,
    status: 'published',
  };
  ctx.audit.endOperation('success', { cid: result.cid }, { result });
  return result;
}

module.exports = cmdPost;
