import Link from "next/link";
import { redirect } from "next/navigation";
import { hasAccess } from "@/lib/beta/access";
import { todayUtc, turnsRemaining, type Balance } from "@/lib/billing/quota";
import { createClient } from "@/lib/supabase/server";
import { getWorld } from "@/lib/worlds/load";
import { createCampaign } from "./actions";

const ERRORS: Record<string, string> = {
  new_story: "Choose an origin and a name for your character.",
  name_taken: "That name belongs to another story. Choose an original one.",
  too_many: "You have 10 stories in progress. Finish one before starting another.",
};

export default async function PlayPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/play");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, birthdate_confirmed_18, beta_access, plan")
    .eq("id", user.id)
    .single();
  if (!profile || !hasAccess(profile)) redirect("/onboarding");

  const [{ data: campaigns }, { data: balance }, world] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, origin_id, state, turn_count, status, updated_at")
      .order("updated_at", { ascending: false }),
    supabase.from("turn_balances").select("*").eq("user_id", user.id).single<Balance>(),
    getWorld("sundered-crown"),
  ]);
  const left = balance ? turnsRemaining(balance, profile.plan, todayUtc()) : null;
  const originTitle = new Map(world.origins.origins.map((o) => [o.id, o.title]));

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 px-4 py-12">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Welcome, {profile.display_name}</h1>
        <form action="/auth/signout" method="post">
          <button className="text-sm underline">Sign out</button>
        </form>
      </header>

      {left && (
        <p className="text-sm text-neutral-500">
          {left.intro > 0
            ? `${left.intro} free story turns left in your first chapter, then ${left.daily} free turns a day.`
            : `${left.monthly + left.pack} premium turns · ${left.daily} free turns left today.`}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Your stories</h2>
        {campaigns?.length ? (
          <ul className="flex flex-col gap-2">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/play/${c.id}`}
                  className="block rounded border border-neutral-300 p-3 hover:border-neutral-500 dark:border-neutral-700"
                >
                  <span className="font-medium">{c.state.player.name}</span>
                  <span className="text-neutral-500">
                    {" "}· {originTitle.get(c.origin_id) ?? c.origin_id} · day {c.state.day} · turn {c.turn_count}
                    {c.status !== "active" && ` · ${c.status}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-neutral-500">No stories yet.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">Begin a new story in {world.meta.title}</h2>
        <form action={createCampaign} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-2">
            {world.origins.origins.map((o, i) => (
              <label
                key={o.id}
                className="flex gap-3 rounded border border-neutral-300 p-3 has-[:checked]:border-neutral-900 dark:border-neutral-700 dark:has-[:checked]:border-neutral-100"
              >
                <input type="radio" name="origin_id" value={o.id} defaultChecked={i === 0} className="mt-1" />
                <span>
                  <span className="font-medium">{o.title}</span>
                  <span className="block text-sm text-neutral-500">{o.pitch}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1 text-sm">
            Your character&apos;s name
            <input
              name="character_name"
              required
              maxLength={40}
              placeholder="Aldric Vane"
              className="rounded border border-neutral-400 bg-transparent px-3 py-2"
            />
          </label>
          <button className="w-fit rounded bg-neutral-900 px-4 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900">
            Begin
          </button>
          {error && <p className="text-sm text-red-600">{ERRORS[error] ?? "Something went wrong."}</p>}
        </form>
      </section>
    </main>
  );
}
