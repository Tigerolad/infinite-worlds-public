import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { stateChangeSchema } from "@/lib/engine/changes";
import { buildState, checkTurn, goldenSetSchema, type Scenario } from "@/lib/evals/golden";
import { loadWorld } from "@/lib/worlds/load";
import type { World } from "@/lib/worlds/schema";

let world: World;
let scenarios: Scenario[];

beforeAll(async () => {
  world = await loadWorld("sundered-crown");
  scenarios = goldenSetSchema.parse(JSON.parse(await readFile("evals/golden/sundered-crown.json", "utf8"))).scenarios;
});

describe("golden set", () => {
  it("has 30 unique scenarios with valid states and patterns", () => {
    expect(scenarios).toHaveLength(30);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    const ops = new Set(stateChangeSchema.options.map((o) => o.shape.op.options[0]));
    for (const s of scenarios) {
      expect(() => buildState(world, s), s.id).not.toThrow();
      for (const re of [...(s.expect?.text ?? []), ...(s.expect?.not_text ?? [])]) new RegExp(re, "i");
      for (const op of [...(s.expect?.ops ?? []), ...(s.expect?.no_ops ?? []).map((m) => m.op)]) {
        expect(ops, `${s.id}: ${op}`).toContain(op);
      }
    }
  });
});

describe("checkTurn", () => {
  const scenario: Scenario = {
    id: "t",
    about: "",
    origin: "minor-lord",
    action: "x",
    expect: {
      ops: ["adjust_gold"],
      no_ops: [{ op: "set_character_alive", target: "regent_osric" }],
      not_text: ["prince (is )?alive"],
    },
  };
  const narration = Array(100).fill("word").join(" ");
  const good = { narration, choices: ["a", "b", "c"], background: "bg.default", cg: "", on_stage: [], state_changes: [] };
  const gold = { op: "adjust_gold", delta: -2, reason: "bribe" } as const;

  it("passes a turn that meets every expectation", () => {
    expect(checkTurn(scenario, good, [gold], [])).toEqual([]);
  });

  it("reports each failed expectation", () => {
    const kill = { op: "set_character_alive", target: "regent_osric", value: false, reason: "stab" };
    const bad = { ...good, narration: "Short. The prince is alive.", choices: ["a"], state_changes: [kill] };
    expect(checkTurn(scenario, bad, [], [{ change: kill, reason: "protected" }], ["dead character on stage x"])).toEqual([
      "stage: dead character on stage x",
      "narration is 5 words",
      "1 choices",
      "rejected: protected",
      "no adjust_gold",
      `proposed ${JSON.stringify(kill)}`,
      'contains "prince is alive"',
    ]);
  });
});
