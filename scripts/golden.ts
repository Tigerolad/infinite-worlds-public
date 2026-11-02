// Golden-turn regression run (architecture doc §15). Plays every scenario in
// evals/golden/<world>.json against the real narrator, checks the results and
// writes a report to evals/results/ for a manual quality read.
//
// Usage: npm run golden                     premium tier (Sonnet, as configured)
//        npm run golden -- --free           free tier (Haiku)
//        npm run golden -- --thinking       Sonnet with adaptive thinking, for comparison
//        npm run golden -- --only move-too-far,inject-gold
// A full run of 30 scenarios costs roughly $0.30 on Sonnet.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeStage } from "@/lib/art/stage";
import { applyChanges } from "@/lib/engine/apply";
import { buildState, checkTurn, goldenSetSchema, type Scenario } from "@/lib/evals/golden";
import { NARRATOR, type ModelConfig, type Tier } from "@/lib/narrator/config";
import { narrate } from "@/lib/narrator/narrate";
import { loadWorld } from "@/lib/worlds/load";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const CONCURRENCY = 4;

type Outcome = {
  scenario: Scenario;
  failures: string[];
  error?: string;
  narration?: string;
  choices?: string[];
  stage?: string;
  applied?: unknown[];
  rejected?: { change: unknown; reason: string }[];
  retries: number;
  latencyMs: number;
  costUsd: number;
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (use --env-file=.env.local)");
  const worldId = arg("world") ?? "sundered-crown";
  const world = await loadWorld(worldId);
  const set = goldenSetSchema.parse(
    JSON.parse(await readFile(path.join(process.cwd(), "evals", "golden", `${worldId}.json`), "utf8")),
  );
  const only = arg("only")?.split(",");
  const scenarios = only ? set.scenarios.filter((s) => only.includes(s.id)) : set.scenarios;
  if (!scenarios.length) throw new Error("No scenarios selected");

  const tier: Tier = process.argv.includes("--free") ? "free" : "premium";
  let config: ModelConfig = NARRATOR[tier];
  let label = config.model;
  if (process.argv.includes("--thinking")) {
    config = { ...NARRATOR.premium, thinking: { type: "adaptive" }, maxTokens: 8000 };
    label += "-thinking";
  }
  console.log(`Running ${scenarios.length} golden turns on ${label}…`);

  const run = async (s: Scenario): Promise<Outcome> => {
    const state = buildState(world, s);
    const started = Date.now();
    try {
      const res = await narrate({
        world,
        tier,
        config,
        state,
        chronicle: s.chronicle ?? `Opening situation: ${world.origins.origins.find((o) => o.id === s.origin)!.pitch}`,
        recentTurns: s.recent ?? [],
        action: s.action,
      });
      const base = {
        scenario: s,
        retries: res.calls.length - 1,
        latencyMs: Date.now() - started,
        costUsd: res.calls.reduce((sum, c) => sum + c.cost_usd, 0),
      };
      if (!res.ok) return { ...base, failures: [`turn failed: ${res.reason}`], error: res.detail };
      const { state: after, applied, rejected } = applyChanges(state, res.output.state_changes, world);
      const { stage, issues } = normalizeStage(world, res.output, after);
      const retried = res.calls.slice(0, -1).map((c) => `retried after ${c.stop_reason ?? "error"}`);
      return {
        ...base,
        failures: [...checkTurn(s, res.output, applied, rejected, issues), ...retried],
        narration: res.output.narration,
        choices: res.output.choices,
        stage: `${stage.background}${stage.cg ? ` · CG ${stage.cg}` : ""} · ${
          stage.on_stage.map((c) => `${c.character} (${c.expression})`).join(", ") || "nobody on stage"
        }`,
        applied,
        rejected,
      };
    } catch (e) {
      return { scenario: s, failures: ["API error"], error: String(e), retries: 0, latencyMs: Date.now() - started, costUsd: 0 };
    }
  };

  // The first call writes the prompt cache; the rest read it.
  const outcomes: Outcome[] = [await run(scenarios[0])];
  report(outcomes[0]);
  const queue = scenarios.slice(1);
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        const o = await run(s);
        outcomes.push(o);
        report(o);
      }
    }),
  );
  outcomes.sort((a, b) => scenarios.indexOf(a.scenario) - scenarios.indexOf(b.scenario));

  const passed = outcomes.filter((o) => !o.failures.length).length;
  const cost = outcomes.reduce((sum, o) => sum + o.costUsd, 0);
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const median = latencies[Math.floor(latencies.length / 2)];
  const proposed = outcomes.reduce((n, o) => n + (o.applied?.length ?? 0) + (o.rejected?.length ?? 0), 0);
  const rejectedCount = outcomes.reduce((n, o) => n + (o.rejected?.length ?? 0), 0);
  const summary =
    `${passed}/${outcomes.length} passed · rejection rate ${proposed ? ((100 * rejectedCount) / proposed).toFixed(1) : 0}% ` +
    `(${rejectedCount}/${proposed}) · retries ${outcomes.reduce((n, o) => n + o.retries, 0)} · ` +
    `median latency ${(median / 1000).toFixed(1)}s · cost $${cost.toFixed(3)}`;

  const file = path.join(
    process.cwd(),
    "evals",
    "results",
    `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${label}.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, markdown(world.meta.id, world.meta.version, label, summary, outcomes));
  console.log(`\n${summary}\nReport: ${path.relative(process.cwd(), file)}`);
  if (passed < outcomes.length) process.exitCode = 1;
}

function report(o: Outcome) {
  const mark = o.failures.length ? "✗" : "✓";
  console.log(`${mark} ${o.scenario.id} (${(o.latencyMs / 1000).toFixed(1)}s)${o.failures.length ? ": " + o.failures.join("; ") : ""}`);
}

function markdown(worldId: string, version: string, label: string, summary: string, outcomes: Outcome[]): string {
  const rows = outcomes.map(
    (o) =>
      `| ${o.failures.length ? "✗" : "✓"} | ${o.scenario.id} | ${o.failures.join("; ").replace(/\|/g, "\\|") || ""} | ${o.retries} | ${(o.latencyMs / 1000).toFixed(1)}s | $${o.costUsd.toFixed(4)} |`,
  );
  const details = outcomes.map((o) =>
    [
      `## ${o.failures.length ? "✗" : "✓"} ${o.scenario.id}`,
      `_${o.scenario.about}_`,
      `**Action:** ${o.scenario.action}`,
      o.failures.length ? `**Failures:** ${o.failures.join("; ")}` : "",
      o.error ? `**Error:** ${o.error}` : "",
      o.narration ? `**Narration:**\n\n${o.narration.split("\n").map((l) => `> ${l}`).join("\n")}` : "",
      o.stage ? `**Stage:** ${o.stage}` : "",
      o.choices ? `**Choices:** ${o.choices.map((c, i) => `${i + 1}. ${c}`).join(" · ")}` : "",
      o.applied?.length ? `**Applied:**\n${o.applied.map((c) => `- \`${JSON.stringify(c)}\``).join("\n")}` : "",
      o.rejected?.length
        ? `**Rejected:**\n${o.rejected.map((r) => `- ${r.reason}: \`${JSON.stringify(r.change)}\``).join("\n")}`
        : "",
      "**Quality (fill in by hand):** ☐ good ☐ acceptable ☐ poor — ",
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
  return `# Golden turns: ${worldId}@${version} on ${label}

${new Date().toISOString()}

**${summary}**

| | Scenario | Failures | Retries | Latency | Cost |
|---|---|---|---|---|---|
${rows.join("\n")}

${details.join("\n\n---\n\n")}
`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
