import type { Tier } from "@/lib/narrator/config";

// Turn allowances (architecture doc §10, business plan §5). The bucket chosen
// here is passed to commit_turn, which re-checks and charges it atomically.

export const INTRO_TURNS = 40; // free Sonnet turns per player, once ("first chapter")
export const FREE_DAILY_TURNS = 10; // Haiku turns per UTC day after the intro

/** Kill switch for the beta budget ($500 total, §10): no new turns once the
 *  day's model spend (UTC) reaches DAILY_SPEND_LIMIT_USD. 0 turns it off. */
export function dailySpendLimitUsd(env: string | undefined = process.env.DAILY_SPEND_LIMIT_USD): number | null {
  const limit = env === undefined || env === "" ? 15 : Number(env);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

export type Bucket = "intro" | "monthly" | "pack" | "daily";

export type Balance = {
  intro_turns_used: number;
  monthly_allowance: number;
  monthly_used: number;
  pack_credits: number;
  daily_free_used: number;
  daily_reset_on: string; // YYYY-MM-DD (UTC)
};

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function dailyUsed(b: Balance, today: string): number {
  return b.daily_reset_on < today ? 0 : b.daily_free_used;
}

/** Which allowance pays for the next turn, in order of use. null = out of turns. */
export function pickBucket(b: Balance, plan: "free" | "premium", today: string): Bucket | null {
  if (b.intro_turns_used < INTRO_TURNS) return "intro";
  if (plan === "premium" && b.monthly_used < b.monthly_allowance) return "monthly";
  if (b.pack_credits > 0) return "pack";
  if (dailyUsed(b, today) < FREE_DAILY_TURNS) return "daily";
  return null;
}

/** Paid and intro turns get the premium narrator; free daily turns get Haiku. */
export function tierForBucket(bucket: Bucket): Tier {
  return bucket === "daily" ? "free" : "premium";
}

export function turnsRemaining(b: Balance, plan: "free" | "premium", today: string) {
  return {
    intro: Math.max(0, INTRO_TURNS - b.intro_turns_used),
    monthly: plan === "premium" ? Math.max(0, b.monthly_allowance - b.monthly_used) : 0,
    pack: b.pack_credits,
    daily: Math.max(0, FREE_DAILY_TURNS - dailyUsed(b, today)),
  };
}
