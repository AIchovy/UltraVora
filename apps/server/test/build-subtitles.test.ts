import { describe, it, expect } from "vitest";
import { buildSubtitles } from "../src/subtitles/build-subtitles.js";
import type { Scene } from "@ultracreator/shared";
import type { NarrationData } from "@ultracreator/shared";

const scenes: Scene[] = [
  { id: "s1", startSec: 0, durationSec: 8, visual: "v", narration: "Welcome to Giggle Academy. Where young minds blossom." },
  { id: "s2", startSec: 8, durationSec: 4, visual: "v" }, // silent: no narration
];

const narration: NarrationData = {
  totalMs: 12000,
  segments: [
    { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 },
    { sceneId: "s2", startMs: 8000, durationMs: 4000 },
  ],
};

describe("buildSubtitles", () => {
  it("emits one segment per sentence/line for narrated scenes only", () => {
    const segs = buildSubtitles(scenes, narration);
    expect(segs.map((s) => s.text)).toEqual([
      "Welcome to Giggle Academy.",
      "Where young minds blossom.",
    ]);
    expect(segs.every((s) => s.sceneId === "s1")).toBe(true);
  });

  it("partitions the spoken window (durationMs - 1000 tail) with no gaps or overlaps", () => {
    const segs = buildSubtitles(scenes, narration);
    // spoken window: [0, 7000)
    expect(segs[0]!.startMs).toBe(0);
    expect(segs.at(-1)!.endMs).toBe(7000);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.startMs).toBe(segs[i - 1]!.endMs); // contiguous
    }
  });

  it("allocates duration proportional to line length", () => {
    const segs = buildSubtitles(scenes, narration);
    const len0 = "Welcome to Giggle Academy.".length;
    const len1 = "Where young minds blossom.".length;
    const expectedBoundary = Math.round((7000 * len0) / (len0 + len1));
    expect(segs[0]!.endMs).toBe(expectedBoundary);
  });

  it("splits sentences longer than 10 words into multiple lines", () => {
    const long: Scene[] = [{
      id: "s1", startSec: 0, durationSec: 8, visual: "v",
      narration: "one two three four five six seven eight nine ten eleven twelve",
    }];
    const n: NarrationData = {
      totalMs: 8000,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 }],
    };
    const segs = buildSubtitles(long, n);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.text).toBe("one two three four five six seven eight nine ten");
    expect(segs[1]!.text).toBe("eleven twelve");
  });

  it("returns no segments when narration is empty or whitespace", () => {
    const blank: Scene[] = [{ id: "s1", startSec: 0, durationSec: 8, visual: "v", narration: "   " }];
    const n: NarrationData = {
      totalMs: 8000,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 }],
    };
    expect(buildSubtitles(blank, n)).toEqual([]);
  });

  it("skips narrated scenes whose spoken window is non-positive", () => {
    const scenes: Scene[] = [{ id: "s1", startSec: 0, durationSec: 0, visual: "v", narration: "Hi there." }];
    const narration: NarrationData = {
      totalMs: 0,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 0 }],
    };
    expect(buildSubtitles(scenes, narration)).toEqual([]);
  });
});
