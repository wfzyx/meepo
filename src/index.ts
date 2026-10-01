/**
 * @wfzyx/meepo - Multi-Brain Local & Hybrid Agent Extension for Pi
 * "Divided We Stand"
 *
 * Brain Roster (Scheme 1):
 * 1. router: Von 1.3.5 (OptionMarker System One) - sub-30ms non-autoregressive triage & tool pruner
 * 2. chat:   Gemma 4 E2B-it - conversational layer, 128k context, human dialogue
 * 3. tools:  LFM 2.5 1.2B - operational tool execution puppet & bash/fs mechanics
 * 4. code:   Qwen 3.5 2B - specialized Gated Delta syntax and diff generator
 * 5. cloud:  Claude Opus / Gemini Flash - non-local cloud advisor for hard dilemmas
 */

import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { MeepoOrchestrator } from './orchestrator';
import {
  createMeepoProviderConfig,
  getMeepoModels,
  MEEPO_API_NAME,
  MEEPO_PROVIDER_ID,
} from './provider';

export * from './types';
export * from './client';
export * from './router';
export * from './orchestrator';
export * from './provider';

export default function registerMeepoExtension(pi: ExtensionAPI) {
  const orchestrator = new MeepoOrchestrator();

  // 1. Register Meepo as a first-class Model Provider in Pi
  // Enables /model meepo/mesh, meepo/chat, meepo/tools, meepo/code, meepo/cloud
  pi.registerProvider(MEEPO_PROVIDER_ID, createMeepoProviderConfig(orchestrator));
  // 1. Slash Command: /meepo [status | config | reload | cloud | code]
  pi.registerCommand('meepo', {
    description: 'Inspect and manage the Meepo multi-brain intelligence mesh',
    handler: async (args: string, ctx: any) => {
      const parts = (args || '').trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || 'status';

      switch (sub) {
        case 'status': {
          const dashboard = await orchestrator.formatStatusDashboard();
          ctx.ui?.notify?.('Fetched Meepo mesh status', 'info');
          if (typeof ctx.ui?.output === 'function') {
            ctx.ui.output(dashboard);
          } else {
            console.log(dashboard);
          }
          break;
        }

        case 'config': {
          const cfg = orchestrator.getConfig();
          const str = JSON.stringify(cfg, null, 2);
          if (typeof ctx.ui?.output === 'function') {
            ctx.ui.output(str);
          } else {
            console.log(str);
          }
          break;
        }

        case 'reload': {
          const cfg = orchestrator.reloadConfig();
          ctx.ui?.notify?.(`Meepo config reloaded: ${cfg.name} (v${cfg.version})`, 'info');
          break;
        }

        case 'cloud': {
          const prompt = parts.slice(1).join(' ').trim();
          if (!prompt) {
            ctx.ui?.notify?.('Usage: /meepo cloud <problem or question>', 'error');
            return;
          }
          ctx.ui?.notify?.('Consulting Meepo Cloud model...', 'info');
          try {
            const res = await orchestrator.consultCloud(
              {
                goal: 'Direct user query via /meepo cloud',
                errorOrObstacle: prompt,
              },
              (pi as any).subagent
            );
            const formatted = `[Meepo Cloud - ${res.model} (${res.latencyMs}ms)]\n\n${res.verdict}`;
            if (typeof ctx.ui?.output === 'function') {
              ctx.ui.output(formatted);
            } else {
              console.log(formatted);
            }
          } catch (e: any) {
            ctx.ui?.notify?.(`Cloud consultation failed: ${e.message}`, 'error');
          }
          break;
        }

        case 'code': {
          const spec = parts.slice(1).join(' ').trim();
          if (!spec) {
            ctx.ui?.notify?.('Usage: /meepo code <instruction>', 'error');
            return;
          }
          ctx.ui?.notify?.('Generating code via Qwen 3.5 Code Engine...', 'info');
          try {
            const res = await orchestrator.generateCode({
              language: 'typescript',
              instruction: spec,
            });
            const output = `[Meepo Code Engine - ${res.model} (${res.latencyMs}ms)]\n\n${res.code}`;
            if (typeof ctx.ui?.output === 'function') {
              ctx.ui.output(output);
            } else {
              console.log(output);
            }
          } catch (e: any) {
            ctx.ui?.notify?.(`Code generation failed: ${e.message}`, 'error');
          }
          break;
        }

        case 'models': {
          const models = getMeepoModels(orchestrator);
          let text = 'Meepo Models Registered:\n';
          for (const m of models) {
            text += `  • meepo/${m.id.padEnd(6)} - ${m.name}\n`;
          }
          text += '\nSelect in Pi via /model meepo/mesh (or /meepo use mesh)';
          if (typeof ctx.ui?.output === 'function') {
            ctx.ui.output(text);
          } else {
            console.log(text);
          }
          break;
        }

        case 'use':
        case 'activate': {
          const targetId = parts[1]?.toLowerCase() || 'mesh';
          const models = getMeepoModels(orchestrator);
          const found = models.find((m) => m.id === targetId);
          if (!found) {
            ctx.ui?.notify?.(
              `Unknown Meepo model '${targetId}'. Available: ${models.map((m) => m.id).join(', ')}`,
              'error'
            );
            return;
          }

          if (typeof (pi as any).setModel === 'function') {
            try {
              await (pi as any).setModel({
                id: found.id,
                name: found.name,
                api: MEEPO_API_NAME,
                provider: MEEPO_PROVIDER_ID,
                baseUrl: orchestrator.getConfig().llamaServer.baseUrl,
                reasoning: found.reasoning,
                input: found.input,
                cost: found.cost,
                contextWindow: found.contextWindow,
                maxTokens: found.maxTokens,
              });
              ctx.ui?.notify?.(`Active model switched to meepo/${found.id}`, 'info');
            } catch (err: any) {
              ctx.ui?.notify?.(`Failed to switch model: ${err.message}`, 'error');
            }
          } else {
            ctx.ui?.notify?.(`Use command: /model meepo/${found.id}`, 'info');
          }
          break;
        }

        default:
          ctx.ui?.notify?.(
            `Unknown meepo subcommand '${sub}'. Use status, config, reload, models, use, cloud, or code.`,
            'warning'
          );
      }
    },
  });

  // 2. Tool: meepo_ask_cloud (Escalation to non-local model)
  pi.registerTool({
    name: 'meepo_ask_cloud',
    label: 'Meepo Cloud',
    description:
      'Consult the non-local Cloud model (Claude Opus / Gemini Flash) for deep architectural decisions, concurrency races, deadlocks, memory leaks, or repeated obstacles. Cap brief to essentials.',
    parameters: Type.Object({
      goal: Type.String({ description: 'The overarching objective or task being attempted' }),
      errorOrObstacle: Type.String({ description: 'The exact deadlock, repeated error, or hard decision requiring Cloud review' }),
      filesInPlay: Type.Optional(Type.Array(Type.String(), { description: 'Source files relevant to the problem' })),
      whatWasTried: Type.Optional(Type.String({ description: 'Summary of what has already failed or been evaluated' })),
    }),
    execute: async (_toolCallId: string, params: any) => {
      try {
        const result = await orchestrator.consultCloud(
          {
            goal: params.goal,
            errorOrObstacle: params.errorOrObstacle,
            filesInPlay: params.filesInPlay,
            whatWasTried: params.whatWasTried,
          },
          (pi as any).subagent
        );

        return {
          content: [
            {
              type: 'text',
              text: `[Meepo Cloud Response (${result.model} in ${result.latencyMs}ms)]\n${result.verdict}`,
            },
          ],
          details: {
            model: result.model,
            latencyMs: result.latencyMs,
            error: undefined as string | undefined,
          },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `[Meepo Cloud Failed]: ${err.message}`,
            },
          ],
          details: {
            model: 'cloud-error',
            latencyMs: 0,
            error: err.message,
          },
        };
      }
    },
  });

  // 3. Tool: meepo_generate_code (Subcontract code generation to Qwen 3.5)
  pi.registerTool({
    name: 'meepo_generate_code',
    label: 'Meepo Code',
    description:
      'Subcontract isolated code block, function, or patch generation to the specialized Qwen 3.5 Code Engine. Keeps large code synthesis out of the operational tool loop.',
    parameters: Type.Object({
      language: Type.String({ description: 'Target programming language (e.g. typescript, go, python, rust)' }),
      instruction: Type.String({ description: 'Precise implementation specification for the code block' }),
      existingCode: Type.Optional(Type.String({ description: 'Verbatim enclosing code or interface to conform to' })),
      filePath: Type.Optional(Type.String({ description: 'Target file path for context' })),
    }),
    execute: async (_toolCallId: string, params: any) => {
      try {
        const result = await orchestrator.generateCode({
          language: params.language,
          instruction: params.instruction,
          existingCode: params.existingCode,
          filePath: params.filePath,
        });

        return {
          content: [
            {
              type: 'text',
              text: `[Meepo Code Result (${result.model} in ${result.latencyMs}ms)]:\n\n${result.code}`,
            },
          ],
          details: {
            model: result.model,
            tokens: result.tokensGenerated,
            latencyMs: result.latencyMs,
            error: undefined as string | undefined,
          },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `[Meepo Code Error]: ${err.message}`,
            },
          ],
          details: {
            model: 'code-error',
            tokens: undefined,
            latencyMs: 0,
            error: err.message,
          },
        };
      }
    },
  });

  // 4. Session Start Event: Notify user of Meepo mesh state
  if (pi.on) {
    pi.on('session_start', async (_event: any, ctx: any) => {
      try {
        const health = await orchestrator.getHealth();
        if (health.allHealthy) {
          ctx.ui?.notify?.('[meepo] Model registered: meepo/mesh (Auto-Routing). Ready for /model meepo/mesh.', 'info');
        } else {
          ctx.ui?.notify?.('[meepo] Model registered: meepo/mesh. (Mesh partially offline - run /meepo status)', 'warning');
        }
      } catch {}
    });

    // 5. Prompt injection for multi-brain awareness
    pi.on('before_agent_start', async (event: any, _ctx: any) => {
      const c = orchestrator.getConfig();
      const injection = `\n\n[Meepo Multi-Brain Sub-Delegation Available]:
Divided We Stand: You have access to specialized Meepo sub-brains:
- Use 'meepo_generate_code' when you need to write complex algorithms, functions, or patches; Qwen 3.5 generates the pure code block without polluting tool schemas.
- Use 'meepo_ask_cloud' when hitting concurrency deadlocks, memory leaks, repeated errors, or hard architectural crossroads. The non-local Cloud model (${c.roles.cloud.modelId}) will evaluate the state.`;

      if (event?.systemPrompt) {
        return {
          systemPrompt: event.systemPrompt + injection,
        };
      }
      return undefined;
    });
  }
}
