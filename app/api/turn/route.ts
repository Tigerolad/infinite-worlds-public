import { after } from "next/server";
import { z } from "zod";
import { track } from "@/lib/analytics";
import { hasAccess } from "@/lib/beta/access";
import { createClient } from "@/lib/supabase/server";
import { refreshChronicle } from "@/lib/turn/chronicle";
import { runTurn, type TurnErrorCode, type TurnEvent, type TurnOutcome } from "@/lib/turn/run";

// POST /api/turn — plays one turn. Responds with newline-delimited JSON
// TurnEvents: narration deltas while the model writes, then "done" or "error".

export const maxDuration = 60;

const bodySchema = z.object({
  campaignId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
  action: z.string().max(2000),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("birthdate_confirmed_18, beta_access")
    .eq("id", user.id)
    .single();
  if (!hasAccess(profile)) return Response.json({ error: "Complete onboarding first" }, { status: 403 });

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Invalid request" }, { status: 400 });

  // Analytics and the chronicle refresh run after the response has finished streaming.
  let turnFinished!: (outcome: TurnOutcome | null) => void;
  const finished = new Promise<TurnOutcome | null>((resolve) => (turnFinished = resolve));
  let failure: TurnErrorCode | null = null;
  after(async () => {
    const outcome = await finished;
    if (outcome) await track(user.id, "turn_played", outcome.analytics);
    else if (failure) await track(user.id, "turn_failed", { campaign_id: body.data.campaignId, code: failure });
    if (outcome?.refreshChronicle) {
      await refreshChronicle(body.data.campaignId, user.id).catch((e) => console.error("chronicle refresh crashed", e));
    }
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: TurnEvent) => {
        if (e.type === "error") failure = e.code;
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      };
      try {
        turnFinished((await runTurn({ userId: user.id, ...body.data }, emit)) ?? null);
      } catch (e) {
        console.error("turn crashed", e);
        emit({ type: "error", code: "failed", message: "Something went wrong with that turn. You weren't charged. Try again." });
      } finally {
        turnFinished(null); // no-op if already resolved
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
