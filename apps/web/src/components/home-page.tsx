"use client";
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MonitorPlay, BookOpen, Smartphone, Sparkles } from "lucide-react";
import {
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_DURATIONS,
  type AspectRatio,
  type Duration,
} from "@ultracreator/shared";
import { cn } from "@/lib/utils";
import { SEED_STYLES, type AccentKey } from "@/lib/seed-styles";
import { usePersistentState } from "@/lib/use-persistent-state";
import { HomeComposer } from "./home-composer";
import { PlazaPromoBanner } from "./plaza-promo-banner";

interface Mode {
  id: string;
  label: string;
  icon: typeof MonitorPlay;
  placeholder: string;
  duration: Duration;
  aspect: AspectRatio;
}

const MODES: Mode[] = [
  {
    // Product demo — Highlight product features, workflows, and core advantages
    // to deepen understanding and drive conversion.
    id: "product-demo",
    label: "Product demo",
    icon: MonitorPlay,
    placeholder: "Walk through our dashboard's three core features in 30 seconds…",
    duration: 30,
    aspect: "16:9",
  },
  {
    // Brand story — Tell the brand's origin, philosophy, and values to build an
    // emotional connection with the audience.
    id: "brand-story",
    label: "Brand story",
    icon: BookOpen,
    placeholder: "Why we started — the problem we kept hitting, and the team that set out to fix it…",
    duration: 60,
    aspect: "16:9",
  },
  {
    // Social feed — Short vertical clips with fast cuts and punchy captions,
    // built for social distribution.
    id: "social",
    label: "Social feed",
    icon: Smartphone,
    placeholder: "Hook them in 15 seconds — fast cuts, punchy captions, product front and center…",
    duration: 15,
    aspect: "9:16",
  },
  {
    // Freeform — Flexibly create any video to meet a specific marketing or
    // content need.
    id: "freeform",
    label: "Freeform",
    icon: Sparkles,
    placeholder: "Describe anything you want to see on screen…",
    duration: 45,
    aspect: "1:1",
  },
];

const ACCENT: Record<AccentKey, { pill: string; item: string }> = {
  blue: {
    pill: "bg-blue-500/10 text-blue-700 ring-blue-500/30 dark:text-blue-300",
    item: "hover:border-blue-500/60 hover:bg-blue-500/10 hover:text-blue-700 dark:hover:text-blue-300",
  },
  emerald: {
    pill: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
    item: "hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300",
  },
  amber: {
    pill: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300",
    item: "hover:border-amber-500/60 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300",
  },
  violet: {
    pill: "bg-violet-500/10 text-violet-700 ring-violet-500/30 dark:text-violet-300",
    item: "hover:border-violet-500/60 hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300",
  },
};

// Shared easing for the staged hero reveal — the same cubic-bezier already used
// for the heading and the expandable style list.
const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

// Motion props for one element in the hero's staggered upward reveal. Under
// reduced-motion `initial` is `false`, so the element just appears with no
// transform or delay.
function reveal(reduce: boolean | null, delay: number) {
  return {
    initial: reduce ? false : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.4, delay: reduce ? 0 : delay, ease: EASE },
  };
}

export function HomePage(): React.ReactElement {
  const reduce = useReducedMotion();
  // Composer preferences survive a refresh (mirrors `uc.autoApprove`). A guard
  // drops stale/invalid stored values so an old duration or a removed mode id
  // can never wedge the UI.
  const [modeId, setModeId] = usePersistentState<string>(
    "uc.modeId",
    MODES[0]!.id,
    (v): v is string => typeof v === "string" && MODES.some((m) => m.id === v),
  );
  const [text, setText] = useState("");
  const [duration, setDuration] = usePersistentState<Duration>(
    "uc.duration",
    MODES[0]!.duration,
    (v): v is Duration => ALLOWED_DURATIONS.includes(v as Duration),
  );
  const [aspect, setAspect] = usePersistentState<AspectRatio>(
    "uc.aspect",
    MODES[0]!.aspect,
    (v): v is AspectRatio => ALLOWED_ASPECT_RATIOS.includes(v as AspectRatio),
  );
  const [expandedStyle, setExpandedStyle] = useState<string | null>(null);
  const mode = MODES.find((m) => m.id === modeId)!;
  const openStyle = SEED_STYLES.find((s) => s.id === expandedStyle) ?? null;

  function pickMode(m: Mode) {
    setModeId(m.id);
    setDuration(m.duration);
    setAspect(m.aspect);
  }

  return (
    <div className="relative h-full">
      <div className="h-full overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-6 pb-24 pt-16">
          <motion.h1
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="text-center text-4xl font-semibold tracking-tight md:text-5xl"
          >
            Promo videos for{" "}
            <span className="relative whitespace-nowrap text-primary">
              your product
              <span className="absolute inset-x-0 -bottom-1 h-[3px] rounded-full bg-primary/30" />
            </span>
          </motion.h1>
          <motion.p
            {...reveal(reduce, 0.08)}
            className="mx-auto mt-4 max-w-md text-center text-[15px] leading-relaxed text-muted-foreground"
          >
            Drop in your product page and logo. UltraVora drafts the brief, script, and the final promo.
          </motion.p>

          <div className="mt-8 flex flex-wrap justify-center gap-2">
            {MODES.map((m, i) => {
              const Icon = m.icon;
              const active = m.id === modeId;
              return (
                <motion.button
                  key={m.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => pickMode(m)}
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: reduce ? 0 : 0.16 + i * 0.04, ease: EASE }}
                  whileHover={reduce ? undefined : { y: -2 }}
                  whileTap={reduce ? undefined : { scale: 0.97 }}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {m.label}
                </motion.button>
              );
            })}
          </div>

          <motion.div {...reveal(reduce, 0.3)} className="mt-6">
            <HomeComposer
              text={text}
              onTextChange={setText}
              duration={duration}
              onDurationChange={setDuration}
              aspect={aspect}
              onAspectChange={setAspect}
              placeholder={mode.placeholder}
            />
          </motion.div>

          <section className="mt-12">
            <motion.div {...reveal(reduce, 0.36)} className="mb-4 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Promo styles</h2>
              <span className="text-xs text-muted-foreground/70">Pick a style, then a starting prompt</span>
            </motion.div>

            <div className="flex flex-wrap gap-2">
              {SEED_STYLES.map((style, i) => {
                const Icon = style.icon;
                const open = expandedStyle === style.id;
                return (
                  <motion.button
                    key={style.id}
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpandedStyle((cur) => (cur === style.id ? null : style.id))}
                    initial={reduce ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: reduce ? 0 : 0.42 + i * 0.04, ease: EASE }}
                    whileHover={reduce ? undefined : { y: -2 }}
                    whileTap={reduce ? undefined : { scale: 0.97 }}
                    className={cn(
                      "cursor-pointer inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ring-1 transition-colors",
                      open
                        ? ACCENT[style.accent].pill
                        : "bg-muted text-muted-foreground ring-transparent hover:bg-muted/70 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {style.title}
                  </motion.button>
                );
              })}
            </div>

            <AnimatePresence initial={false}>
              {openStyle && (
                <motion.div
                  key={openStyle.id}
                  initial={reduce ? false : { height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {openStyle.prompts.map((prompt, i) => (
                      <motion.li
                        key={prompt}
                        initial={reduce ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: reduce ? 0 : i * 0.04 }}
                      >
                        <button
                          type="button"
                          onClick={() => setText(prompt)}
                          className={cn(
                            "w-full rounded-xl border border-border bg-card px-3 py-2.5 text-left text-[13px] leading-snug text-muted-foreground transition-colors",
                            ACCENT[openStyle.accent].item,
                          )}
                        >
                          {prompt}
                        </button>
                      </motion.li>
                    ))}
                  </ul>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>
      </div>
      <PlazaPromoBanner />
    </div>
  );
}
