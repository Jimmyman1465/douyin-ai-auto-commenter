const { REQUIRED_TAIL, generateContentAwareComment } = require('../lib/quick-comment/content-aware');

describe('content-aware top-level comments', () => {
  it('always includes the required campaign sentence exactly once', () => {
    const text = generateContentAwareComment({ title: 'Codex 零基础安装教程' });
    expect(text.split(REQUIRED_TAIL)).toHaveLength(2);
    expect(text.endsWith(REQUIRED_TAIL)).toBe(true);
  });

  it('uses different topic-aware leads for different videos', () => {
    const codex = generateContentAwareComment({ title: 'Codex 从安装到使用教程' });
    const knowledge = generateContentAwareComment({ title: '四步搭建 AI 知识库' });
    const workflow = generateContentAwareComment({ title: 'AI 工作流效率提升' });
    expect(codex).toContain('Codex');
    expect(knowledge).toContain('知识库');
    expect(workflow).toContain('工作流');
    expect(new Set([codex, knowledge, workflow]).size).toBe(3);
  });

  it('normalizes unsafe whitespace and respects the configured length', () => {
    const text = generateContentAwareComment({
      title: 'AI\n教程\u0000小白入门',
      requiredTail: REQUIRED_TAIL,
      maxLength: 90,
    });
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(text.length).toBeLessThanOrEqual(90);
    expect(text.endsWith(REQUIRED_TAIL)).toBe(true);
  });
});
