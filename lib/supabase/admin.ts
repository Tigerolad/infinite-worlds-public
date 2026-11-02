import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Service-role client. Bypasses RLS — use only in server code, and only after
 *  checking who the player is with the regular server client. */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
