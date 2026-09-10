function normalizeCandidate(raw, sourceKeyword) {
  const info = raw?.aweme_info || raw || {};
  const stats = info.statistics || {};
  return {
    awemeId: String(info.aweme_id || info.awemeId || ''),
    description: String(info.desc || info.description || ''),
    authorId: String(info.author?.uid || info.author_id || info.uid || ''),
    authorName: String(info.author?.nickname || info.author || ''),
    publishedAt: Number(info.create_time || info.published_at || info.time || 0),
    likeCount: Number(stats.digg_count ?? info.like_count ?? info.likes ?? 0),
    commentCount: Number(stats.comment_count ?? info.comment_count ?? 0),
    sourceKeyword,
  };
}

function includesTerm(text, terms) {
  const haystack = text.toLocaleLowerCase();
  return terms.some(term => haystack.includes(String(term).toLocaleLowerCase()));
}

function scoreCandidate(candidate, cfg, now = Date.now()) {
  if (!candidate.awemeId || !candidate.description) {
    return { decision: 'skipped', score: 0, reason: 'missing_required_fields' };
  }
  const text = `${candidate.description} ${candidate.authorName}`;
  if (cfg.filters.excluded_author_ids.includes(candidate.authorId)) {
    return { decision: 'skipped', score: 0, reason: 'excluded_author' };
  }
  if (includesTerm(text, cfg.filters.exclude_terms)) {
    return { decision: 'skipped', score: 0, reason: 'excluded_term' };
  }
  const publishedMs = candidate.publishedAt > 1e12
    ? candidate.publishedAt
    : candidate.publishedAt * 1000;
  if (cfg.filters.max_video_age_days > 0 &&
      (!publishedMs || now - publishedMs > cfg.filters.max_video_age_days * 86400000)) {
    return { decision: 'skipped', score: 0, reason: 'too_old' };
  }
  if (candidate.commentCount < cfg.filters.min_comment_count) {
    return { decision: 'skipped', score: 0, reason: 'comment_count_below_min' };
  }
  if (candidate.likeCount < cfg.filters.min_like_count) {
    return { decision: 'skipped', score: 0, reason: 'like_count_below_min' };
  }
  const terms = [...new Set([...cfg.keywords, ...cfg.filters.include_terms].map(term => String(term).toLocaleLowerCase()))];
  const matched = terms.filter(term => includesTerm(text, [term]));
  if (!matched.length) return { decision: 'skipped', score: 0, reason: 'no_relevant_term' };
  const score = matched.length ? Math.min(1, 0.7 + (matched.length - 1) * 0.1) : 0;
  return score >= cfg.filters.relevance_threshold
    ? { decision: 'accepted', score, reason: `matched:${matched.join(',')}` }
    : { decision: 'skipped', score, reason: matched.length ? 'score_below_threshold' : 'no_relevant_term' };
}

function dedupeCandidates(groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const raw of group.items || []) {
      const item = normalizeCandidate(raw, group.keyword);
      if (!item.awemeId) continue;
      const old = byId.get(item.awemeId);
      if (!old) byId.set(item.awemeId, item);
      else if (!old.description && item.description) byId.set(item.awemeId, { ...old, ...item });
    }
  }
  return [...byId.values()];
}

module.exports = { normalizeCandidate, scoreCandidate, dedupeCandidates };
