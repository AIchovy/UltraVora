import { ShowcasePanel } from "./showcase-panel";

const FINDINGS: { key: string; value: string }[] = [
  { key: "audience", value: "home baristas" },
  { key: "tone", value: "warm, unhurried" },
  { key: "angle", value: "sell the ritual" },
  { key: "hook", value: "the first pour" },
];

/** Stage 02 — a prompt types in, then the research it pulled sits below, with a
 *  light sweep reading across the panel. */
export function ResearchAnim(): React.ReactElement {
  return (
    <ShowcasePanel label="research">
      <div className="relative [container-type:inline-size]">
        <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 animate-scan bg-gradient-to-r from-transparent via-foreground/[0.06] to-transparent" />
        <div className="w-fit max-w-full rounded-xl rounded-tl-sm bg-primary px-3 py-2 text-[12px] leading-snug text-primary-foreground">
          <span className="block animate-type whitespace-nowrap">
            15s promo for our ceramic mug, warm morning light.
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2.5">
          {FINDINGS.map((f) => (
            <div
              key={f.key}
              className="rounded-xl border border-border/70 bg-muted/50 px-3 py-2"
            >
              <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
                {f.key}
              </div>
              <div className="mt-0.5 text-[12px] font-medium text-foreground">{f.value}</div>
            </div>
          ))}
        </div>
      </div>
    </ShowcasePanel>
  );
}
