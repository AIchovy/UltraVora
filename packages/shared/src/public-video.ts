// packages/shared/src/public-video.ts

/** Sort orders for the Product Plaza listing. */
export const PUBLIC_VIDEO_SORTS = ["recent", "likes"] as const;
export type PublicVideoSort = (typeof PUBLIC_VIDEO_SORTS)[number];

export function isPublicVideoSort(v: unknown): v is PublicVideoSort {
  // Cast to string[]: TS's Array.includes() won't accept a plain string arg
  // against the narrow tuple element type ("recent" | "likes").
  return typeof v === "string" && (PUBLIC_VIDEO_SORTS as readonly string[]).includes(v);
}

/** One public video as shown on the Plaza / share page. */
export interface PublicVideoSummary {
  /** Owning creator_session id; also the playback + like key. */
  sid: string;
  title: string | null;
  author: { name: string; image: string | null };
  /** Outbound product link the creator entered (null if none). */
  productUrl: string | null;
  likeCount: number;
  createdAt: string; // ISO
  /** Whether the requesting viewer has liked it (false when logged out). */
  likedByMe: boolean;
}
