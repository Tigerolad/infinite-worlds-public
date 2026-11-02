import "server-only";
import { LIMITS } from "@/lib/narrator/prompt";
import { needsChronicleRefresh, summarize } from "@/lib/narrator/summarize";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWorld } from "@/lib/worlds/load";
import type { GameState } from "@/lib/worlds/schema";

// Background chronicle refresh (architecture doc §4 [9]). Runs after the turn's
// response has finished, so the player never waits for it. Safe to run twice:
// the update only lands if nobody else refreshed the chronicle first.

/** Most turns folded in one call, so a long backlog is caught up in steps. */
const MAX_FOLD = 20;

export async function refreshChronicle(campaignId: string, userId: string): Promise<void> {
  const db = createAdminClient();
  const { data: campaign } = await db
    .from("campaigns")
    .select("world_id, state, chronicle_summary, chronicle_through, turn_count")
    .eq("id", campaignId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!campaign || !needsChronicleRefresh(campaign.turn_count, campaign.chronicle_through)) return;

  const from = campaign.chronicle_through;
  const through = Math.min(campaign.turn_count - LIMITS.keepVerbatim, from + MAX_FOLD);
  const { data: turns, error } = await db
    .from("turns")
    .select("turn_number, player_input, narration")
    .eq("campaign_id", campaignId)
    .gt("turn_number", from)
    .lte("turn_number", through)
    .order("turn_number", { ascending: true });
  if (error) throw error;
  if (!turns?.length) return;

  const world = await getWorld(campaign.world_id);
  let result;
  try {
    result = await summarize({
      world,
      state: campaign.state as GameState,
      chronicle: campaign.chronicle_summary,
      turns,
    });
  } catch (e) {
    console.error("chronicle refresh failed", e);
    return; // retried after the next turn
  }

  await db
    .from("usage_ledger")
    .insert({ ...result.call, user_id: userId, campaign_id: campaignId, turn_id: null });
  if (!result.ok) {
    console.warn("chronicle refresh rejected", result.call.stop_reason);
    return;
  }

  const lastFolded = turns.at(-1)!.turn_number;
  const { error: updateError } = await db
    .from("campaigns")
    .update({ chronicle_summary: result.text, chronicle_through: lastFolded })
    .eq("id", campaignId)
    .eq("chronicle_through", from); // another refresh got there first: keep theirs
  if (updateError) console.error("chronicle update failed", updateError);
}
