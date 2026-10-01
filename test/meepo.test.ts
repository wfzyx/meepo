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

  it('validates that Von/router explicitly strips MCP tool schemas to protect prefill latency', async () => {
    const orchestrator = new MeepoOrchestrator();

    // Context flooded with 10 MCP tools + core tools
    const toolsWithMcp = [
      'bash',
      'read',
      'write',
      'edit',
      'mcp__filesystem__read_file',
      'mcp__filesystem__write_file',
      'mcp__github__create_issue',
      'mcp__github__list_commits',
      'mcp__cloudflare__list_zones',
      'mcp__cloudflare__deploy_worker',
      'mcp__slack__post_message',
      'mcpScript',
      'mcp',
      'web_search',
    ];

    // 1. Triage a conversational prompt -> chat role
    const chatDecision = await orchestrator.routeTurn('Explain how recurrent matrix state works in RWKV-7', toolsWithMcp);
    expect(chatDecision.targetRole).toBe('chat');
    expect(chatDecision.mcpStripped?.length).toBeGreaterThan(0);
    expect(chatDecision.mcpStripped).toContain('mcp__filesystem__read_file');
    expect(chatDecision.mcpStripped).toContain('mcp__github__create_issue');
    expect(chatDecision.mcpStripped).toContain('mcpScript');
    expect(chatDecision.mcpStripped).toContain('mcp');
    expect(chatDecision.allowedTools).not.toContain('mcp__github__create_issue');
    expect(chatDecision.tokensSavedEstimate).toBeGreaterThanOrEqual(3500); // 10+ pruned schemas saved ~3500+ tokens

    // 2. Triage a code prompt -> code role
    const codeDecision = await orchestrator.routeTurn('Implement an OptionMarker parser in TypeScript', toolsWithMcp);
    expect(codeDecision.targetRole).toBe('code');
    expect(codeDecision.mcpStripped).toContain('mcp__cloudflare__deploy_worker');
    expect(codeDecision.allowedTools).not.toContain('mcp__cloudflare__deploy_worker');
    expect(codeDecision.allowedTools).toContain('edit');

    // 3. Triage an operational prompt -> tools role
    const toolsDecision = await orchestrator.routeTurn('run bash command ps aux and check disk usage', toolsWithMcp);
    expect(toolsDecision.targetRole).toBe('tools');
    expect(toolsDecision.mcpStripped).toContain('mcp__slack__post_message');
    expect(toolsDecision.allowedTools).not.toContain('mcp__slack__post_message');
    expect(toolsDecision.allowedTools).toContain('bash');
  });

  it('converts messy user input into structured commands for Qwen (code) and LFM (tools) via Gemma', async () => {
    const orchestrator = new MeepoOrchestrator();

    const userPrompt = 'Run the test suite, find why the auth token refresh failed, and fix the race condition in src/auth.ts';
    const decomposition = await orchestrator.translatePromptWithGemma(userPrompt);

    expect(decomposition.userGoal.length).toBeGreaterThan(0);
    expect(decomposition.model).toContain('gemma-4-E2B-it');
    expect(decomposition.summary.length).toBeGreaterThan(0);

    // Should generate actionable operational commands for LFM or code spec for Qwen
    const hasTools = Array.isArray(decomposition.commandsForTools) && decomposition.commandsForTools.length > 0;
    const hasCode = typeof decomposition.specForCode === 'string' && decomposition.specForCode.length > 0;
    expect(hasTools || hasCode).toBe(true);
  }, 20000);

  it('summarizes code diffs and tool logs into clean, human-readable prose via Gemma', async () => {
    const orchestrator = new MeepoOrchestrator();

    const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
index e69de29..b614e31 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,4 +10,12 @@
+export class TokenManager {
+  private mutex = new Mutex();
+  public async refreshToken(): Promise<string> {
+    const unlock = await this.mutex.lock();
+    try {
+      return await fetchToken();
+    } finally {
+      unlock();
+    }
+  }
+}`;

    const summaryResult = await orchestrator.summarizeDiffWithGemma({
      goal: 'Eliminate race condition in auth token refresh',
      diff: sampleDiff,
      toolOutput: 'bun test v1.4.2: 4 pass, 0 fail (14ms)',
    });

    expect(summaryResult.model).toContain('gemma-4-E2B-it');
    expect(summaryResult.filesChanged).toContain('src/auth.ts');
    expect(summaryResult.prose.length).toBeGreaterThan(0);
    expect(summaryResult.prose.toLowerCase()).toMatch(/mutex|token|refresh|race/);
    expect(summaryResult.summaryBullets.length).toBeGreaterThan(0);
  }, 20000);
});
