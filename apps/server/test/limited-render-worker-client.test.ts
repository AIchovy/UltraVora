// LimitedRenderWorkerClient wraps a RenderWorkerClient so at most `capacity`
// renders fork at once — see render-concurrency-limiter.ts for the prod
// motivation. These tests drive the async iterators manually (not the shared
// `collect()` helper) so we can assert what has/hasn't started mid-flight.
import { describe, it, expect, vi } from "vitest";
import type { RenderWorkerClient, RenderOptions } from "../src/render/render-worker-client.js";
import type { WorkerMessage } from "../src/render/worker-protocol.js";
import { RenderConcurrencyLimiter } from "../src/render/render-concurrency-limiter.js";
import { LimitedRenderWorkerClient } from "../src/render/limited-render-worker-client.js";

/** Fully controllable fake: each `render()` call blocks until `finish(n)` is called. */
class ControllableRenderWorkerClient implements RenderWorkerClient {
  callCount = 0;
  started: boolean[] = [];
  private gates: Array<() => void> = [];
  private shouldThrow: Set<number> = new Set();

  throwOn(n: number): void {
    this.shouldThrow.add(n);
  }

  render(_opts: RenderOptions): AsyncIterable<WorkerMessage> {
    const idx = this.callCount++;
    const self = this;
    return (async function* (): AsyncGenerator<WorkerMessage> {
      self.started[idx] = true;
      await new Promise<void>((resolve) => { self.gates[idx] = resolve; });
      if (self.shouldThrow.has(idx)) throw new Error(`boom-${idx}`);
      yield { type: "done", mp4Path: `out-${idx}.mp4` };
    })();
  }

  finish(idx: number): void {
    this.gates[idx]?.();
  }
}

const opts = (signal: AbortSignal): RenderOptions => ({
  projectDir: "/proj",
  outputPath: "/proj/out.mp4",
  signal,
});

describe("LimitedRenderWorkerClient", () => {
  it("logs when a render queues and when its slot is granted (operator visibility)", async () => {
    // The chat only gets a one-time "queued" notice; the only other signal
    // an operator has is these log lines — see render-handler.ts's `case
    // "queued"` and the review that flagged zero visibility otherwise.
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const inner = new ControllableRenderWorkerClient();
    const limiter = new RenderConcurrencyLimiter(1);
    const client = new LimitedRenderWorkerClient(inner, limiter);

    const iter1 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const iter2 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const next1 = iter1.next();
    await vi.waitFor(() => expect(inner.started[0]).toBe(true));
    await iter2.next(); // queued
    const next2 = iter2.next(); // drives past the yield to await granted

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("queued for /proj"));
    logSpy.mockClear();

    inner.finish(0);
    await next1;
    await iter1.next(); // drains the outer generator so its own release() fires

    await vi.waitFor(() => expect(inner.started[1]).toBe(true));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("slot granted for /proj"));

    inner.finish(1);
    await next2;
    logSpy.mockRestore();
  });

  it("blocks a second render at capacity 1 until the first completes, reporting queue position", async () => {
    const inner = new ControllableRenderWorkerClient();
    const limiter = new RenderConcurrencyLimiter(1);
    const client = new LimitedRenderWorkerClient(inner, limiter);

    const iter1 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const iter2 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();

    // First render starts immediately (capacity available).
    const next1 = iter1.next();
    await vi.waitFor(() => expect(inner.started[0]).toBe(true));

    // Second is queued: yields `queued` and never starts the inner render.
    const msg2 = await iter2.next();
    expect(msg2.value).toEqual({ type: "queued", position: 1 });
    expect(inner.started[1]).toBeUndefined();

    // The consumer (render-handler's `for await`) immediately asks for the
    // next value — that's what drives the generator past the yield to
    // `await granted`. Only the SECOND `.next()` call does this; the promise
    // it returns won't settle until the slot is actually granted.
    const next2 = iter2.next();

    inner.finish(0);
    expect((await next1).value).toEqual({ type: "done", mp4Path: "out-0.mp4" });
    expect((await iter1.next()).done).toBe(true);

    // Releasing the first slot lets the second start.
    await vi.waitFor(() => expect(inner.started[1]).toBe(true));
    inner.finish(1);
    expect((await next2).value).toEqual({ type: "done", mp4Path: "out-1.mp4" });
  });

  it("runs up to capacity concurrently with no queued message", async () => {
    const inner = new ControllableRenderWorkerClient();
    const limiter = new RenderConcurrencyLimiter(2);
    const client = new LimitedRenderWorkerClient(inner, limiter);

    const iter1 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const iter2 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const next1 = iter1.next();
    const next2 = iter2.next();
    await vi.waitFor(() => {
      expect(inner.started[0]).toBe(true);
      expect(inner.started[1]).toBe(true);
    });
    inner.finish(0);
    inner.finish(1);
    expect((await next1).value).toEqual({ type: "done", mp4Path: "out-0.mp4" });
    expect((await next2).value).toEqual({ type: "done", mp4Path: "out-1.mp4" });
  });

  it("releases the slot even when the inner render throws, so a queued caller still proceeds", async () => {
    const inner = new ControllableRenderWorkerClient();
    inner.throwOn(0);
    const limiter = new RenderConcurrencyLimiter(1);
    const client = new LimitedRenderWorkerClient(inner, limiter);

    const iter1 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const iter2 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const next1 = iter1.next();
    await vi.waitFor(() => expect(inner.started[0]).toBe(true));
    const msg2 = await iter2.next();
    expect(msg2.value).toEqual({ type: "queued", position: 1 });
    const next2 = iter2.next();

    inner.finish(0);
    await expect(next1).rejects.toThrow("boom-0");

    await vi.waitFor(() => expect(inner.started[1]).toBe(true));
    inner.finish(1);
    expect((await next2).value).toEqual({ type: "done", mp4Path: "out-1.mp4" });
  });

  it("an already-aborted signal at capacity yields an error instead of crashing or running the render anyway", async () => {
    // Regression: acquire() resolves this case with position 0 (no queueing)
    // but a REJECTED `granted` — the wrapper must still await/catch it rather
    // than treating position 0 as "proceed directly to the inner render".
    const inner = new ControllableRenderWorkerClient();
    const limiter = new RenderConcurrencyLimiter(1);
    const client = new LimitedRenderWorkerClient(inner, limiter);

    const controller1 = new AbortController();
    const iter1 = client.render(opts(controller1.signal))[Symbol.asyncIterator]();
    const next1 = iter1.next();
    await vi.waitFor(() => expect(inner.started[0]).toBe(true));

    const controller2 = new AbortController();
    controller2.abort();
    const iter2 = client.render(opts(controller2.signal))[Symbol.asyncIterator]();
    const msg2 = await iter2.next();
    expect(msg2.value).toMatchObject({ type: "error" });
    expect((msg2.value as { message: string }).message).toMatch(/abort/i);
    expect(inner.started[1]).toBeUndefined();
    expect((await iter2.next()).done).toBe(true);

    // The active slot count must be untouched by the aborted attempt.
    inner.finish(0);
    expect((await next1).value).toEqual({ type: "done", mp4Path: "out-0.mp4" });
    expect((await iter1.next()).done).toBe(true); // drains the outer generator to its own release()
    expect(limiter.activeCount).toBe(0);
  });

  it("abandoning a queued render (iterator never pulled again) releases its reservation instead of leaking the slot", async () => {
    // Regression: if the consumer stops pulling values while this render is
    // still queued (e.g. an exception elsewhere abandons the for-await
    // loop), calling .return() on the iterator must unwind through the
    // decorator's try/finally and dequeue the reservation — otherwise it
    // sits in the limiter's queue forever and, once eventually granted,
    // permanently wedges a phantom slot nobody is listening for.
    const inner = new ControllableRenderWorkerClient();
    const limiter = new RenderConcurrencyLimiter(1);
    const client = new LimitedRenderWorkerClient(inner, limiter);

    const iter1 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const iter2 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const next1 = iter1.next();
    await vi.waitFor(() => expect(inner.started[0]).toBe(true));

    const msg2 = await iter2.next(); // queued at position 1
    expect(msg2.value).toEqual({ type: "queued", position: 1 });
    expect(limiter.queueLength).toBe(1);

    await iter2.return?.(undefined); // consumer gives up on this render

    inner.finish(0);
    expect((await next1).value).toEqual({ type: "done", mp4Path: "out-0.mp4" });
    expect((await iter1.next()).done).toBe(true); // drains the outer generator to its own release()
    expect(limiter.queueLength).toBe(0);
    expect(limiter.activeCount).toBe(0); // released — not stuck at 1 forever

    // A fresh render must be able to acquire immediately — the abandoned
    // reservation didn't leave a phantom slot behind. Its inner render is
    // idx 1: the abandoned iter2 never reached (and must never reach)
    // `inner.render()` at all, so `callCount` only advanced once (iter1).
    expect(inner.callCount).toBe(1);
    const iter3 = client.render(opts(new AbortController().signal))[Symbol.asyncIterator]();
    const next3 = iter3.next();
    await vi.waitFor(() => expect(inner.started[1]).toBe(true));
    inner.finish(1);
    expect((await next3).value).toEqual({ type: "done", mp4Path: "out-1.mp4" });
  });

  it("aborting a queued render yields a single error message and never starts the inner render", async () => {
    const inner = new ControllableRenderWorkerClient();
    const limiter = new RenderConcurrencyLimiter(1);
    const client = new LimitedRenderWorkerClient(inner, limiter);
    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const iter1 = client.render(opts(controller1.signal))[Symbol.asyncIterator]();
    const iter2 = client.render(opts(controller2.signal))[Symbol.asyncIterator]();
    const next1 = iter1.next();
    await vi.waitFor(() => expect(inner.started[0]).toBe(true));

    const msg2 = await iter2.next();
    expect(msg2.value).toEqual({ type: "queued", position: 1 });

    controller2.abort();
    const err2 = await iter2.next();
    expect(err2.value).toMatchObject({ type: "error" });
    expect((err2.value as { message: string }).message).toMatch(/abort/i);
    expect((await iter2.next()).done).toBe(true);
    expect(inner.started[1]).toBeUndefined();

    // The first render is unaffected and still holds/releases its own slot.
    inner.finish(0);
    expect((await next1).value).toEqual({ type: "done", mp4Path: "out-0.mp4" });
  });
});
