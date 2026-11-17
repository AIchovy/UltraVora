// apps/web/src/lib/public-videos-server.ts
// Server-side fetchers for the public video API. Like getServerSession and the
// sitemap, these talk to Fastify directly (API_PROXY_TARGET) — the endpoints are
// public, so no cookies are involved. They exist so plaza and /v/[sid] can ship
// real content in the server HTML instead of client-side skeletons: crawlers
// index the actual video list/title, and React Query hydrates from initialData.

import type { PublicVideoSummary } from "@ultracreator/shared";

function apiOrigin(): string {
  return process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";
}

/**
 * Recent public videos for the plaza grid. `null` means the API was unreachable
 * or errored — callers fall back to the client-side fetch, never an empty grid.
 */
export async function fetchPublicVideos(): Promise<PublicVideoSummary[] | null> {
  try {
    const res = await fetch(`${apiOrigin()}/api/public/videos?sort=recent`, {
      next: { revalidate: 120 },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicVideoSummary[];
  } catch {
    return null;
  }
}

export type PublicVideoLookup =
  | { status: "found"; video: PublicVideoSummary }
  | { status: "missing" } // API answered 404: unpublished or deleted → page should 404 too
  | { status: "unavailable" }; // network/API failure → degrade, don't 404 real content

/**
 * One public video by sid. Uses the same URL + fetch options from
 * generateMetadata and the page so Next dedupes the two calls per request.
 */
export async function fetchPublicVideo(sid: string): Promise<PublicVideoLookup> {
  try {
    const res = await fetch(`${apiOrigin()}/api/public/videos/${sid}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) return { status: "missing" };
    if (!res.ok) return { status: "unavailable" };
    return { status: "found", video: (await res.json()) as PublicVideoSummary };
  } catch {
    return { status: "unavailable" };
  }
}
