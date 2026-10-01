/**
 * @wfzyx/meepo - Mesh Client
 * Connects to llama-server, Von System One router, and external Cloud model
 * Scheme 1: router, chat, tools, code, cloud
 */

import { spawn } from 'child_process';
import type {
  MeepoConfig,
  BrainStatus,
  MeshHealth,
  CodeGenerationRequest,
  CodeGenerationResult,
  CloudConsultationRequest,
  CloudConsultationResult,
} from './types';

export class MeepoMeshClient {
  private config: MeepoConfig;

  constructor(config: MeepoConfig) {
    this.config = config;
  }

  public updateConfig(config: MeepoConfig): void {
    this.config = config;
  }

  /**
   * Check health of llama-server and list active loaded models
   */
  public async checkLlamaServer(): Promise<{ online: boolean; models: string[]; latencyMs: number }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);

      const res = await fetch(`${this.config.llamaServer.baseUrl}/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        return { online: false, models: [], latencyMs: Date.now() - start };
      }

      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const models = (data.data || []).map((m) => m.id);
      return { online: true, models, latencyMs: Date.now() - start };
    } catch {
      return { online: false, models: [], latencyMs: Date.now() - start };
    }
  }

  /**
   * Check Von System One decision server
   */
  public async checkVon(): Promise<{ online: boolean; latencyMs: number; details?: string }> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 800);

      const res = await fetch(this.config.roles.router.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'choice',
          state: 'health_check',
          choices: { ok: 'System is healthy', err: 'System has error' },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      return {
        online: res.status < 500,
        latencyMs: Date.now() - start,
        details: res.ok ? 'Calibrated 395M ModernBERT online' : `HTTP ${res.status}`,
      };
    } catch (e: any) {
      return {
        online: false,
        latencyMs: Date.now() - start,
        details: e.name === 'AbortError' ? 'Timeout (>800ms)' : 'Offline / unreachable',
      };
    }
  }

  /**
   * Query Von System One to make a sub-50ms categorical routing decision
   */
  public async decideVon(
    state: string,
    choices: Record<string, string>
  ): Promise<{ decision: string; probabilities: Record<string, number>; latencyMs: number } | null> {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);

      const res = await fetch(this.config.roles.router.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'choice',
          state,
          choices,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) return null;
      const data = (await res.json()) as { choice?: string; probabilities?: Record<string, number> };
      if (!data.choice) return null;

      return {
        decision: data.choice,
        probabilities: data.probabilities || {},
        latencyMs: Date.now() - start,
      };
    } catch {
      return null;
    }
  }

  /**
   * Complete a raw prompt on a designated local model via llama-server
   */
  public async completeLocal(
    modelId: string,
    messages: Array<{ role: string; content: string }>,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<{ content: string; latencyMs: number; tokens?: number }> {
    const start = Date.now();
    const res = await fetch(`${this.config.llamaServer.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens ?? 2048,
        stream: false,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`llama-server completion failed (${res.status}): ${err}`);
    }

    const data = (await res.json()) as any;
    const content = data.choices?.[0]?.message?.content || '';
    const tokens = data.usage?.completion_tokens;

    return {
      content,
      latencyMs: Date.now() - start,
      tokens,
    };
  }

  /**
   * Delegate isolated code generation to Qwen 3.5 without tool schema pollution
   */
  public async generateCodeWithQwen(req: CodeGenerationRequest): Promise<CodeGenerationResult> {
    const model = this.config.roles.code.modelId;
    const systemPrompt = `You are an elite, minimal code generation engine (${model}).
Output ONLY the replacement code block or patch. No markdown conversational filler, no polite preamble, no explanations.
Target Language: ${req.language}
File Context: ${req.filePath || 'unspecified'}`;

    const userPrompt = `${req.instruction}

${req.existingCode ? `Existing code reference:\n\`\`\`${req.language}\n${req.existingCode}\n\`\`\`` : ''}`;

    const result = await this.completeLocal(
      model,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature: this.config.roles.code.temperature ?? 0.2 }
    );

    let cleanCode = result.content.trim();
    if (cleanCode.startsWith('```')) {
      const lines = cleanCode.split('\n');
      if (lines.length > 2) {
        cleanCode = lines.slice(1, -1).join('\n');
      }
    }

    return {
      code: cleanCode,
      model,
      latencyMs: result.latencyMs,
      tokensGenerated: result.tokens,
    };
  }

  /**
   * Consult the non-local Cloud model (Claude Opus / Gemini Flash) for deep architectural problems
   */
  public async consultCloud(
    req: CloudConsultationRequest,
    piSubagent?: (args: any) => Promise<any>
  ): Promise<CloudConsultationResult> {
    const start = Date.now();
    const cloudConfig = this.config.roles.cloud;
    const prompt = `Goal: ${req.goal}
Files in play: ${(req.filesInPlay || []).join(', ') || 'N/A'}
What was already tried: ${req.whatWasTried || 'First attempt'}
Error / Obstacle: ${req.errorOrObstacle}
Constraints: ${(req.constraints || []).join('; ') || 'Standard memory safety and zero regressions'}

You are the Cloud Advisor: external senior systems architect. Provide:
1. Verdict (Direct 1-line truth)
2. Recommended Action (Exact executable steps)
3. Architectural Risks / Deadlocks`;

    if (piSubagent) {
      try {
        const subResult = await piSubagent({
          agent: 'advisor',
          task: prompt,
        });
        return {
          verdict: subResult?.output || 'Cloud model returned evaluation',
          recommendedAction: 'Apply recommended diff/plan',
          architecturalRisks: [],
          model: cloudConfig.modelId,
          latencyMs: Date.now() - start,
        };
      } catch {}
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(
        'pi',
        ['--mode', 'json', '-p', '--no-session', '--model', cloudConfig.modelId, prompt],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => (stdout += d.toString()));
      proc.stderr.on('data', (d) => (stderr += d.toString()));

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`Cloud consultation failed (code ${code}): ${stderr}`));
        }

        let verdict = stdout.trim();
        try {
          const lines = stdout.trim().split('\n');
          for (const line of lines) {
            const parsed = JSON.parse(line);
            if (parsed.type === 'message' && parsed.message?.role === 'assistant') {
              const textParts = (parsed.message.content || [])
                .filter((p: any) => p.type === 'text')
                .map((p: any) => p.text);
              if (textParts.length > 0) {
                verdict = textParts.join('\n');
              }
            }
          }
        } catch {}

        resolve({
          verdict,
          recommendedAction: 'See Cloud response above',
          architecturalRisks: [],
          model: cloudConfig.modelId,
          latencyMs: Date.now() - start,
        });
      });
    });
  }

  /**
   * Probe the complete multi-brain mesh
   */
  public async checkMeshHealth(): Promise<MeshHealth> {
    const llama = await this.checkLlamaServer();
    const von = await this.checkVon();

    const isLoaded = (modelId: string) =>
      llama.models.some((m) => m.toLowerCase().includes(modelId.toLowerCase()));

    const brains: Record<string, BrainStatus> = {
      router: {
        role: 'router',
        name: this.config.roles.router.name,
        type: 'system_one',
        online: von.online,
        latencyMs: von.latencyMs,
        details: von.details,
      },
      chat: {
        role: 'chat',
        name: this.config.roles.chat.name,
        type: 'autoregressive',
        online: llama.online,
        modelLoaded: isLoaded(this.config.roles.chat.modelId),
        details: `128k ctx (${this.config.roles.chat.modelId})`,
      },
      tools: {
        role: 'tools',
        name: this.config.roles.tools.name,
        type: 'autoregressive',
        online: llama.online,
        modelLoaded: isLoaded(this.config.roles.tools.modelId),
        details: `Tool harness driver (${this.config.roles.tools.modelId})`,
      },
      code: {
        role: 'code',
        name: this.config.roles.code.name,
        type: 'autoregressive',
        online: llama.online,
        modelLoaded: isLoaded(this.config.roles.code.modelId),
        details: `Gated Delta diff engine (${this.config.roles.code.modelId})`,
      },
      cloud: {
        role: 'cloud',
        name: this.config.roles.cloud.name,
        type: 'cloud_advisor',
        online: Boolean(this.config.roles.cloud.enabled),
        details: `Cloud Escalation (${this.config.roles.cloud.modelId})`,
      },
    };

    const allHealthy = llama.online && Object.values(brains).some((b) => b.online);

    return {
      allHealthy,
      brains: brains as Record<any, BrainStatus>,
      loadedLlamaModels: llama.models,
    };
  }
}
