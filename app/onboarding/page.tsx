import { redirect } from "next/navigation";
import { hasAccess, inviteOnly } from "@/lib/beta/access";
import { createClient } from "@/lib/supabase/server";
import { completeOnboarding } from "./actions";

const ERRORS: Record<string, string> = {
  age: "You must be 18 or older to play.",
  name: "Choose a display name.",
  invite_missing: "Enter your invite code.",
  invite_invalid: "That invite code isn't valid, has expired or has been used up.",
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; code?: string }>;
}) {
  const { error, code } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/onboarding");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, birthdate_confirmed_18, beta_access")
    .eq("id", user.id)
    .single();
  if (hasAccess(profile)) redirect("/play");
  const needsCode = inviteOnly() && !profile?.beta_access;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Before you begin</h1>
      <form action={completeOnboarding} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Display name
          <input
            name="display_name"
            required
            maxLength={40}
            defaultValue={profile?.display_name ?? ""}
            className="rounded border border-neutral-400 bg-transparent px-3 py-2"
          />
        </label>
        {needsCode && (
          <label className="flex flex-col gap-1 text-sm">
            Invite code
            <input
              name="invite_code"
              required
              maxLength={32}
              defaultValue={code ?? ""}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="CROWN-XXXX-XXXX"
              className="rounded border border-neutral-400 bg-transparent px-3 py-2 font-mono uppercase"
            />
            <span className="text-neutral-500">Infinite Worlds is in closed beta.</span>
          </label>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            name="confirm_18"
            type="checkbox"
            required
            defaultChecked={profile?.birthdate_confirmed_18}
            className="mt-1"
          />
          I confirm I am 18 or older. Stories may include violence and mature themes.
        </label>
        <button className="rounded bg-neutral-900 px-3 py-2 text-white dark:bg-neutral-100 dark:text-neutral-900">
          Continue
        </button>
        {error && <p className="text-sm text-red-600">{ERRORS[error] ?? "Something went wrong."}</p>}
      </form>
    </main>
  );
}
