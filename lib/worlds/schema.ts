import { z } from "zod";

// World file format (architecture doc §14). One directory per world under
// /worlds/<id>/. These schemas validate each file on load; cross-file checks
// (IDs referenced between files) live in validateWorld() in ./load.ts.

const id = z.string().regex(/^[a-z0-9_.-]+$/, "IDs are lowercase, using a-z 0-9 _ . -");

export const worldMetaSchema = z.object({
  id,
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Use semver, e.g. 0.1.0"),
  title: z.string().min(1),
  genre: z.string().min(1),
  // Flags the game sets itself once the story reaches a given day (e.g. the
  // council convening). The narrator cannot set them.
  timed_flags: z.array(z.object({ flag: id, day: z.number().int().positive() })).optional(),
});

export const castSchema = z.object({
  factions: z.array(
    z.object({ id, name: z.string().min(1), description: z.string() }),
  ),
  characters: z.array(
    z.object({
      id,
      name: z.string().min(1),
      faction: id.optional(), // omitted for unaligned characters
      protected: z.boolean(),
      // A protected character can only die once this state flag is true
      // (e.g. a scripted chapter event). Without it they can never die.
      unprotected_by_flag: id.optional(),
      description: z.string(),
    }),
  ),
});

export const locationsSchema = z.object({
  locations: z.array(
    z.object({
      id,
      name: z.string().min(1),
      region: id,
      adjacent: z.array(id),
    }),
  ),
});

// Canonical game state (architecture doc §5.1). Also the shape stored in
// campaigns.state.
export const gameStateSchema = z.object({
  day: z.number().int().positive(),
  location: id,
  player: z.object({
    name: z.string(),
    origin: id,
    health: z.enum(["healthy", "wounded", "gravely_wounded", "dead"]),
    gold: z.number().int().nonnegative(),
    reputation: z.number().int().min(-100).max(100),
    inventory: z.array(id),
  }),
  factions: z.record(
    z.string(),
    z.object({
      loyalty: z.number().int().min(-100).max(100),
      status: z.enum(["allied", "friendly", "neutral", "wary", "hostile"]),
    }),
  ),
  characters: z.record(
    z.string(),
    z.object({
      alive: z.boolean(),
      disposition: z.number().int().min(-100).max(100),
      known_secrets: z.array(z.string()),
      died_day: z.number().int().positive().optional(),
      cause: z.string().optional(),
    }),
  ),
  flags: z.record(z.string(), z.boolean()),
  quest_log: z.array(z.string()),
});

export const originsSchema = z.object({
  origins: z.array(
    z.object({
      id,
      title: z.string().min(1),
      pitch: z.string().min(1),
      starting_state: gameStateSchema,
    }),
  ),
});

const artImage = z.object({ tag: id, file: z.string(), prompt: z.string() });

/** art.json: the visual-novel art library (architecture doc §9). Backgrounds
 *  have no people in them; CGs are full-screen illustrations for big moments;
 *  sprites are cut-out characters layered over a background. */
export const artSpecSchema = z.object({
  /** Shared style prompt for generating every image. */
  style: z.string(),
  default_background: id,
  /** Midjourney parameters and framing text, per image kind. */
  midjourney: z.object({ background: z.string(), cg: z.string(), sprite: z.string(), sprite_framing: z.string() }),
  /** Expression name → prompt text. Every sprite character gets each one. */
  expressions: z.record(id, z.string()),
  backgrounds: z.array(artImage),
  cgs: z.array(artImage),
  sprites: z.array(z.object({ character: id, appearance: z.string() })),
});

/** art_manifest.json: the image files that actually exist, written by `npm run art`. */
export const artManifestSchema = z.object({ files: z.array(z.string()) });

/** Sprite image path for one character and expression. */
export function spriteFile(character: string, expression: string): string {
  return `sprites/${character.replace(/_/g, "-")}-${expression}.webp`;
}

export type WorldMeta = z.infer<typeof worldMetaSchema>;
export type Cast = z.infer<typeof castSchema>;
export type Locations = z.infer<typeof locationsSchema>;
export type GameState = z.infer<typeof gameStateSchema>;
export type Origins = z.infer<typeof originsSchema>;
export type ArtSpec = z.infer<typeof artSpecSchema>;

export type World = {
  meta: WorldMeta;
  lore: string;
  cast: Cast;
  locations: Locations;
  origins: Origins;
  art: ArtSpec;
  /** Image files present in public/scenes/<world id>/. */
  artFiles: Set<string>;
  bannedTerms: string[];
};
