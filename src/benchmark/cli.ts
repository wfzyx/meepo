#!/usr/bin/env bun
/**
 * CLI Runner for Artificial Analysis Intelligence Index
 * Usage: bun run benchmark [--quick]
 */

import { MeepoOrchestrator } from '../orchestrator';
import { ArtificialAnalysisBenchmarkRunner } from './runner';

async function main() {
  const isQuick = process.argv.includes('--quick');
  console.log(`Starting Artificial Analysis Intelligence Index evaluation (${isQuick ? 'QUICK MODE' : 'FULL SUITE'})...`);
  console.log('Evaluating Meepo Mesh against composing brains (router, chat, tools, code)...\n');

  const orchestrator = new MeepoOrchestrator();
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
