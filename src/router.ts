/**
 * @wfzyx/meepo - Intent Router & Dynamic Tool Pruner
 * Powered by Von 1.0 (Non-autoregressive 395M ModernBERT) with heuristic fallback
 */

import type { MeepoConfig, RoutingDecision, BrainRole } from './types';
import type { MeepoMeshClient } from './client';

export class MeepoRouter {
  private client: MeepoMeshClient;
  private config: MeepoConfig;

  constructor(client: MeepoMeshClient, config: MeepoConfig) {
    this.client = client;
    this.config = config;
  }

  public updateConfig(config: MeepoConfig): void {
    this.config = config;
  }

  /**
   * Route user turn to target brain and prune unused tool schemas
   */
  public async routeTurn(
    userPrompt: string,
    availableTools: string[] = []
  ): Promise<RoutingDecision> {
    const start = Date.now();

    // 1. Try fast non-autoregressive classification with Von
    if (this.config.roles.gate.enabled) {
      const choices = {
        frontman: 'Conversational chit-chat, high-level question, explanation, general synthesis',
        hands: 'Terminal/shell command execution, filesystem exploration, file management, system administration',
        code_engine: 'Writing code, refactoring a function, implementing an algorithm, syntax bug fix',
        oracle: 'Complex architectural dispute, concurrency race, deadlock, repeated failure, deep design review',
      };

      const vonResult = await this.client.decideVon(userPrompt, choices);
      if (vonResult && vonResult.decision) {
        const targetRole = vonResult.decision as BrainRole;
        const confidence = vonResult.probabilities[targetRole] ?? 0.85;

        const { allowed, pruned } = this.calculateToolPruning(targetRole, availableTools);

        return {
          targetRole,
          confidence,
          allowedTools: allowed,
          prunedTools: pruned,
          reason: `Von 1.0 single-pass classification (${Math.round(confidence * 100)}% confidence)`,
          latencyMs: Date.now() - start,
          source: 'von',
        };
      }
    }

    // 2. Fast Heuristic Fallback if Von is offline
    const heuristicTarget = this.heuristicClassify(userPrompt);
    const { allowed, pruned } = this.calculateToolPruning(heuristicTarget, availableTools);

    return {
      targetRole: heuristicTarget,
      confidence: 0.7,
      allowedTools: allowed,
      prunedTools: pruned,
      reason: 'Rule-based heuristic pattern match (Von offline)',
      latencyMs: Date.now() - start,
      source: 'heuristic',
    };
  }

  /**
   * Heuristic fallback when Von is unreachable
   */
  private heuristicClassify(prompt: string): BrainRole {
    const p = prompt.toLowerCase();

    // Oracle triggers
    for (const trigger of this.config.policy.oracleEscalationTriggers) {
      if (p.includes(trigger.replace('_', ' '))) {
        return 'oracle';
      }
    }
    if (p.includes('deadlock') || p.includes('race condition') || p.includes('architecture decision') || p.includes('advisor')) {
      return 'oracle';
    }

    // Code engine triggers
    if (
      p.includes('implement') ||
      p.includes('refactor') ||
      p.includes('function') ||
      p.includes('write the code') ||
      p.includes('fix the bug') ||
      p.includes('diff') ||
      p.includes('.ts') ||
      p.includes('.go') ||
      p.includes('.py') ||
      p.includes('.rs')
    ) {
      return 'code_engine';
    }

    // Hands triggers (ops/shell)
    if (
      p.startsWith('run ') ||
      p.startsWith('ls') ||
      p.startsWith('git ') ||
      p.includes('install') ||
      p.includes('build') ||
      p.includes('test') ||
      p.includes('delete') ||
      p.includes('ps aux')
    ) {
      return 'hands';
    }

    // Default to Frontman for general conversational reasoning
    return 'frontman';
  }

  /**
   * Calculate tool schema pruning to protect CPU prefill latency
   */
  private calculateToolPruning(
    role: BrainRole,
    availableTools: string[]
  ): { allowed: string[]; pruned: string[] } {
    if (!this.config.policy.autoPruneTools || availableTools.length === 0) {
      return { allowed: availableTools, pruned: [] };
    }

    let essentialTools: Set<string>;

    switch (role) {
      case 'frontman':
        // Frontman only needs web search or read-only tools
        essentialTools = new Set(['web_search', 'web_fetch', 'read', 'ask']);
        break;
      case 'hands':
        // Ops mechanic needs terminal and filesystem
        essentialTools = new Set(['bash', 'read', 'write', 'edit', 'undo_last_edit']);
        break;
      case 'code_engine':
        // Code specialist needs editor and diagnostics
        essentialTools = new Set(['read', 'edit', 'write', 'lsp_diagnostics', 'undo_last_edit']);
        break;
      case 'oracle':
        // Oracle escalation tool
        essentialTools = new Set(['meepo_ask_oracle', 'ask']);
        break;
      default:
        essentialTools = new Set(availableTools);
    }

    // Always preserve Meepo built-in tools
    essentialTools.add('meepo_ask_oracle');
    essentialTools.add('meepo_generate_code');

    const allowed = availableTools.filter((t) => essentialTools.has(t));
    const pruned = availableTools.filter((t) => !essentialTools.has(t));

    return { allowed, pruned };
  }
}
