// apps/server/src/events/session-event-log.ts
import type { EventBus } from "./event-bus.js";
import type { EventStore, SequencedEvent } from "./event-store.js";

// Re-exported for back-compat: stream-routes imports SequencedEvent from here.
export type { SequencedEvent } from "./event-store.js";
export type SequencedListener = (entry: SequencedEvent) => void;

interface SessionState {
  nextSeq: number;
  subscribers: Set<SequencedListener>;
  unsubFromBus: () => void;
  buffer: SequencedEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Tail of the serialized append chain; resolves when the buffer is persisted. */
  pendingFlush: Promise<void>;
}

export interface SessionEventLogDeps {
  events: EventBus;
  store: EventStore;
  /** Batch window (ms) before a bulk insert. Default 100. Tests pass 0. */
  batchMs?: number;
}

/**
 * Sits between the orchestrator's EventBus and live SSE clients.
 *
 * - On `attach(sid)`: recover the next sequence number from the store
 *   (`maxSeq + 1`) and subscribe to the bus.
 * - On each bus event: stamp it with a per-session monotonic `seq` + ISO `at`,
 *   broadcast `{seq, at, event}` to live subscribers *synchronously*, and push
 *   it onto a buffer that is bulk-inserted ~`batchMs` later (the spec's write
 *   strategy for high-frequency agent.text). `flush(sid)` forces an immediate
 *   drain — the SSE route calls it before replaying so no buffered event is
 *   missed.
 * - `readSince(sid, sinceSeq)` delegates to the store for SSE replay.
 *
 * Sequence numbers are the source of truth for replay ordering; the seq dedup
 * in the SSE route makes the subscribe→flush→readSince→drain handoff safe.
 */
export class SessionEventLog {
  private states = new Map<string, SessionState>();
  private batchMs: number;

  constructor(private deps: SessionEventLogDeps) {
    this.batchMs = deps.batchMs ?? 100;
  }

  async attach(sessionId: string): Promise<void> {
    if (this.states.has(sessionId)) return;
    const nextSeq = (await this.deps.store.maxSeq(sessionId)) + 1;
    const state: SessionState = {
      nextSeq,
      subscribers: new Set(),
      unsubFromBus: () => {},
      buffer: [],
      flushTimer: null,
      pendingFlush: Promise.resolve(),
    };
    state.unsubFromBus = this.deps.events.subscribe(sessionId, (event) => {
      const entry: SequencedEvent = {
        seq: state.nextSeq++,
        at: new Date().toISOString(),
        event,
      };
      state.buffer.push(entry);
      for (const sub of [...state.subscribers]) sub(entry);
      if (!state.flushTimer) {
        state.flushTimer = setTimeout(() => {
          void this.persist(sessionId);
        }, this.batchMs);
      }
    });
    this.states.set(sessionId, state);
  }

  subscribe(sessionId: string, listener: SequencedListener): () => void {
    const state = this.states.get(sessionId);
    if (!state) return () => {};
    state.subscribers.add(listener);
    return () => {
      state.subscribers.delete(listener);
    };
  }

  readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent> {
    return this.deps.store.readSince(sessionId, sinceSeq);
  }

  /** Drain the current buffer to the store now and await it. */
  async flush(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    await this.persist(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.unsubFromBus(); // stop capturing new events first
    await this.persist(sessionId); // flush remainder (row still exists)
    state.subscribers.clear();
    this.states.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.states.keys()];
    for (const id of ids) await this.close(id);
  }

  /**
   * Clear the timer, splice the buffer, and append it to the store, chained
   * after any in-flight append so inserts never overlap. Returns the chain tail.
   */
  private persist(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return Promise.resolve();
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    const batch = state.buffer.splice(0);
    if (batch.length === 0) return state.pendingFlush;
    state.pendingFlush = state.pendingFlush
      .then(() => this.deps.store.append(sessionId, batch))
      .catch((err) => {
        // Events were already broadcast to live clients; a persistence failure
        // only costs replay-after-reconnect. Log, don't crash the stream.
        console.error(`session-event-log: append failed for ${sessionId}`, err);
      });
    return state.pendingFlush;
  }
}
