import type { PhaseId, ServerEvent } from "@ultracreator/shared";
import type { ArtifactToWrite, PhaseContext, PhaseHandler } from "./types.js";

export interface FakePhaseHandlerOptions {
  phase: PhaseId;
  progress?: string[];
  produce: (ctx: PhaseContext) => Promise<ArtifactToWrite[]>;
}

export class FakePhaseHandler implements PhaseHandler {
  readonly phase: PhaseId;
  private opts: FakePhaseHandlerOptions;

  constructor(opts: FakePhaseHandlerOptions) {
    this.phase = opts.phase;
    this.opts = opts;
  }

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    if (ctx.signal.aborted) throw new Error("Aborted");
    for (const message of this.opts.progress ?? []) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      yield { type: "phase.progress", phase: this.phase, message };
    }
    if (ctx.signal.aborted) throw new Error("Aborted");
    const outputs = await this.opts.produce(ctx);
    for (const out of outputs) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      await ctx.artifacts.put(ctx.sessionId, out.kind, out.data, {
        derivedFrom: out.derivedFrom,
      });
    }
  }
}
