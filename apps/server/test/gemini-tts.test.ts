import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiTTSProvider, type GeminiClient } from "../src/providers/gemini-tts.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-gemini-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// 24kHz × 0.1s × 2 bytes = 4800 bytes of silence (zeros) PCM.
const fakePcmBase64 = Buffer.alloc(4800).toString("base64");

function fakeClient(): GeminiClient {
  return {
    models: {
      generateContent: async () => ({
        candidates: [{
          content: {
            parts: [{
              inlineData: {
                mimeType: "audio/L16;rate=24000",
                data: fakePcmBase64,
              },
            }],
          },
        }],
      }),
    },
  };
}

describe("GeminiTTSProvider (unit)", () => {
  it("prefixes a delivery-style instruction so Gemini reads it as direction, not content", async () => {
    let sentText = "";
    const client: GeminiClient = {
      models: {
        generateContent: async (req: any) => {
          sentText = req.contents[0].parts[0].text;
          return {
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: fakePcmBase64 } }] } }],
          };
        },
      },
    };
    const provider = new GeminiTTSProvider({ client, apiKey: "fake" });
    const result = await provider.synthesize({
      text: "Meet Acme.",
      styleInstruction: "Say in a warm, energetic tone",
      outputPath: join(root, "s.wav"),
    });
    expect(sentText).toBe("Say in a warm, energetic tone:\n\nMeet Acme.");
    // Word timings (when enabled) must span only the spoken text — covered by
    // the existing timing test using plain text; here just assert audio wrote.
    expect(result.durationMs).toBe(100);
  });

  it("calls the Gemini API and writes a WAV file with the returned PCM", async () => {
    const provider = new GeminiTTSProvider({ client: fakeClient(), apiKey: "fake" });
    const out = join(root, "n.wav");
    const result = await provider.synthesize({ text: "Hello", outputPath: out });
    expect(result.audioPath).toBe(out);
    expect(result.durationMs).toBe(100);
    expect(existsSync(out)).toBe(true);
    const data = readFileSync(out);
    expect(data.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(data.slice(8, 12).toString("ascii")).toBe("WAVE");
    expect(data.length).toBe(44 + 4800);
  });

  it("rejects when the API returns no audio inline data", async () => {
    const client: GeminiClient = {
      models: {
        generateContent: async () => ({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] }),
      },
    };
    const provider = new GeminiTTSProvider({ client, apiKey: "fake" });
    await expect(
      provider.synthesize({ text: "hi", outputPath: join(root, "x.wav") }),
    ).rejects.toThrow(/no audio/i);
  });

  it("honors an already-aborted signal before calling the API", async () => {
    let called = false;
    const client: GeminiClient = {
      models: {
        generateContent: async () => {
          called = true;
          return { candidates: [] };
        },
      },
    };
    const controller = new AbortController();
    controller.abort();
    const provider = new GeminiTTSProvider({ client, apiKey: "fake" });
    await expect(
      provider.synthesize({ text: "x", outputPath: join(root, "x.wav"), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(called).toBe(false);
  });

  it("emits evenly-spaced word timings when approximateWordTimings is enabled", async () => {
    const provider = new GeminiTTSProvider({
      client: fakeClient(),
      apiKey: "fake",
      approximateWordTimings: true,
    });
    const result = await provider.synthesize({
      text: "one two three",
      outputPath: join(root, "n.wav"),
    });
    expect(result.wordTimings).toBeDefined();
    expect(result.wordTimings!.map((w) => w.word)).toEqual(["one", "two", "three"]);
    const last = result.wordTimings![result.wordTimings!.length - 1]!;
    expect(last.endMs).toBeLessThanOrEqual(result.durationMs);
  });
});

// Optional, expensive — only runs when GEMINI_API_KEY is set.
describe.runIf(process.env.GEMINI_API_KEY)("GeminiTTSProvider (@external)", () => {
  it("synthesizes a short utterance via the real Gemini API", async () => {
    const provider = new GeminiTTSProvider({ apiKey: process.env.GEMINI_API_KEY! });
    const out = join(root, "real.wav");
    const result = await provider.synthesize({ text: "Hello from UltraVora.", outputPath: out });
    expect(result.audioPath).toBe(out);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).slice(0, 4).toString("ascii")).toBe("RIFF");
  }, 60_000);
});
