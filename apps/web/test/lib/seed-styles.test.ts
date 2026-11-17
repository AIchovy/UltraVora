import { describe, it, expect } from "vitest";
import { SEED_STYLES, ACCENT_KEYS } from "@/lib/seed-styles";

describe("SEED_STYLES", () => {
  it("keeps the four named styles", () => {
    expect(SEED_STYLES.map((s) => s.title)).toEqual([
      "Minimalist Tech",
      "Pro Walkthrough",
      "Dynamic Promo",
      "Brand Narrative",
    ]);
  });

  it("gives each style a unique id, an accent, an icon and 4–5 prompts", () => {
    const ids = new Set<string>();
    for (const s of SEED_STYLES) {
      ids.add(s.id);
      expect(ACCENT_KEYS).toContain(s.accent);
      expect(s.icon).toBeTruthy(); // a lucide forwardRef component (object, not function)
      expect(s.prompts.length).toBeGreaterThanOrEqual(4);
      expect(s.prompts.length).toBeLessThanOrEqual(5);
      expect(s.inspiration.length).toBeGreaterThan(0);
    }
    expect(ids.size).toBe(SEED_STYLES.length);
  });

  it("assigns a distinct accent to each style", () => {
    expect(new Set(SEED_STYLES.map((s) => s.accent)).size).toBe(SEED_STYLES.length);
  });
});
