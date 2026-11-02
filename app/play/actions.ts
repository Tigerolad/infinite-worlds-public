"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { track } from "@/lib/analytics";
import { hasAccess } from "@/lib/beta/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { findBannedTerms } from "@/lib/narrator/ip-filter";
import { getWorld } from "@/lib/worlds/load";

const WORLD_ID = "sundered-crown";
const MAX_ACTIVE_CAMPAIGNS = 10;

export async function createCampaign(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/play");

  const { data: profile } = await supabase
    .from("profiles")
    .select("birthdate_confirmed_18, beta_access")
    .eq("id", user.id)
    .single();
  if (!hasAccess(profile)) redirect("/onboarding");

  const world = await getWorld(WORLD_ID);
  const origin = world.origins.origins.find((o) => o.id === formData.get("origin_id"));
  const name = String(formData.get("character_name") ?? "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 40);
  if (!origin || !name) redirect("/play?error=new_story");
  // The name goes into every prompt; a banned one would fail every turn.
  if (findBannedTerms([name], world.bannedTerms).length) redirect("/play?error=name_taken");

  const { count } = await supabase
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  if ((count ?? 0) >= MAX_ACTIVE_CAMPAIGNS) redirect("/play?error=too_many");

  const state = structuredClone(origin.starting_state);
  state.player.name = name;

  const { data, error } = await createAdminClient()
    .from("campaigns")
    .insert({
      user_id: user.id,
      world_id: world.meta.id,
      world_version: world.meta.version,
      origin_id: origin.id,
      state,
      chronicle_summary: `Opening situation: ${origin.pitch}`,
    })
    .select("id")
    .single();
  if (error) throw error;

  after(() => track(user.id, "story_started", { origin: origin.id, world: world.meta.id }));
  redirect(`/play/${data.id}`);
}
