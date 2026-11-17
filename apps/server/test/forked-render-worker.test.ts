import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerMessage } from "../src/render/worker-protocol.js";
import { ForkedRenderWorkerClient } from "../src/render/render-worker-client.js";

const FAKE_RENDERER = fileURLToPath(new URL("./fixtures/fake-renderer.mjs", import.meta.url));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-fork-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function collect(stream: AsyncIterable<WorkerMessage>): Promise<WorkerMessage[]> {
  const out: WorkerMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe("ForkedRenderWorkerClient", () => {
  it("forwards progress lines and ends with a done message containing the output path", async () => {
    const client = new ForkedRenderWorkerClient();
    const outputPath = join(root, "out.mp4");
    const messages = await collect(client.render({
      projectDir: root,
      outputPath,
      rendererCommand: ["node", FAKE_RENDERER, "--output", outputPath, "--lines", "3"],
    }));

    const progress = messages.filter((m) => m.type === "progress");
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toMatchObject({ type: "progress", percent: 100 });

    const last = messages.at(-1)!;
    expect(last).toEqual({ type: "done", mp4Path: outputPath });
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe("FAKE-MP4-BYTES");
  });

  it("yields an error message when the renderer exits non-zero", async () => {
    const client = new ForkedRenderWorkerClient();
    const messages = await collect(client.render({
      projectDir: root,
      outputPath: join(root, "out.mp4"),
      rendererCommand: ["node", FAKE_RENDERER, "--fail"],
    }));
    const last = messages.at(-1)!;
    expect(last.type).toBe("error");
    if (last.type === "error") expect(last.message).toMatch(/code 2/);
  });

  it("kills the renderer and yields error when timeoutMs elapses", async () => {
    const client = new ForkedRenderWorkerClient();
    const messages = await collect(client.render({
      projectDir: root,
      outputPath: join(root, "out.mp4"),
      rendererCommand: ["node", FAKE_RENDERER, "--hang"],
      timeoutMs: 150,
    }));
    const last = messages.at(-1)!;
    expect(last.type).toBe("error");
    if (last.type === "error") expect(last.message).toMatch(/time/i);
  });

  it("kills a silent renderer after stallTimeoutMs without waiting for the hard cap", async () => {
    // Prod regression: the old single hard timer (5 min) killed renders that
    // were still progressing. The replacement is a stall timer — silence is
    // the failure signal, not total duration.
    const client = new ForkedRenderWorkerClient();
    const messages = await collect(client.render({
      projectDir: root,
      outputPath: join(root, "out.mp4"),
      rendererCommand: ["node", FAKE_RENDERER, "--hang"],
      stallTimeoutMs: 200,
      timeoutMs: 60_000, // generous hard cap must NOT be what fires here
    }));
    const last = messages.at(-1)!;
    expect(last.type).toBe("error");
    if (last.type === "error") expect(last.message).toMatch(/stalled/i);
  });

  it("a slow-but-progressing render outlives the stall window (output resets the timer)", async () => {
    const client = new ForkedRenderWorkerClient();
    const outputPath = join(root, "out.mp4");
    // 6 progress lines, one every 100ms → 600ms total, well past the 250ms
    // stall window; each line must reset it.
    const messages = await collect(client.render({
      projectDir: root,
      outputPath,
      rendererCommand: ["node", FAKE_RENDERER, "--output", outputPath, "--drip", "6", "--interval", "100"],
      stallTimeoutMs: 250,
      timeoutMs: 60_000,
    }));
    expect(messages.at(-1)).toEqual({ type: "done", mp4Path: outputPath });
    expect(existsSync(outputPath)).toBe(true);
  });

  it("the hard cap still bounds a renderer that progresses forever", async () => {
    const client = new ForkedRenderWorkerClient();
    const messages = await collect(client.render({
      projectDir: root,
      outputPath: join(root, "out.mp4"),
      rendererCommand: ["node", FAKE_RENDERER, "--drip-forever", "--interval", "50"],
      stallTimeoutMs: 60_000,
      timeoutMs: 400,
    }));
    const last = messages.at(-1)!;
    expect(last.type).toBe("error");
    if (last.type === "error") expect(last.message).toMatch(/timed out/i);
  });

  it("ends the iterator after a done message (no dangling work)", async () => {
    const client = new ForkedRenderWorkerClient();
    const outputPath = join(root, "out.mp4");
    let count = 0;
    for await (const _ of client.render({
      projectDir: root,
      outputPath,
      rendererCommand: ["node", FAKE_RENDERER, "--output", outputPath, "--lines", "1"],
    })) {
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });
});
