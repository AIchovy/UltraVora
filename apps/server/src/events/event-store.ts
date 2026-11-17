import type { ServerEvent } from "@ultracreator/shared";

/** One persisted, sequenced event. `seq` is per-session monotonic; `at` is ISO. */
export interface SequencedEvent {
  seq: number;
  at: string;
  event: ServerEvent;
}

/**
 * Raw persistence for a session's event stream. All sequencing/broadcast logic
 * lives in SessionEventLog; this is dumb CRUD so the PG and in-memory impls
 * stay behaviorally identical.
 */
export interface EventStore {
  /** Highest seq persisted for the session, or 0 if none. */
  maxSeq(sessionId: string): Promise<number>;
  /** Bulk-insert. No-op on an empty batch. */
  append(sessionId: string, entries: SequencedEvent[]): Promise<void>;
  /** Persisted events with seq > sinceSeq, ascending by seq. */
  readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent>;
}
