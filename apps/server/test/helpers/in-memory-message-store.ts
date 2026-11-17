import type { UserMessage } from "@ultracreator/shared";
import type {
  MessageStore,
  SessionMessageRecord,
} from "../../src/messages/message-store.js";

/** In-memory MessageStore fake. Same observable behavior as PgMessageStore. */
export class InMemoryMessageStore implements MessageStore {
  private rows = new Map<number, SessionMessageRecord>();
  private nextId = 1;

  async insert(sessionId: string, payload: UserMessage): Promise<number> {
    const id = this.nextId++;
    this.rows.set(id, {
      id,
      sessionId,
      payload: structuredClone(payload),
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    });
    return id;
  }

  async markProcessing(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "processing";
      row.startedAt = new Date().toISOString();
    }
  }

  async markDone(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "done";
      row.finishedAt = new Date().toISOString();
    }
  }

  async markError(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "error";
      row.finishedAt = new Date().toISOString();
    }
  }

  async listIncomplete(): Promise<SessionMessageRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending" || r.status === "processing")
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r, payload: structuredClone(r.payload) }));
  }

  /** Test-only accessor: every row regardless of status, id ascending. */
  all(): SessionMessageRecord[] {
    return [...this.rows.values()]
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r, payload: structuredClone(r.payload) }));
  }

  /** Test-only: seed a row in an arbitrary status (recovery scenarios). */
  seed(row: Omit<SessionMessageRecord, "id">): number {
    const id = this.nextId++;
    this.rows.set(id, { ...row, id, payload: structuredClone(row.payload) });
    return id;
  }
}
