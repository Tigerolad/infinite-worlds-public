import "server-only";
import { normalizeStage, viewStage, type StageView } from "@/lib/art/stage";
import { dailySpendLimitUsd, FREE_DAILY_TURNS, INTRO_TURNS, pickBucket, tierForBucket, todayUtc, type Balance } from "@/lib/billing/quota";
import { applyChanges, type RejectedChange } from "@/lib/engine/apply";
import type { StateChange } from "@/lib/engine/changes";
import { narrate, type CallRecord } from "@/lib/narrator/narrate";
import { needsChronicleRefresh } from "@/lib/narrator/summarize";
import { LIMITS } from "@/lib/narrator/prompt";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorld } from "@/lib/worlds/load";
import type { GameState } from "@/lib/worlds/schema";

// Turn orchestrator (architecture doc §4). Streams events to the caller as it
// goes. A turn is charged only if commit_turn succeeds; every model call is
// written to the usage ledger either way.

/** The opening turn has no player input: the narrator sets the scene. */
const OPENING_ACTION = "I take stock of my situation.";

export type TurnView = {
  id: string;
  turn_number: number;
  player_input: string;
  narration: string;
  choices: string[];
  stage: StageView;
  applied_changes: StateChange[];
  rejected_changes: RejectedChange[];
};

export type TurnErrorCode =
  | "not_found"
  | "ended"
  | "busy"
  | "conflict"
  | "invalid_action"
  | "out_of_turns"
  | "paused"
  | "narrator_unavailable"
  | "refused"
  | "failed";

export type TurnEvent =
  | { type: "narration"; text: string }
  | { type: "reset" }
  | { type: "done"; turn: TurnView; state: GameState; status: string; version: number }
  | { type: "error"; code: TurnErrorCode; message: string };

const MESSAGES: Record<TurnErrorCode, string> = {
  not_found: "That story doesn't exist.",
  ended: "This story has ended.",
  busy: "The narrator is still writing your last turn.",
  conflict: "This story changed in another tab. Reload to continue.",
  invalid_action: `Describe what you do in 1–${LIMITS.actionChars} characters.`,
  out_of_turns: "You're out of turns for today.",
  paused: "The narrator has reached today's beta budget and rests until 00:00 UTC. You weren't charged.",
  narrator_unavailable: "The narrator needs a moment. Try again.",
  refused: "The story can't go that way. Try a different action.",
  failed: "Something went wrong with that turn. You weren't charged. Try again.",
};

/** What a committed turn reports back: whether to refresh the chronicle, and
 *  the analytics properties for it. */
export type TurnOutcome = { refreshChronicle: boolean; analytics: Record<string, unknown> };

export async function runTurn(
  req: { userId: string; campaignId: string; expectedVersion: number; action: string },
  emit: (e: TurnEvent) => void,
): Promise<TurnOutcome | void> {
  const db = createAdminClient();
  const fail = (code: TurnErrorCode) => emit({ type: "error", code, message: MESSAGES[code] });

  // [1] Take the per-campaign turn lock (one in-flight turn per campaign).
  const { data: locked, error: lockError } = await db.rpc("lock_campaign_turn", {
    p_campaign_id: req.campaignId,
    p_user_id: req.userId,
  });
  if (lockError) throw lockError;
  const campaign = locked?.[0];
  if (!campaign) {
    const { data: row } = await db
      .from("campaigns")
      .select("status")
      .eq("id", req.campaignId)
      .eq("user_id", req.userId)
      .maybeSingle();
    return fail(!row ? "not_found" : row.status !== "active" ? "ended" : "busy");
  }

  const unlock = () => db.rpc("unlock_campaign_turn", { p_campaign_id: campaign.id });
  const logFailedCalls = async (calls: CallRecord[]) => {
    if (!calls.length) return;
    await db.from("usage_ledger").insert(
      calls.map((c) => ({ ...c, user_id: req.userId, campaign_id: campaign.id, turn_id: null })),
    );
  };

  let committed = false;
  try {
    if (campaign.version !== req.expectedVersion) return fail("conflict");

    const isOpening = campaign.turn_count === 0;
    const action = isOpening ? OPENING_ACTION : req.action.trim();
    if (!action || action.length > LIMITS.actionChars) return fail("invalid_action");

    // Quota and spend checks before any model call (§4 [1], §10).
    const today = todayUtc();
    const spendLimit = dailySpendLimitUsd();
    const [{ data: balance }, { data: profile }, spent] = await Promise.all([
      db.from("turn_balances").select("*").eq("user_id", req.userId).single<Balance>(),
      db.from("profiles").select("plan").eq("id", req.userId).single<{ plan: "free" | "premium" }>(),
      spendLimit === null ? null : db.rpc("spend_since", { p_since: `${today}T00:00:00Z` }),
    ]);
    if (!balance || !profile) return fail("failed");
    if (spent?.error) throw spent.error;
    if (spendLimit !== null && Number(spent?.data ?? 0) >= spendLimit) {
      console.error(`daily spend limit reached: $${spent?.data} of $${spendLimit}`);
      return fail("paused");
    }
    const bucket = pickBucket(balance, profile.plan, today);
    if (!bucket) return fail("out_of_turns");

    // [2] Load context: every turn not yet folded into the chronicle.
    const world = await getWorld(campaign.world_id);
    const { data: recent } = await db
      .from("turns")
      .select("player_input, narration")
      .eq("campaign_id", campaign.id)
      .gt("turn_number", campaign.chronicle_through)
      .order("turn_number", { ascending: false })
      .limit(LIMITS.maxRecentTurns);

    // [3–5] Build context, call the narrator, check output.
    let result;
    try {
      result = await narrate(
        {
          world,
          tier: tierForBucket(bucket),
          state: campaign.state as GameState,
          chronicle: campaign.chronicle_summary,
          recentTurns: (recent ?? []).reverse(),
          action,
        },
        {
          onNarration: (text) => emit({ type: "narration", text }),
          onReset: () => emit({ type: "reset" }),
        },
      );
    } catch (e) {
      console.error("narrator call failed", e);
      return fail("narrator_unavailable");
    }

    if (!result.ok) {
      await logFailedCalls(result.calls);
      console.warn("turn failed", result.reason, result.detail);
      return fail(result.reason === "refusal" ? "refused" : "failed");
    }

    // [6] State engine. [7] Scene art.
    const { output } = result;
    const { state, applied, rejected } = applyChanges(campaign.state as GameState, output.state_changes, world);
    const status = state.player.health === "dead" ? "dead" : "active";
    // Staged against the new state: someone who died this turn leaves the stage.
    const { stage, issues } = normalizeStage(world, output, state);
    if (issues.length) console.warn("stage issues", issues);
    const model = result.calls.at(-1)!.model;

    // [8] Commit everything in one transaction.
    const { data: commitRows, error: commitError } = await db.rpc("commit_turn", {
      p_campaign_id: campaign.id,
      p_user_id: req.userId,
      p_expected_version: req.expectedVersion,
      p_bucket: bucket,
      p_intro_limit: INTRO_TURNS,
      p_daily_limit: FREE_DAILY_TURNS,
      p_state: state,
      p_status: status,
      p_turn: {
        player_input: isOpening ? "" : action,
        narration: output.narration,
        choices: output.choices,
        proposed_changes: output.state_changes,
        applied_changes: applied,
        rejected_changes: rejected,
        scene_tag: stage.background,
        stage: { cg: stage.cg, on_stage: stage.on_stage },
        model,
      },
      p_calls: result.calls,
    });

    if (commitError) {
      await logFailedCalls(result.calls);
      if (commitError.message.includes("version_conflict")) return fail("conflict");
      if (commitError.message.includes("out_of_turns")) return fail("out_of_turns");
      console.error("commit_turn failed", commitError);
      return fail("failed");
    }

    committed = true;
    const { turn_id, turn_number } = commitRows[0];
    emit({
      type: "done",
      turn: {
        id: turn_id,
        turn_number,
        player_input: isOpening ? "" : action,
        narration: output.narration,
        choices: output.choices,
        stage: viewStage(world, stage),
        applied_changes: applied,
        rejected_changes: rejected,
      },
      state,
      status,
      version: req.expectedVersion + 1,
    });
    return {
      refreshChronicle: needsChronicleRefresh(turn_number, campaign.chronicle_through),
      analytics: {
        campaign_id: campaign.id,
        turn_number,
        world: campaign.world_id,
        origin: campaign.origin_id,
        day: state.day,
        bucket,
        model,
        retries: result.calls.length - 1,
        latency_ms: result.calls.reduce((ms, c) => ms + c.latency_ms, 0),
        cost_usd: result.calls.reduce((usd, c) => usd + c.cost_usd, 0),
        proposed_changes: output.state_changes.length,
        rejected_changes: rejected.length,
        stage_issues: issues.length,
        cg: stage.cg !== null,
        died: status === "dead",
      },
    };
  } finally {
    // commit_turn clears the lock itself. Unlocking again after a commit could
    // release a lock the player's next turn has already taken.
    if (!committed) await unlock();
  }
}
