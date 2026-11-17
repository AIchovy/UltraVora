"use client";
import { motion, useReducedMotion } from "motion/react";

type ShowcaseLayout = "text-left" | "text-right" | "full";

/**
 * One "how it works" row: copy on one side, a self-running animation on the
 * other, revealed as it scrolls into view. `full` puts the copy above a
 * full-width visual (used to break the left/right zig-zag rhythm). Motion is
 * isolated to this client leaf; reduced-motion renders the resting state.
 */
export function FeatureShowcase({
  title,
  body,
  visual,
  layout = "text-left",
}: {
  title: string;
  body: string;
  visual: React.ReactNode;
  layout?: ShowcaseLayout;
}): React.ReactElement {
  const reduce = useReducedMotion();
  const reveal = {
    initial: reduce ? false : ({ opacity: 0, y: 28 } as const),
    whileInView: { opacity: 1, y: 0 },
    viewport: { once: true, amount: 0.25 },
    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] as const },
  };

  const copy = (
    <div className="max-w-md">
      <h3 className="text-2xl font-semibold tracking-tight md:text-3xl">{title}</h3>
      <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );

  if (layout === "full") {
    return (
      <motion.div {...reveal}>
        {copy}
        <div className="mt-10">{visual}</div>
      </motion.div>
    );
  }

  return (
    <motion.div
      {...reveal}
      className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16"
    >
      <div className={layout === "text-right" ? "lg:order-2" : undefined}>{copy}</div>
      <div className={layout === "text-right" ? "lg:order-1" : undefined}>{visual}</div>
    </motion.div>
  );
}
