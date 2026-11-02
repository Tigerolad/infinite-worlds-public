import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODE_ALPHABET, hasAccess, inviteOnly, normalizeCode } from "@/lib/beta/access";
import { FEEDBACK_CATEGORIES } from "@/lib/feedback/categories";

afterEach(() => vi.unstubAllEnvs());

describe("beta access", () => {
  const onboarded = { birthdate_confirmed_18: true, beta_access: false };

  it("needs an invite by default", () => {
    vi.stubEnv("BETA_INVITE_ONLY", "");
    expect(inviteOnly()).toBe(true);
    expect(hasAccess(onboarded)).toBe(false);
    expect(hasAccess({ ...onboarded, beta_access: true })).toBe(true);
  });

  it("always needs the age gate", () => {
    vi.stubEnv("BETA_INVITE_ONLY", "false");
    expect(hasAccess(onboarded)).toBe(true);
    expect(hasAccess({ birthdate_confirmed_18: false, beta_access: true })).toBe(false);
    expect(hasAccess(null)).toBe(false);
  });

  it("normalizes typed codes", () => {
    expect(normalizeCode("  crown-7kq2 -xm4p ")).toBe("CROWN-7KQ2-XM4P");
  });

  it("uses no look-alike characters in codes", () => {
    expect(CODE_ALPHABET).not.toMatch(/[01OI]/);
  });
});

describe("feedback categories", () => {
  it("match the check constraint in the migration", () => {
    const sql = readFileSync("supabase/migrations/20261003000000_beta.sql", "utf8");
    const allowed = /category in \(([^)]+)\)/.exec(sql)![1].match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1));
    expect(allowed.sort()).toEqual(Object.keys(FEEDBACK_CATEGORIES).sort());
  });
});
