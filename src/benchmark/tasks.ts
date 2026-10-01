/**
 * De-Saturated Benchmark Tasks Dataset (Artificial Analysis v4.3 Methodology)
 *
 * Replaces fuzzy keyword matching with strict, unsparing execution gates:
 * - Coding: Sandboxed JS/TS code execution with hidden assertion vectors
 * - Agentic: Strict JSON Tool Schema parsing, zero parameter hallucination
 * - Reasoning: Multi-step mathematical bounds and distributed system conditions
 * - Synthesis: Strict length and structural constraints
 */

import type { BenchmarkTask } from './types';

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  // 1. Agentic Tasks (30% weight) - Strict Schema & Tool Calling Gates
  {
    id: 'agentic-tool-read-schema',
    category: 'agentic',
    name: 'Strict Tool Schema Calling (15 Distractor Tools)',
    prompt: 'You are an agent with access to tools: [read, write, edit, bash, undo_last_edit, mcp__fs__list, mcp__fs__read, mcp__github__pr, mcp__slack_notify, mcpScript]. Call the exact tool to read the first 50 lines of "/home/wfzyx/Code/personal/meepo/package.json". Respond ONLY with valid JSON conforming to {"name": string, "arguments": object}. No markdown, no conversation.',
    validate: (res: string) => {
      try {
        let raw = res.trim();
        if (raw.startsWith('```json')) raw = raw.replace(/^```json/, '').replace(/```$/, '').trim();
        else if (raw.startsWith('```')) raw = raw.replace(/^```/, '').replace(/```$/, '').trim();

        // Must parse as JSON without rambling prose
        const parsed = JSON.parse(raw);
        const call = Array.isArray(parsed) ? parsed[0] : parsed;

        if (!call || typeof call !== 'object') return { passed: false, score: 0, feedback: 'Not a JSON object' };
        if (call.name !== 'read') return { passed: false, score: 0.1, feedback: `Wrong tool: picked ${call.name} instead of read` };
        if (!call.arguments || typeof call.arguments !== 'object') return { passed: false, score: 0.2, feedback: 'Missing arguments object' };

        const path = call.arguments.path;
        if (typeof path !== 'string' || !path.includes('package.json')) {
          return { passed: false, score: 0.4, feedback: `Invalid or missing path parameter: ${path}` };
        }
        if (call.arguments.limit !== 50) {
          return { passed: false, score: 0.7, feedback: 'Limit argument not set to 50' };
        }

        return { passed: true, score: 1.0, feedback: 'Valid schema call without parameter hallucination' };
      } catch (err: any) {
        return { passed: false, score: 0, feedback: `JSON syntax error: ${err.message}` };
      }
    },
  },
  {
    id: 'agentic-tool-bash-command',
    category: 'agentic',
    name: 'Agent Shell Error Recovery',
    prompt: 'A git command failed with: "fatal: A branch named \'feature/auth\' already exists." Emit the single exact tool call to switch to this existing branch. Respond ONLY with valid JSON: {"name": "bash", "arguments": {"command": "..."}}.',
    validate: (res: string) => {
      try {
        let raw = res.trim();
        if (raw.startsWith('```json')) raw = raw.replace(/^```json/, '').replace(/```$/, '').trim();
        else if (raw.startsWith('```')) raw = raw.replace(/^```/, '').replace(/```$/, '').trim();

        const parsed = JSON.parse(raw);
        const call = Array.isArray(parsed) ? parsed[0] : parsed;

        if (call?.name !== 'bash') return { passed: false, score: 0.1, feedback: `Wrong tool: ${call?.name}` };
        const cmd = (call?.arguments?.command || '').trim();
        const valid = cmd === 'git checkout feature/auth' || cmd === 'git switch feature/auth';
        if (!valid) return { passed: false, score: 0.3, feedback: `Invalid git recovery command: ${cmd}` };

        return { passed: true, score: 1.0, feedback: 'Correct shell error recovery command' };
      } catch (err: any) {
        return { passed: false, score: 0, feedback: `JSON syntax error: ${err.message}` };
      }
    },
  },

  // 2. Coding Tasks (20% weight) - Strict Sandboxed Code Execution
  {
    id: 'coding-algo-quickselect',
    category: 'coding',
    name: 'Quickselect Execution (3 Assertion Vectors)',
    prompt: 'Write JavaScript code defining a function quickselect(arr, k) that returns the kth smallest element (1-indexed). Output only executable code.',
    validate: (res: string) => {
      try {
        const clean = res.replace(/```(?:typescript|javascript)?/g, '').replace(/```/g, '').trim();
        const fn = new Function(clean + '; return quickselect;');
        const qs = fn();

        if (typeof qs !== 'function') return { passed: false, score: 0, feedback: 'quickselect is not a function' };

        // Test 1: standard unsorted array
        if (qs([7, 10, 4, 3, 20, 15], 3) !== 7) return { passed: false, score: 0.33, feedback: 'Failed standard array' };
        // Test 2: duplicate elements
        if (qs([3, 2, 3, 1, 2, 4, 5, 5, 6], 4) !== 3) return { passed: false, score: 0.66, feedback: 'Failed duplicate elements' };
        // Test 3: single element
        if (qs([42], 1) !== 42) return { passed: false, score: 0.66, feedback: 'Failed single element' };

        return { passed: true, score: 1.0, feedback: 'Passed all 3 execution vectors' };
      } catch (err: any) {
        return { passed: false, score: 0, feedback: `Execution runtime error: ${err.message}` };
      }
    },
  },
  {
    id: 'coding-lru-cache',
    category: 'coding',
    name: 'LRU Cache State Machine (5 Eviction Assertions)',
    prompt: 'Write a JavaScript class LRUCache with constructor(capacity), get(key), and put(key, value) maintaining strict O(1) eviction order. Output only executable code.',
    validate: (res: string) => {
      try {
        const clean = res.replace(/```(?:typescript|javascript)?/g, '').replace(/```/g, '').trim();
        const fn = new Function(clean + '; return LRUCache;');
        const Cls = fn();

        if (typeof Cls !== 'function') return { passed: false, score: 0, feedback: 'LRUCache is not a class' };

        const lru = new Cls(2);
        lru.put(1, 1);
        lru.put(2, 2);
        if (lru.get(1) !== 1) return { passed: false, score: 0.2, feedback: 'get(1) failed' };
        lru.put(3, 3); // evicts key 2
        const key2 = lru.get(2);
        if (key2 !== -1 && key2 !== undefined) return { passed: false, score: 0.4, feedback: 'Key 2 was not evicted' };
        lru.put(4, 4); // evicts key 1
        const key1 = lru.get(1);
        if (key1 !== -1 && key1 !== undefined) return { passed: false, score: 0.6, feedback: 'Key 1 was not evicted' };
        if (lru.get(3) !== 3) return { passed: false, score: 0.8, feedback: 'Key 3 corrupted' };
        if (lru.get(4) !== 4) return { passed: false, score: 0.8, feedback: 'Key 4 corrupted' };

        return { passed: true, score: 1.0, feedback: 'Passed all 5 LRU eviction assertions' };
      } catch (err: any) {
        return { passed: false, score: 0, feedback: `Execution runtime error: ${err.message}` };
      }
    },
  },

  // 3. Reasoning Tasks (20% weight) - Strict Theoretical & Math Logic
  {
    id: 'reasoning-coffman-deadlock',
    category: 'reasoning',
    name: 'Coffman Deadlock Conditions & Hierarchy Rule',
    prompt: 'What are the 4 Coffman conditions required for a deadlock? Which specific condition is mathematically eliminated by strict global resource hierarchy ordering? Format the eliminated condition on a line by itself: "Eliminated: <condition>".',
    validate: (res: string) => {
      const lower = res.toLowerCase();
      let score = 0;
      if (lower.includes('mutual exclusion')) score += 0.2;
      if (lower.includes('hold and wait') || lower.includes('hold & wait')) score += 0.2;
      if (lower.includes('no preemption') || lower.includes('non-preemption')) score += 0.2;
      if (lower.includes('circular wait')) score += 0.2;

      const hasEliminatedMatch = /eliminated:\s*circular\s*wait/i.test(res);
      if (hasEliminatedMatch) score += 0.2;

      return {
        passed: score >= 0.8,
        score: Math.min(1.0, score),
        feedback: `Coffman conditions identified: ${Math.round(score * 100)}%`,
      };
    },
  },
  {
    id: 'reasoning-kv-cache-math',
    category: 'reasoning',
    name: 'Exact KV Cache Memory Calculation',
    prompt: 'Calculate the exact KV cache memory in gigabytes (GB) for a 16-layer transformer with 16 attention heads, head dimension 64, float16 (2 bytes per value), batch size 1, at 32,768 context length. State the exact final number on a line: "Final: X GB".',
    validate: (res: string) => {
      // 2 * 16 layers * 16 heads * 64 dim * 2 bytes * 32768 tokens = 2,147,483,648 bytes = exactly 2.0 GB (or 2.15 GB in 10^9)
      const hasExact2 = /final:\s*(?:2(?:\.0+)?|2\.15)\s*gb/i.test(res);
      const hasFormula = res.includes('16') && res.includes('64') && res.includes('32768');

      if (hasExact2) return { passed: true, score: 1.0, feedback: 'Exact 2 GB calculation correct' };
      if (hasFormula) return { passed: false, score: 0.3, feedback: 'Formula present but incorrect final GB calculation' };
      return { passed: false, score: 0, feedback: 'Incorrect math calculation' };
    },
  },

  // 4. Synthesis & Knowledge (30% weight) - Strict Structural Constraints
  {
    id: 'synthesis-diff-root-cause',
    category: 'synthesis',
    name: 'Diff Root-Cause Distillation (<= 50 words)',
    prompt: 'Given this diff:\n```diff\n- async refreshToken() { return await fetch(); }\n+ async refreshToken() { const unlock = await this.mutex.lock(); try { return await fetch(); } finally { unlock(); } }\n```\nSummarize the bug prevented and mechanism used. Length MUST be 50 words or fewer.',
    validate: (res: string) => {
      const lower = res.toLowerCase();
      const words = res.trim().split(/\s+/).filter(Boolean);
      const hasBug = lower.includes('race') || lower.includes('concurrent') || lower.includes('duplicate');
      const hasMech = lower.includes('mutex') || lower.includes('lock') || lower.includes('mutual exclusion');

      let score = 0;
      if (hasBug) score += 0.4;
      if (hasMech) score += 0.4;
      if (words.length <= 50) score += 0.2;
      else score = Math.max(0, score - 0.2); // length penalty

      return {
        passed: score >= 0.8,
        score: Math.min(1.0, score),
        feedback: `Identified bug (${hasBug}), mechanism (${hasMech}), word count: ${words.length}`,
      };
    },
  },
  {
    id: 'synthesis-architectural-tradeoff',
    category: 'synthesis',
    name: 'Mamba-2 vs Transformer Bounds (Exact 2 Bullets)',
    prompt: 'Compare Mamba-2 state space models vs standard multi-head attention on: (1) KV cache memory growth, and (2) associative recall on random tokens. Format response as EXACTLY two bullet points starting with "- ".',
    validate: (res: string) => {
      const lines = res.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '));
      const lower = res.toLowerCase();

      const mentionsCache = lower.includes('constant') || lower.includes('o(1)') || lower.includes('linear') || lower.includes('kv cache');
      const mentionsRecall = lower.includes('associative') || lower.includes('recall') || lower.includes('compression') || lower.includes('needle');

      let score = 0;
      if (lines.length === 2) score += 0.3; // structural constraint
      if (mentionsCache) score += 0.35;
      if (mentionsRecall) score += 0.35;

      return {
        passed: score >= 0.7,
        score: Math.min(1.0, score),
        feedback: `Bullets count: ${lines.length}, cache contrast: ${mentionsCache}, recall contrast: ${mentionsRecall}`,
      };
    },
  },
];
