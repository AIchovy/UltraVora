// apps/server/test/narration-prompt.test.ts
import { describe, it, expect } from "vitest";
import {
  buildNarrationPromptBlock,
  retimeScenesToNarration,
} from "../src/phases/narration-prompt.js";

describe("buildNarrationPromptBlock", () => {
  it("emits exact seconds and an audio-clip instruction per narrated scene", () => {
    const { block, totalDurationSec } = buildNarrationPromptBlock({
      totalMs: 12000,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 6000 },
        { sceneId: "s2", audioFile: "narration-s2.wav", startMs: 6000, durationMs: 6000 },
      ],
    });
    expect(totalDurationSec).toBe("12.00");
    expect(block).toContain('scene s1: data-start="0.00" data-duration="6.00"');
    expect(block).toContain('scene s2: data-start="6.00" data-duration="6.00"');
    expect(block).toContain('narration-s1.wav');
    expect(block).toContain('data-track-index="0"');
    // mentions the root duration
    expect(block).toContain("12.00");
  });

  it("discloses the tail pad as the transition window and allows early scene reveals", () => {
    const { block } = buildNarrationPromptBlock({
      totalMs: 12000,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 6000 },
        { sceneId: "s2", audioFile: "narration-s2.wav", startMs: 6000, durationMs: 6000 },
      ],
    });
    // The ~1s tail pad after each narrated scene's speech is the transition window.
    expect(block).toMatch(/tail pad|silence/i);
    expect(block).toMatch(/transition window/i);
    // Visual clips may start up to 0.8s early for crossfade overlap…
    expect(block).toContain("0.8");
    expect(block).toMatch(/before its listed/i);
    // …but audio timing stays exact.
    expect(block).toMatch(/audio[^.]*EXACT/i);
    // Scenes must never start late.
    expect(block).toMatch(/never delay/i);
  });

  it("marks silent scenes and omits an audio clip for them", () => {
    const { block } = buildNarrationPromptBlock({
      totalMs: 9500,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 3500 },
        { sceneId: "s2", startMs: 3500, durationMs: 6000 },
      ],
    });
    expect(block).toContain('scene s2: data-start="3.50" data-duration="6.00" (silent)');
    // the silent scene has no audio filename on its line
    const s2Line = block.split("\n").find((l) => l.includes("scene s2"))!;
    expect(s2Line).not.toContain(".wav");
  });
});

describe("retimeScenesToNarration", () => {
  // The compose prompt used to carry TWO conflicting duration sets: the
  // narration timeline (authoritative — audio length + tail pad) and the
  // script scenes' stale planned startSec/durationSec. Motion authored to the
  // stale, shorter duration dies seconds before the scene ends (prod session
  // 45a7b61e: script said 6s, narration stretched the scene to 7.91s → static
  // tail). The scenes fed to the prompt must carry the FINAL timings.
  const scenes = [
    { id: "s1", startSec: 0, durationSec: 5, visual: "hook", onScreenText: "Hi" },
    { id: "s2", startSec: 5, durationSec: 6, visual: "intro", onScreenText: "Yo" },
  ];

  it("rewrites startSec/durationSec from the narration segments, preserving other fields", () => {
    const out = retimeScenesToNarration(scenes, {
      totalMs: 15240,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 7330 },
        { sceneId: "s2", audioFile: "narration-s2.wav", startMs: 7330, durationMs: 7910 },
      ],
    });
    expect(out).toEqual([
      { id: "s1", startSec: 0, durationSec: 7.33, visual: "hook", onScreenText: "Hi" },
      { id: "s2", startSec: 7.33, durationSec: 7.91, visual: "intro", onScreenText: "Yo" },
    ]);
  });

  it("leaves scenes without a matching segment untouched and never mutates the input", () => {
    const out = retimeScenesToNarration(scenes, {
      totalMs: 9000,
      segments: [{ sceneId: "s2", startMs: 3000, durationMs: 6000 }],
    });
    expect(out[0]).toEqual(scenes[0]);
    expect(out[1]!.startSec).toBe(3);
    expect(out[1]!.durationSec).toBe(6);
    // input untouched
    expect(scenes[1]!.startSec).toBe(5);
  });
});
