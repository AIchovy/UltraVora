import { describe, it, expect } from "vitest";
import { findSevereContainerOverflows } from "../src/render/inspect-overflow-check.js";

/**
 * Fixtures mirror `hyperframes inspect --json` output. Regression source:
 * session e871ba4d — a 936×168 logo sized height-only rendered 2507px wide on a
 * 1920px canvas; inspect reported it as a container_overflow WARNING, exit 0,
 * and the quality gate shipped it.
 */

const CANVAS_RECT = { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 };

function issue(overrides: Record<string, unknown> = {}) {
  return {
    code: "container_overflow",
    severity: "warning",
    time: 38.401,
    selector: "#logo-s5",
    containerSelector: "#scene_5",
    message: "Element extends outside a clipping layout container.",
    rect: { left: -293.56, top: 183, right: 2213.58, bottom: 633, width: 2507.14, height: 450 },
    containerRect: CANVAS_RECT,
    overflow: { left: 293.56, right: 293.58 },
    fixHint:
      "Resize/reposition the child or container, or mark intentional overflow with data-layout-allow-overflow.",
    firstSeen: 38.401,
    lastSeen: 38.401,
    occurrences: 1,
    ...overrides,
  };
}

function inspectJson(issues: unknown[]): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      duration: 40.66,
      samples: [2.259, 6.777, 38.401],
      tolerance: 2,
      strict: false,
      collapseStatic: true,
      ok: true,
      errorCount: 0,
      warningCount: issues.length,
      infoCount: 0,
      issueCount: issues.length,
      totalIssueCount: issues.length,
      truncated: false,
      issues,
      _meta: { version: "0.7.26" },
    },
    null,
    2,
  );
}

describe("findSevereContainerOverflows", () => {
  it("promotes a container_overflow far beyond the canvas threshold", () => {
    const out = findSevereContainerOverflows(inspectJson([issue()]));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("#logo-s5");
    expect(out[0]).toContain("#scene_5");
    expect(out[0]).toMatch(/left 293\.56px/);
    expect(out[0]).toMatch(/right 293\.58px/);
    expect(out[0]).toContain("data-layout-allow-overflow");
  });

  it("includes the sampled time so the agent can locate the scene", () => {
    const out = findSevereContainerOverflows(
      inspectJson([issue({ firstSeen: 2.259, lastSeen: 6.777, occurrences: 2 })]),
    );
    expect(out[0]).toMatch(/t=2\.26/);
    expect(out[0]).toMatch(/6\.78/);
  });

  it("ignores horizontal overflow below 2% of the container width", () => {
    // 2% of 1920 = 38.4px; 20px is a shadow/rounding-level bleed.
    const out = findSevereContainerOverflows(
      inspectJson([issue({ overflow: { left: 20 } })]),
    );
    expect(out).toEqual([]);
  });

  it("uses the container HEIGHT for vertical overflow thresholds", () => {
    // 2% of 1080 = 21.6px: 25px down is severe even though 25 < 38.4 (width threshold).
    const out = findSevereContainerOverflows(
      inspectJson([issue({ overflow: { bottom: 25 } })]),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/bottom 25px/);
  });

  it("applies a 12px floor on small containers instead of a bare 2%", () => {
    const small = { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 };
    // 8px on a 100px card (2% = 2px) is still sub-visible: below the floor.
    expect(
      findSevereContainerOverflows(
        inspectJson([issue({ containerRect: small, overflow: { right: 8 } })]),
      ),
    ).toEqual([]);
    // 20px on the same card is a fifth of the card: severe.
    expect(
      findSevereContainerOverflows(
        inspectJson([issue({ containerRect: small, overflow: { right: 20 } })]),
      ),
    ).toHaveLength(1);
  });

  it("falls back to the 12px floor when containerRect is missing", () => {
    const out = findSevereContainerOverflows(
      inspectJson([issue({ containerRect: undefined, overflow: { left: 14 } })]),
    );
    expect(out).toHaveLength(1);
  });

  it("ignores issues that are not container_overflow", () => {
    const out = findSevereContainerOverflows(
      inspectJson([
        issue({ code: "canvas_overflow", severity: "info" }),
        issue({ code: "text_box_overflow", severity: "error" }),
      ]),
    );
    expect(out).toEqual([]);
  });

  it("returns [] for malformed or non-JSON stdout", () => {
    expect(findSevereContainerOverflows("")).toEqual([]);
    expect(findSevereContainerOverflows("not json at all")).toEqual([]);
    expect(findSevereContainerOverflows('{"issues": "nope"}')).toEqual([]);
  });

  it("still parses when tooling noise precedes the JSON document", () => {
    const noisy = `npm warn deprecated something\n${inspectJson([issue()])}`;
    expect(findSevereContainerOverflows(noisy)).toHaveLength(1);
  });
});
