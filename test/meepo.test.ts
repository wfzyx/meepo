import { describe, it, expect } from 'bun:test';
import { MeepoOrchestrator } from '../src/orchestrator';

describe('Meepo Multi-Brain Orchestrator (Scheme 1: router, chat, tools, code, cloud)', () => {
  it('loads valid configuration scaffold with Scheme 1 roles', () => {
    const orchestrator = new MeepoOrchestrator();
    const config = orchestrator.getConfig();

    expect(config.name).toBe('meepo');
    expect(config.roles.router.name).toBe('von-1.3.5');
    expect(config.roles.chat.name).toBe('gemma-4-E2B-it');
    expect(config.roles.tools.name).toBe('LFM2.5-1.2B-Instruct');
    expect(config.roles.code.name).toBe('Qwen3.5-2B');
    expect(config.roles.cloud.name).toBe('claude-opus-5-5');
    expect(config.roles.cloud.enabled).toBe(true);
  });

  it('routes intent using Scheme 1 roles and dynamic tool pruning', async () => {
    const orchestrator = new MeepoOrchestrator();
    const allTools = ['bash', 'read', 'write', 'edit', 'web_search', 'meepo_ask_cloud'];

    // 1. Conversational question -> chat
    const resChat = await orchestrator.routeTurn('What is the weather today in Tokyo?', allTools);
    expect(resChat.targetRole).toBe('chat');
    expect(resChat.allowedTools).toContain('web_search');
    expect(resChat.prunedTools).toContain('bash');

    // 2. Code refactor -> code
    const resCode = await orchestrator.routeTurn('Refactor this TypeScript function to sort items faster', allTools);
    expect(resCode.targetRole).toBe('code');
    expect(resCode.allowedTools).toContain('edit');

    // 3. Terminal command -> tools
    const resOps = await orchestrator.routeTurn('run ps aux and kill process', allTools);
    expect(resOps.targetRole).toBe('tools');
    expect(resOps.allowedTools).toContain('bash');

    // 4. Deadlock / Architecture -> cloud
    const resCloud = await orchestrator.routeTurn('We have a concurrency deadlock between two mutexes', allTools);
    expect(resCloud.targetRole).toBe('cloud');
    expect(resCloud.allowedTools).toContain('meepo_ask_cloud');
  });

  it('generates a clean status dashboard with Scheme 1 headings', async () => {
    const orchestrator = new MeepoOrchestrator();
    const dashboard = await orchestrator.formatStatusDashboard();

    expect(dashboard).toContain('MEEPO: DIVIDED WE STAND');
    expect(dashboard).toContain('ROUTER');
    expect(dashboard).toContain('CHAT');
    expect(dashboard).toContain('TOOLS');
    expect(dashboard).toContain('CODE');
    expect(dashboard).toContain('CLOUD');
  });
});
