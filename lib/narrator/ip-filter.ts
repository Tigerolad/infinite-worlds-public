// Post-generation banned-terms check (architecture doc §8).

const cache = new WeakMap<string[], RegExp>();

function patternFor(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  let re = cache.get(terms);
  if (!re) {
    const alternatives = terms
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['’]/g, "['’]"))
      .sort((a, b) => b.length - a.length);
    // Letter/number boundaries rather than \b, so terms ending in punctuation
    // and curly apostrophes still match whole words only. Plurals match too.
    re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})s?(?![\\p{L}\\p{N}])`, "giu");
    cache.set(terms, re);
  }
  return re;
}

export const MASK = "[unknown name]";

/** Replaces banned terms in untrusted player text before the narrator sees
 *  it, so the narrator can't echo them (which would force a retry). */
export function maskBannedTerms(text: string, terms: string[]): string {
  const re = patternFor(terms);
  return re ? text.replace(re, MASK) : text;
}

/** Returns each banned term found in `texts` (as written in the list), or []. */
export function findBannedTerms(texts: string[], terms: string[]): string[] {
  const re = patternFor(terms);
  if (!re) return [];
  const byLower = new Map(terms.map((t) => [t.toLowerCase().replace(/’/g, "'"), t]));
  const found = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      const key = m[0].toLowerCase().replace(/’/g, "'");
      found.add(byLower.get(key) ?? byLower.get(key.replace(/s$/, "")) ?? m[0]);
    }
  }
  return [...found];
}
