import { describe, expect, it } from "vitest";
import { dailySpendLimitUsd } from "@/lib/billing/quota";
import { checkReport, dailyReportSchema, type DailyReport } from "@/lib/billing/report";

const model = {
  model: "claude-sonnet-5-5",
  calls: 100,
  retries: 2,
  failed_calls: 1,
  turns: 99,
  cost_usd: 1.0,
  summarize_usd: 0,
  input_tokens: 20_000,
  cache_read_tokens: 800_000,
  cache_write_tokens: 10_000,
  p50_ms: 6500,
  p95_ms: 11000,
};

const healthy: DailyReport = {
  day: "2026-10-05",
  spend_usd: 1.0,
  month_to_date_usd: 5,
  total_usd: 20,
  turns: 99,
  players: 12,
  new_players: 3,
  proposed_changes: 150,
  rejected_changes: 2,
  models: [model],
  feedback: [],
};

const limits = { dailySpendUsd: 15, budgetUsd: 250 };

describe("checkReport", () => {
  it("has no alerts on a healthy day", () => {
    const { lines, alerts } = checkReport(healthy, limits);
    expect(alerts).toEqual([]);
    expect(lines.join("\n")).toContain("99 turns · 12 players · 3 new");
  });

  it("alerts on spend near the daily cap and the budget", () => {
    const { alerts } = checkReport({ ...healthy, spend_usd: 13, total_usd: 210 }, limits);
    expect(alerts).toHaveLength(2);
  });

  it("alerts on expensive turns, broken caching, slow turns and rejections", () => {
    const bad = { ...model, cost_usd: 3, cache_read_tokens: 1000, p95_ms: 25_000 };
    const { alerts } = checkReport({ ...healthy, models: [bad], rejected_changes: 20 }, limits);
    expect(alerts.join("\n")).toMatch(/\/turn/);
    expect(alerts.join("\n")).toMatch(/cache hit rate/);
    expect(alerts.join("\n")).toMatch(/p95/);
    expect(alerts.join("\n")).toMatch(/rejection rate/);
  });

  it("leaves summaries out of the cost per turn", () => {
    const haiku = { ...model, model: "claude-haiku-4-5", cost_usd: 1.5, summarize_usd: 1.0, turns: 100 };
    expect(checkReport({ ...healthy, models: [haiku] }, limits).alerts).toEqual([]);
  });

  it("ignores rates on tiny samples", () => {
    const quiet = { ...model, calls: 3, turns: 3, failed_calls: 2, cost_usd: 0.03 };
    const r = { ...healthy, turns: 3, proposed_changes: 4, rejected_changes: 3, models: [quiet] };
    expect(checkReport(r, limits).alerts).toEqual([]);
  });

  it("parses the SQL function's JSON, where numerics arrive as strings", () => {
    const r = dailyReportSchema.parse({
      ...healthy,
      spend_usd: "1.234500",
      models: [{ ...model, cost_usd: "1.0", p50_ms: null }],
    });
    expect(r.spend_usd).toBe(1.2345);
    expect(r.models[0].p50_ms).toBeNull();
  });
});

describe("dailySpendLimitUsd", () => {
  it("defaults to $15, and 0 turns it off", () => {
    expect(dailySpendLimitUsd(undefined)).toBe(15);
    expect(dailySpendLimitUsd("")).toBe(15);
    expect(dailySpendLimitUsd("40")).toBe(40);
    expect(dailySpendLimitUsd("0")).toBeNull();
    expect(dailySpendLimitUsd("nope")).toBeNull();
  });
});
