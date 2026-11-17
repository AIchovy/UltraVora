// apps/web/src/components/plaza/product-plaza.tsx
"use client";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { PublicVideoSort, PublicVideoSummary } from "@/lib/api-types";
import { usePublicVideos } from "@/state/use-public-videos";
import { cn } from "@/lib/utils";
import { VideoCard } from "./video-card";

const SORTS: { value: PublicVideoSort; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "likes", label: "Most liked" },
];

export function ProductPlaza({
  loggedIn,
  initialVideos,
}: {
  loggedIn: boolean;
  /** Server-fetched "recent" list — makes the first HTML paint carry real cards. */
  initialVideos?: PublicVideoSummary[];
}): React.ReactElement {
  const reduce = useReducedMotion();
  const [sort, setSort] = useState<PublicVideoSort>("recent");
  const { data: videos = [], isLoading } = usePublicVideos(
    sort,
    sort === "recent" ? initialVideos : undefined,
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Product Plaza</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Public promo videos from the community. {loggedIn ? "Like your favorites." : "Log in to like."}
          </p>
        </div>
        {/* Segmented sort control — the active pill slides between options. */}
        <div role="group" aria-label="sort" className="flex rounded-full bg-muted p-1">
          {SORTS.map((s) => {
            const active = sort === s.value;
            return (
              <button
                key={s.value}
                type="button"
                aria-pressed={active}
                onClick={() => setSort(s.value)}
                className={cn(
                  "relative cursor-pointer rounded-full px-3.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="plaza-sort-thumb"
                    aria-hidden
                    transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0.2, duration: 0.4 }}
                    className="absolute inset-0 rounded-full bg-card shadow-raised"
                  />
                )}
                <span className="relative">{s.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div
          role="status"
          aria-label="loading videos"
          className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="overflow-hidden rounded-2xl bg-card shadow-card">
              <div className="aspect-video animate-pulse bg-muted" />
              <div className="space-y-2.5 p-4">
                <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
                <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : videos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No public videos yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((v) => (
            <VideoCard key={v.sid} video={v} />
          ))}
        </div>
      )}
    </div>
  );
}
