import { z } from "zod";
import { statusForLoyalty } from "@/lib/engine/rules";
import type { RejectedChange } from "@/lib/engine/apply";
import type { StateChange } from "@/lib/engine/changes";
import type { NarratorOutput } from "@/lib/narrator/output";
import { gameStateSchema, type GameState, type World } from "@/lib/worlds/schema";

// Golden turns (architecture doc §15): fixed scenarios run against the real
// narrator whenever prompts or models change. Automated checks catch format,
// rule and secret-keeping failures; the report is also read by hand for quality.

const opMatch = z.object({ op: z.string() }).catchall(z.unknown());

export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  about: z.string(),
  origin: z.string(),
  state: z
    .object({
      day: z.number().int().positive().optional(),
      location: z.string().optional(),
      gold: z.number().int().nonnegative().optional(),
      health: z.enum(["healthy", "wounded", "gravely_wounded", "dead"]).optional(),
      inventory: z.array(z.string()).optional(),
      loyalty: z.record(z.string(), z.number().int()).optional(),
      characters: z
        .record(z.string(), z.object({ alive: z.boolean().optional(), disposition: z.number().int().optional() }))
        .optional(),
      flags: z.record(z.string(), z.boolean()).optional(),
      quest_log: z.array(z.string()).optional(),
    })
    .optional(),
  chronicle: z.string().optional(),
  recent: z.array(z.object({ player_input: z.string(), narration: z.string() })).optional(),
  action: z.string(),
  expect: z
    .object({
      /** Each op must be among the applied changes. */
      ops: z.array(z.string()).optional(),
      /** No proposed change may match any of these (op plus any listed fields). */
      no_ops: z.array(opMatch).optional(),
      /** Case-insensitive regexes that must / must not match narration or choices. */
      text: z.array(z.string()).optional(),
      not_text: z.array(z.string()).optional(),
      /** Default 0: a good narrator only proposes changes the engine accepts. */
      max_rejected: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const goldenSetSchema = z.object({ world: z.string(), scenarios: z.array(scenarioSchema) });

export type Scenario = z.infer<typeof scenarioSchema>;

export const PLAYER_NAME = "Aldric";

/** The scenario's starting state: its origin's, with the overrides applied. */
export function buildState(world: World, s: Scenario): GameState {
  const origin = world.origins.origins.find((o) => o.id === s.origin);
  if (!origin) throw new Error(`${s.id}: unknown origin ${s.origin}`);
  const state = structuredClone(origin.starting_state);
  state.player.name = PLAYER_NAME;
  const o = s.state ?? {};
  if (o.day) state.day = o.day;
  if (o.location) state.location = o.location;
  if (o.gold !== undefined) state.player.gold = o.gold;
  if (o.health) state.player.health = o.health;
  if (o.inventory) state.player.inventory = o.inventory;
  if (o.quest_log) state.quest_log = o.quest_log;
  Object.assign(state.flags, o.flags);
  for (const [id, loyalty] of Object.entries(o.loyalty ?? {})) {
    state.factions[id] = { loyalty, status: statusForLoyalty(loyalty) };
  }
  for (const [id, c] of Object.entries(o.characters ?? {})) {
    const current = state.characters[id] ?? { alive: true, disposition: 0, known_secrets: [] };
    state.characters[id] = { ...current, ...c, ...(c.alive === false && { died_day: Math.max(1, state.day - 1) }) };
  }

  const known = {
    location: new Set(world.locations.locations.map((l) => l.id)),
    faction: new Set(world.cast.factions.map((f) => f.id)),
    character: new Set(world.cast.characters.map((c) => c.id)),
  };
  const unknown = [
    !known.location.has(state.location) && `location ${state.location}`,
    ...Object.keys(state.factions).map((f) => !known.faction.has(f) && `faction ${f}`),
    ...Object.keys(state.characters).map((c) => !known.character.has(c) && `character ${c}`),
  ].filter(Boolean);
  if (unknown.length) throw new Error(`${s.id}: unknown ${unknown.join(", ")}`);
  return gameStateSchema.parse(state);
}

const WORDS = { min: 80, max: 350 };

/** Automated checks for one narrated turn. Returns the failures, or []. */
export function checkTurn(
  s: Scenario,
  output: NarratorOutput,
  applied: StateChange[],
  rejected: RejectedChange[],
  stageIssues: string[] = [],
): string[] {
  const failures: string[] = stageIssues.map((i) => `stage: ${i}`);
  const e = s.expect ?? {};
  const text = [output.narration, ...output.choices].join("\n");

  const words = output.narration.split(/\s+/).filter(Boolean).length;
  if (words < WORDS.min || words > WORDS.max) failures.push(`narration is ${words} words`);
  if (output.choices.length !== 3) failures.push(`${output.choices.length} choices`);

  const maxRejected = e.max_rejected ?? 0;
  if (rejected.length > maxRejected) {
    failures.push(`rejected: ${rejected.map((r) => r.reason).join("; ")}`);
  }
  for (const op of e.ops ?? []) {
    if (!applied.some((c) => c.op === op)) failures.push(`no ${op}`);
  }
  for (const m of e.no_ops ?? []) {
    const hit = output.state_changes.find(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        Object.entries(m).every(([k, v]) => (c as Record<string, unknown>)[k] === v),
    );
    if (hit) failures.push(`proposed ${JSON.stringify(hit)}`);
  }
  for (const re of e.text ?? []) {
    if (!new RegExp(re, "i").test(text)) failures.push(`missing /${re}/`);
  }
  for (const re of e.not_text ?? []) {
    const m = new RegExp(re, "i").exec(text);
    if (m) failures.push(`contains "${m[0]}"`);
  }
  return failures;
}
