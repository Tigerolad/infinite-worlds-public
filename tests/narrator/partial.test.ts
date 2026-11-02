import { describe, expect, it } from "vitest";
import { partialNarration } from "@/lib/narrator/partial";

describe("partialNarration", () => {
  const full = JSON.stringify({ narration: 'He said "go".\nThen: café — done', choices: ["a"] });

  it("decodes the complete value", () => {
    expect(partialNarration(full)).toBe('He said "go".\nThen: café — done');
  });

  it("returns a growing prefix for every cut point, never garbage", () => {
    const target = JSON.parse(full).narration as string;
    let previous = "";
    for (let i = 0; i <= full.length; i++) {
      const got = partialNarration(full.slice(0, i));
      expect(target.startsWith(got)).toBe(true);
      expect(got.length).toBeGreaterThanOrEqual(previous.length);
      previous = got;
    }
  });

  it("handles \\u escapes, including split ones", () => {
    const json = '{"narration": "caf\\u00e9 and more';
    expect(partialNarration(json)).toBe("café and more");
    expect(partialNarration('{"narration": "caf\\u00')).toBe("caf");
  });

  it("is empty before the field starts", () => {
    expect(partialNarration('{"narr')).toBe("");
  });
});
