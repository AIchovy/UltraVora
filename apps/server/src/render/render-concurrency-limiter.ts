export interface Reservation {
  /** Queue depth ahead of this caller at the time of the call. 0 = granted immediately. */
  readonly position: number;
  /** Resolves once a slot is available; rejects if this reservation is released or its signal aborts first (never took a slot). */
  readonly granted: Promise<void>;
  /**
   * Give up this reservation. Idempotent and safe at ANY point in its
   * lifecycle: if the slot was already granted, frees it for the next
   * queued caller; if still queued, removes it from the queue without ever
   * taking a slot (so an abandoned reservation can never wedge one). Callers
   * MUST call this exactly once they are done with the reservation — wrap
   * the whole usage (including any `yield` before `granted` settles) in a
   * `try/finally` so it still fires if the caller is abandoned mid-wait.
   */
  release(): void;
}

type EntryState = "queued" | "granted" | "done";

interface QueueEntry {
  resolve: () => void;
  reject: (err: Error) => void;
  state: EntryState;
  /** Detaches this entry's abort listener. Set only for queued entries with a signal. */
  detach?: () => void;
}

/**
 * Process-wide semaphore gating how many renders run at once. Every
 * `acquire()` call gets its OWN reservation with its own `release()` — there
 * is no free-standing release method, so a release can never be mismatched
 * to the wrong acquire or double-applied to the same slot.
 */
export class RenderConcurrencyLimiter {
  private active = 0;
  private queue: QueueEntry[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`RenderConcurrencyLimiter capacity must be a positive integer, got ${capacity}`);
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  acquire(signal?: AbortSignal): Reservation {
    if (this.active < this.capacity) {
      this.active++;
      const entry: QueueEntry = { resolve: () => undefined, reject: () => undefined, state: "granted" };
      return {
        position: 0,
        granted: Promise.resolve(),
        release: () => this.releaseEntry(entry),
      };
    }

    if (signal?.aborted) {
      const granted = Promise.reject(new Error("Aborted while queued for a render slot"));
      granted.catch(() => undefined);
      return { position: 0, granted, release: () => undefined };
    }

    const position = this.queue.length + 1;
    const entry: QueueEntry = { resolve: () => undefined, reject: () => undefined, state: "queued" };
    let onAbort: (() => void) | undefined;
    const granted = new Promise<void>((resolve, reject) => {
      entry.resolve = () => {
        entry.state = "granted";
        resolve();
      };
      entry.reject = (err) => {
        entry.state = "done";
        reject(err);
      };
      if (signal) {
        onAbort = () => {
          const idx = this.queue.indexOf(entry);
          if (idx < 0) return; // already granted or released — nothing to abort
          this.queue.splice(idx, 1);
          entry.reject(new Error("Aborted while queued for a render slot"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", onAbort!);
      }
    });
    granted.catch(() => undefined);
    this.queue.push(entry);

    return {
      position,
      granted,
      release: () => {
        entry.detach?.();
        if (entry.state === "queued") {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
          entry.state = "done";
          return;
        }
        this.releaseEntry(entry);
      },
    };
  }

  private releaseEntry(entry: QueueEntry): void {
    if (entry.state !== "granted") return; // already released, or never actually held a slot
    entry.state = "done";
    this.active--;
    const next = this.queue.shift();
    if (next) {
      next.detach?.(); // its wait is over — no longer needs its own abort listener
      this.active++;
      next.resolve();
    }
  }
}
