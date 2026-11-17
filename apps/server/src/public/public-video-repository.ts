// apps/server/src/public/public-video-repository.ts
import type { PublicVideoSort, PublicVideoSummary } from "@ultracreator/shared";

export interface ListPublicVideosOpts {
  sort: PublicVideoSort;
  limit: number;
  /** Viewer whose likes populate likedByMe; null/undefined when logged out. */
  viewerId?: string | null;
}

/** Result of a like/unlike toggle; null when the target isn't a public video. */
export interface LikeResult {
  likeCount: number;
  liked: boolean;
}

/**
 * Read/like surface for public videos. A public video is a creator_sessions row
 * with is_public=true AND status='done'. The PG impl and the in-memory fake
 * MUST behave identically (same contract as SessionRepository's pair).
 */
export interface PublicVideoRepository {
  list(opts: ListPublicVideosOpts): Promise<PublicVideoSummary[]>;
  get(sessionId: string, viewerId?: string | null): Promise<PublicVideoSummary | null>;
  like(sessionId: string, userId: string): Promise<LikeResult | null>;
  unlike(sessionId: string, userId: string): Promise<LikeResult | null>;
}
