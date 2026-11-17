// Process-wide render concurrency gate: a 2-vCPU prod VM forking one headless
// -Chrome render per finishing session contends for the same CPU, slowing
// every render down and risking the stall/hard timeouts (or worse, OOM) once
// several sessions finish compose around the same time. Beyond `capacity`
// simultaneous renders, later callers queue in FIFO order instead of forking
// immediately. Every `acquire()` returns its own reservation with its own
// `release()` — there is no free-standing release, so a call can never be
// mismatched to the wrong acquire or double-applied to the same slot.
import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import { RenderConcurrencyLimiter } from "../src/render/render-concurrency-limiter.js";

describe("RenderConcurrencyLimiter", () => {
  it("grants immediately up to capacity", async () => {
    const limiter = new RenderConcurrencyLimiter(2);
    const a = limiter.acquire();
    const b = limiter.acquire();
    expect(a.position).toBe(0);
    expect(b.position).toBe(0);
    await expect(a.granted).resolves.toBeUndefined();
    await expect(b.granted).resolves.toBeUndefined();
    expect(limiter.activeCount).toBe(2);
    expect(limiter.queueLength).toBe(0);
  });

  it("queues beyond capacity, reporting position at call time", async () => {
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire();
    const b = limiter.acquire();
    const c = limiter.acquire();
    expect(a.position).toBe(0);
    expect(b.position).toBe(1);
    expect(c.position).toBe(2);
    expect(limiter.queueLength).toBe(2);

    let bGranted = false;
    void b.granted.then(() => { bGranted = true; });
    await Promise.resolve();
    expect(bGranted).toBe(false); // still queued — capacity is held by a
  });

  it("releasing grants the next queued caller, in FIFO order", async () => {
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire();
    const b = limiter.acquire();
    const c = limiter.acquire();
    const order: string[] = [];
    void b.granted.then(() => order.push("b"));
    void c.granted.then(() => order.push("c"));

    await a.granted;
    a.release();
    await b.granted; // now granted
    expect(order).toEqual(["b"]);
    expect(limiter.queueLength).toBe(1); // c still waiting

    b.release();
    await c.granted;
    expect(order).toEqual(["b", "c"]);
    expect(limiter.queueLength).toBe(0);
  });

  it("a new acquire after an uncontested release gets position 0 again", async () => {
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire();
    await a.granted;
    a.release();

    const d = limiter.acquire();
    expect(d.position).toBe(0);
    await expect(d.granted).resolves.toBeUndefined();
  });

  it("release() is idempotent — a second call neither double-frees nor re-grants", async () => {
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire();
    await a.granted;
    a.release();
    a.release(); // must not decrement activeCount again or re-grant anyone

    const b = limiter.acquire();
    expect(b.position).toBe(0); // exactly one slot was freed, not two
    expect(limiter.activeCount).toBe(1);
  });

  it("aborting a queued acquire rejects it and never consumes a slot", async () => {
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire(); // holds the only slot
    const controller = new AbortController();
    const b = limiter.acquire(controller.signal);
    expect(b.position).toBe(1);

    controller.abort();
    await expect(b.granted).rejects.toThrow(/abort/i);
    expect(limiter.queueLength).toBe(0);

    // Releasing `a` must free the slot for a THIRD caller, not resurrect `b`.
    const c = limiter.acquire();
    await a.granted;
    a.release();
    await expect(c.granted).resolves.toBeUndefined();
  });

  it("an already-aborted signal at capacity rejects without incrementing active or ever queueing", async () => {
    // Regression: RenderPhaseHandler only checks ctx.signal.aborted once at
    // the top of run(), before several awaited steps — a user's abort can
    // land in that window, so acquire() may see an already-aborted signal
    // while at capacity. The rejection must be handled by the caller (see
    // LimitedRenderWorkerClient, which always awaits `granted`) and must
    // never corrupt the semaphore's bookkeeping.
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire(); // holds the only slot
    const controller = new AbortController();
    controller.abort();
    const b = limiter.acquire(controller.signal);

    expect(limiter.queueLength).toBe(0);
    await expect(b.granted).rejects.toThrow(/abort/i);
    // `b` never took a slot: releasing it must be a no-op, not a corrupting
    // decrement of a slot it never held.
    b.release();
    expect(limiter.activeCount).toBe(1); // only `a`'s slot, untouched

    void a;
  });

  it("releasing a reservation while it is STILL QUEUED dequeues it without ever taking a slot", async () => {
    // This is what a caller MUST do if it abandons the wait (e.g. its own
    // consumer stopped pulling values) instead of ever reaching `granted` —
    // otherwise the entry sits in the queue forever and, once eventually
    // granted by some future release(), permanently wedges a phantom slot
    // nobody is listening for.
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire(); // holds the only slot
    const b = limiter.acquire(); // queued, position 1
    expect(limiter.queueLength).toBe(1);

    b.release(); // abandoned while still queued
    expect(limiter.queueLength).toBe(0);

    await a.granted;
    a.release();
    // The slot must go to a THIRD, later caller — not silently vanish nor
    // grant the abandoned `b`.
    const c = limiter.acquire();
    expect(c.position).toBe(0);
    await expect(c.granted).resolves.toBeUndefined();
    expect(limiter.activeCount).toBe(1);
  });

  it("removes the queued-wait abort listener once granted — no stale listener lingers on the signal", async () => {
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire();
    const controller = new AbortController();
    const b = limiter.acquire(controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    a.release();
    await b.granted;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    b.release();
  });

  it("removes the queued-wait abort listener when the reservation is released while still queued", () => {
    const limiter = new RenderConcurrencyLimiter(1);
    const a = limiter.acquire();
    const controller = new AbortController();
    const b = limiter.acquire(controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

    b.release(); // abandoned while still queued, never granted
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    void a;
  });

  it("rejects a non-positive or non-integer capacity", () => {
    expect(() => new RenderConcurrencyLimiter(0)).toThrow();
    expect(() => new RenderConcurrencyLimiter(-1)).toThrow();
    expect(() => new RenderConcurrencyLimiter(1.5)).toThrow();
  });
});
