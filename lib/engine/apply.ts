import type { GameState, World } from "@/lib/worlds/schema";
import { stateChangeSchema, type StateChange } from "./changes";
import { CAPS, clampScore, statusForLoyalty } from "./rules";

export type RejectedChange = { change: unknown; reason: string };

export type ApplyResult = {
  state: GameState;
  applied: StateChange[];
  rejected: RejectedChange[];
};

/**
 * The state engine (architecture doc §7.3). Takes the narrator's proposed
 * changes and applies the ones that are valid, in order. Pure: the input state
 * is never mutated. Each change is checked against the state as updated by the
 * changes before it.
 */
export function applyChanges(state: GameState, proposed: unknown[], world: World): ApplyResult {
  const next = structuredClone(state);
  const ctx = new TurnContext(world);
  const applied: StateChange[] = [];
  const rejected: RejectedChange[] = [];

  for (const raw of proposed) {
    const parsed = stateChangeSchema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ change: raw, reason: "malformed change" });
      continue;
    }
    const error = applyOne(next, parsed.data, ctx);
    if (error) rejected.push({ change: raw, reason: error });
    else applied.push(parsed.data);
  }

  // Scripted milestones: the game, not the narrator, sets these.
  for (const t of world.meta.timed_flags ?? []) {
    if (next.day >= t.day) next.flags[t.flag] = true;
  }

  return { state: next, applied, rejected };
}

/** World lookups plus running per-turn totals for cumulative caps. */
class TurnContext {
  readonly factions: Set<string>;
  readonly characters: Map<string, World["cast"]["characters"][number]>;
  readonly locations: Map<string, World["locations"]["locations"][number]>;
  /** Flags that unlock scripted events. Only game code may set these. */
  readonly reservedFlags: Set<string>;
  private totals = new Map<string, number>();

  constructor(world: World) {
    this.factions = new Set(world.cast.factions.map((f) => f.id));
    this.characters = new Map(world.cast.characters.map((c) => [c.id, c]));
    this.locations = new Map(world.locations.locations.map((l) => [l.id, l]));
    this.reservedFlags = new Set([
      ...world.cast.characters.flatMap((c) => (c.unprotected_by_flag ? [c.unprotected_by_flag] : [])),
      ...(world.meta.timed_flags ?? []).map((t) => t.flag),
    ]);
  }

  /** Adds `amount` to the running total for `key`; returns false (and adds
   *  nothing) if that would take the total beyond ±cap. */
  withinCap(key: string, amount: number, cap: number): boolean {
    const total = (this.totals.get(key) ?? 0) + amount;
    if (Math.abs(total) > cap) return false;
    this.totals.set(key, total);
    return true;
  }
}

/** Applies one change to `s` in place. Returns a rejection reason, or null. */
function applyOne(s: GameState, c: StateChange, ctx: TurnContext): string | null {
  if (s.player.health === "dead") return "player is dead";

  switch (c.op) {
    case "adjust_faction_loyalty": {
      if (!ctx.factions.has(c.target)) return `unknown faction ${c.target}`;
      if (!ctx.withinCap(`loyalty:${c.target}`, c.delta, CAPS.loyaltyPerTurn)) {
        return `loyalty change exceeds ±${CAPS.loyaltyPerTurn} per turn`;
      }
      const current = s.factions[c.target]?.loyalty ?? 0;
      const loyalty = clampScore(current + c.delta);
      s.factions[c.target] = { loyalty, status: statusForLoyalty(loyalty) };
      return null;
    }

    case "adjust_disposition": {
      if (!ctx.characters.has(c.target)) return `unknown character ${c.target}`;
      const ch = s.characters[c.target];
      if (ch && !ch.alive) return `${c.target} is dead`;
      if (!ctx.withinCap(`disposition:${c.target}`, c.delta, CAPS.dispositionPerTurn)) {
        return `disposition change exceeds ±${CAPS.dispositionPerTurn} per turn`;
      }
      s.characters[c.target] = {
        ...(ch ?? { alive: true, disposition: 0, known_secrets: [] }),
        disposition: clampScore((ch?.disposition ?? 0) + c.delta),
      };
      return null;
    }

    case "set_character_alive": {
      const def = ctx.characters.get(c.target);
      if (!def) return `unknown character ${c.target}`;
      const ch = s.characters[c.target] ?? { alive: true, disposition: 0, known_secrets: [] };
      if (c.value) return ch.alive ? "character is already alive" : "dead characters cannot be revived";
      if (!ch.alive) return "character is already dead";
      if (def.protected && !(def.unprotected_by_flag && s.flags[def.unprotected_by_flag])) {
        return `${c.target} is protected and cannot die yet`;
      }
      s.characters[c.target] = { ...ch, alive: false, died_day: s.day, cause: c.reason.slice(0, 120) };
      return null;
    }

    case "adjust_gold": {
      if (s.player.gold + c.delta < 0) return "player cannot afford this";
      if (!ctx.withinCap("gold", c.delta, CAPS.goldPerTurn)) {
        return `gold change exceeds ±${CAPS.goldPerTurn} per turn`;
      }
      s.player.gold += c.delta;
      return null;
    }

    case "adjust_reputation": {
      if (!ctx.withinCap("reputation", c.delta, CAPS.reputationPerTurn)) {
        return `reputation change exceeds ±${CAPS.reputationPerTurn} per turn`;
      }
      s.player.reputation = clampScore(s.player.reputation + c.delta);
      return null;
    }

    case "set_player_health":
      s.player.health = c.value;
      return null;

    case "add_item": {
      if (s.player.inventory.includes(c.item)) return `player already has ${c.item}`;
      if (s.player.inventory.length >= CAPS.inventorySize) return "inventory is full";
      s.player.inventory.push(c.item);
      return null;
    }

    case "remove_item": {
      const i = s.player.inventory.indexOf(c.item);
      if (i === -1) return `player does not have ${c.item}`;
      s.player.inventory.splice(i, 1);
      return null;
    }

    case "move_location": {
      const here = ctx.locations.get(s.location);
      if (!ctx.locations.has(c.to)) return `unknown location ${c.to}`;
      if (c.to === s.location) return "player is already there";
      if (!here?.adjacent.includes(c.to)) return `${c.to} is not reachable from ${s.location}`;
      if (!ctx.withinCap("moves", 1, CAPS.movesPerTurn)) return "only one move per turn";
      s.location = c.to;
      return null;
    }

    case "set_flag": {
      if (ctx.reservedFlags.has(c.flag)) return `${c.flag} is controlled by the game, not the narrator`;
      if (!(c.flag in s.flags) && Object.keys(s.flags).length >= CAPS.flagCount) return "too many flags";
      s.flags[c.flag] = c.value;
      return null;
    }

    case "advance_time": {
      if (c.days < 1) return "time can only move forward";
      if (!ctx.withinCap("days", c.days, CAPS.daysPerTurn)) {
        return `cannot advance more than ${CAPS.daysPerTurn} days per turn`;
      }
      s.day += c.days;
      return null;
    }

    case "add_quest": {
      const text = c.text.trim();
      if (!text || text.length > CAPS.questTextLength) return "quest text must be 1–140 characters";
      if (s.quest_log.includes(text)) return "quest already in log";
      if (s.quest_log.length >= CAPS.activeQuests) return "quest log is full";
      s.quest_log.push(text);
      return null;
    }

    case "complete_quest": {
      const i = s.quest_log.indexOf(c.text.trim());
      if (i === -1) return "no such quest in log";
      s.quest_log.splice(i, 1);
      return null;
    }
  }
}
