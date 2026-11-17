import { describe, it, expect } from "vitest";
import { clampSplit, CHAT_SPLIT_DEFAULT } from "@/lib/clamp-split";

describe("clampSplit", () => {
  it("keeps values inside [25, 50]", () => {
    expect(clampSplit(40)).toBe(40);
    expect(clampSplit(25)).toBe(25);
    expect(clampSplit(50)).toBe(50);
  });

  it("clamps below the min to 25 (left never narrower than a quarter)", () => {
    expect(clampSplit(10)).toBe(25);
    expect(clampSplit(0)).toBe(25);
  });

  it("clamps above the max to 50 (neither side wider than half)", () => {
    expect(clampSplit(80)).toBe(50);
    expect(clampSplit(50.1)).toBe(50);
  });

  it("falls back to the default for NaN", () => {
    expect(clampSplit(Number.NaN)).toBe(CHAT_SPLIT_DEFAULT);
  });
});
