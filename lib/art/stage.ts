import { spriteFile, type GameState, type World } from "@/lib/worlds/schema";

// Visual-novel staging (architecture doc §9). The narrator proposes what the
// screen shows; normalizeStage keeps only what the world allows, and viewStage
// turns that into image URLs, falling back gracefully while art is missing.

export const MAX_ON_STAGE = 2;

/** What is stored with each turn. */
export type Stage = {
  background: string;
  cg: string | null;
  on_stage: { character: string; expression: string }[];
};

/** What the story screen renders. A null URL means the image isn't made yet. */
export type StageView = {
  background: { tag: string; url: string | null };
  cg: { tag: string; url: string } | null;
  on_stage: { character: string; expression: string; url: string | null }[];
};

/** Checks the narrator's proposed staging against the world and state.
 *  Returns the cleaned stage plus a note for each thing it dropped. */
export function normalizeStage(
  world: World,
  proposed: { background?: unknown; cg?: unknown; on_stage?: unknown },
  state: GameState,
): { stage: Stage; issues: string[] } {
  const issues: string[] = [];
  const art = world.art;

  const backgrounds = new Set(art.backgrounds.map((b) => b.tag));
  let background = typeof proposed.background === "string" ? proposed.background : "";
  if (!backgrounds.has(background)) {
    if (background) issues.push(`unknown background ${background}`);
    background = backgrounds.has(state.location) ? state.location : art.default_background;
  }

  let cg = typeof proposed.cg === "string" && proposed.cg ? proposed.cg : null;
  if (cg && !art.cgs.some((c) => c.tag === cg)) {
    issues.push(`unknown cg ${cg}`);
    cg = null;
  }

  const cast = new Set(world.cast.characters.map((c) => c.id));
  const on_stage: Stage["on_stage"] = [];
  for (const raw of Array.isArray(proposed.on_stage) ? proposed.on_stage : []) {
    const character = typeof raw?.character === "string" ? raw.character : "";
    let expression = typeof raw?.expression === "string" ? raw.expression : "neutral";
    if (!cast.has(character)) {
      issues.push(`unknown character on stage ${character || JSON.stringify(raw)}`);
      continue;
    }
    if (state.characters[character]?.alive === false) {
      issues.push(`dead character on stage ${character}`);
      continue;
    }
    if (on_stage.some((c) => c.character === character)) continue;
    if (on_stage.length >= MAX_ON_STAGE) {
      issues.push(`more than ${MAX_ON_STAGE} on stage`);
      break;
    }
    if (!(expression in art.expressions)) {
      issues.push(`unknown expression ${expression}`);
      expression = "neutral";
    }
    on_stage.push({ character, expression });
  }

  return { stage: { background, cg, on_stage }, issues };
}

/** Image URLs for a stored stage. Missing images fall back: background →
 *  default background → none; expression → neutral → no sprite. */
export function viewStage(world: World, stage: Stage): StageView {
  const url = (file: string) => (world.artFiles.has(file) ? `/scenes/${world.meta.id}/${file}` : null);
  const art = world.art;
  const bgFile = (tag: string) => art.backgrounds.find((b) => b.tag === tag)?.file;

  const bgUrl = [stage.background, art.default_background]
    .map((t) => bgFile(t))
    .map((f) => (f ? url(f) : null))
    .find(Boolean);
  const cgFile = stage.cg ? art.cgs.find((c) => c.tag === stage.cg)?.file : undefined;
  const cgUrl = cgFile ? url(cgFile) : null;

  return {
    background: { tag: stage.background, url: bgUrl ?? null },
    cg: stage.cg && cgUrl ? { tag: stage.cg, url: cgUrl } : null,
    on_stage: stage.on_stage.map((c) => ({
      ...c,
      url: url(spriteFile(c.character, c.expression)) ?? url(spriteFile(c.character, "neutral")),
    })),
  };
}

/** Turns saved before the visual-novel update only have a scene tag. */
export function legacyStage(world: World, sceneTag: string | null, stage: unknown): Stage {
  if (stage && typeof stage === "object" && "on_stage" in stage) {
    const s = stage as Partial<Stage>;
    return { background: sceneTag ?? world.art.default_background, cg: s.cg ?? null, on_stage: s.on_stage ?? [] };
  }
  const tag = sceneTag ?? "";
  if (world.art.cgs.some((c) => c.tag === tag)) return { background: world.art.default_background, cg: tag, on_stage: [] };
  const isBackground = world.art.backgrounds.some((b) => b.tag === tag);
  return { background: isBackground ? tag : world.art.default_background, cg: null, on_stage: [] };
}
