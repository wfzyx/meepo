import { describe, expect, it } from 'bun:test';
import { MeepoOrchestrator } from '../src/orchestrator';
import { ArtificialAnalysisBenchmarkRunner } from '../src/benchmark/runner';
import { BENCHMARK_TASKS } from '../src/benchmark/tasks';
import type { MeshBenchmarkComparison } from '../src/benchmark/types';

describe('Artificial Analysis Intelligence Index Benchmark', () => {
  it('defines a standardized task dataset across the 4 Artificial Analysis categories', () => {
    expect(BENCHMARK_TASKS.length).toBeGreaterThanOrEqual(8);

    const categories = new Set(BENCHMARK_TASKS.map((t) => t.category));
    expect(categories.has('agentic')).toBe(true);
    expect(categories.has('coding')).toBe(true);
    expect(categories.has('reasoning')).toBe(true);
    expect(categories.has('synthesis')).toBe(true);

    for (const task of BENCHMARK_TASKS) {
      expect(task.id).toBeDefined();
      expect(task.prompt.length).toBeGreaterThan(10);
      expect(typeof task.validate).toBe('function');
    }
  });

  it('runs the benchmark and compares Meepo Mesh against composing brains', async () => {
    const orchestrator = new MeepoOrchestrator();
    const runner = new ArtificialAnalysisBenchmarkRunner(orchestrator);

    // Run quick benchmark across all components
    const comparison: MeshBenchmarkComparison = await runner.runBenchmark({ quick: true, mock: true });

    // Validate comparison structure
    expect(comparison.mesh).toBeDefined();
    expect(comparison.mesh.role).toBe('mesh');
    expect(comparison.mesh.intelligenceIndex).toBeGreaterThan(0);
    expect(comparison.mesh.categoryScores.agentic).toBeDefined();
    expect(comparison.mesh.categoryScores.coding).toBeDefined();
    expect(comparison.mesh.categoryScores.reasoning).toBeDefined();
    expect(comparison.mesh.categoryScores.synthesis).toBeDefined();

    // Validate composing components are present
    expect(comparison.components.router).toBeDefined();
    expect(comparison.components.chat).toBeDefined();
    expect(comparison.components.tools).toBeDefined();
    expect(comparison.components.code).toBeDefined();

    // Validate Turn 1 prompt diet / prefill reduction
    expect(comparison.analysis.prefillReductionPercent).toBeGreaterThanOrEqual(50);
    expect(comparison.mesh.avgPrefillTokens).toBeLessThan(comparison.components.code.avgPrefillTokens);

    // Validate Artificial Analysis composite index calculation formula
    const expectedComposite = Math.round(
      comparison.mesh.categoryScores.agentic * 0.30 +
      comparison.mesh.categoryScores.synthesis * 0.30 +
      comparison.mesh.categoryScores.coding * 0.20 +
      comparison.mesh.categoryScores.reasoning * 0.20
    );
    expect(comparison.mesh.intelligenceIndex).toBe(expectedComposite);
  }, 60000);

  it('generates a clean ASCII leaderboard report matching Artificial Analysis format', async () => {
    const orchestrator = new MeepoOrchestrator();
    const runner = new ArtificialAnalysisBenchmarkRunner(orchestrator);
    const comparison = await runner.runBenchmark({ quick: true, mock: true });

    const table = runner.formatLeaderboardTable(comparison);
    expect(table).toContain('ARTIFICIAL ANALYSIS INTELLIGENCE INDEX');
    expect(table).toContain('meepo-mesh (mesh)');
    expect(table).toContain('Agentic (30%)');
    expect(table).toContain('Coding (20%)');
    expect(table).toContain('Reason (20%)');
    expect(table).toContain('Synth (30%)');
    expect(table).toContain('MEESH ADVANTAGE ANALYSIS');
    expect(table).toContain('Cost Saved (Cache Hits)');
    expect(comparison.analysis.costReductionPercent).toBeGreaterThanOrEqual(90);
  }, 60000);
});
