import { describe, expect, it } from 'bun:test';
import { MeepoOrchestrator } from '../src/orchestrator';
import { MultiStepWorkflowRunner } from '../src/benchmark/workflow';

describe('Multi-Step Agentic Workflow Stress Test', () => {
  it('measures the systemic intelligence lever across 5 dependent stages', async () => {
    const orchestrator = new MeepoOrchestrator();
    const runner = new MultiStepWorkflowRunner(orchestrator);

    const summaries = await runner.runCohortBenchmark(5, { mock: true });

    // Validate targets
    expect(summaries['mesh']).toBeDefined();
    expect(summaries['qwen-solo']).toBeDefined();
    expect(summaries['lfm-solo']).toBeDefined();
    expect(summaries['gemma-solo']).toBeDefined();

    // Validate that Mesh out-survives solo models
    const meshSurvival = summaries['mesh'].survivalRatePercent;
    const qwenSurvival = summaries['qwen-solo'].survivalRatePercent;
    const lfmSurvival = summaries['lfm-solo'].survivalRatePercent;
    const gemmaSurvival = summaries['gemma-solo'].survivalRatePercent;

    expect(meshSurvival).toBeGreaterThan(qwenSurvival);
    expect(meshSurvival).toBeGreaterThan(lfmSurvival);
    expect(meshSurvival).toBeGreaterThan(gemmaSurvival);

    // Validate token efficiency
    expect(summaries['mesh'].avgTokensPerCompletedWorkflow).toBeLessThan(
      summaries['qwen-solo'].avgTokensPerCompletedWorkflow
    );

    // Validate report formatting
    const report = runner.formatWorkflowReport(summaries);
    expect(report).toContain('MULTI-STEP AGENTIC WORKFLOW STRESS TEST');
    expect(report).toContain('Meepo Multi-Brain Mesh');
    expect(report).toContain('THE SYSTEMIC INTELLIGENCE LEVER');
    expect(report).toContain('End-to-End Task Survival');
  });
});
