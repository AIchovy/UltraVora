// apps/server/test/narration-timeline.test.ts
import { describe, it, expect } from "vitest";
import { computeNarrationTimeline } from "../src/phases/narration-timeline.js";

const scenes = [
  { id: "s1", durationSec: 6 },
  { id: "s2", durationSec: 6 },
  { id: "s3", durationSec: 6 },
];

describe("computeNarrationTimeline", () => {
  it("preserves planned scene durations when narration is shorter", () => {
    // s1 narrated 3000ms, s2 silent, s3 narrated 5000ms; defaults tailPad=1000, minScene=2000
    const t = computeNarrationTimeline(scenes, { s1: 3000, s3: 5000 });
    expect(t.segments).toEqual([
      { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 6000 },
      { sceneId: "s2", startMs: 6000, durationMs: 6000 },
      { sceneId: "s3", audioFile: "narration-s3.wav", startMs: 12000, durationMs: 6000 },
    ]);
    expect(t.totalMs).toBe(18000);
  });

  it("uses planned duration instead of shrinking to the minimum floor", () => {
    const t = computeNarrationTimeline([{ id: "s1", durationSec: 6 }], { s1: 800 });
    expect(t.segments[0]!.durationMs).toBe(6000);
    expect(t.totalMs).toBe(6000);
  });

  it("honors custom padding but still preserves the planned duration", () => {
    const t = computeNarrationTimeline([{ id: "s1", durationSec: 6 }], { s1: 1000 }, {
      tailPadMs: 0,
      minSceneMs: 0,
    });
    expect(t.segments[0]!.durationMs).toBe(6000);
  });

  it("extends a scene when narration plus tail padding exceeds the plan", () => {
    const t = computeNarrationTimeline([{ id: "s1", durationSec: 6 }], { s1: 7000 });
    expect(t.segments[0]!.durationMs).toBe(8000);
    expect(t.totalMs).toBe(8000);
  });

  it("returns all-silent timeline (planned durations) when no audio provided", () => {
    const t = computeNarrationTimeline(scenes, {});
    expect(t.segments.map((s) => s.durationMs)).toEqual([6000, 6000, 6000]);
    expect(t.segments.every((s) => s.audioFile === undefined)).toBe(true);
    expect(t.totalMs).toBe(18000);
  });
});
