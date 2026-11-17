import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderCommand } from "../src/render/worker-protocol.js";

const WORKER_PATH = fileURLToPath(new URL("../src/render/worker.ts", import.meta.url));
const FAKE_RENDERER = fileURLToPath(new URL("./fixtures/fake-renderer.mjs", import.meta.url));

let root: string;
let child: ChildProcess | undefined;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-ipc-")); });
afterEach(() => {
  try { child?.kill("SIGKILL"); } catch { /* ignore */ }
  child = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("worker IPC teardown", () => {
  it("does not crash when the parent disconnects mid-stream", async () => {
    const outputPath = join(root, "out.mp4");
    child = fork(WORKER_PATH, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });

    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker did not exit in time")), 5000);
        let disconnected = false;

        child!.on("message", (raw: unknown) => {
          const msg = raw as { type?: string };
          if (msg?.type === "ready") {
            const cmd: RenderCommand = {
              type: "render",
              projectDir: root,
              outputPath,
              rendererCommand: ["node", FAKE_RENDERER, "--stream"],
            };
            child!.send(cmd);
            return;
          }
          // First forwarded line from the streaming renderer: tear the channel
          // down while the renderer is still spewing stdout.
          if (!disconnected) {
            disconnected = true;
            child!.disconnect();
          }
        });

        child!.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
        child!.on("error", reject);
      },
    );

    // Include full context in failures — this test has flaked rarely under
    // parallel-suite load with a bare non-zero exit code and no diagnosis.
    const diag = `exit code=${result.code} signal=${result.signal} stderr=${JSON.stringify(stderr)}`;
    expect(stderr, diag).not.toContain("ERR_IPC_CHANNEL_CLOSED");
    expect(result.signal, diag).toBeNull();
    expect(result.code, diag).toBe(0);
  });
});
