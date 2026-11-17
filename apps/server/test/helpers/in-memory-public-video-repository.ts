// apps/server/test/helpers/in-memory-public-video-repository.ts
import type { PublicVideoSummary } from "@ultracreator/shared";
import type {
  LikeResult,
  ListPublicVideosOpts,
  PublicVideoRepository,
} from "../../src/public/public-video-repository.js";

type SeedRow = Omit<PublicVideoSummary, "likedByMe">;

/** Seed-driven fake. Each seeded row is a public+done video. */
export class InMemoryPublicVideoRepository implements PublicVideoRepository {
  private rows = new Map<string, SeedRow>();
  private likes = new Set<string>(); // `${sid}:${userId}`

  seed(row: SeedRow): void {
    this.rows.set(row.sid, { ...row });
  }

  private toSummary(row: SeedRow, viewerId?: string | null): PublicVideoSummary {
    return { ...row, likedByMe: viewerId ? this.likes.has(`${row.sid}:${viewerId}`) : false };
  }

  async list(opts: ListPublicVideosOpts): Promise<PublicVideoSummary[]> {
    const all = [...this.rows.values()];
    all.sort((a, b) =>
      opts.sort === "likes"
        ? b.likeCount - a.likeCount || (a.createdAt < b.createdAt ? 1 : -1)
        : a.createdAt < b.createdAt
          ? 1
          : a.createdAt > b.createdAt
            ? -1
            : 0,
    );
    return all.slice(0, opts.limit).map((r) => this.toSummary(r, opts.viewerId));
  }

  async get(sessionId: string, viewerId?: string | null): Promise<PublicVideoSummary | null> {
    const row = this.rows.get(sessionId);
    return row ? this.toSummary(row, viewerId) : null;
  }

  async like(sessionId: string, userId: string): Promise<LikeResult | null> {
    const row = this.rows.get(sessionId);
    if (!row) return null;
    const key = `${sessionId}:${userId}`;
    if (!this.likes.has(key)) {
      this.likes.add(key);
      row.likeCount += 1;
    }
    return { likeCount: row.likeCount, liked: true };
  }

  async unlike(sessionId: string, userId: string): Promise<LikeResult | null> {
    const row = this.rows.get(sessionId);
    if (!row) return null;
    const key = `${sessionId}:${userId}`;
    if (this.likes.has(key)) {
      this.likes.delete(key);
      row.likeCount = Math.max(0, row.likeCount - 1);
    }
    return { likeCount: row.likeCount, liked: false };
  }
}
