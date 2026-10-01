/**
 * Meepo Standalone OpenAI-Compatible Reverse Proxy & Supervisor Server
 *
 * Exposes:
 * - GET  /v1/models
 * - POST /v1/chat/completions (SSE streaming + non-streaming)
 * - GET  /health
 *
 * Fronts llama-server (port 8080) and Von (port 8000), applying:
 * 1. Sub-30ms System One intent routing (<30ms)
 * 2. Dynamic Tool Schema Pruning (Turn 1 Prompt Diet)
 * 3. XML/Skills/Docs System Prompt Bloat Stripping
 * 4. Auto-healing bridge that transforms leaked text <tool_call> tags into native OpenAI tool_calls
 */

import { MeepoOrchestrator } from './orchestrator';
import { extractToolCallFromText } from './provider';
import type { BrainRole } from './types';

export interface ServerOptions {
  port?: number;
  host?: string;
  configPath?: string;
}

export function startMeepoServer(options: ServerOptions = {}) {
  const orchestrator = new MeepoOrchestrator(options.configPath);
  const cfg = orchestrator.getConfig();
  const port = options.port ?? 8081;
  const host = options.host ?? '127.0.0.1';

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS Preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*',
          },
        });
      }

      // 1. Health Endpoint
      if (url.pathname === '/health' || url.pathname === '/v1/health') {
        const health = await orchestrator.getHealth();
        return Response.json(
          {
            status: health.allHealthy ? 'healthy' : 'degraded',
            orchestrator: 'meepo',
            version: '0.1.0',
            port,
            health,
          },
          {
            headers: { 'Access-Control-Allow-Origin': '*' },
          }
        );
      }

      // 2. Models Endpoint (OpenAI spec)
      if (url.pathname === '/v1/models' && req.method === 'GET') {
        return Response.json(
          {
            object: 'list',
            data: [
              { id: 'mesh', object: 'model', created: 1733234400, owned_by: 'meepo' },
              { id: 'meepo/mesh', object: 'model', created: 1733234400, owned_by: 'meepo' },
              { id: 'chat', object: 'model', created: 1733234400, owned_by: 'meepo' },
              { id: 'tools', object: 'model', created: 1733234400, owned_by: 'meepo' },
              { id: 'code', object: 'model', created: 1733234400, owned_by: 'meepo' },
              { id: 'cloud', object: 'model', created: 1733234400, owned_by: 'meepo' },
            ],
          },
          {
            headers: { 'Access-Control-Allow-Origin': '*' },
          }
        );
      }

      // 3. Chat Completions Endpoint (OpenAI spec)
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        try {
          const body = await req.json();
          return await handleChatCompletion(body, orchestrator, cfg);
        } catch (err: any) {
          return Response.json(
            {
              error: {
                message: err?.message || String(err),
                type: 'server_error',
                code: 'meepo_proxy_error',
              },
            },
            { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } }
          );
        }
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  return server;
}

/**
 * Handle incoming Chat Completion requests with Meepo triage & schema diet
 */
async function handleChatCompletion(body: any, orchestrator: MeepoOrchestrator, cfg: any): Promise<Response> {
  const reqModel: string = body.model || 'mesh';
  const rawMessages: any[] = body.messages || [];
  const rawTools: any[] = body.tools || [];
  const stream: boolean = body.stream === true;

  // 1. Determine Target Role
  let targetRole: BrainRole = 'chat';

  if (reqModel === 'mesh' || reqModel === 'meepo/mesh' || reqModel === 'meepo-mesh') {
    // Check if the conversation is in an active tool loop (last non-assistant message is a tool result)
    const nonAssistant = rawMessages.filter((m) => m.role !== 'assistant');
    const lastNonAssistant = nonAssistant[nonAssistant.length - 1];

    if (lastNonAssistant?.role === 'tool') {
      targetRole = 'tools';
    } else {
      // Check for image content in user message
      const lastUser = [...rawMessages].reverse().find((m) => m.role === 'user');
      const hasImage =
        Array.isArray(lastUser?.content) &&
        lastUser.content.some((c: any) => c.type === 'image' || c.type === 'image_url');

      if (hasImage) {
        targetRole = 'chat'; // Gemma 4 multimodal frontman
      } else {
        const userPrompt = extractPromptText(lastUser?.content);
        const availableToolNames = rawTools.map((t) => t.function?.name || t.name).filter(Boolean);
        const decision = await orchestrator.routeTurn(userPrompt, availableToolNames);
        targetRole = decision.targetRole;
      }
    }
  } else if (reqModel.includes('chat')) {
    targetRole = 'chat';
  } else if (reqModel.includes('tools')) {
    targetRole = 'tools';
  } else if (reqModel.includes('code')) {
    targetRole = 'code';
  } else if (reqModel.includes('cloud')) {
    targetRole = 'cloud';
  }

  // 2. Prune Tools & Apply Prompt Diet
  const availableToolNames = rawTools.map((t) => t.function?.name || t.name).filter(Boolean);
  const pruning = orchestrator.getRouter().calculateToolPruning(targetRole, availableToolNames);
  const allowedSet = new Set(pruning.allowed);

  const prunedTools = rawTools.filter((t: any) => {
    const name = t.function?.name || t.name;
    return allowedSet.has(name);
  });

  // 3. Strip System Message Prompt Bloat (Skills, Docs, Distractor Tool text)
  const sanitizedMessages = rawMessages.map((msg, index) => {
    if (index === 0 && msg.role === 'system' && typeof msg.content === 'string') {
      let content = msg.content;
      // Strip massive skill and doc sections
      content = content.replace(/<skills>[\s\S]*?<\/skills>/g, '');
      content = content.replace(/<docs>[\s\S]*?<\/docs>/g, '');

      // Rewrite tools text if present
      if (content.includes('<tools>')) {
        if (prunedTools.length > 0) {
          const toolList = prunedTools
            .map((t: any) => `- ${t.function?.name || t.name}: ${t.function?.description || ''}`)
            .join('\n');
          content = content.replace(/<tools>[\s\S]*?<\/tools>/g, `<tools>\n${toolList}\n</tools>`);
        } else {
          content = content.replace(/<tools>[\s\S]*?<\/tools>/g, '');
        }
      }
      return { ...msg, content: content.trim() };
    }
    return msg;
  });

  // 4. Map Target Model for llama-server
  const targetModelId =
    targetRole === 'chat'
      ? cfg.roles.chat.modelId
      : targetRole === 'tools'
        ? cfg.roles.tools.modelId
        : targetRole === 'code'
          ? cfg.roles.code.modelId
          : cfg.roles.cloud.modelId;

  // 5. Cloud Escalation Handler
  if (targetRole === 'cloud') {
    const lastUser = [...rawMessages].reverse().find((m) => m.role === 'user');
    const userPrompt = extractPromptText(lastUser?.content);

    const cloudRes = await orchestrator.consultCloud({
      goal: 'Consultation via Meepo Cloud',
      errorOrObstacle: userPrompt,
      filesInPlay: [],
    });

    if (!stream) {
      return Response.json(
        {
          id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: `meepo-${targetRole} (${targetModelId})`,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: cloudRes.verdict },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1500,
            completion_tokens: Math.ceil(cloudRes.verdict.length / 4),
            total_tokens: 1500 + Math.ceil(cloudRes.verdict.length / 4),
          },
        },
        { headers: { 'Access-Control-Allow-Origin': '*' } }
      );
    } else {
      // SSE streaming response for cloud verdict
      const sseStream = new ReadableStream({
        start(controller) {
          const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;
          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: `meepo-${targetRole} (${targetModelId})`,
            choices: [{ index: 0, delta: { role: 'assistant', content: cloudRes.verdict }, finish_reason: null }],
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));

          const doneChunk = {
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: `meepo-${targetRole} (${targetModelId})`,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new Response(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  }

  // 6. Local llama-server Execution Payload
  const upstreamPayload: any = {
    ...body,
    model: targetModelId,
    messages: sanitizedMessages,
  };

  if (prunedTools.length > 0) {
    upstreamPayload.tools = prunedTools;
  } else {
    delete upstreamPayload.tools;
    delete upstreamPayload.tool_choice;
  }

  const upstreamRes = await fetch(`${cfg.llamaServer.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(upstreamPayload),
  });

  if (!upstreamRes.ok) {
    const errorText = await upstreamRes.text();
    return new Response(errorText, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // 7A. Non-streaming Response with Auto-healing
  if (!stream) {
    const json = await upstreamRes.json();
    const firstChoice = json.choices?.[0];
    if (firstChoice && !firstChoice.message?.tool_calls && firstChoice.message?.content) {
      const extracted = extractToolCallFromText(firstChoice.message.content);
      if (extracted) {
        firstChoice.message.content = extracted.cleanedText;
        firstChoice.message.tool_calls = [
          {
            id: extracted.toolCall.id,
            type: 'function',
            function: {
              name: extracted.toolCall.name,
              arguments: JSON.stringify(extracted.toolCall.arguments),
            },
          },
        ];
        firstChoice.finish_reason = 'tool_calls';
      }
    }
    return Response.json(json, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // 7B. Streaming SSE Response with Auto-Healing Bridge
  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    return new Response('No response body from llama-server', { status: 500 });
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let accumulatedContent = '';
  let sentToolCall = false;

  const sseStream = new ReadableStream({
    async start(controller) {
      let buffer = '';
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          if (trimmed === 'data: [DONE]') {
            // Stream is concluding. Check if we need to auto-heal leaked tool call!
            if (!sentToolCall && accumulatedContent.includes('<tool_call>')) {
              const extracted = extractToolCallFromText(accumulatedContent);
              if (extracted) {
                sentToolCall = true;
                const toolCallChunk = {
                  id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: `meepo-${targetRole} (${targetModelId})`,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        tool_calls: [
                          {
                            index: 0,
                            id: extracted.toolCall.id,
                            type: 'function',
                            function: {
                              name: extracted.toolCall.name,
                              arguments: JSON.stringify(extracted.toolCall.arguments),
                            },
                          },
                        ],
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolCallChunk)}\n\n`));
              }
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            streamDone = true;
            break;
          }

          try {
            const dataStr = trimmed.slice(6);
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;

            if (delta?.content) {
              accumulatedContent += delta.content;
            }
            if (delta?.tool_calls) {
              sentToolCall = true;
            }

            // Forward the chunk as-is
            controller.enqueue(encoder.encode(`${line}\n\n`));
          } catch {
            controller.enqueue(encoder.encode(`${line}\n\n`));
          }
        }
        if (streamDone) break;
      }

      controller.close();
    },
  });

  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function extractPromptText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
  }
  return '';
}
