const repository = require('./repository');

function buildReport(runId) {
  const run = repository.getRun(runId);
  if (!run) throw new Error(`运行不存在: ${runId}`);
  const jobs = repository.listJobs(runId);
  const stats = repository.countStatuses(runId);
  return {
    run,
    stats,
    jobs: jobs.map(job => ({
      id: job.id,
      aweme_id: job.awemeId,
      status: job.status,
      attempts: job.attempts,
      platform_comment_id: job.platformCommentId,
      error_code: job.errorCode,
      error_message: job.errorMessage,
    })),
  };
}

function toMarkdown(report) {
  const lines = [
    `# 自动评论运行报告`,
    '',
    `- 运行 ID: ${report.run.id}`,
    `- 活动: ${report.run.campaignName}`,
    `- 状态: ${report.run.status}`,
    `- dry-run: ${report.run.dryRun}`,
    `- 停止原因: ${report.run.stopReason || '无'}`,
    '',
    '| 状态 | 数量 |',
    '|---|---:|',
  ];
  for (const [key, value] of Object.entries(report.stats)) lines.push(`| ${key} | ${value} |`);
  return lines.join('\n');
}

module.exports = { buildReport, toMarkdown };
