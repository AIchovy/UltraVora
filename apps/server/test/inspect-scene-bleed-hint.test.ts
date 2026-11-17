import { describe, it, expect } from "vitest";
import { findSceneBleedHints } from "../src/render/inspect-scene-bleed-hint.js";

// Verbatim shape from the 2026-07-09 prod compose failure: inspect blames the
// SCENE's only text node for a full-frame "clipped_text" while the real cause
// is a decorative bleeding past the scene edge (inflated scrollWidth), sampled
// mid scene-wipe. Four LLM fix rounds followed the CLI's "widen the text box"
// hint and never converged.
const PROD_SCENE_CLIP = JSON.stringify({
  schemaVersion: 1,
  ok: false,
  issues: [
    {
      code: "clipped_text",
      severity: "error",
      time: 19.18,
      selector: "#scene_3",
      text: "Interactive storybooks, games, and nursery rhymes",
      message: "Text content is clipped by its own box.",
      rect: { left: 216.21, top: 0, right: 2136.21, bottom: 1080, width: 1920, height: 1080 },
      overflow: { right: 354 },
      fixHint:
        "Text is 1920px x 1080px inside 1920px x 1080px and overflows by up to 354px; widen the text box to at least ~2274px, or allow wrapping with max-width/fitTextFontSize.",
      firstSeen: 19.18,
      lastSeen: 19.18,
      occurrences: 1,
    },
  ],
});

describe("findSceneBleedHints", () => {
  it("emits a clip-layer hint for clipped_text blamed on a scene container", () => {
    const hints = findSceneBleedHints(PROD_SCENE_CLIP);
    expect(hints).toHaveLength(1);
    const hint = hints[0]!;
    expect(hint).toContain("#scene_3");
    // Must teach the actual fix …
    expect(hint).toMatch(/overflow:\s*hidden/);
    expect(hint).toMatch(/inset:\s*0/);
    // … and warn away from the CLI's misleading suggestion + the known-useless
    // child attribute.
    expect(hint).toMatch(/widen/i);
    expect(hint).toMatch(/data-layout-allow-overflow/);
  });

  it("stays silent for clipped_text on a leaf element (a real text clip)", () => {
    const leaf = JSON.stringify({
      issues: [
        {
          code: "clipped_text",
          severity: "error",
          selector: "#scene_2 .headline",
          overflow: { bottom: 40 },
          rect: { width: 800, height: 90 },
        },
      ],
    });
    expect(findSceneBleedHints(leaf)).toEqual([]);
  });

  it("ignores other issue codes on scene selectors", () => {
    const other = JSON.stringify({
      issues: [{ code: "canvas_overflow", severity: "info", selector: "#scene_3" }],
    });
    expect(findSceneBleedHints(other)).toEqual([]);
  });

  it("returns [] for unparseable stdout", () => {
    expect(findSceneBleedHints("not json at all")).toEqual([]);
  });

  it("dedupes multiple issues on the same scene", () => {
    const doc = JSON.parse(PROD_SCENE_CLIP) as { issues: unknown[] };
    doc.issues.push(JSON.parse(JSON.stringify(doc.issues[0])));
    expect(findSceneBleedHints(JSON.stringify(doc))).toHaveLength(1);
  });
});
