import { and, asc, eq, gt, max } from "drizzle-orm";
import { sessionEvent } from "../db/schema/creator.js";
import type { Db } from "../db/client.js";
import type { EventStore, SequencedEvent } from "./event-store.js";

export class PgEventStore implements EventStore {
  constructor(private db: Db) {}

  async maxSeq(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ m: max(sessionEvent.seq) })
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, sessionId));
    return rows[0]?.m ?? 0;
  }

  async append(sessionId: string, entries: SequencedEvent[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.db.insert(sessionEvent).values(
        entries.map((e) => ({
          sessionId,
          seq: e.seq,
          at: new Date(e.at),
          event: e.event,
        })),
      );
    } catch (err) {
      // 23503 = foreign_key_violation: the session was deleted out from under a
      // pending batch. The events are gone with it — drop them silently.
      // Drizzle wraps PG errors in DrizzleQueryError; the PG error is in `cause`.
      const code =
        (err as { code?: string }).code ??
        (err as { cause?: { code?: string } }).cause?.code;
      if (code === "23503") return;
      throw err;
    }
  }

  async *readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent> {
    const rows = await this.db
      .select()
      .from(sessionEvent)
      .where(and(eq(sessionEvent.sessionId, sessionId), gt(sessionEvent.seq, sinceSeq)))
      .orderBy(asc(sessionEvent.seq));
    for (const row of rows) {
      yield { seq: row.seq, at: row.at.toISOString(), event: row.event };
    }
  }
}
