import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getWorld } from "@/lib/worlds/load";
import type { GameState } from "@/lib/worlds/schema";
import type { TurnView } from "@/lib/turn/run";
import { legacyStage, viewStage } from "@/lib/art/stage";
import { Story, type Labels } from "./story";

const HISTORY_TURNS = 50;

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=/play/${id}`);

  // RLS: players can only read their own campaigns and turns.
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, world_id, state, status, version, chronicle_summary, chronicle_through")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) notFound();

  const [{ data: turns }, world] = await Promise.all([
    supabase
      .from("turns")
      .select("id, turn_number, player_input, narration, choices, scene_tag, stage, applied_changes, rejected_changes")
      .eq("campaign_id", id)
      .order("turn_number", { ascending: false })
      .limit(HISTORY_TURNS),
    getWorld(campaign.world_id),
  ]);

  // Which of these turns the player has already flagged with 👎.
  const { data: flags } = await supabase
    .from("turn_feedback")
    .select("turn_id")
    .in("turn_id", (turns ?? []).map((t) => t.id));

  const history: TurnView[] = (turns ?? []).reverse().map(({ scene_tag, stage, ...t }) => ({
    ...t,
    stage: viewStage(world, legacyStage(world, scene_tag, stage)),
  }));

  const labels: Labels = {
    locations: Object.fromEntries(world.locations.locations.map((l) => [l.id, l.name])),
    factions: Object.fromEntries(world.cast.factions.map((f) => [f.id, f.name])),
    characters: Object.fromEntries(world.cast.characters.map((c) => [c.id, c.name])),
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <nav className="flex items-center justify-between text-sm">
        <Link href="/play" className="underline">
          ← Your stories
        </Link>
        <span className="text-neutral-500">{world.meta.title}</span>
      </nav>
      <Story
        campaignId={campaign.id}
        initialTurns={history}
        initialState={campaign.state as GameState}
        initialStatus={campaign.status}
        initialVersion={campaign.version}
        initialFlagged={(flags ?? []).map((f) => f.turn_id)}
        chronicle={campaign.chronicle_through > 0 ? campaign.chronicle_summary : null}
        labels={labels}
      />
    </main>
  );
}
