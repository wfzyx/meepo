#!/usr/bin/env bun
/**
 * CLI Runner for Artificial Analysis Intelligence Index
 * Usage: bun run benchmark [--quick]
 */

import { MeepoOrchestrator } from '../orchestrator';
import { ArtificialAnalysisBenchmarkRunner } from './runner';
import { MultiStepWorkflowRunner } from './workflow';
async function main() {
  const isQuick = process.argv.includes('--quick');
  const isWorkflow = process.argv.includes('--workflow');
  const orchestrator = new MeepoOrchestrator();

  if (isWorkflow) {
    console.log('Starting Multi-Step Agentic Workflow Stress Test (5 Dependent Stages)...');
    const runner = new MultiStepWorkflowRunner(orchestrator);
    const summaries = await runner.runCohortBenchmark(isQuick ? 3 : 10, { mock: isQuick });
    const table = runner.formatWorkflowReport(summaries);
    console.log(table);

    const outPath = 'workflow-results.json';
    await Bun.write(outPath, JSON.stringify(summaries, null, 2));
    console.log(`\n✅ Saved workflow benchmark artifact to ${outPath}\n`);
    return;
  }

  console.log(`Starting Artificial Analysis Intelligence Index evaluation (${isQuick ? 'QUICK MODE' : 'FULL SUITE'})...`);
  console.log('Evaluating Meepo Mesh against composing brains (router, chat, tools, code)...\n');

  const runner = new ArtificialAnalysisBenchmarkRunner(orchestrator);
  const comparison = await runner.runBenchmark({ quick: isQuick });
  const table = runner.formatLeaderboardTable(comparison);
  console.log(table);

  // Write JSON artifact
  const outPath = 'benchmark-results.json';
  await Bun.write(outPath, JSON.stringify(comparison, null, 2));
  console.log(`\n✅ Saved benchmark artifact to ${outPath}\n`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
