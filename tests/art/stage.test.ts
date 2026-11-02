import { beforeAll, describe, expect, it } from "vitest";
import { legacyStage, normalizeStage, viewStage } from "@/lib/art/stage";
import { loadWorld } from "@/lib/worlds/load";
import type { GameState, World } from "@/lib/worlds/schema";

let world: World;
let state: GameState;
const withArt = (...files: string[]): World => ({ ...world, artFiles: new Set(files) });

beforeAll(async () => {
  world = await loadWorld("sundered-crown");
  state = structuredClone(world.origins.origins.find((o) => o.id === "minor-lord")!.starting_state);
});

describe("normalizeStage", () => {
  it("keeps a valid stage", () => {
    const proposed = {
      background: "vane.holdfast",
      cg: "",
      on_stage: [{ character: "lord_harlan_vane", expression: "angry" }],
    };
    expect(normalizeStage(world, proposed, state)).toEqual({
      stage: { background: "vane.holdfast", cg: null, on_stage: proposed.on_stage },
      issues: [],
    });
  });

  it("drops what the world doesn't allow and says why", () => {
    const dead = structuredClone(state);
    dead.characters.brother_tomas.alive = false;
    const { stage, issues } = normalizeStage(
      world,
      {
        background: "capital.throne_room",
        cg: "event.dragon",
        on_stage: [
          { character: "brother_tomas", expression: "neutral" },
          { character: "bette_garran", expression: "smiling" },
          { character: "lord_harlan_vane", expression: "smug" },
          { character: "lord_harlan_vane", expression: "angry" },
          { character: "wenna_holt", expression: "neutral" },
          { character: "regent_osric", expression: "neutral" },
        ],
      },
      dead,
    );
    expect(stage).toEqual({
      background: "vane.holdfast", // the current location
      cg: null,
      on_stage: [
        { character: "lord_harlan_vane", expression: "neutral" },
        { character: "wenna_holt", expression: "neutral" },
      ],
    });
    expect(issues).toEqual([
      "unknown background capital.throne_room",
      "unknown cg event.dragon",
      "dead character on stage brother_tomas",
      "unknown character on stage bette_garran",
      "unknown expression smug",
      "more than 2 on stage",
    ]);
  });
});

describe("viewStage", () => {
  const stage = {
    background: "vane.holdfast",
    cg: "event.duel",
    on_stage: [{ character: "lord_harlan_vane", expression: "angry" }],
  };

  it("uses each image that exists", () => {
    const w = withArt("bg/vane-holdfast.webp", "cg/event-duel.webp", "sprites/lord-harlan-vane-angry.webp");
    expect(viewStage(w, stage)).toEqual({
      background: { tag: "vane.holdfast", url: "/scenes/sundered-crown/bg/vane-holdfast.webp" },
      cg: { tag: "event.duel", url: "/scenes/sundered-crown/cg/event-duel.webp" },
      on_stage: [
        { ...stage.on_stage[0], url: "/scenes/sundered-crown/sprites/lord-harlan-vane-angry.webp" },
      ],
    });
  });

  it("falls back to the default background and the neutral sprite, or nothing", () => {
    const w = withArt("bg/bg-default.webp", "sprites/lord-harlan-vane-neutral.webp");
    const view = viewStage(w, stage);
    expect(view.background.url).toBe("/scenes/sundered-crown/bg/bg-default.webp");
    expect(view.cg).toBeNull();
    expect(view.on_stage[0].url).toBe("/scenes/sundered-crown/sprites/lord-harlan-vane-neutral.webp");

    const bare = viewStage(withArt(), stage);
    expect(bare.background.url).toBeNull();
    expect(bare.on_stage[0].url).toBeNull(); // shown as a nameplate
  });
});

describe("legacyStage", () => {
  it("maps old scene tags to a background or a CG", () => {
    expect(legacyStage(world, "vane.holdfast", null).background).toBe("vane.holdfast");
    expect(legacyStage(world, "event.duel", null)).toMatchObject({ cg: "event.duel", background: "bg.default" });
    expect(legacyStage(world, "portrait.regent_osric", null).background).toBe("bg.default");
  });
});

describe("art spec", () => {
  it("has a background for every location and sprites for the core cast", () => {
    const bgs = new Set(world.art.backgrounds.map((b) => b.tag));
    for (const l of world.locations.locations) expect(bgs).toContain(l.id);
    expect(world.art.sprites.map((s) => s.character)).toHaveLength(8);
    expect(Object.keys(world.art.expressions)).toEqual(["neutral", "angry", "afraid", "smiling"]);
  });
});
