import { describe, it, expect } from "vitest";
import { segmentsToVtt } from "@/lib/segments-to-vtt";

describe("segmentsToVtt", () => {
  it("builds a WEBVTT cue from a segment, using a dot ms separator", () => {
    expect(
      segmentsToVtt([{ sceneId: "s1", text: "Hello world", startMs: 0, endMs: 1500 }]),
    ).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello world\n");
  });

  it("separates multiple cues with a blank line", () => {
    expect(
      segmentsToVtt([
        { sceneId: "s1", text: "Hi", startMs: 0, endMs: 1000 },
        { sceneId: "s2", text: "There", startMs: 1000, endMs: 2000 },
      ]),
    ).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi\n\n00:00:01.000 --> 00:00:02.000\nThere\n",
    );
  });

  it("zero-pads hours, minutes, seconds and milliseconds", () => {
    // 1h 02m 03.004s
    const ms = 3_600_000 + 2 * 60_000 + 3 * 1000 + 4;
    expect(segmentsToVtt([{ sceneId: "s1", text: "x", startMs: ms, endMs: ms }])).toContain(
      "01:02:03.004 --> 01:02:03.004",
    );
  });

  it("returns a bare WEBVTT header for no segments", () => {
    expect(segmentsToVtt([])).toBe("WEBVTT\n");
  });
});
