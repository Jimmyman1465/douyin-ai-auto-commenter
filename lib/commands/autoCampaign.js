const fs = require('fs');
const path = require('path');
const { getFlag } = require('./helpers');
const { loadConfig, configSummary } = require('../auto-campaign/config');
const repository = require('../auto-campaign/repository');
const { createDouyinAdapter } = require('../auto-campaign/adapters');
const { runCampaign, resumeCampaign } = require('../auto-campaign/orchestrator');
const { buildReport, toMarkdown } = require('../auto-campaign/reporter');

function configPath(args) {
  const file = getFlag(args, '--config', null);
  if (!file) throw new Error('缺少 --config <path>');
  return path.resolve(String(file));
}

function runId(args) {
  if (args.includes('--latest')) return repository.latestRun()?.id;
  return args.find(value => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value))) || null;
}

function loadCampaignConfig(args, options) {
  try {
    return loadConfig(configPath(args), options);
  } catch (error) {
    if (!error.exitCode) error.exitCode = 2;
    throw error;
  }
}

function applyRunExitCode(report) {
  const reason = report.run.stopReason || '';
  const errorCodes = report.jobs.map(job => job.error_code).filter(Boolean);
  let code = 0;
  if (reason === 'circuit_breaker') code = 5;
  else if (reason === 'CONTRACT_CHANGED' || errorCodes.includes('CONTRACT_CHANGED')) code = 4;
  else if (report.stats.unknown > 0 || report.stats.blocked > 0 || report.stats.sending > 0 || report.run.status === 'blocked') code = 3;
  else if (report.run.status === 'failed') code = 10;
  if (code) process.exitCode = code;
  return report;
}

async function executeCampaign(operation) {
  try {
    return applyRunExitCode(await operation());
  } catch (error) {
    if (!error.exitCode) {
      if (/CONTRACT_CHANGED/.test(error.message)) error.exitCode = 4;
      else if (/不可自动恢复/.test(error.message)) error.exitCode = 3;
      else error.exitCode = 10;
    }
    throw error;
  }
}

async function cmdAutoCampaign(ctx, args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'validate') {
    return configSummary(loadCampaignConfig(rest, { dryRun: rest.includes('--dry-run') ? true : undefined }));
  }
  if (sub === 'run') {
    const cfg = loadCampaignConfig(rest, { dryRun: rest.includes('--dry-run') ? true : undefined });
    return executeCampaign(() => runCampaign(cfg, createDouyinAdapter(ctx), { audit: ctx.audit }));
  }
  if (sub === 'status') {
    const id = runId(rest);
    if (!id) throw new Error('找不到运行；使用 status --latest 或 status <run_id>');
    return buildReport(id);
  }
  if (sub === 'stop') {
    const id = runId(rest);
    if (!id) throw new Error('用法: auto-campaign stop <run_id>');
    return repository.requestStop(id);
  }
  if (sub === 'resume') {
    const id = runId(rest);
    if (!id) throw new Error('用法: auto-campaign resume <run_id> --config <path>');
    const existing = repository.getRun(id);
    if (existing?.dryRun) {
      const error = new Error('dry-run 运行不可恢复为正式发送；请新建正式运行');
      error.exitCode = 2;
      throw error;
    }
    const cfg = loadCampaignConfig(rest, { dryRun: false });
    return executeCampaign(() => resumeCampaign(id, cfg, createDouyinAdapter(ctx)));
  }
  if (sub === 'report') {
    const id = runId(rest);
    if (!id) throw new Error('用法: auto-campaign report --latest|<run_id> [--markdown] [--out path]');
    const report = buildReport(id);
    const output = rest.includes('--markdown') ? toMarkdown(report) : JSON.stringify(report, null, 2);
    const out = getFlag(rest, '--out', null);
    if (out) {
      const target = path.resolve(String(out));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, output, 'utf8');
      return { run_id: id, output: target };
    }
    return rest.includes('--markdown') ? { markdown: output } : report;
  }
  throw new Error('用法: auto-campaign <validate|run|status|stop|resume|report>');
}

module.exports = cmdAutoCampaign;
module.exports.applyRunExitCode = applyRunExitCode;
