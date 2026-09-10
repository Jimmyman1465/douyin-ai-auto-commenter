const path = require('path');
const { getFlag } = require('./helpers');
const { loadConfig, configSummary } = require('../auto-campaign/config');
const { createDouyinAdapter } = require('../auto-campaign/adapters');
const { resumeCampaign } = require('../auto-campaign/orchestrator');
const { buildReport } = require('../auto-campaign/reporter');
const repository = require('../auto-campaign/repository');
const { applyRunExitCode } = require('./autoCampaign');
const { readInput, resolveInputText } = require('../quick-comment/input-parser');
const { runQuickComment } = require('../quick-comment/orchestrator');

function requiredFlag(args, name) {
  const value = getFlag(args, name, null);
  if (!value) throw new Error(`缺少 ${name} <path>`);
  return String(value);
}

function loadQuickConfig(args, dryRun) {
  try {
    return loadConfig(path.resolve(requiredFlag(args, '--config')), { dryRun });
  } catch (error) {
    if (!error.exitCode) error.exitCode = 2;
    throw error;
  }
}

function findRunId(args) {
  if (args.includes('--latest')) return repository.latestRun()?.id || null;
  return args.find(value => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value))) || null;
}

async function loadTargets(args) {
  const value = requiredFlag(args, '--input');
  const input = value === '-' ? '-' : path.resolve(value);
  return resolveInputText(readInput(input));
}

async function execute(operation) {
  try {
    return applyRunExitCode(await operation());
  } catch (error) {
    if (!error.exitCode) error.exitCode = 10;
    throw error;
  }
}

async function cmdQuickComment(ctx, args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (rest.includes('--live') && rest.includes('--dry-run')) {
    const error = new Error('--live 与 --dry-run 不能同时使用');
    error.exitCode = 2;
    throw error;
  }
  if (sub === 'validate') {
    const cfg = loadQuickConfig(rest, true);
    const targets = await loadTargets(rest);
    return { config: configSummary(cfg), target_count: targets.length, targets };
  }
  if (sub === 'run') {
    const live = rest.includes('--live');
    const cfg = loadQuickConfig(rest, !live);
    const targets = await loadTargets(rest);
    return execute(() => runQuickComment(cfg, targets, createDouyinAdapter(ctx), { audit: ctx.audit }));
  }
  if (sub === 'resume') {
    const id = findRunId(rest);
    if (!id) throw new Error('用法: quick-comment resume <run_id> --config <path>');
    const cfg = loadQuickConfig(rest, false);
    return execute(() => resumeCampaign(id, cfg, createDouyinAdapter(ctx)));
  }
  if (sub === 'status') {
    const id = findRunId(rest);
    if (!id) throw new Error('找不到运行；使用 status --latest 或 status <run_id>');
    return buildReport(id);
  }
  throw new Error('用法: quick-comment <validate|run|resume|status>');
}

module.exports = cmdQuickComment;
