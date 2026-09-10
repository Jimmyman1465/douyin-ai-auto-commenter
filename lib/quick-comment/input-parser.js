const fs = require('fs');

const DOUYIN_HOST_RE = /(^|\.)douyin\.com$/i;
const ID_RE = /^\d{5,30}$/;

function trimUrlPunctuation(value) {
  return value.replace(/[，。；、）】}>"']+$/u, '');
}

function candidateFromLine(line) {
  const value = String(line || '').trim();
  if (!value || value.startsWith('#')) return null;
  if (ID_RE.test(value)) return value;
  const url = value.match(/https?:\/\/[^\s]+/iu)?.[0];
  return url ? trimUrlPunctuation(url) : value;
}

function parseDouyinUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error(`不是有效的抖音视频链接或视频 ID: ${value}`);
  }
  if (!DOUYIN_HOST_RE.test(url.hostname)) {
    throw new Error(`仅支持 douyin.com 链接: ${value}`);
  }
  const pathId = url.pathname.match(/\/video\/(\d{5,30})(?:\/|$)/i)?.[1];
  const queryId = url.searchParams.get('aweme_id') || url.searchParams.get('modal_id');
  const awemeId = pathId || (queryId && ID_RE.test(queryId) ? queryId : null);
  return { url, awemeId };
}

function parseDirectTarget(value) {
  const token = candidateFromLine(value);
  if (!token) return null;
  if (ID_RE.test(token)) return { awemeId: token, source: token, resolvedUrl: null };
  const parsed = parseDouyinUrl(token);
  if (!parsed.awemeId) return { awemeId: null, source: token, resolvedUrl: parsed.url.toString() };
  return { awemeId: parsed.awemeId, source: token, resolvedUrl: parsed.url.toString() };
}

async function resolveTarget(value, options = {}) {
  const direct = parseDirectTarget(value);
  if (!direct || direct.awemeId) return direct;
  const start = new URL(direct.resolvedUrl);
  if (!/^v\.douyin\.com$/i.test(start.hostname)) {
    throw new Error(`链接中找不到视频 ID: ${direct.source}`);
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 不支持短链接解析');
  let response;
  try {
    response = await fetchImpl(start.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: options.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
  } catch (error) {
    throw new Error(`短链接解析失败: ${direct.source} (${error.message})`);
  }
  const finalUrl = response?.url || '';
  const resolved = parseDirectTarget(finalUrl);
  if (!resolved?.awemeId) throw new Error(`短链接未解析到视频 ID: ${direct.source}`);
  return { ...resolved, source: direct.source };
}

function parseInputText(text) {
  return String(text || '').split(/\r?\n/).map((line, index) => ({
    line: index + 1,
    value: candidateFromLine(line),
  })).filter(item => item.value);
}

async function resolveInputText(text, options = {}) {
  const parsed = parseInputText(text);
  if (!parsed.length) throw new Error('目标列表为空');
  const out = [];
  const seen = new Set();
  for (const item of parsed) {
    let target;
    try {
      target = await resolveTarget(item.value, options);
    } catch (error) {
      throw new Error(`第 ${item.line} 行: ${error.message}`);
    }
    if (seen.has(target.awemeId)) continue;
    seen.add(target.awemeId);
    out.push(target);
  }
  return out;
}

function readInput(filePath) {
  return filePath === '-'
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(filePath, 'utf8');
}

module.exports = {
  candidateFromLine,
  parseDirectTarget,
  parseInputText,
  readInput,
  resolveInputText,
  resolveTarget,
};
