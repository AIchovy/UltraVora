import { describe, it, expect } from "vitest";
import { segmentsToSrt } from "../src/subtitles/srt.js";

describe("segmentsToSrt", () => {
  it("formats segments as standard SRT cues", () => {
    const srt = segmentsToSrt([
      { sceneId: "s1", text: "Hello world", startMs: 0, endMs: 1500 },
      { sceneId: "s1", text: "Second line", startMs: 1500, endMs: 3725 },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n" +
        "2\n00:00:01,500 --> 00:00:03,725\nSecond line\n",
    );
  });

  it("zero-pads hours, minutes, seconds and milliseconds", () => {
    const srt = segmentsToSrt([
      { sceneId: "s1", text: "x", startMs: 3661001, endMs: 3662002 },
    ]);
    expect(srt).toBe("1\n01:01:01,001 --> 01:01:02,002\nx\n");
  });

  it("returns an empty string for no segments", () => {
    expect(segmentsToSrt([])).toBe("");
  });
});
