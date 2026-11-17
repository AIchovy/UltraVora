/**
 * Shared chrome for the landing "how it works" animations: a floating white
 * panel with a window bar and a soft accent halo, matching the hero's
 * ProductGlimpse motif. Pure presentation; the panel label (e.g. "timeline")
 * carries the pipeline-stage identity so the showcases don't need an eyebrow.
 */
export function ShowcasePanel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div aria-hidden="true" className="relative">
      <div className="absolute -inset-6 rounded-[2rem] bg-accent/50 blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card shadow-panel">
        <div className="flex items-center gap-1.5 border-b border-border/70 bg-muted/60 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="h-2.5 w-2.5 rounded-full bg-border" />
          <span className="ml-3 font-mono text-[11px] lowercase tracking-wide text-muted-foreground">
            {label}
          </span>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
