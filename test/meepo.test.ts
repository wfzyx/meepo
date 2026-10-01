import { describe, it, expect } from 'bun:test';
import { MeepoOrchestrator } from '../src/orchestrator';
import { MeepoRouter } from '../src/router';
import { MeepoMeshClient } from '../src/client';

describe('Meepo Multi-Brain Orchestrator', () => {
  it('loads valid configuration scaffold', () => {
    const orchestrator = new MeepoOrchestrator();
    const config = orchestrator.getConfig();

    expect(config.name).toBe('meepo');
    expect(config.roles.gate.name).toBe('von-1.0');
    expect(config.roles.frontman.name).toBe('gemma-4-E2B-it');
    expect(config.roles.hands.name).toBe('LFM2.5-1.2B-Instruct');
    expect(config.roles.code_engine.name).toBe('Qwen3.5-2B');
    expect(config.roles.oracle.name).toBe('claude-opus-5-5');
    expect(config.roles.oracle.enabled).toBe(true);
  });

  it('routes intent using heuristic fallback when offline', async () => {
    const orchestrator = new MeepoOrchestrator();
    const allTools = ['bash', 'read', 'write', 'edit', 'web_search', 'meepo_ask_oracle'];

    // Conversational question -> Frontman
    const resChat = await orchestrator.routeTurn('What is the weather today in Tokyo?', allTools);
    expect(resChat.targetRole).toBe('frontman');
    expect(resChat.allowedTools).toContain('web_search');
    expect(resChat.prunedTools).toContain('bash');

    // Code refactor -> Code Engine
    const resCode = await orchestrator.routeTurn('Refactor this TypeScript function to sort items faster', allTools);
    expect(resCode.targetRole).toBe('code_engine');
    expect(resCode.allowedTools).toContain('edit');

    // Terminal command -> Hands
    const resOps = await orchestrator.routeTurn('run ps aux and kill process', allTools);
    expect(resOps.targetRole).toBe('hands');
    expect(resOps.allowedTools).toContain('bash');

    // Deadlock / Architecture -> Oracle
    const resOracle = await orchestrator.routeTurn('We have a concurrency deadlock between two mutexes', allTools);
    expect(resOracle.targetRole).toBe('oracle');
    expect(resOracle.allowedTools).toContain('meepo_ask_oracle');
  });

  it('generates a clean status dashboard', async () => {
    const orchestrator = new MeepoOrchestrator();
    const dashboard = await orchestrator.formatStatusDashboard();

    expect(dashboard).toContain('MEEPO: DIVIDED WE STAND');
    expect(dashboard).toContain('GATE / SYSTEM 1');
    expect(dashboard).toContain('FRONTMAN');
    expect(dashboard).toContain('HANDS / OPS');
    expect(dashboard).toContain('CODE ENGINE');
    expect(dashboard).toContain('ORACLE (CLOUD)');
  });
});
