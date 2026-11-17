import type { UserMessage } from "@ultracreator/shared";

export type SessionMessageStatus = "pending" | "processing" | "done" | "error";

export interface SessionMessageRecord {
  id: number;
  sessionId: string;
  payload: UserMessage;
  status: SessionMessageStatus;
  createdAt: string; // ISO
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Persistence for the durable message queue (session_messages). Raw row CRUD
 * only — the state machine (when to advance which status) lives in
 * SessionOrchestrator. The PG impl and the in-memory fake MUST behave
 * identically. mark* methods are plain UPDATEs: silent no-op on absent rows.
 */
export interface MessageStore {
  /** Insert as pending; returns the new row id. */
  insert(sessionId: string, payload: UserMessage): Promise<number>;
  /** → processing; stamps startedAt. */
  markProcessing(id: number): Promise<void>;
  /** → done; stamps finishedAt. */
  markDone(id: number): Promise<void>;
  /** → error; stamps finishedAt. */
  markError(id: number): Promise<void>;
  /** Every pending|processing row across all sessions, id ascending (= arrival order). */
  listIncomplete(): Promise<SessionMessageRecord[]>;
}
