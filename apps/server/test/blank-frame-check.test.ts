import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  parseSceneWindows,
  analyzeSnapshots,
  planFrameSamples,
  analyzeStaticHolds,
  findRenderedFrameIssues,
} from "../src/render/blank-frame-check.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-blank-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const HTML = `<!doctype html><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="12" data-width="1920" data-height="1080">
  <div id="s1" class="clip" data-start="0" data-duration="6" data-track-index="1"><h1>A</h1></div>
  <div id="s2" class="clip" data-start="6" data-duration="6" data-track-index="2"><h1>B</h1></div>
  <audio data-track-index="0" data-start="0" data-duration="6" src="narration-s1.wav"></audio>
  <div class="bgm" data-track-index="0" data-start="0" data-duration="12"></div>
</div></body>`;

async function framePng(path: string, luma: number, layout: "flat" | "noisy" | "noisy-flipped" = "flat"): Promise<void> {
  if (layout === "flat") {
    await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: luma, g: luma, b: luma } } })
      .png().toFile(path);
    return;
  }
  // Half dark, half bright — high stddev, definitely "content". The flipped
  // variant swaps the halves so a diff against the base variant is huge.
  const dark = await sharp({ create: { width: 32, height: 36, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
  const bright = await sharp({ create: { width: 32, height: 36, channels: 3, background: { r: 230, g: 230, b: 230 } } }).png().toBuffer();
  const flipped = layout === "noisy-flipped";
  await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([
      { input: dark, left: flipped ? 32 : 0, top: 0 },
      { input: bright, left: flipped ? 0 : 32, top: 0 },
    ])
    .png().toFile(path);
}

describe("parseSceneWindows", () => {
  it("extracts scene clips, skipping the root, audio elements and audio-track clips", () => {
    const scenes = parseSceneWindows(HTML);
    expect(scenes).toEqual([
      { id: "s1", startSec: 0, durationSec: 6 },
      { id: "s2", startSec: 6, durationSec: 6 },
    ]);
  });
});

describe("analyzeSnapshots", () => {
  it("flags a near-black frame and names its scene; content frames pass", async () => {
    const snaps = join(root, "snapshots");
    await mkdir(snaps, { recursive: true });
    await framePng(join(snaps, "frame-00-at-3.00s.png"), 5); // black — s1 midpoint
    await framePng(join(snaps, "frame-01-at-9.00s.png"), 0, "noisy"); // real content

    const violations = await analyzeSnapshots(snaps, parseSceneWindows(HTML));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("t=3");
    expect(violations[0]).toContain("#s1");
  });

  it("does not flag a bright uniform frame (deliberate hold) or missing dir", async () => {
    const snaps = join(root, "snapshots");
    await mkdir(snaps, { recursive: true });
    await framePng(join(snaps, "frame-00-at-3.00s.png"), 240); // white flash — uniform but bright
    expect(await analyzeSnapshots(snaps, parseSceneWindows(HTML))).toEqual([]);
    expect(await analyzeSnapshots(join(root, "nope"), [])).toEqual([]);
  });
});

describe("planFrameSamples", () => {
  it("samples every scene's midpoint, and a late hold point only for scenes ≥6s", () => {
    const plan = planFrameSamples([
      { id: "s1", startSec: 0, durationSec: 6 },
      { id: "s2", startSec: 6, durationSec: 6 },
      { id: "s3", startSec: 12, durationSec: 3 }, // short hook — all entrance, skip hold
    ]);
    expect(plan.midpoints.map((s) => s.timeSec)).toEqual([3, 9, 13.5]);
    expect(plan.holds.map((s) => ({ id: s.scene.id, t: s.timeSec }))).toEqual([
      { id: "s1", t: 4 }, // start + duration - 2.0
      { id: "s2", t: 10 },
    ]);
  });

  it("keeps midpoint and hold samples ≥0.2s apart (CLI labels frames at 0.1s precision)", () => {
    const plan = planFrameSamples([{ id: "s1", startSec: 0, durationSec: 6 }]);
    const mid = plan.midpoints[0]!.timeSec;
    const hold = plan.holds[0]!.timeSec;
    expect(Math.abs(hold - mid)).toBeGreaterThanOrEqual(0.2);
  });

  it("caps sampled scenes like the blank check does", () => {
    const scenes = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`, startSec: i * 6, durationSec: 6,
    }));
    const plan = planFrameSamples(scenes, 8);
    expect(plan.midpoints.length).toBeLessThanOrEqual(8);
    expect(plan.holds.length).toBeLessThanOrEqual(8);
  });
});

describe("analyzeStaticHolds", () => {
  const scenes = [
    { id: "s1", startSec: 0, durationSec: 6 },
    { id: "s2", startSec: 6, durationSec: 6 },
  ];

  it("flags a scene whose midpoint and hold frames are pixel-identical, with an ambient-motion recipe", async () => {
    const snaps = join(root, "snapshots");
    await mkdir(snaps, { recursive: true });
    await framePng(join(snaps, "frame-00-at-3.0s.png"), 0, "noisy");
    await framePng(join(snaps, "frame-01-at-4.0s.png"), 0, "noisy"); // identical → frozen hold
    await framePng(join(snaps, "frame-02-at-9.0s.png"), 0, "noisy");
    await framePng(join(snaps, "frame-03-at-10.0s.png"), 0, "noisy-flipped"); // big diff → motion

    const violations = await analyzeStaticHolds(snaps, planFrameSamples(scenes), new Set());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("#s1");
    expect(violations[0]!.toLowerCase()).toContain("ambient");
    // The fix message must teach the lint-legal loop recipe…
    expect(violations[0]).toContain("yoyo");
    expect(violations[0]).toMatch(/repeat:\s*-1/);
    // …and the overflow-safe targets (prod session 15796467: the fix scaled a
    // full-frame wrapper, failed the overflow gate, and stranded the session).
    expect(violations[0]).toContain("data-layout-allow-overflow");
    expect(violations[0]!.toLowerCase()).toContain("full-frame");
  });

  it("skips scenes already flagged blank (one defect, one message)", async () => {
    const snaps = join(root, "snapshots");
    await mkdir(snaps, { recursive: true });
    await framePng(join(snaps, "frame-00-at-3.0s.png"), 5); // black…
    await framePng(join(snaps, "frame-01-at-4.0s.png"), 5); // …and identical

    const violations = await analyzeStaticHolds(snaps, planFrameSamples(scenes), new Set(["s1"]));
    expect(violations).toEqual([]);
  });

  it("returns [] when a sample frame is missing (best-effort, never blocks)", async () => {
    const snaps = join(root, "snapshots");
    await mkdir(snaps, { recursive: true });
    await framePng(join(snaps, "frame-00-at-3.0s.png"), 0, "noisy"); // hold frame absent

    const violations = await analyzeStaticHolds(snaps, planFrameSamples(scenes), new Set());
    expect(violations).toEqual([]);
  });
});

describe("findRenderedFrameIssues", () => {
  function copyStagingCommand(staging: string): string[] {
    return [
      "node", "-e",
      `require('node:fs').cpSync(${JSON.stringify(staging)}, ${JSON.stringify(join(root, "snapshots"))}, {recursive: true})`,
    ];
  }

  it("snapshots midpoints + hold points in one run and reports blank and frozen scenes", async () => {
    await writeFile(join(root, "index.html"), HTML);
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    await framePng(join(staging, "frame-00-at-3.0s.png"), 4); // s1 mid: black
    await framePng(join(staging, "frame-01-at-4.0s.png"), 4); // s1 hold (identical, but blank wins)
    await framePng(join(staging, "frame-02-at-9.0s.png"), 0, "noisy"); // s2 mid: content…
    await framePng(join(staging, "frame-03-at-10.0s.png"), 0, "noisy"); // …identical at hold → frozen

    let seenTimes: number[] = [];
    const violations = await findRenderedFrameIssues(root, {
      commandFor: (_dir, at) => {
        seenTimes = at;
        return copyStagingCommand(staging);
      },
    });
    expect(seenTimes).toEqual([3, 4, 9, 10]);
    // s1 → blank message(s) only (static suppressed); s2 → static-hold message.
    expect(violations.some((v) => v.includes("#s1") && /black/i.test(v))).toBe(true);
    expect(violations.some((v) => v.includes("#s2") && /motion|static|frozen/i.test(v))).toBe(true);
    expect(violations.some((v) => v.includes("#s1") && /motion between/i.test(v))).toBe(false);
  });

  it("clears stale frames from a previous run before snapshotting", async () => {
    await writeFile(join(root, "index.html"), HTML);
    const snaps = join(root, "snapshots");
    await mkdir(snaps, { recursive: true });
    // Stale black frame from the previous composition version — would be a
    // false blank violation (and corrupt diffs) if it survived.
    await framePng(join(snaps, "frame-90-at-3.2s.png"), 3);
    const staging = join(root, "staging");
    await mkdir(staging, { recursive: true });
    await framePng(join(staging, "frame-00-at-3.0s.png"), 0, "noisy");
    await framePng(join(staging, "frame-01-at-4.0s.png"), 0, "noisy-flipped");
    await framePng(join(staging, "frame-02-at-9.0s.png"), 0, "noisy");
    await framePng(join(staging, "frame-03-at-10.0s.png"), 0, "noisy-flipped");

    const violations = await findRenderedFrameIssues(root, {
      commandFor: () => copyStagingCommand(staging),
    });
    expect(violations).toEqual([]);
    expect(existsSync(join(snaps, "frame-90-at-3.2s.png"))).toBe(false);
  });

  it("returns [] when the snapshot tool fails (never blocks a healthy composition)", async () => {
    await writeFile(join(root, "index.html"), HTML);
    const violations = await findRenderedFrameIssues(root, {
      commandFor: () => ["node", "-e", "process.exit(1)"],
    });
    expect(violations).toEqual([]);
  });

  it("returns [] when there is no index.html or no scenes", async () => {
    expect(await findRenderedFrameIssues(root, { commandFor: () => ["node", "-e", "process.exit(0)"] })).toEqual([]);
  });
});
