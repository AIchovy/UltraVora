// apps/server/src/public/pg-public-video-repository.ts
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PublicVideoSummary } from "@ultracreator/shared";
import { creatorSession, videoLike } from "../db/schema/creator.js";
import { user } from "../db/schema/auth.js";
import type { Db } from "../db/client.js";
import type {
  LikeResult,
  ListPublicVideosOpts,
  PublicVideoRepository,
} from "./public-video-repository.js";

interface BaseRow {
  sid: string;
  title: string | null;
  productUrl: string | null;
  likeCount: number;
  createdAt: Date;
  authorName: string;
  authorImage: string | null;
}

const PUBLIC = and(eq(creatorSession.isPublic, true), eq(creatorSession.status, "done"));

export class PgPublicVideoRepository implements PublicVideoRepository {
  constructor(private db: Db) {}

  private select() {
    return this.db
      .select({
        sid: creatorSession.id,
        title: creatorSession.title,
        productUrl: creatorSession.productUrl,
        likeCount: creatorSession.likeCount,
        createdAt: creatorSession.createdAt,
        authorName: user.name,
        authorImage: user.image,
      })
      .from(creatorSession)
      .innerJoin(user, eq(user.id, creatorSession.userId));
  }

  private async withLiked(rows: BaseRow[], viewerId?: string | null): Promise<PublicVideoSummary[]> {
    let likedSet = new Set<string>();
    if (viewerId && rows.length > 0) {
      const liked = await this.db
        .select({ sessionId: videoLike.sessionId })
        .from(videoLike)
        .where(
          and(
            eq(videoLike.userId, viewerId),
            inArray(videoLike.sessionId, rows.map((r) => r.sid)),
          ),
        );
      likedSet = new Set(liked.map((l) => l.sessionId));
    }
    return rows.map((r) => ({
      sid: r.sid,
      title: r.title,
      author: { name: r.authorName, image: r.authorImage },
      productUrl: r.productUrl,
      likeCount: r.likeCount,
      createdAt: r.createdAt.toISOString(),
      likedByMe: likedSet.has(r.sid),
    }));
  }

  async list(opts: ListPublicVideosOpts): Promise<PublicVideoSummary[]> {
    const order =
      opts.sort === "likes"
        ? [desc(creatorSession.likeCount), desc(creatorSession.id)]
        : [desc(creatorSession.createdAt), desc(creatorSession.id)];
    const rows = (await this.select().where(PUBLIC).orderBy(...order).limit(opts.limit)) as BaseRow[];
    return this.withLiked(rows, opts.viewerId);
  }

  async get(sessionId: string, viewerId?: string | null): Promise<PublicVideoSummary | null> {
    const rows = (await this.select()
      .where(and(PUBLIC, eq(creatorSession.id, sessionId)))
      .limit(1)) as BaseRow[];
    if (!rows[0]) return null;
    return (await this.withLiked([rows[0]], viewerId))[0]!;
  }

  async like(sessionId: string, userId: string): Promise<LikeResult | null> {
    return this.db.transaction(async (tx) => {
      const target = await tx
        .select({ id: creatorSession.id })
        .from(creatorSession)
        .where(and(PUBLIC, eq(creatorSession.id, sessionId)))
        .limit(1);
      if (!target[0]) return null;
      const inserted = await tx
        .insert(videoLike)
        .values({ sessionId, userId })
        .onConflictDoNothing()
        .returning({ id: videoLike.id });
      if (inserted.length > 0) {
        await tx
          .update(creatorSession)
          .set({ likeCount: sql`${creatorSession.likeCount} + 1` })
          .where(eq(creatorSession.id, sessionId));
      }
      const [row] = await tx
        .select({ likeCount: creatorSession.likeCount })
        .from(creatorSession)
        .where(eq(creatorSession.id, sessionId))
        .limit(1);
      return { likeCount: row!.likeCount, liked: true };
    });
  }

  async unlike(sessionId: string, userId: string): Promise<LikeResult | null> {
    return this.db.transaction(async (tx) => {
      const target = await tx
        .select({ id: creatorSession.id })
        .from(creatorSession)
        .where(and(PUBLIC, eq(creatorSession.id, sessionId)))
        .limit(1);
      if (!target[0]) return null;
      const deleted = await tx
        .delete(videoLike)
        .where(and(eq(videoLike.sessionId, sessionId), eq(videoLike.userId, userId)))
        .returning({ id: videoLike.id });
      if (deleted.length > 0) {
        await tx
          .update(creatorSession)
          .set({ likeCount: sql`GREATEST(${creatorSession.likeCount} - 1, 0)` })
          .where(eq(creatorSession.id, sessionId));
      }
      const [row] = await tx
        .select({ likeCount: creatorSession.likeCount })
        .from(creatorSession)
        .where(eq(creatorSession.id, sessionId))
        .limit(1);
      return { likeCount: row!.likeCount, liked: false };
    });
  }
}
