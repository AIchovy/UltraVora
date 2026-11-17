// apps/web/src/components/plaza/public-video-view.tsx
"use client";
import { ExternalLink } from "lucide-react";
import type { PublicVideoSummary } from "@/lib/api-types";
import { usePublicVideo } from "@/state/use-public-videos";
import { publicVideoUrl } from "@/lib/api-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LikeButton } from "./like-button";

function publishedOn(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function PublicVideoView({
  sid,
  initialVideo,
}: {
  sid: string;
  /** Server-fetched video — the first HTML paint carries the real title/player. */
  initialVideo?: PublicVideoSummary;
}): React.ReactElement {
  const { data: video, isLoading } = usePublicVideo(sid, initialVideo);

  if (isLoading) {
    return (
      <div role="status" aria-label="loading video" className="mx-auto w-full max-w-4xl px-4 py-8">
        <div className="aspect-video w-full animate-pulse rounded-3xl bg-muted" />
        <div className="mt-6 space-y-3">
          <div className="h-6 w-2/5 animate-pulse rounded-md bg-muted" />
          <div className="h-4 w-1/4 animate-pulse rounded-md bg-muted" />
        </div>
      </div>
    );
  }
  if (!video) return <p className="p-8 text-sm text-muted-foreground">Video not found.</p>;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <div className="overflow-hidden rounded-3xl bg-black shadow-panel">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={publicVideoUrl(video.sid)} className="aspect-video w-full" controls playsInline />
      </div>
      <div className="mt-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{video.title ?? "Untitled"}</h1>
          <div className="mt-2.5 flex items-center gap-2.5">
            <Avatar className="h-7 w-7">
              {video.author.image && <AvatarImage src={video.author.image} alt={video.author.name} />}
              <AvatarFallback className="text-xs">{video.author.name.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-medium">{video.author.name}</span>
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
            <span className="text-sm text-muted-foreground">{publishedOn(video.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <LikeButton sid={video.sid} likeCount={video.likeCount} liked={video.likedByMe} variant="page" />
          {video.productUrl && (
            <a
              href={video.productUrl}
              target="_blank"
              rel="noopener nofollow"
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90"
              aria-label="visit product"
            >
              <ExternalLink className="h-4 w-4" />
              Visit product
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
