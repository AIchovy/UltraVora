import { describe, expect, it } from "vitest";
import { findContrastFailures } from "../src/render/contrast-check.js";

function validateJson(contrast: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, errors: [], warnings: [], contrast, ...extra });
}

describe("findContrastFailures", () => {
  it("returns a formatted line for each wcagAA failure", () => {
    const stdout = validateJson([
      {
        time: 2.5,
        selector: "#scene_1 .subtitle",
        text: "Ship faster with UltraCreator",
        ratio: 2.71,
        wcagAA: false,
        large: false,
        fg: "rgb(140,140,150)",
        bg: "rgb(90,90,110)",
      },
      {
        time: 0,
        selector: "#scene_2 h1",
        text: "Big headline",
        ratio: 8.2,
        wcagAA: true,
        large: true,
        fg: "rgb(255,255,255)",
        bg: "rgb(10,10,20)",
      },
    ]);
    const failures = findContrastFailures(stdout);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("#scene_1 .subtitle");
    expect(failures[0]).toContain("2.71");
    expect(failures[0]).toContain("4.5:1"); // required ratio for normal text
    expect(failures[0]).toContain("Ship faster");
  });

  it("reports the 3:1 requirement for large text", () => {
    const stdout = validateJson([
      {
        time: 1,
        selector: "#scene_3 h2",
        text: "Large but muddy",
        ratio: 2.2,
        wcagAA: false,
        large: true,
        fg: "rgb(120,120,120)",
        bg: "rgb(80,80,80)",
      },
    ]);
    const failures = findContrastFailures(stdout);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("3:1");
  });

  it("returns [] when every element passes", () => {
    const stdout = validateJson([
      { time: 0, selector: "h1", text: "ok", ratio: 12, wcagAA: true, large: false, fg: "rgb(255,255,255)", bg: "rgb(0,0,0)" },
    ]);
    expect(findContrastFailures(stdout)).toEqual([]);
  });

  it("returns [] for missing contrast array, non-JSON, and noisy stdout", () => {
    expect(findContrastFailures(validateJson([]))).toEqual([]);
    expect(findContrastFailures(JSON.stringify({ ok: true, errors: [] }))).toEqual([]);
    expect(findContrastFailures("not json at all")).toEqual([]);
    // JSON embedded in tooling noise still parses (same tolerance as inspect parsing).
    const noisy = `npm warn something\n${validateJson([
      { time: 0, selector: ".x", text: "dim", ratio: 1.9, wcagAA: false, large: false, fg: "rgb(1,1,1)", bg: "rgb(2,2,2)" },
    ])}\ntrailing`;
    expect(findContrastFailures(noisy)).toHaveLength(1);
  });

  it("ignores malformed entries without crashing", () => {
    const stdout = validateJson([
      null,
      42,
      { wcagAA: false }, // no selector/ratio — still reported, with placeholders
    ]);
    const failures = findContrastFailures(stdout);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("(unknown element)");
  });
});
