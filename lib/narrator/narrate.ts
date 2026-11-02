import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { GameState, World } from "@/lib/worlds/schema";
import { NARRATOR, costUsd, type ModelConfig, type Tier } from "./config";
import { findBannedTerms } from "./ip-filter";
import { narratorEnvelopeSchema, narratorOutputSchema, type NarratorOutput } from "./output";
import { partialNarration } from "./partial";
import { buildMessages, buildSystem, type RecentTurn } from "./prompt";

// One narrator call plus the retries in architecture doc §7.4. Every call,
// including failed ones, returns a CallRecord for the usage ledger.

export type CallRecord = {
  call_type: "narrate" | "retry" | "summarize";
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  stop_reason: string | null;
};

export type NarrateFailure = "refusal" | "max_tokens" | "invalid_output" | "banned_terms";

export type NarrateResult =
  | { ok: true; output: NarratorOutput; calls: CallRecord[] }
  | { ok: false; reason: NarrateFailure; detail?: string; calls: CallRecord[] };

/** Optional streaming callbacks. onNarration receives each new piece of the
 *  narration text; onReset means discard what was shown (a retry is starting). */
export type NarrateHooks = {
  onNarration?: (delta: string) => void;
  onReset?: () => void;
};

export type NarrateInput = {
  world: World;
  tier: Tier;
  state: GameState;
  chronicle: string;
  recentTurns: RecentTurn[];
  action: string;
  /** Overrides the tier's model settings (golden-turn comparisons only). */
  config?: ModelConfig;
};

let defaultClient: Anthropic | undefined;
export function client(): Anthropic {
  // Reads ANTHROPIC_API_KEY. The SDK retries 429/5xx twice before throwing.
  return (defaultClient ??= new Anthropic({ timeout: 60_000 }));
}

const outputFormat = zodOutputFormat(narratorOutputSchema);

type Attempt =
  | { ok: true; output: NarratorOutput; record: CallRecord }
  | { ok: false; reason: NarrateFailure; detail?: string; record: CallRecord };

async function attempt(
  input: NarrateInput,
  callType: CallRecord["call_type"],
  correction: string | undefined,
  api: Anthropic,
  hooks: NarrateHooks,
): Promise<Attempt> {
  const cfg = input.config ?? NARRATOR[input.tier];
  const started = Date.now();
  const stream = api.messages.stream({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: buildSystem(input.world),
    messages: buildMessages({ ...input, correction, bannedTerms: input.world.bannedTerms }),
    ...(cfg.thinking && { thinking: cfg.thinking }),
    output_config: { format: outputFormat, ...(cfg.effort && { effort: cfg.effort }) },
  });

  if (hooks.onNarration) {
    let raw = "";
    let shown = 0;
    stream.on("text", (delta) => {
      raw += delta;
      const narration = partialNarration(raw);
      if (narration.length > shown) {
        hooks.onNarration!(narration.slice(shown));
        shown = narration.length;
      }
    });
  }
  const response: Message = await stream.finalMessage();

  const u = response.usage;
  const record: CallRecord = {
    call_type: callType,
    model: cfg.model,
    input_tokens: u.input_tokens,
    cache_read_tokens: u.cache_read_input_tokens ?? 0,
    cache_write_tokens: u.cache_creation_input_tokens ?? 0,
    output_tokens: u.output_tokens,
    cost_usd: costUsd(cfg.model, u),
    latency_ms: Date.now() - started,
    stop_reason: response.stop_reason,
  };

  // Check stop_reason before reading content.
  if (response.stop_reason === "refusal") return { ok: false, reason: "refusal", record };
  if (response.stop_reason === "max_tokens") return { ok: false, reason: "max_tokens", record };

  const text = response.content.find((b) => b.type === "text")?.text;
  let parsed;
  try {
    parsed = narratorEnvelopeSchema.safeParse(JSON.parse(text ?? ""));
  } catch {
    return { ok: false, reason: "invalid_output", detail: "not JSON", record };
  }
  if (!parsed.success) return { ok: false, reason: "invalid_output", detail: parsed.error.message, record };

  const banned = findBannedTerms([parsed.data.narration, ...parsed.data.choices], input.world.bannedTerms);
  if (banned.length) return { ok: false, reason: "banned_terms", detail: banned.join(", "), record };

  return { ok: true, output: parsed.data, record };
}

const CORRECTIONS: Partial<Record<NarrateFailure, (detail?: string) => string>> = {
  max_tokens: () =>
    "Your previous response was cut off. Keep the narration under 200 words and list only the essential state changes.",
  invalid_output: () => "Your previous response did not match the required format. Follow the output schema exactly.",
  banned_terms: (d) =>
    `Your previous response used terms that do not exist in this original world (${d}). Rewrite the turn without them or anything resembling them.`,
};

/** Narrates one turn. Retries once on a cut-off, malformed or banned-term
 *  response (§7.4). Refusals are not retried. Network/API errors throw after
 *  the SDK's own retries; the caller shows "the narrator needs a moment". */
export async function narrate(
  input: NarrateInput,
  hooks: NarrateHooks = {},
  api: Anthropic = client(),
): Promise<NarrateResult> {
  const first = await attempt(input, "narrate", undefined, api, hooks);
  if (first.ok) return { ok: true, output: first.output, calls: [first.record] };

  const correction = CORRECTIONS[first.reason]?.(first.detail);
  if (!correction) return { ok: false, reason: first.reason, detail: first.detail, calls: [first.record] };

  hooks.onReset?.();
  const second = await attempt(input, "retry", correction, api, hooks);
  const calls = [first.record, second.record];
  return second.ok
    ? { ok: true, output: second.output, calls }
    : { ok: false, reason: second.reason, detail: second.detail, calls };
}
