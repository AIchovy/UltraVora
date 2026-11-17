import Link from "next/link";
import { ArrowRight, Check, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

const GLIMPSE_STAGES = ["Research", "Design", "Script", "Voiceover"] as const;

/**
 * Decorative, theme-token-driven mockup of a running session (chat rail +
 * render preview). Pure JSX — no screenshots, no binary assets.
 */
function ProductGlimpse(): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-xl lg:max-w-none">
      <div className="absolute -inset-6 rounded-[2rem] bg-accent/60 blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-panel">
        <div className="flex items-center gap-1.5 border-b border-border/70 bg-muted/60 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="ml-3 truncate text-[11px] font-medium text-muted-foreground">
            UltraVora — Sunlit kitchen promo
          </span>
        </div>
        <div className="grid sm:grid-cols-[1fr_1.5fr]">
          <div className="space-y-2.5 border-b border-border/70 p-4 sm:border-b-0 sm:border-r">
            <div className="w-fit max-w-full rounded-xl rounded-tl-sm bg-primary px-3 py-2 text-[11px] leading-snug text-primary-foreground">
              A 15s spot for our ceramic mug: warm morning light, three quick benefits.
            </div>
            <div className="space-y-1.5 pt-1">
              {GLIMPSE_STAGES.map((stage) => (
                <div key={stage} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Check className="h-3 w-3 text-foreground/70" />
                  {stage}
                </div>
              ))}
              <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                Compose &amp; render
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full w-2/3 rounded-full bg-primary/70" />
              </div>
            </div>
          </div>
          <div className="p-4">
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-foreground">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-background/20 backdrop-blur-sm">
                <Play className="ml-0.5 h-4 w-4 fill-background text-background" />
              </span>
              <span className="absolute inset-x-3 bottom-2 truncate text-center text-[10px] text-background/80">
                Morning light. Real moments. One mug.
              </span>
            </div>
            <div className="mt-3 flex items-center gap-1">
              <span className="h-1.5 flex-[2] rounded-full bg-primary/80" />
              <span className="h-1.5 flex-[3] rounded-full bg-border" />
              <span className="h-1.5 flex-[1.5] rounded-full bg-border" />
              <span className="h-1.5 flex-[2.5] rounded-full bg-border" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingHero(): React.ReactElement {
  return (
    <section className="relative overflow-hidden">
      <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 pb-20 pt-16 md:pt-24 lg:grid-cols-[1fr_1.05fr] lg:items-center">
        <div className="animate-fade-up">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Your AI video agent
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl lg:text-[3.4rem] lg:leading-[1.05]">
            Promo videos from a single prompt.
          </h1>
          <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            UltraVora is an AI agent that researches your product, drafts the brief and the
            script, records the voiceover, and renders the final cut. You direct. It does the
            production.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button asChild size="lg" className="active:translate-y-px">
              <Link href="/login">
                Get started
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg" className="active:translate-y-px">
              <a href="#features">See how it works</a>
            </Button>
          </div>
        </div>
        <div className="animate-fade-up [animation-delay:150ms]">
          <ProductGlimpse />
        </div>
      </div>
    </section>
  );
}
