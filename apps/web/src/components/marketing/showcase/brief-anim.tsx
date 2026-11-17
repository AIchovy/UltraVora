import { Check } from "lucide-react";
import { ShowcasePanel } from "./showcase-panel";

/** The promo's palette, shown as warm-neutral swatches (illustrative, kept in
 *  the page's warm family rather than introducing a foreign accent). */
const SWATCHES = [
  "oklch(0.96 0.02 78)",
  "oklch(0.88 0.045 70)",
  "oklch(0.74 0.06 58)",
  "oklch(0.5 0.045 50)",
  "oklch(0.31 0.02 50)",
];

const PACING = [
  { label: "intro", flex: 2, delay: "0ms" },
  { label: "build", flex: 3.5, delay: "260ms" },
  { label: "payoff", flex: 1.5, delay: "520ms" },
];

/** Stage 03 — the creative brief: palette, pacing and mood assembled for a
 *  one-tap approval. */
export function BriefAnim(): React.ReactElement {
  return (
    <ShowcasePanel label="creative brief">
      <div className="space-y-4">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            palette
          </div>
          <div className="mt-1.5 flex gap-1.5">
            {SWATCHES.map((c, i) => (
              <span
                key={c}
                className="h-7 flex-1 rounded-lg shadow-xs ring-1 ring-foreground/5"
                style={{ backgroundColor: c, animationDelay: `${i * 90}ms` }}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            pacing
          </div>
          <div className="mt-1.5 flex gap-1.5">
            {PACING.map((p) => (
              <div key={p.label} className="h-2 overflow-hidden rounded-full bg-muted" style={{ flex: p.flex }}>
                <div
                  className="h-full origin-left animate-fill rounded-full bg-primary/70"
                  style={{ animationDelay: p.delay }}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3.5">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
              mood
            </div>
            <div className="mt-0.5 text-[12px] font-medium text-foreground">warm, cinematic, calm</div>
          </div>
          <span className="inline-flex animate-sheen items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground">
            <Check className="h-3.5 w-3.5" />
            Approve
          </span>
        </div>
      </div>
    </ShowcasePanel>
  );
}
