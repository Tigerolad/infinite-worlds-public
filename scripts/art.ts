// Visual-novel art pipeline (architecture doc §9).
//
// Usage: npm run art                  status; updates worlds/<world>/art_manifest.json
//        npm run art -- --prompts     writes Midjourney prompts for missing images to art-inbox/<world>/PROMPTS.md
//        npm run art -- --import      converts images dropped in art-inbox/<world>/ into public/scenes/<world>/
//        npm run art -- --quiet       manifest only (runs before dev and build)
//
// Name each downloaded image after its target file: capital-market.png,
// event-duel.png, regent-osric-angry.png. Sprites need a transparent
// background (Finder → right-click → Quick Actions → Remove Background).

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { artFileList } from "@/lib/worlds/load";
import { artSpecSchema, spriteFile, type ArtSpec } from "@/lib/worlds/schema";

const quiet = process.argv.includes("--quiet");
const log = (...a: unknown[]) => !quiet && console.log(...a);
const MAX_KB = { scene: 300, sprite: 600 };

async function exists(p: string) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name))).map((f) => `${entry.name}/${f}`));
    else if (!entry.name.startsWith(".")) out.push(entry.name);
  }
  return out;
}

const stem = (file: string) => path.basename(file).replace(/\.[^.]+$/, "");

/** Converts art-inbox/<world>/* into sized WebP files in public/scenes/<world>/. */
async function importInbox(worldId: string, art: ArtSpec, imageDir: string) {
  const inbox = path.join(process.cwd(), "art-inbox", worldId);
  const byStem = new Map(artFileList(art).map((f) => [stem(f), f]));
  const sources = (await readdir(inbox).catch(() => [])).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  if (!sources.length) return log(`  nothing to import in art-inbox/${worldId}/`);

  await mkdir(path.join(inbox, "imported"), { recursive: true });
  for (const source of sources) {
    const target = byStem.get(stem(source).toLowerCase());
    if (!target) {
      log(`  ? ${source}: no image in art.json is called ${stem(source)}`);
      continue;
    }
    const input = path.join(inbox, source);
    const out = path.join(imageDir, target);
    await mkdir(path.dirname(out), { recursive: true });
    if (target.startsWith("sprites/")) {
      const meta = await sharp(input).metadata();
      if (!meta.hasAlpha) {
        log(`  ! ${source}: sprite has no transparent background. Remove the background first.`);
        continue;
      }
      await sharp(input).trim().resize({ height: 1400, withoutEnlargement: true }).webp({ quality: 85 }).toFile(out);
    } else {
      await sharp(input)
        .resize({ width: 1920, height: 1080, fit: "cover", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toFile(out);
    }
    await rename(input, path.join(inbox, "imported", source));
    log(`  ✓ ${source} → ${target} (${Math.round((await stat(out)).size / 1000)} KB)`);
  }
}

function prompts(art: ArtSpec, missing: Set<string>): string {
  const mj = art.midjourney;
  const lines = [
    "# Midjourney prompts",
    "",
    "1. Make `bg/bg-default.webp` first. Pick the best result and copy its image URL: that is your **style reference**.",
    "   Add `--sref <that URL>` to every prompt below, so all art shares one look.",
    "2. For each character, make the **neutral** sprite first and pick the best face. For their other expressions add",
    "   `--cref <neutral image URL>` (or `--oref` on newer Midjourney versions) so the face stays the same.",
    "3. Remove sprite backgrounds: Finder → right-click the PNG → Quick Actions → Remove Background.",
    "4. Save each image into this folder named exactly as the heading (any of .png .jpg .webp), then run `npm run art -- --import`.",
    "",
  ];
  const section = (title: string, items: { file: string; prompt: string }[]) => {
    const todo = items.filter((i) => missing.has(i.file));
    if (!todo.length) return;
    lines.push(`## ${title} (${todo.length})`, "");
    for (const i of todo) lines.push(`### ${stem(i.file)}`, "```", i.prompt, "```", "");
  };
  section(
    "Backgrounds",
    art.backgrounds.map((b) => ({ file: b.file, prompt: `${b.prompt}, no people, ${art.style} ${mj.background}` })),
  );
  section("CGs", art.cgs.map((c) => ({ file: c.file, prompt: `${c.prompt}, ${art.style} ${mj.cg}` })));
  section(
    "Sprites",
    art.sprites.flatMap((s) =>
      Object.entries(art.expressions).map(([expression, text]) => ({
        file: spriteFile(s.character, expression),
        prompt: `${mj.sprite_framing}, ${s.appearance}, ${text}, ${art.style} ${mj.sprite}${
          expression === "neutral" ? "" : " --cref <neutral image URL>"
        }`,
      })),
    ),
  );
  return lines.join("\n");
}

async function main() {
  const worldsDir = path.join(process.cwd(), "worlds");
  for (const worldId of await readdir(worldsDir)) {
    const art = artSpecSchema.parse(JSON.parse(await readFile(path.join(worldsDir, worldId, "art.json"), "utf8")));
    const imageDir = path.join(process.cwd(), "public", "scenes", worldId);

    if (process.argv.includes("--import")) {
      log(`\n${worldId}: importing`);
      await importInbox(worldId, art, imageDir);
    }

    const present = new Set(await listFiles(imageDir));
    const all = artFileList(art);
    const available = all.filter((f) => present.has(f));
    const missing = new Set(all.filter((f) => !present.has(f)));

    const manifestPath = path.join(worldsDir, worldId, "art_manifest.json");
    const manifest = JSON.stringify({ files: available.sort() }, null, 2) + "\n";
    if (manifest !== (await readFile(manifestPath, "utf8").catch(() => ""))) await writeFile(manifestPath, manifest);

    const count = (prefix: string) => {
      const kind = all.filter((f) => f.startsWith(prefix));
      return `${kind.filter((f) => present.has(f)).length}/${kind.length}`;
    };
    log(`\n${worldId}: backgrounds ${count("bg/")} · CGs ${count("cg/")} · sprites ${count("sprites/")}`);
    const defaultFile = art.backgrounds.find((b) => b.tag === art.default_background)!.file;
    if (!present.has(defaultFile)) log(`  ! make ${defaultFile} first: it is the fallback and your style reference`);
    for (const f of present) if (!all.includes(f)) log(`  ? ${f} is not in art.json`);
    for (const f of available) {
      const kb = (await stat(path.join(imageDir, f))).size / 1000;
      const max = f.startsWith("sprites/") ? MAX_KB.sprite : MAX_KB.scene;
      if (kb > max) log(`  ! ${f} is ${Math.round(kb)} KB (aim for under ${max}); re-import it`);
    }

    if (process.argv.includes("--prompts")) {
      const inbox = path.join(process.cwd(), "art-inbox", worldId);
      await mkdir(inbox, { recursive: true });
      await writeFile(path.join(inbox, "PROMPTS.md"), prompts(art, missing));
      log(`  prompts for ${missing.size} missing images → art-inbox/${worldId}/PROMPTS.md`);
    } else if (missing.size && !(await exists(path.join(process.cwd(), "art-inbox", worldId, "PROMPTS.md")))) {
      log(`  ${missing.size} missing. Run npm run art -- --prompts for Midjourney prompts.`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
