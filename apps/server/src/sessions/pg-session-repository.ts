import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { creatorSession } from "../db/schema/creator.js";
import type { PhaseId } from "@ultracreator/shared";
import type { Db } from "../db/client.js";
import type {
  SessionRecord,
  SessionRepository,
  SessionStatus,
  SessionStatusUpdate,
} from "./session-repository.js";

type Row = typeof creatorSession.$inferSelect;

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    status: row.status as SessionStatus,
    currentPhase: (row.currentPhase as PhaseId | null) ?? null,
    error: row.error,
    autoApprove: row.autoApprove,
    runSeq: row.runSeq,
    pendingRefinement: row.pendingRefinement,
    isPublic: row.isPublic,
    productUrl: row.productUrl,
    freeGrant: row.freeGrant,
    likeCount: row.likeCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgSessionRepository implements SessionRepository {
  constructor(private db: Db) {}

  async create(input: {
    id: string;
    userId: string;
    autoApprove?: boolean;
    isPublic?: boolean;
    productUrl?: string | null;
  }): Promise<void> {
    await this.db
      .insert(creatorSession)
      .values({
        id: input.id,
        userId: input.userId,
        autoApprove: input.autoApprove ?? false,
        isPublic: input.isPublic ?? false,
        productUrl: input.productUrl ?? null,
      })
      .onConflictDoNothing({ target: creatorSession.id });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const rows = await this.db.select().from(creatorSession).where(eq(creatorSession.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db
      .select()
      .from(creatorSession)
      .where(eq(creatorSession.userId, userId))
      .orderBy(desc(creatorSession.updatedAt));
    return rows.map(toRecord);
  }

  async updateStatus(id: string, update: SessionStatusUpdate): Promise<void> {
    await this.db
      .update(creatorSession)
      .set({
        status: update.status,
        currentPhase: update.currentPhase,
        error: update.error,
        pendingRefinement: update.pendingRefinement ?? null,
        updatedAt: new Date(),
      })
      .where(eq(creatorSession.id, id));
  }

  async setTitleIfEmpty(id: string, title: string): Promise<void> {
    await this.db
      .update(creatorSession)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(creatorSession.id, id), isNull(creatorSession.title)));
  }

  async setAutoApprove(id: string, value: boolean): Promise<void> {
    await this.db
      .update(creatorSession)
      .set({ autoApprove: value, updatedAt: new Date() })
      .where(eq(creatorSession.id, id));
  }

  async incrementRunSeq(id: string): Promise<number> {
    const rows = await this.db
      .update(creatorSession)
      .set({ runSeq: sql`${creatorSession.runSeq} + 1`, updatedAt: new Date() })
      .where(eq(creatorSession.id, id))
      .returning({ runSeq: creatorSession.runSeq });
    return rows[0]?.runSeq ?? 0;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(creatorSession).where(eq(creatorSession.id, id));
  }

  async claimFreePublicGrant(sessionId: string, userId: string): Promise<boolean> {
    // Serialize per-user claims with an advisory lock so two concurrent public
    // runs can't both pass the "no holder yet" check and both go free.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
      const holder = await tx
        .select({ id: creatorSession.id })
        .from(creatorSession)
        .where(and(eq(creatorSession.userId, userId), eq(creatorSession.freeGrant, true)))
        .limit(1);
      if (holder[0]) return holder[0].id === sessionId;
      await tx
        .update(creatorSession)
        .set({ freeGrant: true })
        .where(eq(creatorSession.id, sessionId));
      return true;
    });
  }

  async hasFreePublicGrant(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: creatorSession.id })
      .from(creatorSession)
      .where(and(eq(creatorSession.userId, userId), eq(creatorSession.freeGrant, true)))
      .limit(1);
    return rows.length > 0;
  }
}
