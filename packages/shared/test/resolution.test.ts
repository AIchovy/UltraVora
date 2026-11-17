import { describe, expect, test } from "vitest";
import { RESOLUTIONS, resolutionFor, resolutionLabel } from "../src/constraints.js";

describe("resolution by aspect ratio", () => {
  test("pixel dimensions per ratio", () => {
    expect(resolutionFor("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(resolutionFor("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(resolutionFor("1:1")).toEqual({ width: 1080, height: 1080 });
  });
  test("RESOLUTIONS covers every allowed ratio", () => {
    expect(new Set(Object.keys(RESOLUTIONS))).toEqual(new Set(["16:9", "9:16", "1:1"]));
  });
  test("human-readable label", () => {
    expect(resolutionLabel("16:9")).toBe("1920 × 1080");
    expect(resolutionLabel("9:16")).toBe("1080 × 1920");
    expect(resolutionLabel("1:1")).toBe("1080 × 1080");
  });
});
