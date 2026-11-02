"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { track } from "@/lib/analytics";
import { inviteOnly, normalizeCode } from "@/lib/beta/access";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Age gate (§12) and invite code (closed beta). birthdate_confirmed_18 and
 *  beta_access are not writable by players through RLS, so they are set with
 *  the service role after checking who is signed in. */
export async function completeOnboarding(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const displayName = String(formData.get("display_name") ?? "").trim().slice(0, 40);
  const code = normalizeCode(String(formData.get("invite_code") ?? ""));
  const back = (error: string) => redirect(`/onboarding?error=${error}${code ? `&code=${encodeURIComponent(code)}` : ""}`);
  if (formData.get("confirm_18") !== "on") back("age");
  if (!displayName) back("name");

  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ display_name: displayName, birthdate_confirmed_18: true })
    .eq("id", user.id);
  if (error) throw error;

  if (inviteOnly()) {
    if (!code) back("invite_missing");
    const { data: ok, error: redeemError } = await admin.rpc("redeem_invite", { p_user_id: user.id, p_code: code });
    if (redeemError) throw redeemError;
    if (!ok) back("invite_invalid");
  }

  after(() => track(user.id, "onboarded", { invite_code: code || null }));
  redirect("/play");
}
