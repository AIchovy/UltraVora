import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RenderCommand, WorkerMessage } from "./worker-protocol.js";

export interface RenderOptions {
  projectDir: string;
  outputPath: string;
  quality?: RenderCommand["quality"];
  fps?: RenderCommand["fps"];
  /** Override for unit tests (default: `npx hyperframes render ...`). */
  rendererCommand?: string[];
  /** Hard runaway cap (default 30 min) — see RenderCommand. */
  timeoutMs?: number;
  /** No-output stall kill (default 5 min) — see RenderCommand. */
  stallTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface RenderWorkerClient {
  render(opts: RenderOptions): AsyncIterable<WorkerMessage>;
}

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * Default RenderWorkerClient: forks `worker.ts` and bridges its IPC into an
 * AsyncIterable. The iterator completes after the first `done` or `error`
 * message; the child is killed on iterator completion or `signal` abort.
 */
export class ForkedRenderWorkerClient implements RenderWorkerClient {
  constructor(private workerPath: string = WORKER_PATH) {}

  async *render(opts: RenderOptions): AsyncIterable<WorkerMessage> {
    // The project runs TypeScript directly via tsx; the worker is a .ts file,
    // so the forked child must load tsx's ESM loader.
    const child: ChildProcess = fork(this.workerPath, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    const queue: WorkerMessage[] = [];
    let waiter: (() => void) | null = null;
    let finished = false;

    const onAbort = () => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort);
    }

    const drain = (msg: WorkerMessage) => {
      queue.push(msg);
      if (waiter) { const w = waiter; waiter = null; w(); }
    };

    child.on("message", (raw: unknown) => {
      const msg = raw as WorkerMessage;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        const cmd: RenderCommand = {
          type: "render",
          projectDir: opts.projectDir,
          outputPath: opts.outputPath,
          quality: opts.quality,
          fps: opts.fps,
          rendererCommand: opts.rendererCommand,
          timeoutMs: opts.timeoutMs,
          stallTimeoutMs: opts.stallTimeoutMs,
        };
        child.send(cmd);
        return;
      }
      drain(msg);
    });

    const onClose = () => {
      if (finished) return;
      // The worker exited without sending a terminal message — synthesize one.
      drain({ type: "error", message: "Render worker exited unexpectedly" });
    };
    child.on("exit", onClose);
    child.on("error", (err) => drain({ type: "error", message: err.message }));

    try {
      while (!finished) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { waiter = resolve; });
          continue;
        }
        const msg = queue.shift()!;
        yield msg;
        if (msg.type === "done" || msg.type === "error") {
          finished = true;
        }
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}
