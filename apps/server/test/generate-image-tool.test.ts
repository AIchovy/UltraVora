import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeGenerateImageTool } from "../src/tools/image-tools.js";
import type { ImageProvider, ImageInput, ImageResult } from "../src/providers/types.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-genimg-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const signal = new AbortController().signal;

/** Fake provider: writes PNG bytes to the requested outputPath. Captures inputs. */
function fakeProvider(calls: ImageInput[] = []): ImageProvider {
  return {
    id: "fake",
    async generate(input: ImageInput): Promise<ImageResult> {
      calls.push(input);
      await writeFile(input.outputPath, PNG);
      return { imagePath: input.outputPath, mimeType: "image/png" };
    },
  };
}

describe("makeGenerateImageTool", () => {
  it("writes into assets/ and returns the relative assets path (design phase)", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: fakeProvider(), targetDir: "assets",
    });
    const res = await tool.execute("c1", { prompt: "a green cube" }, signal);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^assets\/[0-9a-f]+\.png$/);
    expect(existsSync(join(wm.paths("s1").assets, text.replace("assets/", "")))).toBe(true);
  });

  it("appends the design styleHint to every prompt exactly once", async () => {
    const calls: ImageInput[] = [];
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: fakeProvider(calls), targetDir: "composition",
      styleHint: "flat vector illustration, deep navy background",
    });
    await tool.execute("c1", { prompt: "a rocket launching" }, signal);
    expect(calls[0]!.prompt).toBe("a rocket launching. Style: flat vector illustration, deep navy background");
    // Already-styled prompts are not double-suffixed.
    await tool.execute("c2", { prompt: "a rocket, flat vector illustration, deep navy background" }, signal);
    expect(calls[1]!.prompt).not.toMatch(/Style:/);
  });

  it("writes into composition/ and returns a bare filename (compose phase)", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: fakeProvider(), targetDir: "composition",
    });
    const res = await tool.execute("c1", { prompt: "dashboard" }, signal);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^[0-9a-f]+\.png$/);
    expect(text).not.toContain("/");
    expect(existsSync(join(wm.paths("s1").composition, text))).toBe(true);
  });

  it("forwards the prompt and aspect ratio to the provider", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const calls: ImageInput[] = [];
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: fakeProvider(calls), targetDir: "assets",
    });
    await tool.execute("c1", { prompt: "neon city", aspectRatio: "16:9" }, signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toBe("neon city");
    expect(calls[0]!.aspectRatio).toBe("16:9");
  });

  it("produces distinct files for repeated identical prompts (variations do not collide)", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: fakeProvider(), targetDir: "assets",
    });
    const a = (await tool.execute("c1", { prompt: "same prompt" }, signal)).content[0] as { text: string };
    const b = (await tool.execute("c2", { prompt: "same prompt" }, signal)).content[0] as { text: string };
    expect(a.text).not.toBe(b.text);
    expect(readdirSync(wm.paths("s1").assets).length).toBe(2);
  });

  it("rejects an empty prompt", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: fakeProvider(), targetDir: "assets",
    });
    await expect(tool.execute("c1", { prompt: "   " }, signal)).rejects.toThrow(/prompt/i);
  });
});

describe("makeGenerateImageTool: transient-error retry", () => {
  /** Fails the first `failures` calls with an undici-style fetch error. */
  function flakyProvider(failures: number, calls: ImageInput[] = [], err?: () => Error): ImageProvider {
    let n = 0;
    return {
      id: "flaky",
      async generate(input: ImageInput): Promise<ImageResult> {
        calls.push(input);
        if (++n <= failures) {
          throw err?.() ?? new TypeError("fetch failed", {
            cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
          });
        }
        await writeFile(input.outputPath, PNG);
        return { imagePath: input.outputPath, mimeType: "image/png" };
      },
    };
  }

  it("retries a transient provider failure and succeeds", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const calls: ImageInput[] = [];
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: flakyProvider(1, calls), targetDir: "assets",
      retry: { baseDelayMs: 1 },
    });
    const res = await tool.execute("c1", { prompt: "a green cube" }, signal);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^assets\/[0-9a-f]+\.png$/);
    expect(calls).toHaveLength(2);
  });

  it("gives up after max attempts on persistent transient failure", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const calls: ImageInput[] = [];
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm, provider: flakyProvider(Number.POSITIVE_INFINITY, calls), targetDir: "assets",
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    await expect(tool.execute("c1", { prompt: "a cube" }, signal)).rejects.toThrow(/fetch failed/);
    expect(calls).toHaveLength(3);
  });

  it("does not retry non-transient provider errors", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const calls: ImageInput[] = [];
    const tool = makeGenerateImageTool({
      sessionId: "s1", workspaces: wm,
      provider: flakyProvider(Number.POSITIVE_INFINITY, calls, () => new Error("safety block: prompt rejected")),
      targetDir: "assets",
      retry: { baseDelayMs: 1 },
    });
    await expect(tool.execute("c1", { prompt: "a cube" }, signal)).rejects.toThrow(/safety block/);
    expect(calls).toHaveLength(1);
  });
});
