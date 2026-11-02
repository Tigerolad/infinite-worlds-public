import "server-only";

// Product analytics (architecture doc §13): PostHog, server-side only. Events
// are sent from our routes, so there is no client script, no cookie and no
// ad-blocker gap. The distinct id is the Supabase user id; no email or other
// personal data is sent. Without POSTHOG_KEY this does nothing.

export type AnalyticsEvent =
  | "signed_in"
  | "onboarded"
  | "story_started"
  | "turn_played"
  | "turn_failed"
  | "turn_flagged";

export async function track(
  userId: string,
  event: AnalyticsEvent,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const key = process.env.POSTHOG_KEY;
  if (!key) return;
  const host = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";
  try {
    const res = await fetch(`${host}/i/v0/e/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        event,
        distinct_id: userId,
        properties: { ...properties, $lib: "infinite-worlds-server" },
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) console.warn("analytics", event, res.status);
    else if (process.env.NODE_ENV === "development") console.log("analytics", event, "sent");
  } catch (e) {
    console.warn("analytics", event, e instanceof Error ? e.message : e);
  }
}
