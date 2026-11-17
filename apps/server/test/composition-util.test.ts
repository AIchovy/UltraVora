import { describe, it, expect } from "vitest";
import { RESOLUTIONS, assertHexColor, assertCssFontFamily } from "../src/render/composition-util.js";

describe("composition-util", () => {
  it("maps aspect ratios to pixel resolutions", () => {
    expect(RESOLUTIONS["16:9"]).toEqual({ width: 1920, height: 1080 });
    expect(RESOLUTIONS["9:16"]).toEqual({ width: 1080, height: 1920 });
    expect(RESOLUTIONS["1:1"]).toEqual({ width: 1080, height: 1080 });
  });

  it("accepts valid hex colors and rejects junk", () => {
    expect(assertHexColor("#FF3366")).toBe("#FF3366");
    expect(() => assertHexColor("red; }")).toThrow(/hex/i);
  });

  it("accepts safe font names and rejects injection", () => {
    expect(assertCssFontFamily("Poppins")).toBe("Poppins");
    expect(() => assertCssFontFamily("Foo'; }")).toThrow(/font/i);
  });
});
