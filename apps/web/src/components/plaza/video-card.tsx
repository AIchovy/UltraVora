// apps/web/src/components/plaza/video-card.tsx
"use client";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { PublicVideoSummary } from "@/lib/api-types";
import { publicVideoUrl } from "@/lib/api-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { LikeButton } from "./like-button";

export function VideoCard({ video }: { video: PublicVideoSummary }): React.ReactElement {
  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl bg-card shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-raised">
      <div className="relative">
        {/* Decorative duplicate of the title link below — skip the extra tab
            stop and the nameless-link announcement. */}
        <Link
          href={`/v/${video.sid}`}
          aria-hidden
          tabIndex={-1}
          className="block aspect-video overflow-hidden bg-black"
        >
          {/* Muted first-frame preview; #t=0.1 nudges past a black frame 0. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={`${publicVideoUrl(video.sid)}#t=0.1`}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            muted
            playsInline
            preload="metadata"
          />
        </Link>
        {/* Sibling of the cover link (not a child), so liking never navigates.
            Hover-capable devices hide it until the card is hovered or the
            button is focused (hence the hiding, not the reveal, is gated on
            @media(hover:hover) — Tailwind's group-hover only compiles for
            hover-capable devices, so touch would otherwise never see it). */}
        <div
          className={cn(
            "absolute right-2 top-2 z-10 transition-opacity duration-200",
            !video.likedByMe &&
              "[@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100",
          )}
        >
          <LikeButton sid={video.sid} likeCount={video.likeCount} liked={video.likedByMe} variant="overlay" />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <Link href={`/v/${video.sid}`} className="line-clamp-1 text-sm font-medium hover:underline">
          {video.title ?? "Untitled"}
        </Link>
        <div className="mt-auto flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Avatar className="h-5 w-5">
              {video.author.image && <AvatarImage src={video.author.image} alt={video.author.name} />}
              <AvatarFallback className="text-[10px]">{video.author.name.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <span className="truncate text-xs text-muted-foreground">{video.author.name}</span>
          </div>
          {video.productUrl && (
            <a
              href={video.productUrl}
              target="_blank"
              rel="noopener nofollow"
              className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
              aria-label="visit product"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Visit product
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
