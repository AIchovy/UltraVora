"use client";
import { motion, useReducedMotion } from "motion/react";
import { Sparkles, X } from "lucide-react";
import { usePersistentState } from "@/lib/use-persistent-state";

/**
 * Limited-time "publish to the plaza for free" announcement, floating over the
 * bottom of the logged-in home page (an overlay, so dismissing it never shifts
 * the layout — the content's pb-24 already reserves the space it hovers in).
 * Pure copy — visibility is deliberately not tied to the free-grant or toggle
 * state; the only control is a manual dismiss, persisted so the banner never
 * comes back. A previously-dismissed visitor technically renders the banner
 * for one frame before the storage read hides it, but the entrance animation
 * starts at opacity 0 so nothing is visible in practice.
 */
export function PlazaPromoBanner(): React.ReactElement | null {
  const reduce = useReducedMotion();
  const [dismissed, setDismissed] = usePersistentState("uc.plazaPromoDismissed", false);
  if (dismissed) return null;
  return (
    // The strip spans the main area but only the card inside it catches
    // clicks — the empty sides stay click-through to the content behind.
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10 flex justify-center sm:inset-x-6">
      <motion.div
        initial={reduce ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: reduce ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
        className="pointer-events-auto flex max-w-full items-center gap-3 rounded-2xl bg-card py-3 pl-4 pr-2 shadow-panel ring-1 ring-primary/15"
      >
        <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-primary" />
        <p className="text-[13px] leading-snug text-foreground">
          <span className="font-semibold text-primary">Limited-time offer:</span>{" "}
          publish your video to the Product Plaza for free — turn on{" "}
          <span className="font-medium">“Public to plaza”</span> in video settings.
        </p>
        <button
          type="button"
          aria-label="dismiss plaza promo"
          onClick={() => setDismissed(true)}
          className="cursor-pointer rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </motion.div>
    </div>
  );
}
