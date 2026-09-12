// 公开仓库只保留通用默认值；个人活动文案通过参数或环境变量提供。
const REQUIRED_TAIL = process.env.DOUYIN_CAMPAIGN_TAIL || '欢迎分享你的实际使用体验。';

function normalize(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chooseLead(text) {
  if (/Codex/i.test(text) && /安装|教程|入门|使用|实操|精通/i.test(text)) {
    return 'Codex从安装到实际使用的步骤梳理得很清楚，适合跟着练一遍。';
  }
  if (/Codex/i.test(text)) {
    return 'Codex把需求拆成可执行任务的思路很实用，真正上手才能感受到效率变化。';
  }
  if (/Claude\s*Code/i.test(text)) {
    return 'Claude Code从基础配置到自动化能力的串联很完整，项目实操这部分尤其有参考价值。';
  }
  if (/Vibe\s*Coding|vibecoding/i.test(text)) {
    return 'Vibe Coding最有价值的是把想法快速做成能运行的东西，这种完整实操对新手很友好。';
  }
  if (/知识库/i.test(text)) {
    return 'AI知识库的关键确实不是堆工具，而是形成能持续积累和复用的闭环。';
  }
  if (/工作流|效率|办公|生产力/i.test(text)) {
    return '把AI落到具体工作流，比单纯比较工具更有价值，这套方法很适合直接照着实践。';
  }
  if (/Agent|智能体/i.test(text)) {
    return '从单次问答走向智能体工作流，真正的变化是任务可以被拆解并持续执行。';
  }
  if (/GPT-?6|AGI|会用工具/i.test(text)) {
    return '模型会主动选择和使用工具之后，AI的价值确实从回答问题走向了完成任务。';
  }
  if (/Gemini/i.test(text)) {
    return 'Gemini放到真实任务里看效果，比只比较参数更有意义，这个使用思路很值得试。';
  }
  if (/ChatGPT|GPT/i.test(text)) {
    return 'ChatGPT真正好用的地方还是把它放进具体场景，方法和提问思路比工具名称更重要。';
  }
  if (/教程|入门|小白|学习/i.test(text)) {
    return '这套AI入门路径讲得很清楚，新手按步骤做一遍会比只收藏更有收获。';
  }
  return '这个AI应用案例讲得很具体，能落到真实任务里的方法才最值得学习。';
}

function generateContentAwareComment(input = {}) {
  const requiredTail = normalize(input.requiredTail || REQUIRED_TAIL);
  if (!requiredTail) throw new Error('requiredTail 不能为空');
  const context = normalize([input.title, input.description].filter(Boolean).join(' '));
  const lead = chooseLead(context);
  const maxLength = Math.max(requiredTail.length + 2, Number(input.maxLength) || 180);
  const room = Math.max(0, maxLength - requiredTail.length - 1);
  const trimmedLead = lead.slice(0, room).replace(/[，。！？；、\s]+$/u, '');
  return `${trimmedLead}${trimmedLead ? '。' : ''}${requiredTail}`.slice(0, maxLength);
}

module.exports = { REQUIRED_TAIL, generateContentAwareComment };
