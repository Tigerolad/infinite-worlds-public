// Per-turn limits (architecture doc §7.3). Caps are cumulative per target within
// one turn, so two +15 loyalty changes to the same house count as +30.

export const CAPS = {
  loyaltyPerTurn: 20,
  dispositionPerTurn: 20,
  goldPerTurn: 200,
  reputationPerTurn: 15,
  daysPerTurn: 7,
  movesPerTurn: 1,
  inventorySize: 20,
  activeQuests: 10,
  questTextLength: 140,
  flagCount: 200,
} as const;

export const SCORE_RANGE = { min: -100, max: 100 } as const;

export type FactionStatus = "allied" | "friendly" | "neutral" | "wary" | "hostile";

/** Faction status is derived from loyalty so the two can never disagree. */
export function statusForLoyalty(loyalty: number): FactionStatus {
  if (loyalty >= 50) return "allied";
  if (loyalty >= 20) return "friendly";
  if (loyalty > -20) return "neutral";
  if (loyalty > -50) return "wary";
  return "hostile";
}

export function clampScore(n: number): number {
  return Math.max(SCORE_RANGE.min, Math.min(SCORE_RANGE.max, n));
}
