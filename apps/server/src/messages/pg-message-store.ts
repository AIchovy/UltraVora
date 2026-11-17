// PG-backed MessageStore over the session_messages table. Unlike PgEventStore,
// FK violations are NOT swallowed: routes validate session ownership before
// any insert, so a violation is a real bug/race that must surface — a user
// message silently dropped is worse than a logged 5xx.
import { asc, eq, inArray } from "drizzle-orm";
import type { UserMessage } from "@ultracreator/shared";
import type { Db } from "../db/client.js";
import { sessionMessage } from "../db/schema/creator.js";
import type {
  MessageStore,
  SessionMessageRecord,
  SessionMessageStatus,
} from "./message-store.js";

export class PgMessageStore implements MessageStore {
  constructor(private db: Db) {}

  async insert(sessionId: string, payload: UserMessage): Promise<number> {
    const rows = await this.db
      .insert(sessionMessage)
      .values({ sessionId, payload })
      .returning({ id: sessionMessage.id });
    return rows[0]!.id;
  }

  async markProcessing(id: number): Promise<void> {
    await this.db
      .update(sessionMessage)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(sessionMessage.id, id));
  }

  async markDone(id: number): Promise<void> {
    await this.db
      .update(sessionMessage)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(sessionMessage.id, id));
  }

  async markError(id: number): Promise<void> {
    await this.db
      .update(sessionMessage)
      .set({ status: "error", finishedAt: new Date() })
      .where(eq(sessionMessage.id, id));
  }

  async listIncomplete(): Promise<SessionMessageRecord[]> {
    const rows = await this.db
      .select()
      .from(sessionMessage)
      .where(inArray(sessionMessage.status, ["pending", "processing"]))
      .orderBy(asc(sessionMessage.id));
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      payload: r.payload,
      status: r.status as SessionMessageStatus,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  }
}
