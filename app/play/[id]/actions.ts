"use server";

import { after } from "next/server";
import { z } from "zod";
import { track } from "@/lib/analytics";
import { FEEDBACK_CATEGORIES, FEEDBACK_REASON_MAX } from "@/lib/feedback/categories";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const flagSchema = z.object({
  turnId: z.uuid(),
  category: z.enum(Object.keys(FEEDBACK_CATEGORIES) as [keyof typeof FEEDBACK_CATEGORIES]),
  reason: z.string().max(FEEDBACK_REASON_MAX * 2),
});

/** 👎 on a turn (§13). Flagging the same turn again replaces the earlier flag. */
export async function flagTurn(input: z.input<typeof flagSchema>): Promise<{ ok: boolean }> {
  const parsed = flagSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const { turnId, category } = parsed.data;
  const reason = parsed.data.reason.trim().slice(0, FEEDBACK_REASON_MAX) || null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false };

  // RLS: this only finds the turn if it belongs to one of the player's campaigns.
  const { data: turn } = await supabase.from("turns").select("id, campaign_id, turn_number").eq("id", turnId).maybeSingle();
  if (!turn) return { ok: false };

  const { error } = await createAdminClient()
    .from("turn_feedback")
    .upsert({ turn_id: turnId, user_id: user.id, category, reason }, { onConflict: "turn_id,user_id" });
  if (error) {
    console.error("flagTurn failed", error);
    return { ok: false };
  }

  after(() =>
    track(user.id, "turn_flagged", {
      campaign_id: turn.campaign_id,
      turn_number: turn.turn_number,
      category,
      has_reason: reason !== null,
    }),
  );
  return { ok: true };
}
