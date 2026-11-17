// apps/web/src/components/plaza/like-button.tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Heart } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useLikeVideo } from "@/state/use-public-videos";
import { cn } from "@/lib/utils";

interface Props {
  sid: string;
  likeCount: number;
  liked: boolean;
  /** overlay = frosted pill on the video cover; page = bordered pill on the detail page. */
  variant?: "overlay" | "page";
}

export function LikeButton({ sid, likeCount, liked, variant = "overlay" }: Props): React.ReactElement {
  const router = useRouter();
  const reduce = useReducedMotion();
  const { data: session } = useSession();
  const like = useLikeVideo();
  // Increments on each like CLICK (not on `liked` itself), so the pop/ping
  // play only for an interaction — never for a card that mounts already liked.
  const [burst, setBurst] = useState(0);
  // Roll direction for the count odometer: up when it grew, down when it shrank.
  const prevCount = useRef(likeCount);
  const dir = likeCount >= prevCount.current ? 1 : -1;
  useEffect(() => {
    prevCount.current = likeCount;
  });

  return (
    <button
      type="button"
      // Constant action name (toggling names + aria-pressed is an SR
      // antipattern); the count rides along so it's announced too.
      aria-label={`like (${likeCount})`}
      aria-pressed={liked}
      onClick={() => {
        if (!session) {
          router.push("/login");
          return;
        }
        if (!liked && !reduce) setBurst((b) => b + 1);
        like.mutate({ sid, liked });
      }}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        variant === "overlay"
          ? "bg-black/60 px-2.5 py-1.5 text-xs text-white backdrop-blur-md hover:bg-black/70"
          : "bg-card px-3.5 py-2 text-sm text-foreground shadow-xs ring-1 ring-border transition-[color,box-shadow] hover:shadow-card",
      )}
    >
      <span className="relative inline-flex">
        {/* One-shot ping ring, replayed per like via the burst key. It settles
            at opacity 0, so no exit bookkeeping is needed. */}
        {burst > 0 && (
          <motion.span
            key={`ping-${burst}`}
            aria-hidden
            initial={{ scale: 0.5, opacity: 0.7 }}
            animate={{ scale: 2.2, opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="absolute -inset-0.5 rounded-full bg-red-500/60"
          />
        )}
        <motion.span
          key={`heart-${burst}`}
          aria-hidden
          animate={burst > 0 ? { scale: [1, 1.35, 1] } : undefined}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="relative inline-flex"
        >
          <Heart
            className={cn(
              variant === "overlay" ? "h-3.5 w-3.5" : "h-4 w-4",
              "transition-colors duration-200",
              liked ? "fill-red-500 text-red-500" : "fill-transparent",
            )}
          />
        </motion.span>
      </span>
      {/* The count rolls like an odometer — up on grow, down on shrink. The
          `custom` direction must sit on BOTH AnimatePresence (for the exiting
          element) and the motion.span (for the entering one). */}
      <span aria-hidden className="relative inline-flex h-[1.25em] min-w-[1ch] items-center overflow-hidden tabular-nums">
        <AnimatePresence initial={false} mode="popLayout" custom={dir}>
          <motion.span
            key={likeCount}
            custom={dir}
            variants={{
              enter: (d: number) => (reduce ? { opacity: 0 } : { y: `${0.9 * d}em`, opacity: 0 }),
              center: { y: 0, opacity: 1 },
              exit: (d: number) => (reduce ? { opacity: 0 } : { y: `${-0.9 * d}em`, opacity: 0 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="inline-flex"
          >
            {likeCount}
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  );
}
