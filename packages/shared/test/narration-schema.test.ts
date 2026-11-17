// packages/shared/test/narration-schema.test.ts
import { describe, it, expect } from "vitest";
import { NarrationDataSchema, NARRATION_TAIL_PAD_MS } from "../src/artifact.js";

describe("NARRATION_TAIL_PAD_MS", () => {
  it("is the shared 1000ms tail pad between narrated scenes", () => {
    expect(NARRATION_TAIL_PAD_MS).toBe(1000);
  });
});

describe("NarrationDataSchema", () => {
  it("accepts a per-scene timeline", () => {
    const v = NarrationDataSchema.parse({
      totalMs: 9000,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 3000 },
        { sceneId: "s2", startMs: 3000, durationMs: 6000 },
      ],
    });
    expect(v.segments).toHaveLength(2);
    expect(v.segments[1]!.audioFile).toBeUndefined();
  });

  it("rejects the old single-file shape", () => {
    const r = NarrationDataSchema.safeParse({ audioPath: "x.wav", durationMs: 5 });
    expect(r.success).toBe(false);
  });

  it("rejects negative timing values", () => {
    const r = NarrationDataSchema.safeParse({
      totalMs: -1,
      segments: [{ sceneId: "s1", startMs: 0, durationMs: 10 }],
    });
    expect(r.success).toBe(false);
  });
});
