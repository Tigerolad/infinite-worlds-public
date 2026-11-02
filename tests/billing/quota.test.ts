import { describe, expect, it } from "vitest";
import { pickBucket, tierForBucket, turnsRemaining, type Balance } from "@/lib/billing/quota";

const today = "2026-09-30";
const fresh: Balance = {
  intro_turns_used: 0,
  monthly_allowance: 0,
  monthly_used: 0,
  pack_credits: 0,
  daily_free_used: 0,
  daily_reset_on: today,
};

describe("pickBucket", () => {
  it("uses intro turns first, on the premium narrator", () => {
    expect(pickBucket(fresh, "free", today)).toBe("intro");
    expect(tierForBucket("intro")).toBe("premium");
  });

  it("then monthly (premium only), then packs, then free daily", () => {
    const b = { ...fresh, intro_turns_used: 40, monthly_allowance: 500, pack_credits: 150 };
    expect(pickBucket(b, "premium", today)).toBe("monthly");
    expect(pickBucket(b, "free", today)).toBe("pack");
    expect(pickBucket({ ...b, monthly_used: 500 }, "premium", today)).toBe("pack");
    expect(pickBucket({ ...b, pack_credits: 0 }, "free", today)).toBe("daily");
    expect(tierForBucket("daily")).toBe("free");
  });

  it("runs out after 10 daily turns and resets the next UTC day", () => {
    const b = { ...fresh, intro_turns_used: 40, daily_free_used: 10 };
    expect(pickBucket(b, "free", today)).toBeNull();
    expect(pickBucket(b, "free", "2026-10-01")).toBe("daily");
    expect(turnsRemaining(b, "free", "2026-10-01").daily).toBe(10);
  });
});
