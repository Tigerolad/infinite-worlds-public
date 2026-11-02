import { readFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { statusForLoyalty } from "@/lib/engine/rules";
import { findBannedTerms } from "@/lib/narrator/ip-filter";
import {
  artManifestSchema,
  castSchema,
  locationsSchema,
  originsSchema,
  artSpecSchema,
  spriteFile,
  worldMetaSchema,
  type GameState,
  type World,
} from "./schema";

const WORLDS_DIR = path.join(process.cwd(), "worlds");

/** The lore bible is resent (cached) on every turn; ≈4 characters per token. */
export const LORE_MAX_CHARS = 24_000;

async function readJson<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T>> {
  const raw = JSON.parse(await readFile(file, "utf8"));
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new Error(`${path.relative(process.cwd(), file)}: ${result.error.message}`);
  }
  return result.data;
}

export function parseBannedTerms(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** Loads and validates a world from /worlds/<worldId>. Throws on any problem. */
export async function loadWorld(worldId: string, dir = WORLDS_DIR): Promise<World> {
  const root = path.join(dir, worldId);
  const [meta, lore, cast, locations, origins, art, banned] = await Promise.all([
    readJson(path.join(root, "world.json"), worldMetaSchema),
    readFile(path.join(root, "lore.md"), "utf8"),
    readJson(path.join(root, "cast.json"), castSchema),
    readJson(path.join(root, "locations.json"), locationsSchema),
    readJson(path.join(root, "origins.json"), originsSchema),
    readJson(path.join(root, "art.json"), artSpecSchema),
    readFile(path.join(root, "banned_terms.txt"), "utf8"),
  ]);
  const manifest = await readJson(path.join(root, "art_manifest.json"), artManifestSchema).catch((e) => {
    if (e?.code === "ENOENT") return { files: [] }; // no art yet
    throw e;
  });

  const world: World = {
    meta,
    lore,
    cast,
    locations,
    origins,
    art,
    artFiles: new Set(manifest.files),
    bannedTerms: parseBannedTerms(banned),
  };

  const errors = validateWorld(world);
  if (meta.id !== worldId) errors.unshift(`world.json id "${meta.id}" does not match directory "${worldId}"`);
  if (errors.length) {
    throw new Error(`World "${worldId}" is invalid:\n- ${errors.join("\n- ")}`);
  }
  return world;
}

const worldCache = new Map<string, Promise<World>>();

/** Cached loadWorld for request handlers. World files only change on deploy. */
export function getWorld(worldId: string): Promise<World> {
  let world = worldCache.get(worldId);
  if (!world) {
    world = loadWorld(worldId);
    world.catch(() => worldCache.delete(worldId));
    worldCache.set(worldId, world);
  }
  return world;
}

/** Cross-file checks: every ID referenced anywhere must be defined exactly once. */
export function validateWorld(world: World): string[] {
  const errors: string[] = [];
  const factionIds = uniqueIds("faction", world.cast.factions, errors);
  const characterIds = uniqueIds("character", world.cast.characters, errors);
  const locationIds = uniqueIds("location", world.locations.locations, errors);
  uniqueIds("origin", world.origins.origins, errors);

  for (const c of world.cast.characters) {
    if (c.faction && !factionIds.has(c.faction)) errors.push(`character ${c.id}: unknown faction ${c.faction}`);
  }

  for (const loc of world.locations.locations) {
    for (const next of loc.adjacent) {
      if (!locationIds.has(next)) {
        errors.push(`location ${loc.id}: unknown adjacent location ${next}`);
      } else if (!world.locations.locations.find((l) => l.id === next)!.adjacent.includes(loc.id)) {
        errors.push(`location ${loc.id} → ${next} is one-way; adjacency must be symmetric`);
      }
    }
  }

  const art = world.art;
  uniqueIds("art tag", [...art.backgrounds, ...art.cgs].map((t) => ({ id: t.tag })), errors);
  if (!art.backgrounds.some((b) => b.tag === art.default_background)) {
    errors.push(`art.json: default_background "${art.default_background}" is not a background`);
  }
  for (const l of world.locations.locations) {
    if (!art.backgrounds.some((b) => b.tag === l.id)) errors.push(`art.json: no background for location ${l.id}`);
  }
  for (const s of art.sprites) {
    if (!characterIds.has(s.character)) errors.push(`art.json: sprite for unknown character ${s.character}`);
  }
  if (!("neutral" in art.expressions)) errors.push(`art.json: expressions must include "neutral"`);
  const files = new Set(artFileList(art));
  for (const file of world.artFiles) {
    if (!files.has(file)) errors.push(`art_manifest.json: ${file} is not in art.json (run npm run art)`);
  }

  for (const t of world.meta.timed_flags ?? []) {
    if (world.origins.origins.some((o) => t.flag in o.starting_state.flags)) {
      errors.push(`world.json: timed flag ${t.flag} must not be set in a starting state`);
    }
  }

  for (const origin of world.origins.origins) {
    errors.push(
      ...validateStateRefs(origin.starting_state, { factionIds, characterIds, locationIds }).map(
        (e) => `origin ${origin.id}: ${e}`,
      ),
    );
    if (origin.starting_state.player.origin !== origin.id) {
      errors.push(`origin ${origin.id}: starting_state.player.origin must be "${origin.id}"`);
    }
    for (const f of factionIds) {
      const standing = origin.starting_state.factions[f];
      if (!standing) errors.push(`origin ${origin.id}: missing faction ${f}`);
      else if (standing.status !== statusForLoyalty(standing.loyalty)) {
        errors.push(`origin ${origin.id}: faction ${f} status should be "${statusForLoyalty(standing.loyalty)}"`);
      }
    }
  }

  if (world.lore.length > LORE_MAX_CHARS) {
    errors.push(`lore.md is ${world.lore.length} characters; keep it under ${LORE_MAX_CHARS} (≈6k tokens)`);
  }

  // Everything the narrator sees from the world files must be free of banned terms.
  const sources: [string, string[]][] = [
    ["lore.md", [world.lore]],
    ["cast.json", [...world.cast.factions, ...world.cast.characters].flatMap((x) => [x.name, x.description])],
    ["locations.json", world.locations.locations.map((l) => l.name)],
    ["origins.json", world.origins.origins.flatMap((o) => [o.title, o.pitch, ...o.starting_state.quest_log])],
  ];
  for (const [file, texts] of sources) {
    for (const term of findBannedTerms(texts, world.bannedTerms)) {
      errors.push(`${file} contains banned term "${term}"`);
    }
  }

  return errors;
}

function validateStateRefs(
  state: GameState,
  ids: { factionIds: Set<string>; characterIds: Set<string>; locationIds: Set<string> },
): string[] {
  const errors: string[] = [];
  if (!ids.locationIds.has(state.location)) errors.push(`unknown location ${state.location}`);
  for (const f of Object.keys(state.factions)) {
    if (!ids.factionIds.has(f)) errors.push(`unknown faction ${f}`);
  }
  for (const c of Object.keys(state.characters)) {
    if (!ids.characterIds.has(c)) errors.push(`unknown character ${c}`);
  }
  return errors;
}

/** Every image file art.json describes. */
export function artFileList(art: World["art"]): string[] {
  return [
    ...art.backgrounds.map((b) => b.file),
    ...art.cgs.map((c) => c.file),
    ...art.sprites.flatMap((s) => Object.keys(art.expressions).map((e) => spriteFile(s.character, e))),
  ];
}

function uniqueIds(kind: string, items: { id: string }[], errors: string[]): Set<string> {
  const seen = new Set<string>();
  for (const { id } of items) {
    if (seen.has(id)) errors.push(`duplicate ${kind} id ${id}`);
    seen.add(id);
  }
  return seen;
}
