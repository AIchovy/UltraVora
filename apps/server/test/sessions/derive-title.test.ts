import { describe, it, expect } from "vitest";
import { deriveTitle } from "../../src/sessions/derive-title.js";

describe("deriveTitle", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(deriveTitle("  Make a promo for Acme  ")).toBe("Make a promo for Acme");
  });
  it("uses only the first line", () => {
    expect(deriveTitle("Launch teaser\n\nProduct page: https://acme.dev")).toBe("Launch teaser");
  });
  it("truncates to 80 chars", () => {
    expect(deriveTitle("x".repeat(200))).toHaveLength(80);
  });
  it("falls back to Untitled for blank input", () => {
    expect(deriveTitle("   \n  ")).toBe("Untitled");
  });
});
