import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiMusicProvider, type GeminiMusicClient } from "../src/providers/gemini-music.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-gemini-music-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Minimal fake audio payload.
const AUDIO = Buffer.from("RIFFfakewav", "ascii");
const fakeAudioBase64 = AUDIO.toString("base64");

function fakeClient(capture?: (opts: any) => void): GeminiMusicClient {
  return {
    models: {
      generateContent: async (opts: any) => {
        capture?.(opts);
        return {
          candidates: [{
            content: { parts: [{ inlineData: { mimeType: "audio/wav", data: fakeAudioBase64 } }] },
          }],
        };
      },
    },
  };
}

describe("GeminiMusicProvider (unit)", () => {
  it("calls the API and writes the returned audio bytes", async () => {
    const provider = new GeminiMusicProvider({ client: fakeClient(), apiKey: "fake" });
    const out = join(root, "bgm.wav");
    const result = await provider.generate({ prompt: "upbeat synth", durationSec: 30, outputPath: out });
    expect(result.audioPath).toBe(out);
    expect(result.mimeType).toBe("audio/wav");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).equals(AUDIO)).toBe(true);
  });

  it("uses the default model and allows overriding it", async () => {
    let captured: any;
    const dflt = new GeminiMusicProvider({ client: fakeClient((o) => { captured = o; }), apiKey: "fake" });
    await dflt.generate({ prompt: "x", durationSec: 10, outputPath: join(root, "a.wav") });
    expect(typeof captured.model).toBe("string");
    expect(captured.model.length).toBeGreaterThan(0);
    const defaultModel = captured.model;

    const custom = new GeminiMusicProvider({
      client: fakeClient((o) => { captured = o; }), apiKey: "fake", model: "custom-music-model",
    });
    await custom.generate({ prompt: "x", durationSec: 10, outputPath: join(root, "b.wav") });
    expect(captured.model).toBe("custom-music-model");
    expect(captured.model).not.toBe(defaultModel);
  });

  it("rejects when the API returns no audio inline data", async () => {
    const client: GeminiMusicClient = {
      models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] }) },
    };
    const provider = new GeminiMusicProvider({ client, apiKey: "fake" });
    await expect(
      provider.generate({ prompt: "x", durationSec: 10, outputPath: join(root, "x.wav") }),
    ).rejects.toThrow(/no (audio|music)/i);
  });

  it("honors an already-aborted signal before calling the API", async () => {
    let called = false;
    const client: GeminiMusicClient = {
      models: { generateContent: async () => { called = true; return { candidates: [] }; } },
    };
    const controller = new AbortController();
    controller.abort();
    const provider = new GeminiMusicProvider({ client, apiKey: "fake" });
    await expect(
      provider.generate({ prompt: "x", durationSec: 10, outputPath: join(root, "x.wav"), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(called).toBe(false);
  });
});
