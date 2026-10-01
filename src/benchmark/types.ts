/**
 * Artificial Analysis Intelligence Index - Benchmark Types
 *
 * Implements the Artificial Analysis composite intelligence framework:
 * - Agentic Tasks (30%)
 * - General Knowledge & Synthesis (30%)
 * - Coding Tasks (20%)
 * - Scientific / Logical Reasoning (20%)
 *
 * Measures quality, speed (tokens/s), TTFT (latency), and prefill token efficiency.
 */

import type { BrainRole } from '../types';

export type BenchmarkCategory = 'agentic' | 'synthesis' | 'coding' | 'reasoning';

export interface BenchmarkTask {
  id: string;
  category: BenchmarkCategory;
  name: string;
  prompt: string;
  systemPrompt?: string;
  tools?: Array<{ name: string; description: string; parameters: any }>;
  expectedKeywords?: string[];
  validate?: (response: string) => { passed: boolean; score: number; feedback?: string };
}

export interface MetricSample {
  ttftMs: number;
  totalLatencyMs: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond: number;
  score: number; // 0.0 - 1.0
}

export interface ComponentBenchmarkResult {
  role: BrainRole | 'mesh';
  modelName: string;
  categoryScores: Record<BenchmarkCategory, number>; // 0 - 100
  intelligenceIndex: number; // Weighted composite 0 - 100
  avgTtftMs: number;
  avgTokensPerSec: number;
  avgPrefillTokens: number;
  passRate: number; // Percentage 0 - 100
  sampleCount: number;
}

export interface MeshBenchmarkComparison {
  mesh: ComponentBenchmarkResult;
  components: Record<string, ComponentBenchmarkResult>;
  analysis: {
    prefillReductionPercent: number;
    effectiveTtftMultiplier: number;
    compositeQualityDelta: number;
    summary: string;
  };
  timestamp: string;
}
