const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({
  config_schema_version: 1,
  filters: {
    include_terms: [],
    exclude_terms: [],
    excluded_author_ids: [],
    max_video_age_days: 7,
    min_comment_count: 0,
    min_like_count: 0,
    relevance_threshold: 0.7,
    use_llm_for_borderline: false,
  },
  limits: {
    max_candidates_per_keyword: 20,
    max_send_per_run: 10,
    max_send_per_day: 20,
    run_timeout_minutes: 60,
    min_interval_seconds: 60,
    max_interval_seconds: 75,
    bridge_batch_size: 5,
    max_attempts: 2,
    max_consecutive_failures: 3,
  },
  runtime: {
    dry_run: true,
    stop_on_auth_error: true,
    stop_on_challenge: true,
  },
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isForbiddenCharacter(char) {
  const codePoint = char.codePointAt(0);
  return codePoint <= 8
    || (codePoint >= 11 && codePoint <= 12)
    || (codePoint >= 14 && codePoint <= 31)
    || codePoint === 127
    || (codePoint >= 0x200b && codePoint <= 0x200f)
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || codePoint === 0x2060
    || codePoint === 0xfeff;
}

function assertText(name, value, options = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} 必须是非空字符串`);
  }
  if ([...value].some(isForbiddenCharacter)) {
    throw new Error(`${name} 含有控制字符或不可见格式字符`);
  }
  if (options.max && value.length > options.max) {
    throw new Error(`${name} 不能超过 ${options.max} 个字符`);
  }
  return value.trim();
}

function boundedInt(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function validateStringArray(name, value) {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是字符串数组`);
  return value.map((item, index) => assertText(`${name}[${index}]`, item));
}

function validateConfig(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('配置必须是 JSON 对象');
  }

  const config = {
    ...DEFAULTS,
    ...input,
    filters: { ...DEFAULTS.filters, ...(input.filters || {}) },
    limits: { ...DEFAULTS.limits, ...(input.limits || {}) },
    runtime: { ...DEFAULTS.runtime, ...(input.runtime || {}) },
  };
  if (input.limits?.max_interval_seconds == null
      && config.limits.min_interval_seconds > config.limits.max_interval_seconds) {
    config.limits.max_interval_seconds = config.limits.min_interval_seconds;
  }
  if (options.dryRun != null) config.runtime.dry_run = Boolean(options.dryRun);

  if (config.config_schema_version !== 1) {
    throw new Error('仅支持 config_schema_version=1');
  }

  config.campaign_name = assertText('campaign_name', config.campaign_name);
  config.account_alias = assertText('account_alias', config.account_alias);
  config.account_uid = typeof config.account_uid === 'string' ? config.account_uid.trim() : '';
  config.fixed_comment = assertText('fixed_comment', config.fixed_comment, { max: 500 });
  config.comment_version = assertText('comment_version', config.comment_version);
  config.keywords = validateStringArray('keywords', config.keywords);
  if (!config.keywords.length) throw new Error('keywords 至少需要一个关键词');
  config.filters.include_terms = validateStringArray('filters.include_terms', config.filters.include_terms);
  config.filters.exclude_terms = validateStringArray('filters.exclude_terms', config.filters.exclude_terms);
  config.filters.excluded_author_ids = validateStringArray(
    'filters.excluded_author_ids',
    config.filters.excluded_author_ids,
  );

  const f = config.filters;
  boundedInt('filters.max_video_age_days', f.max_video_age_days, 0, 3650);
  boundedInt('filters.min_comment_count', f.min_comment_count, 0, 1_000_000_000);
  boundedInt('filters.min_like_count', f.min_like_count, 0, 1_000_000_000);
  if (typeof f.relevance_threshold !== 'number' || f.relevance_threshold < 0 || f.relevance_threshold > 1) {
    throw new Error('filters.relevance_threshold 必须在 0 到 1 之间');
  }
  if (f.use_llm_for_borderline !== false) {
    throw new Error('filters.use_llm_for_borderline 暂未实现，请设为 false');
  }

  const l = config.limits;
  boundedInt('limits.max_candidates_per_keyword', l.max_candidates_per_keyword, 1, 100);
  boundedInt('limits.max_send_per_run', l.max_send_per_run, 1, 1000);
  boundedInt('limits.max_send_per_day', l.max_send_per_day, 1, 10000);
  boundedInt('limits.run_timeout_minutes', l.run_timeout_minutes, 1, 1440);
  boundedInt('limits.min_interval_seconds', l.min_interval_seconds, 1, 86400);
  boundedInt('limits.max_interval_seconds', l.max_interval_seconds, l.min_interval_seconds, 86400);
  boundedInt('limits.bridge_batch_size', l.bridge_batch_size, 1, 10);
  boundedInt('limits.max_attempts', l.max_attempts, 1, 10);
  boundedInt('limits.max_consecutive_failures', l.max_consecutive_failures, 1, 100);

  config.runtime.dry_run = Boolean(config.runtime.dry_run);
  config.runtime.stop_on_auth_error = Boolean(config.runtime.stop_on_auth_error);
  config.runtime.stop_on_challenge = Boolean(config.runtime.stop_on_challenge);
  if (!config.runtime.dry_run) {
    config.account_uid = assertText('account_uid', config.account_uid);
  }

  config.content_hash = sha256(`${config.comment_version}\n${config.fixed_comment}`);
  config.config_hash = sha256(JSON.stringify(stable({
    ...config,
    content_hash: undefined,
    config_hash: undefined,
  })));
  return config;
}

function loadConfig(filePath, options = {}) {
  const absolutePath = path.resolve(filePath);
  const input = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  return validateConfig(input, options);
}

function configSummary(config) {
  return {
    config_schema_version: config.config_schema_version,
    campaign_name: config.campaign_name,
    account_alias: config.account_alias,
    account_uid: config.account_uid || null,
    keywords: config.keywords,
    filters: config.filters,
    limits: config.limits,
    runtime: config.runtime,
    fixed_comment: {
      version: config.comment_version,
      length: config.fixed_comment.length,
      sha256: config.content_hash,
    },
    config_hash: config.config_hash,
  };
}

module.exports = {
  DEFAULTS,
  configSummary,
  loadConfig,
  sha256,
  validateConfig,
};
