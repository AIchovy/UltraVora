import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { makeGenerateMusicTool } from "../src/tools/music-tools.js";
import type { MusicProvider, MusicInput, MusicResult } from "../src/providers/types.js";
import type { MusicData } from "@ultracreator/shared";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-genmusic-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const AUDIO = Buffer.from("RIFFfakewav", "ascii");
const signal = new AbortController().signal;

function storeFor(wm: WorkspaceManager): ArtifactStore {
  return new ArtifactStore(new InMemoryArtifactRepository(), new EventBus());
}

function fakeProvider(calls: MusicInput[] = []): MusicProvider {
  return {
    id: "fake",
    async generate(input: MusicInput): Promise<MusicResult> {
      calls.push(input);
      await writeFile(input.outputPath, AUDIO);
      return { audioPath: input.outputPath, mimeType: "audio/wav" };
    },
  };
}

describe("makeGenerateMusicTool", () => {
  it("writes the track into composition/ and returns a bare filename", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeGenerateMusicTool({ sessionId: "s1", workspaces: wm, provider: fakeProvider(), artifacts: storeFor(wm) });
    const res = await tool.execute("c1", { prompt: "cinematic ambient", durationSec: 30 }, signal);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^[0-9a-f]+\.wav$/);
    expect(text).not.toContain("/");
    expect(existsSync(join(wm.paths("s1").composition, text))).toBe(true);
  });

  it("forwards the prompt and duration to the provider", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const calls: MusicInput[] = [];
    const tool = makeGenerateMusicTool({ sessionId: "s1", workspaces: wm, provider: fakeProvider(calls), artifacts: storeFor(wm) });
    await tool.execute("c1", { prompt: "lofi beat", durationSec: 45 }, signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("lofi beat");
    expect(calls[0]!.durationSec).toBe(45);
  });

  it("rejects an empty prompt", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeGenerateMusicTool({ sessionId: "s1", workspaces: wm, provider: fakeProvider(), artifacts: storeFor(wm) });
    await expect(tool.execute("c1", { prompt: "  ", durationSec: 30 }, signal)).rejects.toThrow(/prompt/i);
  });

  it("records a music artifact pointing at the generated file", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const store = storeFor(wm);
    const tool = makeGenerateMusicTool({ sessionId: "s1", workspaces: wm, provider: fakeProvider(), artifacts: store });
    const res = await tool.execute("c1", { prompt: "cinematic ambient", durationSec: 30 }, signal);
    const fileName = (res.content[0] as { text: string }).text;
    const env = await store.get<MusicData>("s1", "music");
    expect(env?.data).toEqual({ file: fileName, prompt: "cinematic ambient", durationSec: 30 });
  });

  it("persists beat analysis and returns usable sync points", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const store = storeFor(wm);
    const tool = makeGenerateMusicTool({
      sessionId: "s1", workspaces: wm, provider: fakeProvider(), artifacts: store,
      audioAnalyzer: { analyze: async () => ({
        durationSec: 30, fps: 30, bpm: 120,
        beatTimesSec: [0.5, 1, 1.5], energyPeaksSec: [1], frames: [],
      }) },
    });
    const result = await tool.execute("c1", { prompt: "rhythmic launch", durationSec: 30 }, signal);
    const music = await store.get<MusicData>("s1", "music");
    expect(music?.data).toMatchObject({ bpm: 120, beatTimesSec: [0.5, 1, 1.5] });
    expect(music?.data.analysisFile).toMatch(/\.analysis\.json$/);
    expect(existsSync(join(wm.paths("s1").composition, music!.data.analysisFile!))).toBe(true);
    expect((result.content[1] as { text: string }).text).toContain("sync points 0.5, 1, 1.5s");
  });
});

describe("makeGenerateMusicTool: transient-error retry", () => {
  function flakyProvider(failures: number, calls: MusicInput[] = []): MusicProvider {
    let n = 0;
    return {
      id: "flaky",
      async generate(input: MusicInput): Promise<MusicResult> {
        calls.push(input);
        if (++n <= failures) {
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
          });
        }
        await writeFile(input.outputPath, AUDIO);
        return { audioPath: input.outputPath, mimeType: "audio/wav" };
      },
    };
  }

  it("retries a transient provider failure and succeeds", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const calls: MusicInput[] = [];
    const tool = makeGenerateMusicTool({
      sessionId: "s1", workspaces: wm, provider: flakyProvider(1, calls), artifacts: storeFor(wm),
      retry: { baseDelayMs: 1 },
    });
    const res = await tool.execute("c1", { prompt: "ambient", durationSec: 30 }, signal);
    expect((res.content[0] as { text: string }).text).toMatch(/^[0-9a-f]+\.wav$/);
    expect(calls).toHaveLength(2);
  });

  it("gives up after max attempts on persistent transient failure", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const calls: MusicInput[] = [];
    const tool = makeGenerateMusicTool({
      sessionId: "s1", workspaces: wm, provider: flakyProvider(Number.POSITIVE_INFINITY, calls), artifacts: storeFor(wm),
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    await expect(tool.execute("c1", { prompt: "ambient", durationSec: 30 }, signal)).rejects.toThrow(/fetch failed/);
    expect(calls).toHaveLength(3);
  });
});
