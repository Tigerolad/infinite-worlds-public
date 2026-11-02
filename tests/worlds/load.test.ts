import { describe, expect, it } from "vitest";
import { loadWorld, parseBannedTerms, validateWorld } from "@/lib/worlds/load";

describe("sundered-crown world files", () => {
  it("load and pass all cross-file checks", async () => {
    const world = await loadWorld("sundered-crown");
    expect(world.meta.id).toBe("sundered-crown");
    expect(world.origins.origins.length).toBeGreaterThan(0);
    expect(world.bannedTerms).toContain("Westeros");
  });
});

describe("validateWorld", () => {
  it("catches unknown IDs, one-way adjacency and banned terms in lore", async () => {
    const world = await loadWorld("sundered-crown");
    const broken = structuredClone(world);
    broken.cast.characters.push({
      id: "ghost",
      name: "Ghost",
      faction: "house_nowhere",
      protected: false,
      description: "",
    });
    broken.locations.locations[0].adjacent.push("capital.council_chamber");
    broken.origins.origins[0].starting_state.characters["nobody"] = {
      alive: true,
      disposition: 0,
      known_secrets: [],
    };
    broken.lore += "\nA tale from Westeros.";
    broken.cast.characters[0].description += " Rides to Winterfell.";
    delete broken.origins.origins[0].starting_state.factions.house_lisle;
    broken.origins.origins[0].starting_state.factions.house_marrow = { loyalty: 30, status: "neutral" };

    const errors = validateWorld(broken).join("\n");
    expect(errors).toMatch(/unknown faction house_nowhere/);
    expect(errors).toMatch(/one-way/);
    expect(errors).toMatch(/unknown character nobody/);
    expect(errors).toMatch(/lore.md contains banned term "Westeros"/);
    expect(errors).toMatch(/cast.json contains banned term "Winterfell"/);
    expect(errors).toMatch(/missing faction house_lisle/);
    expect(errors).toMatch(/house_marrow status should be "friendly"/);
  });
});

describe("banned-term matching in world text", () => {
  it("matches whole words only", async () => {
    const world = await loadWorld("sundered-crown");
    const broken = structuredClone(world);
    broken.lore += "\nIn service to the Regency, the sergeant served.";
    expect(validateWorld(broken)).toEqual([]);
  });
});

describe("parseBannedTerms", () => {
  it("skips comments and blank lines", () => {
    expect(parseBannedTerms("# c\n\n Foo \nBar\n")).toEqual(["Foo", "Bar"]);
  });
});
