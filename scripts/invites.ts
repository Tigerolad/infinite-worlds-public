// Closed-beta invite codes.
//
// Usage: npm run invites                                  list codes and uses
//        npm run invites -- create 10                     10 single-use codes
//        npm run invites -- create 1 --uses 25 --note discord --expires 2026-11-30
//
// Each code prints with its invite link. The link signs the player in and
// fills the code in for them.

import { randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { CODE_ALPHABET } from "@/lib/beta/access";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function newCode(): string {
  const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  return `CROWN-${part()}-${part()}`;
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const link = (code: string) => `${site}/onboarding?code=${code}`;

  if (args[0] === "create") {
    const count = Number(args[1] ?? 1);
    const uses = Number(flag("uses") ?? 1);
    const expires = flag("expires");
    if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error("create needs a count from 1 to 500");
    if (!Number.isInteger(uses) || uses < 1) throw new Error("--uses needs a whole number");
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) throw new Error("--expires needs a date like 2026-11-30");

    const rows = Array.from({ length: count }, () => ({
      code: newCode(),
      max_uses: uses,
      note: flag("note") ?? null,
      expires_at: expires ? `${expires}T23:59:59Z` : null,
    }));
    const { error } = await db.from("invite_codes").insert(rows);
    if (error) throw error;
    console.log(`Created ${count} code${count > 1 ? "s" : ""} (${uses} use${uses > 1 ? "s" : ""} each):\n`);
    for (const r of rows) console.log(`${r.code}  ${link(r.code)}`);
    return;
  }

  const { data, error } = await db
    .from("invite_codes")
    .select("code, note, max_uses, uses, expires_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!data.length) return console.log("No invite codes yet. Create some with: npm run invites -- create 10");
  const used = data.reduce((n, c) => n + c.uses, 0);
  console.log(`${data.length} codes · ${used} redeemed\n`);
  for (const c of data) {
    const expired = c.expires_at && new Date(c.expires_at) < new Date();
    const state = expired ? "expired" : c.uses >= c.max_uses ? "used up" : "open";
    console.log(`${c.code}  ${c.uses}/${c.max_uses}  ${state.padEnd(7)}  ${c.note ?? ""}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
