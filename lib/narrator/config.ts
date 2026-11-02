import type { OutputConfig, ThinkingConfigParam } from "@anthropic-ai/sdk/resources/messages";

// Model routing and pricing (architecture doc §7.1, §10). Change models here only.

export type Tier = "premium" | "free";

export type ModelConfig = {
  model: string;
  maxTokens: number;
  thinking?: ThinkingConfigParam;
  effort?: OutputConfig["effort"];
};

export const NARRATOR: Record<Tier, ModelConfig> = {
  premium: {
    model: "claude-sonnet-5-5",
    maxTokens: 2000,
    // Thinking off (Sonnet 5.5 rejects {type: "disabled"}) and low effort to keep
    // latency and cost down. Try adaptive thinking in the beta for quality.
    thinking: { type: "between_tools" },
    effort: "low",
  },
  free: {
    model: "claude-haiku-4-5",
    maxTokens: 2000,
  },
};

export const SUMMARIZER: ModelConfig = { model: "claude-haiku-4-5", maxTokens: 1200 };

/** USD per million tokens. Cache writes use the 5-minute TTL rate (1.25× input). */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function costUsd(model: string, u: TokenUsage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price for model ${model}; add it to PRICES`);
  const cost =
    u.input_tokens * p.input +
    u.output_tokens * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    (u.cache_creation_input_tokens ?? 0) * p.cacheWrite;
  return cost / 1e6;
}
