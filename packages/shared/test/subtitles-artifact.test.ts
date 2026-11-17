import { describe, it, expect } from "vitest";
import { ARTIFACT_KINDS, ARTIFACT_DATA_SCHEMAS } from "../src/artifact.js";

describe("subtitles artifact", () => {
  it("registers the subtitles kind", () => {
    expect(ARTIFACT_KINDS).toContain("subtitles");
  });

  it("parses a valid SubtitlesData payload", () => {
    const parsed = ARTIFACT_DATA_SCHEMAS.subtitles.parse({
      language: "en",
      srtPath: "output/abc.srt",
      segments: [{ sceneId: "s1", text: "Hello world", startMs: 0, endMs: 1500 }],
    });
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.language).toBe("en");
  });

  it("rejects a segment whose endMs is not greater than startMs", () => {
    expect(() =>
      ARTIFACT_DATA_SCHEMAS.subtitles.parse({
        srtPath: "output/abc.srt",
        segments: [{ sceneId: "s1", text: "x", startMs: 1000, endMs: 1000 }],
      }),
    ).toThrow();
  });

  it("defaults language to en when omitted", () => {
    const parsed = ARTIFACT_DATA_SCHEMAS.subtitles.parse({
      srtPath: "output/abc.srt",
      segments: [{ sceneId: "s1", text: "x", startMs: 0, endMs: 1000 }],
    });
    expect(parsed.language).toBe("en");
  });
});
