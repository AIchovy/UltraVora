import type { EventStore, SequencedEvent } from "../../src/events/event-store.js";

/** In-memory EventStore for unit tests. Behaves identically to PgEventStore. */
export class InMemoryEventStore implements EventStore {
  private rows = new Map<string, SequencedEvent[]>();

  async maxSeq(sessionId: string): Promise<number> {
    const list = this.rows.get(sessionId);
    return list && list.length > 0 ? Math.max(...list.map((e) => e.seq)) : 0;
  }

  async append(sessionId: string, entries: SequencedEvent[]): Promise<void> {
    if (entries.length === 0) return;
    const list = this.rows.get(sessionId) ?? [];
    for (const e of entries) list.push({ ...e });
    this.rows.set(sessionId, list);
  }

  async *readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent> {
    const list = (this.rows.get(sessionId) ?? [])
      .filter((e) => e.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
    for (const e of list) yield { ...e };
  }
}
