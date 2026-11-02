// Play The Sundered Crown in the terminal against the real API (no database).
// Usage: npx tsx --env-file=.env.local scripts/play.ts [--free] [--origin minor-lord] [--name Aldric]
// Each turn costs roughly 1–2 cents (Sonnet) or under 1 cent (Haiku, --free).

import { createInterface } from "node:readline/promises";
import { normalizeStage } from "@/lib/art/stage";
import { applyChanges } from "@/lib/engine/apply";
import { narrate } from "@/lib/narrator/narrate";
import { LIMITS, type RecentTurn } from "@/lib/narrator/prompt";
import { summarize } from "@/lib/narrator/summarize";
import { loadWorld } from "@/lib/worlds/load";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (use --env-file=.env.local)");

  const world = await loadWorld("sundered-crown");
  const origin = world.origins.origins.find((o) => o.id === (arg("origin") ?? "minor-lord"));
  if (!origin) throw new Error(`Unknown origin. Choose: ${world.origins.origins.map((o) => o.id).join(", ")}`);

  let state = structuredClone(origin.starting_state);
  state.player.name = arg("name") ?? "Aldric Vane";
  const tier = process.argv.includes("--free") ? "free" : "premium";
  let chronicle = `Opening situation: ${origin.pitch}`;
  let recentTurns: RecentTurn[] = []; // turns not yet folded into the chronicle
  let totalCost = 0;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n${world.meta.title} (${tier} narrator). Type an action, or "quit".\n`);
  let action = "I take stock of my situation.";

  for (;;) {
    process.stdout.write("\n");
    const res = await narrate(
      { world, tier, state, chronicle, recentTurns, action },
      {
        onNarration: (text) => process.stdout.write(text),
        onReset: () => process.stdout.write("\n\n[retrying…]\n\n"),
      },
    );
    const cost = res.calls.reduce((sum, c) => sum + c.cost_usd, 0);
    totalCost += cost;
    const last = res.calls.at(-1)!;

    if (!res.ok) {
      console.log(`\n[turn failed: ${res.reason}${res.detail ? ` (${res.detail})` : ""}]`);
    } else {
      const { state: next, applied, rejected } = applyChanges(state, res.output.state_changes, world);
      state = next;
      recentTurns.push({ player_input: action, narration: res.output.narration });

      console.log("\n");
      res.output.choices.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
      const { stage, issues } = normalizeStage(world, res.output, state);
      const cast = stage.on_stage.map((c) => `${c.character} (${c.expression})`).join(", ") || "nobody";
      console.log(`\n  [background: ${stage.background}${stage.cg ? ` · cg: ${stage.cg}` : ""} · on stage: ${cast}]`);
      for (const i of issues) console.log(`  ! stage: ${i}`);
      for (const c of applied) console.log(`  + ${JSON.stringify(c)}`);
      for (const r of rejected) console.log(`  ✗ ${r.reason}: ${JSON.stringify(r.change)}`);
    }
    console.log(
      `  [${last.model} · ${last.latency_ms}ms · in ${last.input_tokens} / cache read ${last.cache_read_tokens} / ` +
        `cache write ${last.cache_write_tokens} / out ${last.output_tokens} · $${cost.toFixed(4)} · total $${totalCost.toFixed(4)}]`,
    );
    // Same rule as the app: fold older turns into the chronicle every few turns.
    if (recentTurns.length >= LIMITS.summarizeAt) {
      const fold = recentTurns.length - LIMITS.keepVerbatim;
      const s = await summarize({ world, state, chronicle, turns: recentTurns.slice(0, fold) });
      totalCost += s.call.cost_usd;
      if (s.ok) {
        chronicle = s.text;
        recentTurns = recentTurns.slice(fold);
        console.log(`\n  [chronicle updated · ${s.call.latency_ms}ms · $${s.call.cost_usd.toFixed(4)}]\n${chronicle}`);
      } else {
        console.log(`\n  [chronicle refresh failed: ${s.call.stop_reason}]`);
      }
    }
    if (state.player.health === "dead") {
      console.log("\nYou have died. The chronicle ends here.");
      break;
    }

    const input = (await rl.question("\n> ")).trim();
    if (input === "quit") break;
    action = /^[1-9]$/.test(input) && res.ok ? res.output.choices[Number(input) - 1] ?? input : input;
  }

  rl.close();
  console.log(`\nChronicle:\n${chronicle}\n\nFinal state:\n${JSON.stringify(state, null, 2)}\nTotal cost: $${totalCost.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
