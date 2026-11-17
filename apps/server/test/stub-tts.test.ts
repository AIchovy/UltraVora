import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubTTSProvider } from "../src/providers/stub-tts.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-stub-tts-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("StubTTSProvider", () => {
  it("writes a non-empty WAV file at the requested path and returns its duration", async () => {
    const provider = new StubTTSProvider();
    const out = join(root, "narration.wav");
    const result = await provider.synthesize({ text: "Hello world", outputPath: out });
    expect(result.audioPath).toBe(out);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);
    const data = readFileSync(out);
    // RIFF/WAVE header sanity-check.
    expect(data.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(data.slice(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("returns word timings spanning the duration when withTimings is set", async () => {
    const provider = new StubTTSProvider({ withTimings: true });
    const out = join(root, "n.wav");
    const result = await provider.synthesize({ text: "one two three", outputPath: out });
    expect(result.wordTimings).toBeDefined();
    expect(result.wordTimings!.map((w) => w.word)).toEqual(["one", "two", "three"]);
    const last = result.wordTimings![result.wordTimings!.length - 1]!;
    expect(last.endMs).toBeLessThanOrEqual(result.durationMs);
  });

  it("respects an already-aborted signal", async () => {
    const provider = new StubTTSProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.synthesize({ text: "anything", outputPath: join(root, "x.wav"), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
