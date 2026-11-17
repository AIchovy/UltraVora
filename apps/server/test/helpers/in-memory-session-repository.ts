import type {
  SessionRecord,
  SessionRepository,
  SessionStatusUpdate,
} from "../../src/sessions/session-repository.js";

/** In-memory SessionRepository for unit tests. Behaves identically to the PG impl. */
export class InMemorySessionRepository implements SessionRepository {
  private rows = new Map<string, SessionRecord>();

  async create(input: {
    id: string;
    userId: string;
    autoApprove?: boolean;
    isPublic?: boolean;
    productUrl?: string | null;
  }): Promise<void> {
    if (this.rows.has(input.id)) return;
    const now = new Date().toISOString();
    this.rows.set(input.id, {
      id: input.id,
      userId: input.userId,
      title: null,
      status: "idle",
      currentPhase: null,
      error: null,
      autoApprove: input.autoApprove ?? false,
      runSeq: 0,
      pendingRefinement: null,
      isPublic: input.isPublic ?? false,
      productUrl: input.productUrl ?? null,
      freeGrant: false,
      likeCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((r) => ({ ...r }));
  }

  async updateStatus(id: string, update: SessionStatusUpdate): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return; // plain UPDATE semantics
    row.status = update.status;
    row.currentPhase = update.currentPhase;
    row.error = update.error;
    row.pendingRefinement = update.pendingRefinement ?? null;
    row.updatedAt = new Date().toISOString();
  }

  async setTitleIfEmpty(id: string, title: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.title !== null) return;
    row.title = title;
    row.updatedAt = new Date().toISOString();
  }

  async setAutoApprove(id: string, value: boolean): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return; // plain UPDATE semantics
    row.autoApprove = value;
    row.updatedAt = new Date().toISOString();
  }

  async incrementRunSeq(id: string): Promise<number> {
    const row = this.rows.get(id);
    if (!row) return 0; // plain UPDATE semantics
    row.runSeq += 1;
    row.updatedAt = new Date().toISOString();
    return row.runSeq;
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async claimFreePublicGrant(sessionId: string, userId: string): Promise<boolean> {
    const holder = [...this.rows.values()].find((r) => r.userId === userId && r.freeGrant);
    if (holder) return holder.id === sessionId;
    const row = this.rows.get(sessionId);
    if (!row) return false;
    row.freeGrant = true;
    return true;
  }

  async hasFreePublicGrant(userId: string): Promise<boolean> {
    return [...this.rows.values()].some((r) => r.userId === userId && r.freeGrant);
  }
}
