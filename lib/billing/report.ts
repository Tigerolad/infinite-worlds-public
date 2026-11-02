import { z } from "zod";

// Daily cost checks (architecture doc §10 Alerts). The numbers come from the
// daily_report SQL function; this turns them into a readable report and a list
// of alerts. Thresholds are set from the golden runs: ~$0.01 per premium turn,
// ~6–7s median latency, 0% rejected changes.

export const THRESHOLDS = {
  /** Share of DAILY_SPEND_LIMIT_USD spent in one day. */
  dailySpendShare: 0.8,
  /** Share of API_BUDGET_USD spent in total. */
  budgetShare: 0.8,
  /** USD per turn, excluding chronicle summaries. */
  turnCost: { "claude-sonnet-5-5": 0.02, "claude-haiku-4-5": 0.01 } as Record<string, number>,
  defaultTurnCost: 0.02,
  /** Cached share of input tokens, below which caching is probably broken. */
  minCacheHitRate: 0.5,
  maxRejectionRate: 0.05,
  maxRetryRate: 0.1,
  maxFailureRate: 0.05,
  maxP95Ms: 20_000,
  /** Flagged turns per turn played. */
  maxFlagRate: 0.05,
  /** Rates on fewer events than this are noise. */
  minSample: 20,
};

const num = z.coerce.number().catch(0);

const modelRowSchema = z.object({
  model: z.string(),
  calls: num,
  retries: num,
  failed_calls: num,
  turns: num,
  cost_usd: num,
  summarize_usd: num,
  input_tokens: num,
  cache_read_tokens: num,
  cache_write_tokens: num,
  p50_ms: z.coerce.number().nullable().catch(null),
  p95_ms: z.coerce.number().nullable().catch(null),
});

export const dailyReportSchema = z.object({
  day: z.string(),
  spend_usd: num,
  month_to_date_usd: num,
  total_usd: num,
  turns: num,
  players: num,
  new_players: num,
  proposed_changes: num,
  rejected_changes: num,
  models: z.array(modelRowSchema),
  feedback: z.array(
    z.object({
      turn_id: z.string(),
      category: z.string(),
      reason: z.string().nullable(),
      narration: z.string(),
    }),
  ),
});

export type DailyReport = z.infer<typeof dailyReportSchema>;

export type Limits = { dailySpendUsd: number | null; budgetUsd: number };

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const secs = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)}s`);

export function checkReport(r: DailyReport, limits: Limits): { lines: string[]; alerts: string[] } {
  const t = THRESHOLDS;
  const lines: string[] = [];
  const alerts: string[] = [];

  lines.push(
    `Infinite Worlds · ${r.day} (UTC)`,
    `Spend ${usd(r.spend_usd)}${limits.dailySpendUsd ? ` of ${usd(limits.dailySpendUsd)} daily cap` : ""} · month ${usd(
      r.month_to_date_usd,
    )} · all time ${usd(r.total_usd)} of ${usd(limits.budgetUsd)} budget`,
    `${r.turns} turns · ${r.players} players · ${r.new_players} new`,
  );
  if (limits.dailySpendUsd && r.spend_usd >= limits.dailySpendUsd * t.dailySpendShare) {
    alerts.push(`daily spend ${usd(r.spend_usd)} is ${pct(r.spend_usd / limits.dailySpendUsd)} of the cap`);
  }
  if (r.total_usd >= limits.budgetUsd * t.budgetShare) {
    alerts.push(`total spend ${usd(r.total_usd)} is ${pct(r.total_usd / limits.budgetUsd)} of the budget`);
  }

  for (const m of r.models) {
    const turnCost = m.turns ? (m.cost_usd - m.summarize_usd) / m.turns : 0;
    const inputs = m.input_tokens + m.cache_read_tokens + m.cache_write_tokens;
    const hitRate = inputs ? m.cache_read_tokens / inputs : 0;
    const retryRate = m.calls ? m.retries / m.calls : 0;
    const failureRate = m.calls ? m.failed_calls / m.calls : 0;
    lines.push(
      `  ${m.model}: ${m.turns} turns · ${usd(turnCost)}/turn · cache ${pct(hitRate)} · p50 ${secs(m.p50_ms)} p95 ${secs(
        m.p95_ms,
      )} · retries ${m.retries} · failed ${m.failed_calls}${m.summarize_usd ? ` · summaries ${usd(m.summarize_usd)}` : ""}`,
    );
    const maxCost = t.turnCost[m.model] ?? t.defaultTurnCost;
    if (m.turns >= 5 && turnCost > maxCost) alerts.push(`${m.model} costs ${usd(turnCost)}/turn (limit ${usd(maxCost)})`);
    if (m.calls >= t.minSample && hitRate < t.minCacheHitRate) alerts.push(`${m.model} cache hit rate is ${pct(hitRate)}`);
    if (m.calls >= t.minSample && retryRate > t.maxRetryRate) alerts.push(`${m.model} retry rate is ${pct(retryRate)}`);
    if (m.calls >= t.minSample && failureRate > t.maxFailureRate) alerts.push(`${m.model} failure rate is ${pct(failureRate)}`);
    if (m.calls >= t.minSample && m.p95_ms !== null && m.p95_ms > t.maxP95Ms) alerts.push(`${m.model} p95 latency is ${secs(m.p95_ms)}`);
  }

  const rejection = r.proposed_changes ? r.rejected_changes / r.proposed_changes : 0;
  lines.push(`Rejected state changes: ${r.rejected_changes}/${r.proposed_changes} (${pct(rejection)})`);
  if (r.proposed_changes >= t.minSample && rejection > t.maxRejectionRate) alerts.push(`rejection rate is ${pct(rejection)}`);

  const flagRate = r.turns ? r.feedback.length / r.turns : 0;
  lines.push(`Flagged turns: ${r.feedback.length}`);
  for (const f of r.feedback) {
    lines.push(`  👎 ${f.category}${f.reason ? `: "${f.reason}"` : ""} (turn ${f.turn_id})`, `     ${f.narration.replace(/\s+/g, " ")}…`);
  }
  if (r.turns >= t.minSample && flagRate > t.maxFlagRate) alerts.push(`${pct(flagRate)} of turns were flagged`);

  return { lines, alerts };
}
