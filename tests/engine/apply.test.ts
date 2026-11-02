import { beforeAll, describe, expect, it } from "vitest";
import { applyChanges } from "@/lib/engine/apply";
import { loadWorld } from "@/lib/worlds/load";
import type { GameState, World } from "@/lib/worlds/schema";

let world: World;
let start: GameState;

beforeAll(async () => {
  world = await loadWorld("sundered-crown");
  // minor-lord: day 1 at vane.holdfast, 80 gold, reputation 10, house_vane 60
  start = world.origins.origins.find((o) => o.id === "minor-lord")!.starting_state;
});

const r = "test";
const run = (changes: unknown[], state = start) => applyChanges(state, changes, world);
const reasons = (res: ReturnType<typeof run>) => res.rejected.map((x) => x.reason);

describe("general", () => {
  it("does not mutate the input state", () => {
    const before = structuredClone(start);
    run([{ op: "adjust_gold", delta: 50, reason: r }]);
    expect(start).toEqual(before);
  });

  it("rejects malformed and unknown ops but keeps applying the rest", () => {
    const res = run([
      { op: "grant_throne", reason: r },
      { op: "adjust_gold", delta: "lots", reason: r },
      { op: "adjust_gold", delta: 10, reason: r },
    ]);
    expect(res.applied).toHaveLength(1);
    expect(reasons(res)).toEqual(["malformed change", "malformed change"]);
    expect(res.state.player.gold).toBe(90);
  });

  it("applies nothing once the player is dead", () => {
    const res = run([
      { op: "set_player_health", value: "dead", reason: r },
      { op: "adjust_gold", delta: 10, reason: r },
    ]);
    expect(res.state.player.health).toBe("dead");
    expect(reasons(res)).toEqual(["player is dead"]);
  });
});

describe("factions", () => {
  it("adjusts loyalty and derives status", () => {
    const res = run([{ op: "adjust_faction_loyalty", target: "house_calder", delta: -20, reason: r }]);
    expect(res.state.factions.house_calder).toEqual({ loyalty: -20, status: "wary" });
  });

  it("rejects unknown factions", () => {
    const res = run([{ op: "adjust_faction_loyalty", target: "house_starke", delta: 5, reason: r }]);
    expect(reasons(res)).toEqual(["unknown faction house_starke"]);
  });

  it("caps loyalty cumulatively per faction per turn", () => {
    const res = run([
      { op: "adjust_faction_loyalty", target: "house_marrow", delta: 15, reason: r },
      { op: "adjust_faction_loyalty", target: "house_marrow", delta: 10, reason: r },
      { op: "adjust_faction_loyalty", target: "house_lisle", delta: 20, reason: r },
    ]);
    expect(res.state.factions.house_marrow.loyalty).toBe(15);
    expect(res.state.factions.house_lisle.loyalty).toBe(20);
    expect(res.rejected).toHaveLength(1);
  });

  it("clamps loyalty to ±100", () => {
    const state = structuredClone(start);
    state.factions.house_vane.loyalty = 95;
    const res = run([{ op: "adjust_faction_loyalty", target: "house_vane", delta: 20, reason: r }], state);
    expect(res.state.factions.house_vane).toEqual({ loyalty: 100, status: "allied" });
  });
});

describe("characters", () => {
  it("kills an unprotected character and records when", () => {
    const res = run([{ op: "set_character_alive", target: "brother_tomas", value: false, reason: "ambushed on the high road" }]);
    expect(res.state.characters.brother_tomas).toMatchObject({ alive: false, died_day: 1, cause: "ambushed on the high road" });
  });

  it("adds a cast character to state on first mention", () => {
    const res = run([{ op: "adjust_disposition", target: "master_quill", delta: 10, reason: r }]);
    expect(res.state.characters.master_quill).toEqual({ alive: true, disposition: 10, known_secrets: [] });
  });

  it("never revives the dead or lets them be adjusted", () => {
    const state = structuredClone(start);
    state.characters.brother_tomas.alive = false;
    const res = run(
      [
        { op: "set_character_alive", target: "brother_tomas", value: true, reason: r },
        { op: "adjust_disposition", target: "brother_tomas", delta: 5, reason: r },
      ],
      state,
    );
    expect(reasons(res)).toEqual(["dead characters cannot be revived", "brother_tomas is dead"]);
  });

  it("protects characters until their unlock flag is set", () => {
    const kill = { op: "set_character_alive", target: "regent_osric", value: false, reason: r };
    expect(reasons(run([kill]))).toEqual(["regent_osric is protected and cannot die yet"]);

    const unlocked = structuredClone(start);
    unlocked.flags.chapter3_council_convened = true;
    expect(run([kill], unlocked).state.characters.regent_osric.alive).toBe(false);
  });

  it("does not let the narrator set a protection-unlock flag", () => {
    const res = run([
      { op: "set_flag", flag: "chapter3_council_convened", value: true, reason: r },
      { op: "set_character_alive", target: "regent_osric", value: false, reason: r },
    ]);
    expect(res.applied).toHaveLength(0);
    expect(res.state.characters.regent_osric.alive).toBe(true);
  });

  it("rejects unknown characters", () => {
    expect(reasons(run([{ op: "set_character_alive", target: "jon_snow", value: false, reason: r }]))).toEqual([
      "unknown character jon_snow",
    ]);
  });
});

describe("player", () => {
  it("caps gold per turn and never goes negative", () => {
    expect(reasons(run([{ op: "adjust_gold", delta: 10000, reason: r }]))).toEqual(["gold change exceeds ±200 per turn"]);
    expect(reasons(run([{ op: "adjust_gold", delta: -81, reason: r }]))).toEqual(["player cannot afford this"]);
    expect(run([{ op: "adjust_gold", delta: -80, reason: r }]).state.player.gold).toBe(0);
  });

  it("a rejected purchase does not use up the gold cap", () => {
    const res = run([
      { op: "adjust_gold", delta: -150, reason: r },
      { op: "adjust_gold", delta: 200, reason: r },
    ]);
    expect(res.state.player.gold).toBe(280);
  });

  it("caps reputation per turn", () => {
    const res = run([
      { op: "adjust_reputation", delta: 10, reason: r },
      { op: "adjust_reputation", delta: 10, reason: r },
    ]);
    expect(res.state.player.reputation).toBe(20);
    expect(res.rejected).toHaveLength(1);
  });

  it("only removes items the player owns", () => {
    const res = run([
      { op: "remove_item", item: "dragon_egg", reason: r },
      { op: "remove_item", item: "signet_ring", reason: r },
      { op: "add_item", item: "poisoned_vial", reason: r },
      { op: "add_item", item: "poisoned_vial", reason: r },
    ]);
    expect(res.state.player.inventory).toEqual(["summons_from_regent", "poisoned_vial"]);
    expect(reasons(res)).toEqual(["player does not have dragon_egg", "player already has poisoned_vial"]);
  });
});

describe("world", () => {
  it("moves only to adjacent locations, once per turn", () => {
    const res = run([
      { op: "move_location", to: "capital.ashen_hall", reason: r },
      { op: "move_location", to: "high_road.waystation", reason: r },
      { op: "move_location", to: "capital.gate", reason: r },
    ]);
    expect(res.state.location).toBe("high_road.waystation");
    expect(reasons(res)).toEqual([
      "capital.ashen_hall is not reachable from vane.holdfast",
      "only one move per turn",
    ]);
  });

  it("advances time forward only, within the cap", () => {
    const res = run([
      { op: "advance_time", days: 0, reason: r },
      { op: "advance_time", days: 3, reason: r },
      { op: "advance_time", days: 5, reason: r },
    ]);
    expect(res.state.day).toBe(4);
    expect(res.rejected).toHaveLength(2);
  });

  it("adds and completes quests", () => {
    const res = run([
      { op: "add_quest", text: "Find the ambushers", reason: r },
      { op: "complete_quest", text: "Answer the Regent's summons", reason: r },
      { op: "complete_quest", text: "Win the war", reason: r },
    ]);
    expect(res.state.quest_log).toEqual(["Find the ambushers"]);
    expect(reasons(res)).toEqual(["no such quest in log"]);
  });

  it("sets ordinary flags", () => {
    expect(run([{ op: "set_flag", flag: "met_quill", value: true, reason: r }]).state.flags).toEqual({ met_quill: true });
  });
});

describe("timed flags", () => {
  it("sets the council flag from day 40, which unprotects the regent", () => {
    const day39 = { ...structuredClone(start), day: 39 };
    const before = run(
      [
        { op: "advance_time", days: 1, reason: r },
        { op: "set_character_alive", target: "regent_osric", value: false, reason: r },
      ],
      day39,
    );
    expect(before.state.flags.chapter3_council_convened).toBe(true);
    expect(reasons(before)).toEqual(["regent_osric is protected and cannot die yet"]);

    const after = run([{ op: "set_character_alive", target: "regent_osric", value: false, reason: r }], before.state);
    expect(after.state.characters.regent_osric.alive).toBe(false);
  });

  it("cannot be set by the narrator", () => {
    const res = run([{ op: "set_flag", flag: "chapter3_council_convened", value: true, reason: r }]);
    expect(res.state.flags.chapter3_council_convened).toBeUndefined();
  });
});
