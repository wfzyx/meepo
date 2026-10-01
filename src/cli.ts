#!/usr/bin/env bun
/**
 * Meepo Standalone CLI Entry Point
 *
 * Commands:
 *   meepo serve [--port 8081] [--host 127.0.0.1]   Start the OpenAI-compatible proxy server
 *   meepo status                                    Check mesh and sub-brain health
 *   meepo benchmark [--quick] [--workflow]          Run the Artificial Analysis benchmark
 */

import { startMeepoServer } from './server';
import { MeepoOrchestrator } from './orchestrator';
import { ArtificialAnalysisBenchmarkRunner } from './benchmark/runner';
import { MultiStepWorkflowRunner } from './benchmark/workflow';

const args = process.argv.slice(2);
const command = args[0] || 'serve';

async function main() {
  if (command === 'serve' || command === 'start') {
    let port = 8081;
    let host = '127.0.0.1';
    let configPath: string | undefined;

    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--port' || args[i] === '-p') {
        port = parseInt(args[++i], 10) || 8081;
      } else if (args[i] === '--host' || args[i] === '-h') {
        host = args[++i];
      } else if (args[i] === '--config' || args[i] === '-c') {
        configPath = args[++i];
      }
    }

    const server = startMeepoServer({ port, host, configPath });
    const orch = new MeepoOrchestrator(configPath);
    const cfg = orch.getConfig();

    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                  MEEPO: MULTI-BRAIN LLM PROXY                    ║
║                   OpenAI-Compatible Endpoint                     ║
╚═══════════════════════════════════════════════════════════════════╝

  • Local Endpoint:    http://${host}:${port}/v1
  • Health Check:      http://${host}:${port}/health
  • Upstream Llama:    ${cfg.llamaServer.baseUrl}
  • Upstream Von:      ${cfg.roles.router.endpoint}

Available Models:
  - mesh          (Auto-routed Multi-Brain Mesh)
  - chat          (${cfg.roles.chat.modelId} - Gemma 4 E2B)
  - tools         (${cfg.roles.tools.modelId} - LFM 2.5 1.2B)
  - code          (${cfg.roles.code.modelId} - Qwen 3.5 2B)
  - cloud         (${cfg.roles.cloud.modelId} - Claude Opus / Gemini)

Pi Configuration (~/.pi/agent/models.json):
  "providers": {
    "meepo": {
      "baseUrl": "http://${host}:${port}/v1",
      "api": "openai-completions",
      "apiKey": "local"
    }
  }

Press Ctrl+C to stop.
`);

    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nStopping Meepo proxy...');
      server.stop();
      process.exit(0);
    });
  } else if (command === 'status') {
    const orch = new MeepoOrchestrator();
    const dashboard = await orch.formatStatusDashboard();
    console.log(dashboard);
  } else if (command === 'benchmark') {
    const isWorkflow = args.includes('--workflow');
    const isQuick = args.includes('--quick');

    const orch = new MeepoOrchestrator();
    if (isWorkflow) {
      console.log('\nRunning Multi-Step Agentic Workflow Stress Test...');
      const runner = new MultiStepWorkflowRunner(orch);
      const results = await runner.runCohortBenchmark(isQuick ? 3 : 10, { mock: true });
      console.log(runner.formatWorkflowReport(results));
    } else {
      console.log('\nRunning Artificial Analysis Intelligence Index Benchmark...');
      const runner = new ArtificialAnalysisBenchmarkRunner(orch);
      const results = await runner.runBenchmark({ quick: isQuick, mock: true });
      console.log(runner.formatLeaderboardTable(results));
    }
  } else if (command === '--help' || command === '-h' || command === 'help') {
    console.log(`
Meepo - Multi-Brain Local/Hybrid Agent Orchestration Proxy

Usage:
  meepo [command] [options]

Commands:
  serve                 Start the OpenAI-compatible proxy (default)
  status                Check local health of all sub-brains
  benchmark             Run the Artificial Analysis Intelligence Index suite
  help                  Show this help screen

Options for 'serve':
  --port, -p <number>   Port to listen on (default: 8081)
  --host, -h <string>   Host to bind to (default: 127.0.0.1)
  --config, -c <path>   Path to meepo.config.json

Options for 'benchmark':
  --quick               Run reduced 2-task evaluation
  --workflow            Run 5-stage agentic workflow stress test
`);
  } else {
    console.error(`Unknown command: ${command}. Run 'meepo --help' for usage.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Meepo CLI Error:', err);
  process.exit(1);
});
