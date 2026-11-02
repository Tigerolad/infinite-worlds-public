// Daily cost check (architecture doc §10 Alerts).
//
// Usage: npm run costs                     yesterday (UTC)
//        npm run costs -- --today          today so far
//        npm run costs -- --day 2026-10-05
//
// Exits with code 1 when there are alerts, so the scheduled GitHub Action
// (.github/workflows/daily-costs.yml) fails and GitHub emails you.

import { createClient } from "@supabase/supabase-js";
import { dailySpendLimitUsd } from "@/lib/billing/quota";
import { checkReport, dailyReportSchema } from "@/lib/billing/report";

function pickDay(): string {
  const i = process.argv.indexOf("--day");
  if (i > 0) {
    const day = process.argv[i + 1] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("--day needs a date like 2026-10-05");
    return day;
  }
  const d = new Date();
  if (!process.argv.includes("--today")) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await db.rpc("daily_report", { p_day: pickDay() });
  if (error) throw error;
  const { lines, alerts } = checkReport(dailyReportSchema.parse(data), {
    dailySpendUsd: dailySpendLimitUsd(),
    budgetUsd: Number(process.env.API_BUDGET_USD || 250),
  });

  console.log(lines.join("\n"));
  if (alerts.length) {
    console.log(`\n${alerts.length} alert${alerts.length > 1 ? "s" : ""}:\n${alerts.map((a) => `  ! ${a}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("\nNo alerts.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
