import { writeFile } from "node:fs/promises";
import type { RenderOptions, RenderWorkerClient } from "./render-worker-client.js";
import type { WorkerMessage } from "./worker-protocol.js";

export interface StubRenderWorkerOptions {
  /** Scripted sequence yielded as-is. Default: one 50% progress + one done. */
  messages?: WorkerMessage[];
  /** If true, write a tiny placeholder MP4 to `outputPath` and force `done.mp4Path = outputPath`. */
  writeOutput?: boolean;
  /** If set, yields exactly one `error` message with this text and stops. */
  failWith?: string;
}

export class StubRenderWorkerClient implements RenderWorkerClient {
  constructor(private opts: StubRenderWorkerOptions = {}) {}

  async *render(opts: RenderOptions): AsyncIterable<WorkerMessage> {
    if (this.opts.failWith) {
      yield { type: "error", message: this.opts.failWith };
      return;
    }

    if (this.opts.writeOutput) {
      await writeFile(opts.outputPath, "STUB-MP4-BYTES");
      yield { type: "progress", percent: 50 };
      yield { type: "done", mp4Path: opts.outputPath };
      return;
    }

    const scripted = this.opts.messages ?? [
      { type: "progress", percent: 50 },
      { type: "done", mp4Path: opts.outputPath },
    ];
    for (const m of scripted) {
      yield m;
    }
  }
}
