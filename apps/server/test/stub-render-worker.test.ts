import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerMessage } from "../src/render/worker-protocol.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-stub-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function collect(stream: AsyncIterable<WorkerMessage>): Promise<WorkerMessage[]> {
  const out: WorkerMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe("StubRenderWorkerClient", () => {
  it("yields the scripted messages in order", async () => {
    const client = new StubRenderWorkerClient({
      messages: [
        { type: "progress", percent: 25 },
        { type: "progress", percent: 75 },
        { type: "done", mp4Path: "/tmp/stub.mp4" },
      ],
    });
    const got = await collect(client.render({ projectDir: "/x", outputPath: "/tmp/stub.mp4" }));
    expect(got).toEqual([
      { type: "progress", percent: 25 },
      { type: "progress", percent: 75 },
      { type: "done", mp4Path: "/tmp/stub.mp4" },
    ]);
  });

  it("when writeOutput is true, materializes an MP4 at outputPath and rewrites the done.mp4Path", async () => {
    const client = new StubRenderWorkerClient({ writeOutput: true });
    const outputPath = join(root, "stub.mp4");
    const got = await collect(client.render({ projectDir: root, outputPath }));
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toContain("STUB-MP4");
    expect(got.at(-1)).toEqual({ type: "done", mp4Path: outputPath });
  });

  it("when configured to fail, yields an error message and stops", async () => {
    const client = new StubRenderWorkerClient({ failWith: "render kaboom" });
    const got = await collect(client.render({ projectDir: "/x", outputPath: "/tmp/x.mp4" }));
    expect(got).toEqual([{ type: "error", message: "render kaboom" }]);
  });
});
