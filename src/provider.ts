/**
 * Meepo Provider Implementation for Pi
 *
 * Registers Meepo as a first-class Model Provider in Pi.
 * Transparently intercepts turns, triages user intent via Von System One (or heuristic fallback),
 * dynamically prunes tool schemas to eliminate prompt prefill latency, and routes execution
 * to the optimal specialized brain (chat, tools, code, or cloud).
 */

import {
  collapseSystemMessages,
  contentText,
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import type { MeepoOrchestrator } from './orchestrator';
import type { BrainRole, RoutingDecision } from './types';

export const MEEPO_PROVIDER_ID = 'meepo';
export const MEEPO_API_NAME = 'meepo-mesh-api';

/**
 * Available models exposed by Meepo to Pi
 */
export function getMeepoModels(orchestrator: MeepoOrchestrator) {
  const cfg = orchestrator.getConfig();
  return [
    {
      id: 'mesh',
      name: 'Meepo Multi-Brain Mesh (Auto-Routing)',
      reasoning: true,
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 16384,
    },
    {
      id: 'chat',
      name: `Meepo Chat (${cfg.roles.chat.modelId})`,
      reasoning: false,
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cfg.roles.chat.contextWindow ?? 131072,
      maxTokens: 16384,
    },
    {
      id: 'tools',
      name: `Meepo Tools (${cfg.roles.tools.modelId})`,
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cfg.roles.tools.contextWindow ?? 32768,
      maxTokens: 8192,
    },
    {
      id: 'code',
      name: `Meepo Code (${cfg.roles.code.modelId})`,
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: cfg.roles.code.contextWindow ?? 32768,
      maxTokens: 8192,
    },
    {
      id: 'cloud',
      name: `Meepo Cloud (${cfg.roles.cloud.modelId})`,
      reasoning: true,
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ];
}

/**
 * Filter tool declarations on the leading system message to only the allowed tool set
 */
export function pruneTranscriptForRole(
  context: TranscriptContext,
  allowedToolNames: string[]
): TranscriptContext {
  const collapsed = collapseSystemMessages(context);
  const currentTools = getCurrentTools(collapsed.messages);
  const allowedSet = new Set(allowedToolNames);
  const prunedTools = currentTools.filter((t) => allowedSet.has(t.name));

  const messages = [...collapsed.messages];
  if (messages.length > 0 && messages[0].role === 'system') {
    const systemMsg = { ...messages[0] } as any;
    if (prunedTools.length > 0) {
      systemMsg.toolsAdded = prunedTools;
    } else {
      delete systemMsg.toolsAdded;
    }
    messages[0] = systemMsg;
  }

  return { messages } as TranscriptContext;
}

/**
 * Main streaming entry point for Meepo model execution in Pi
 */
export function streamMeepo(
  model: Model<any>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  orchestrator: MeepoOrchestrator
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const collapsed = collapseSystemMessages(context);
    const currentTools = getCurrentTools(collapsed.messages);
    const allToolNames = currentTools.map((t) => t.name);

    let targetRole: BrainRole = 'chat';
    let routingDecision: RoutingDecision | null = null;

    try {
      // 1. Triage Intent & Select Sub-Brain
      if (model.id === 'mesh') {
        const nonAssistant = collapsed.messages.filter((m) => m.role !== 'assistant');
        const lastNonAssistant = nonAssistant[nonAssistant.length - 1];

        if (lastNonAssistant?.role === 'toolResult') {
          // Ongoing tool loop: keep executing tools
          targetRole = 'tools';
        } else {
          // Extract latest user prompt
          const lastUser = [...collapsed.messages].reverse().find((m) => m.role === 'user');
          const hasImage =
            Array.isArray(lastUser?.content) &&
            lastUser.content.some((c) => (c as { type?: string }).type === 'image');

          if (hasImage) {
            // Multimodal input: route directly to Gemma 4 (chat) as vision encoder
            targetRole = 'chat';
          } else {
            const userPrompt = lastUser ? contentText(lastUser.content) : '';
            routingDecision = await orchestrator.routeTurn(userPrompt, allToolNames);
            targetRole = routingDecision.targetRole;
          }
        }
      } else if (model.id in orchestrator.getConfig().roles) {
        targetRole = model.id as BrainRole;
      }

      const cfg = orchestrator.getConfig();
      const roleConfig = cfg.roles[targetRole];

      // 2. Dynamic Tool Pruning (Turn 1 Prompt Diet)
      const allowedTools =
        routingDecision?.allowedTools ??
        orchestrator.getRouter().calculateToolPruning(targetRole, allToolNames).allowed;

      const prunedContext = pruneTranscriptForRole(collapsed, allowedTools);

      // 3. Execution: Cloud vs Local
      if (targetRole === 'cloud') {
        // Non-local Cloud escalation
        const output: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          responseModel: `${cfg.roles.cloud.modelId} [cloud]`,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'pending',
          timestamp: Date.now(),
        };

        stream.push({ type: 'start', partial: output });

        const lastUser = [...collapsed.messages].reverse().find((m) => m.role === 'user');
        const userPrompt = lastUser ? contentText(lastUser.content) : 'Turn consultation';

        const cloudResult = await orchestrator.consultCloud({
          goal: 'Turn consultation via Meepo Cloud',
          errorOrObstacle: userPrompt,
          filesInPlay: [],
        });

        const textBlock = { type: 'text' as const, text: cloudResult.verdict };
        output.content.push(textBlock);

        stream.push({ type: 'text_start', contentIndex: 0, partial: output });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: cloudResult.verdict, partial: output });
        stream.push({ type: 'text_end', contentIndex: 0, content: cloudResult.verdict, partial: output });

        output.stopReason = 'stop';
        output.usage.output = Math.ceil(cloudResult.verdict.length / 4);
        output.usage.totalTokens = output.usage.output;

        stream.push({ type: 'done', reason: 'stop', message: output });
        stream.end();
        return;
      }

      // Autoregressive local models (chat, tools, code) via llama-server
      const autoRoleConfig = roleConfig as { modelId: string; contextWindow?: number };
      const targetModelId = autoRoleConfig.modelId || 'local-brain';
      const targetModel: Model<'openai-completions'> = {
        id: targetModelId,
        name: `${targetModelId} [meepo:${targetRole}]`,
        api: 'openai-completions',
        provider: 'meepo',
        baseUrl: cfg.llamaServer.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: (roleConfig as any).contextWindow ?? 32768,
        maxTokens: 16384,
        compat: {
          supportsDeveloperRole: false,
          supportsStore: false,
          supportsReasoningEffort: false,
        },
      };

      const innerStream = openAICompletionsApi().streamSimple(
        targetModel,
        prunedContext,
        {
          ...options,
          apiKey: 'meepo-local',
        }
      );

      for await (const event of innerStream) {
        if (event.type === 'start') {
          event.partial.model = model.id;
          event.partial.responseModel = `${targetModelId} [${targetRole}]`;
        } else if (event.type === 'done') {
          event.message.model = model.id;
          event.message.responseModel = `${targetModelId} [${targetRole}]`;
        }
        stream.push(event);
      }
      stream.end();
    } catch (err: any) {
      const errorMessage =
        err?.message?.includes('fetch failed') || err?.message?.includes('ECONNREFUSED')
          ? `[Meepo] llama-server is unreachable at ${orchestrator.getConfig().llamaServer.baseUrl}. Start it with:\nllama-server --models-dir ~/models --no-models-autoload --host 127.0.0.1 --port 8080`
          : `[Meepo Execution Error]: ${err?.message || String(err)}`;

      stream.push({
        type: 'error',
        reason: 'error',
        error: {
          role: 'assistant',
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'error',
          errorMessage,
          timestamp: Date.now(),
        },
      });
      stream.end();
    }
  })();

  return stream;
}

/**
 * Assemble the Provider configuration object for pi.registerProvider
 */
export function createMeepoProviderConfig(orchestrator: MeepoOrchestrator) {
  const cfg = orchestrator.getConfig();
  const models = getMeepoModels(orchestrator);

  return {
    name: 'Meepo',
    baseUrl: cfg.llamaServer.baseUrl,
    apiKey: 'meepo-mesh-local',
    api: MEEPO_API_NAME,
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      api: MEEPO_API_NAME,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    streamSimple: (
      model: Model<any>,
      context: TranscriptContext,
      options?: SimpleStreamOptions
    ) => streamMeepo(model, context, options, orchestrator),
  };
}
