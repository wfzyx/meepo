/**
 * @wfzyx/meepo - Intent Router & Dynamic Tool Pruner
 * Powered by Von 1.3.5 (OptionMarker System One) with heuristic fallback
 * Scheme 1: router, chat, tools, code, cloud
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
    if (this.config.roles.router.enabled) {
      const choices = {
        chat: 'Conversational chit-chat, high-level question, explanation, general synthesis',
        tools: 'Terminal/shell command execution, filesystem exploration, file management, system administration',
        code: 'Writing code, refactoring a function, implementing an algorithm, syntax bug fix',
        cloud: 'Complex architectural dispute, concurrency race, deadlock, repeated failure, deep design review',
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
          reason: `Von 1.3.5 single-pass classification (${Math.round(confidence * 100)}% confidence)`,
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

    // Cloud escalation triggers
    for (const trigger of this.config.policy.cloudEscalationTriggers) {
      if (p.includes(trigger.replace('_', ' '))) {
        return 'cloud';
      }
    }
    if (p.includes('deadlock') || p.includes('race condition') || p.includes('architecture decision') || p.includes('advisor')) {
      return 'cloud';
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
      return 'code';
    }

    // Tools triggers (ops/shell)
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
      return 'tools';
    }

    // Default to Chat for general conversational reasoning
    return 'chat';
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
      case 'chat':
        essentialTools = new Set(['web_search', 'web_fetch', 'read', 'ask']);
        break;
      case 'tools':
        essentialTools = new Set(['bash', 'read', 'write', 'edit', 'undo_last_edit']);
        break;
      case 'code':
        essentialTools = new Set(['read', 'edit', 'write', 'lsp_diagnostics', 'undo_last_edit']);
        break;
      case 'cloud':
        essentialTools = new Set(['meepo_ask_cloud', 'ask']);
        break;
      default:
        essentialTools = new Set(availableTools);
    }

    // Always preserve Meepo built-in tools
    essentialTools.add('meepo_ask_cloud');
    essentialTools.add('meepo_generate_code');

    const allowed = availableTools.filter((t) => essentialTools.has(t));
    const pruned = availableTools.filter((t) => !essentialTools.has(t));

    return { allowed, pruned };
  }
}
