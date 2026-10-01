import { describe, it, expect } from 'bun:test';
import { MeepoOrchestrator } from '../src/orchestrator';
import {
  createMeepoProviderConfig,
  getMeepoModels,
  MEEPO_API_NAME,
  MEEPO_PROVIDER_ID,
  pruneTranscriptForRole,
} from '../src/provider';
import { normalizeContext, getCurrentTools } from '@earendil-works/pi-ai';
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

  it('registers Meepo as a first-class Model Provider for Pi', () => {
    const orchestrator = new MeepoOrchestrator();
    const models = getMeepoModels(orchestrator);
    const providerConfig = createMeepoProviderConfig(orchestrator);

    expect(providerConfig.name).toBe('Meepo');
    expect(providerConfig.api).toBe(MEEPO_API_NAME);
    expect(providerConfig.apiKey).toBe('meepo-mesh-local');
    expect(typeof providerConfig.streamSimple).toBe('function');

    // 5 registered models
    expect(models.length).toBe(5);
    const modelIds = models.map((m) => m.id);
    expect(modelIds).toEqual(['mesh', 'chat', 'tools', 'code', 'cloud']);

    const meshModel = models.find((m) => m.id === 'mesh');
    expect(meshModel?.reasoning).toBe(true);
    expect(meshModel?.contextWindow).toBe(131072);
  });

  it('dynamically prunes tool schemas on the system message per role', () => {
    const rawContext = normalizeContext({
      systemPrompt: 'You are an autonomous AI coding agent operating inside Pi.',
      tools: [
        { name: 'bash', description: 'Run shell commands', parameters: {} as any },
        { name: 'read', description: 'Read file contents', parameters: {} as any },
        { name: 'write', description: 'Write file contents', parameters: {} as any },
        { name: 'edit', description: 'Edit file ranges', parameters: {} as any },
        { name: 'web_search', description: 'Search the public web', parameters: {} as any },
        { name: 'lsp_hover', description: 'Query type hover', parameters: {} as any },
        { name: 'undo_last_edit', description: 'Undo edit', parameters: {} as any },
        { name: 'ask', description: 'Ask user clarification', parameters: {} as any },
      ],
      messages: [{ role: 'user', content: 'Tell me a story about an earthbender.', timestamp: Date.now() }],
    });

    expect(getCurrentTools(rawContext.messages).length).toBe(8);

    // Prune for chat role: only conversational tools should remain
    const chatPruned = pruneTranscriptForRole(rawContext, ['web_search', 'ask', 'read']);
    const chatTools = getCurrentTools(chatPruned.messages).map((t) => t.name);

    expect(chatTools).toEqual(['read', 'web_search', 'ask']);
    expect(chatTools).not.toContain('bash');
    expect(chatTools).not.toContain('edit');
    expect(chatTools).not.toContain('write');

    // Prune for tools role: only ops tools should remain
    const toolsPruned = pruneTranscriptForRole(rawContext, ['bash', 'read', 'write', 'edit', 'undo_last_edit']);
    const operationalTools = getCurrentTools(toolsPruned.messages).map((t) => t.name);

    expect(operationalTools).toEqual(['bash', 'read', 'write', 'edit', 'undo_last_edit']);
    expect(operationalTools).not.toContain('web_search');
  });
});
