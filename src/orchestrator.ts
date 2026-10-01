/**
 * @wfzyx/meepo - Multi-Brain Orchestrator
 * "Divided We Stand"
 * Scheme 1: router, chat, tools, code, cloud
 */

import * as fs from 'fs';
import * as path from 'path';
import type {
  MeepoConfig,
  MeshHealth,
  RoutingDecision,
  CodeGenerationRequest,
  CodeGenerationResult,
  CloudConsultationRequest,
  CloudConsultationResult,
} from './types';
import { MeepoMeshClient } from './client';
import { MeepoRouter } from './router';

export class MeepoOrchestrator {
  private config: MeepoConfig;
  private client: MeepoMeshClient;
  private router: MeepoRouter;
  private configPath: string;

  constructor(customConfigPath?: string) {
    this.configPath =
      customConfigPath ||
      process.env.MEEPO_CONFIG_PATH ||
      path.resolve(__dirname, '../meepo.config.json');

    this.config = this.loadConfig();
    this.client = new MeepoMeshClient(this.config);
    this.router = new MeepoRouter(this.client, this.config);
  }

  public getConfig(): MeepoConfig {
    return this.config;
  }

  public reloadConfig(): MeepoConfig {
    this.config = this.loadConfig();
    this.client.updateConfig(this.config);
    this.router.updateConfig(this.config);
    return this.config;
  }

  private loadConfig(): MeepoConfig {
    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        return JSON.parse(raw);
      } catch (e) {
        console.error(`[meepo] Failed to parse config at ${this.configPath}:`, e);
      }
    }

    // Default built-in configuration (Scheme 1)
    return {
      name: 'meepo-default',
      version: '0.1.0',
      description: 'Divided We Stand: Default Local Mesh',
      llamaServer: {
        baseUrl: 'http://127.0.0.1:8080/v1',
        modelsDir: '/home/wfzyx/models',
        healthEndpoint: 'http://127.0.0.1:8080/health',
      },
      roles: {
        router: {
          name: 'von-1.0',
          type: 'system_one',
          endpoint: 'http://127.0.0.1:8000/v1/systemone',
          description: 'Non-autoregressive 395M ModernBERT classifier (<30ms decisions)',
          enabled: true,
        },
        chat: {
          name: 'gemma-4-E2B-it',
          type: 'autoregressive',
          modelId: 'gemma-4-E2B-it',
          contextWindow: 131072,
          description: 'Conversational layer with 128k context',
          temperature: 0.7,
        },
        tools: {
          name: 'LFM2.5-1.2B-Instruct',
          type: 'autoregressive',
          modelId: 'LFM2.5-1.2B-Instruct',
          contextWindow: 32768,
          description: 'Operational engine for tool calling and agent harness steering',
          temperature: 0.1,
        },
        code: {
          name: 'Qwen3.5-2B',
          type: 'autoregressive',
          modelId: 'Qwen3.5-2B',
          contextWindow: 32768,
          description: 'Specialized syntax, AST, and diff generation engine',
          temperature: 0.2,
        },
        cloud: {
          name: 'claude-opus-5-5',
          type: 'cloud_advisor',
          provider: 'anthropic',
          modelId: 'anthropic/claude-opus-5-5',
          enabled: true,
          description: 'External non-local cloud model for hard architectural decisions',
        },
      },
      policy: {
        autoPruneTools: true,
        codeEngineOffloadThresholdLines: 5,
        cloudEscalationTriggers: ['concurrency_race', 'deadlock', 'memory_leak', 'repeated_error'],
      },
    };
  }

  public async getHealth(): Promise<MeshHealth> {
    return this.client.checkMeshHealth();
  }

  public async routeTurn(prompt: string, availableTools?: string[]): Promise<RoutingDecision> {
    return this.router.routeTurn(prompt, availableTools);
  }

  public async generateCode(req: CodeGenerationRequest): Promise<CodeGenerationResult> {
    return this.client.generateCodeWithQwen(req);
  }

  public async consultCloud(
    req: CloudConsultationRequest,
    piSubagent?: (args: any) => Promise<any>
  ): Promise<CloudConsultationResult> {
    return this.client.consultCloud(req, piSubagent);
  }

  /**
   * Render a clean terminal dashboard of the Meepo multi-brain mesh
   */
  public async formatStatusDashboard(): Promise<string> {
    const health = await this.getHealth();
    const c = this.config;

    const b = health.brains;
    const formatStatus = (s: { online: boolean; modelLoaded?: boolean; latencyMs?: number; details?: string }) => {
      const state = s.online ? '🟢 ONLINE' : '🔴 OFFLINE';
      const loaded = s.modelLoaded !== undefined ? (s.modelLoaded ? ' [LOADED]' : ' [NOT IN MEM]') : '';
      const lat = s.latencyMs ? ` (${s.latencyMs}ms)` : '';
      const det = s.details ? ` - ${s.details}` : '';
      return `${state}${loaded}${lat}${det}`;
    };

    return [
      `╔════════════════════════════════════════════════════════════════════════════╗`,
      `║                      MEEPO: DIVIDED WE STAND                               ║`,
      `║         Multi-Brain Intelligence Mesh (router / chat / tools / code / cloud)║`,
      `╚════════════════════════════════════════════════════════════════════════════╝`,
      ``,
      `  llama-server: ${health.allHealthy ? '🟢 RUNNING' : '🔴 UNREACHABLE'} (${c.llamaServer.baseUrl})`,
      `  Active Models in llama.cpp: [${health.loadedLlamaModels.join(', ') || 'none'}]`,
      ``,
      `  [1. ROUTER]       ${b.router.name}`,
      `     Status: ${formatStatus(b.router)}`,
      `     Role:   ${c.roles.router.description}`,
      ``,
      `  [2. CHAT]         ${b.chat.name}`,
      `     Status: ${formatStatus(b.chat)}`,
      `     Role:   ${c.roles.chat.description}`,
      ``,
      `  [3. TOOLS]        ${b.tools.name}`,
      `     Status: ${formatStatus(b.tools)}`,
      `     Role:   ${c.roles.tools.description}`,
      ``,
      `  [4. CODE]         ${b.code.name}`,
      `     Status: ${formatStatus(b.code)}`,
      `     Role:   ${c.roles.code.description}`,
      ``,
      `  [5. CLOUD]        ${b.cloud.name}`,
      `     Status: ${formatStatus(b.cloud)}`,
      `     Role:   ${c.roles.cloud.description}`,
      ``,
      `  Policies:`,
      `     Tool Pruning:  ${c.policy.autoPruneTools ? 'ENABLED (Protects CPU prefill)' : 'DISABLED'}`,
      `     Code Offload:  > ${c.policy.codeEngineOffloadThresholdLines} lines`,
      `     Cloud Triggers: ${c.policy.cloudEscalationTriggers.join(', ')}`,
      `══════════════════════════════════════════════════════════════════════════════`,
    ].join('\n');
  }
}
