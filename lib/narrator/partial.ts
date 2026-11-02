const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

/**
 * Reads the value of the "narration" field from an incomplete JSON document,
 * so narration can be shown while the rest of the output is still streaming.
 * Returns only fully decoded characters: a trailing half escape is held back.
 */
export function partialNarration(json: string): string {
  const start = /"narration"\s*:\s*"/.exec(json);
  if (!start) return "";

  let out = "";
  let i = start.index + start[0].length;
  while (i < json.length) {
    const ch = json[i];
    if (ch === '"') break;
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }
    const next = json[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = json.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
    } else {
      out += ESCAPES[next] ?? next;
      i += 2;
    }
  }
  return out;
}
