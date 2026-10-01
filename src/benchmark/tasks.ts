/**
 * Benchmark Tasks Dataset
 * Structured test vectors modeled after the Artificial Analysis Index evaluations.
 */

import type { BenchmarkTask } from './types';

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  // 1. Agentic Tasks (30% weight)
  {
    id: 'agentic-tool-plan',
    category: 'agentic',
    name: 'Tool Orchestration & Shell Diagnostics',
    prompt: 'You need to locate all failed Vitest tests in the repo and check disk space. Specify the exact tools or commands needed.',
    expectedKeywords: ['test', 'vitest', 'df', 'bash'],
    validate: (res: string) => {
      const lower = res.toLowerCase();
      const hasTest = lower.includes('test') || lower.includes('vitest');
      const hasCmd = lower.includes('df') || lower.includes('bash') || lower.includes('run');
      const score = (hasTest ? 0.5 : 0) + (hasCmd ? 0.5 : 0);
      return { passed: score >= 0.5, score };
    },
  },
  {
    id: 'agentic-mcp-filter',
    category: 'agentic',
    name: 'Tool Discrimination (Core vs MCP Bloat)',
    prompt: 'Given tools [bash, read, edit, mcp__slack_post, mcp__github_pr], which tool should be used to inspect package.json on local disk?',
    expectedKeywords: ['read'],
    validate: (res: string) => {
      const lower = res.toLowerCase();
      const mentionsRead = lower.includes('read');
      const rejectsSlack = !lower.includes('mcp__slack_post') || lower.includes('not mcp');
      const score = (mentionsRead ? 0.7 : 0) + (rejectsSlack ? 0.3 : 0);
      return { passed: mentionsRead, score };
    },
  },

  // 2. Coding Tasks (20% weight)
  {
    id: 'coding-algo',
    category: 'coding',
    name: 'TypeScript Quickselect Algorithm',
    prompt: 'Implement a TypeScript function quickselect(arr: number[], k: number): number that returns the kth smallest element.',
    expectedKeywords: ['function quickselect', 'number', 'partition', 'return'],
    validate: (res: string) => {
      const hasFunc = res.includes('quickselect');
      const hasTypes = res.includes('number[]') && res.includes('number');
      const hasPartition = res.toLowerCase().includes('partition') || res.includes('left') || res.includes('pivot');
      const score = (hasFunc ? 0.4 : 0) + (hasTypes ? 0.3 : 0) + (hasPartition ? 0.3 : 0);
      return { passed: score >= 0.7, score };
    },
  },
  {
    id: 'coding-refactor',
    category: 'coding',
    name: 'Concurrency Mutex Refactor',
    prompt: 'Write a TypeScript class AsyncMutex with acquire(): Promise<() => void> ensuring mutual exclusion.',
    expectedKeywords: ['class AsyncMutex', 'acquire', 'Promise'],
    validate: (res: string) => {
      const hasClass = res.includes('AsyncMutex');
      const hasAcquire = res.includes('acquire');
      const hasPromise = res.includes('Promise');
      const score = (hasClass ? 0.4 : 0) + (hasAcquire ? 0.3 : 0) + (hasPromise ? 0.3 : 0);
      return { passed: score >= 0.7, score };
    },
  },

  // 3. Reasoning Tasks (20% weight)
  {
    id: 'reasoning-deadlock',
    category: 'reasoning',
    name: 'Coffman Deadlock Analysis',
    prompt: 'In a distributed database, transaction T1 holds Lock A and waits for B, while T2 holds Lock B and waits for A. Name the condition and the standard resolution mechanism.',
    expectedKeywords: ['deadlock', 'circular wait', 'detection', 'rollback'],
    validate: (res: string) => {
      const lower = res.toLowerCase();
      const hasDeadlock = lower.includes('deadlock') || lower.includes('circular');
      const hasResolution = lower.includes('abort') || lower.includes('rollback') || lower.includes('wait-die') || lower.includes('timeout') || lower.includes('kill');
      const score = (hasDeadlock ? 0.5 : 0) + (hasResolution ? 0.5 : 0);
      return { passed: score >= 0.5, score };
    },
  },
  {
    id: 'reasoning-associative-recall',
    category: 'reasoning',
    name: 'RNN vs Attention Matrix Bounds',
    prompt: 'Why do fixed-size recurrent state RNNs struggle with multi-needle associative recall across long contexts compared to standard Transformers?',
    expectedKeywords: ['kv cache', 'compression', 'fixed', 'retrieval'],
    validate: (res: string) => {
      const lower = res.toLowerCase();
      const hasCompression = lower.includes('fixed') || lower.includes('compression') || lower.includes('finite');
      const hasKv = lower.includes('kv') || lower.includes('attention') || lower.includes('retrieval') || lower.includes('lookback');
      const score = (hasCompression ? 0.5 : 0) + (hasKv ? 0.5 : 0);
      return { passed: score >= 0.5, score };
    },
  },

  // 4. Synthesis & Knowledge (30% weight)
  {
    id: 'synthesis-diff-prose',
    category: 'synthesis',
    name: 'Diff to Prose Summarization',
    prompt: 'Summarize this change: +export function verify(t: string): boolean { return t.length > 10; }',
    expectedKeywords: ['verify', 'token', 'length', 'boolean'],
    validate: (res: string) => {
      const lower = res.toLowerCase();
      const hasVerify = lower.includes('verify');
      const hasLength = lower.includes('length') || lower.includes('10') || lower.includes('validation');
      const score = (hasVerify ? 0.5 : 0) + (hasLength ? 0.5 : 0);
      return { passed: score >= 0.5, score };
    },
  },
  {
    id: 'synthesis-user-facing',
    category: 'synthesis',
    name: 'User-Facing Architectural Explanation',
    prompt: 'Explain what dynamic tool schema pruning does and why it prevents client timeouts on CPU-only machines in 2 clear sentences.',
    expectedKeywords: ['tokens', 'prefill', 'cpu', 'schema'],
    validate: (res: string) => {
      const lower = res.toLowerCase();
      const hasPrefill = lower.includes('prefill') || lower.includes('tokens') || lower.includes('prompt');
      const hasSpeed = lower.includes('faster') || lower.includes('cpu') || lower.includes('timeout') || lower.includes('latency');
      const score = (hasPrefill ? 0.5 : 0) + (hasSpeed ? 0.5 : 0);
      return { passed: score >= 0.5, score };
    },
  },
];
