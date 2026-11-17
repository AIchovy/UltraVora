import { describe, it, expect, beforeEach } from "vitest";
import type { MusicData, NarrationData } from "@ultracreator/shared";
import { buildAudioTracks } from "@/lib/audio-tracks";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});

const narration: NarrationData = {
  totalMs: 12000,
  segments: [
    { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 5000 },
    { sceneId: "s2", startMs: 5000, durationMs: 2000 }, // silent — no audioFile
    { sceneId: "s3", audioFile: "narration-s3.wav", startMs: 7000, durationMs: 5000 },
  ],
};

const music: MusicData = { file: "abc123.wav", prompt: "cinematic ambient", durationSec: 30 };

describe("buildAudioTracks", () => {
  it("maps narrated scenes and the BGM into ordered tracks", () => {
    const tracks = buildAudioTracks("sid1", narration, music);
    expect(tracks.map((t) => t.id)).toEqual(["narration-s1", "narration-s3", "bgm"]);
    expect(tracks[0]).toMatchObject({
      title: "Scene s1",
      artist: "Voiceover · 0:00 – 0:05",
      duration: 5,
    });
    expect(tracks[0]!.url).toContain("/api/sessions/sid1/files/composition/narration-s1.wav");
    expect(tracks[2]).toMatchObject({
      title: "Background music",
      artist: "cinematic ambient",
      duration: 30,
    });
    expect(tracks[2]!.url).toContain("/api/sessions/sid1/files/composition/abc123.wav");
  });

  it("appends ?v=<narration version> to narration URLs (fixed filenames need cache-busting)", () => {
    // Voiceover re-runs overwrite the SAME narration-<sceneId>.wav files, so
    // without a version query the browser replays its cached old audio.
    const tracks = buildAudioTracks("sid1", narration, music, 3);
    expect(tracks[0]!.url).toContain("/api/sessions/sid1/files/composition/narration-s1.wav?v=3");
    expect(tracks[1]!.url).toContain("/api/sessions/sid1/files/composition/narration-s3.wav?v=3");
    // BGM files get a fresh random name per generation — no buster needed.
    expect(tracks[2]!.url).not.toContain("?v=");
  });

  it("skips silent scenes", () => {
    const tracks = buildAudioTracks("sid1", narration, null);
    expect(tracks).toHaveLength(2);
  });

  it("handles music-only sessions", () => {
    const tracks = buildAudioTracks("sid1", null, music);
    expect(tracks.map((t) => t.id)).toEqual(["bgm"]);
  });

  it("returns empty for no audio", () => {
    expect(buildAudioTracks("sid1", null, null)).toEqual([]);
  });
});
