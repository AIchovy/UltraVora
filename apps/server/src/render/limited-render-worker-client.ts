import type { RenderOptions, RenderWorkerClient } from "./render-worker-client.js";
import type { WorkerMessage } from "./worker-protocol.js";
import type { RenderConcurrencyLimiter } from "./render-concurrency-limiter.js";

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decorates a RenderWorkerClient so at most `limiter`'s capacity renders run
 * at once, process-wide. Beyond capacity, callers wait in FIFO order instead
 * of forking immediately and contending for the host's CPU — prod evidence:
 * concurrent renders on a 2-vCPU VM slow each other down and risk tripping
 * the stall/hard render timeouts, or worse, OOM from simultaneous
 * headless-Chrome instances.
 */
export class LimitedRenderWorkerClient implements RenderWorkerClient {
  constructor(
    private inner: RenderWorkerClient,
    private limiter: RenderConcurrencyLimiter,
  ) {}

  async *render(opts: RenderOptions): AsyncIterable<WorkerMessage> {
    const reservation = this.limiter.acquire(opts.signal);
    // Everything — including the `queued` yield and the wait itself — lives
    // inside this try/finally, so `release()` still fires if the caller
    // abandons the iterator mid-wait (e.g. the consuming loop throws before
    // pulling the next value): a reservation that's still queued gets
    // dequeued without ever taking a slot, so it can never wedge one.
    try {
      if (reservation.position > 0) {
        // Operator visibility: the chat only gets a one-time notice (see
        // render-handler.ts's "queued" case), so without this log line a
        // session sitting in the render queue is indistinguishable from a
        // genuinely hung one from outside the process (e.g. `journalctl`).
        console.log(
          `[render-queue] queued for ${opts.projectDir} — position ${reservation.position} ` +
          `(${this.limiter.activeCount} rendering, ${this.limiter.queueLength} waiting)`,
        );
        yield { type: "queued", position: reservation.position };
      }
      try {
        // Always awaited regardless of position: an already-aborted signal
        // at capacity resolves with position 0 but a REJECTED `granted` —
        // skipping this await for position 0 would both crash on the
        // unhandled rejection and run the render anyway despite the abort.
        await reservation.granted;
      } catch (err) {
        yield { type: "error", message: describeError(err) };
        return;
      }
      if (reservation.position > 0) {
        console.log(`[render-queue] slot granted for ${opts.projectDir}`);
      }
      yield* this.inner.render(opts);
    } finally {
      reservation.release();
    }
  }
}
