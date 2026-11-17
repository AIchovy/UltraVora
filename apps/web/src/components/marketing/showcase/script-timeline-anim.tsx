import { ShowcasePanel } from "./showcase-panel";

const SCENES = [
  { n: "01", label: "hook" },
  { n: "02", label: "light" },
  { n: "03", label: "benefit" },
  { n: "04", label: "cta" },
];

// Highlight each scene roughly as the playhead passes it (4 scenes / 5.5s loop).
const SCENE_DELAYS = ["0ms", "1375ms", "2750ms", "4125ms"];

const STRIP = [2, 3, 1.5, 2.5, 1, 2] as const;

/** Stage 04 — the script as a timeline: a playhead reads across the scenes
 *  while the caption for the live scene types in below. */
export function ScriptTimelineAnim(): React.ReactElement {
  return (
    <ShowcasePanel label="timeline">
      <div className="relative [container-type:inline-size]">
        <div className="pointer-events-none absolute -inset-y-1 left-0 z-10 w-0.5 animate-sweep rounded-full bg-foreground/80" />
        <div className="grid grid-cols-4 gap-2.5">
          {SCENES.map((s, i) => (
            <div
              key={s.n}
              className="animate-scene rounded-xl border border-border bg-muted p-2.5"
              style={{ animationDelay: SCENE_DELAYS[i] }}
            >
              <div className="flex h-12 flex-col justify-between">
                <div className="h-1.5 w-2/3 rounded-full bg-foreground/15" />
                <div className="flex items-baseline justify-between gap-1">
                  <span className="font-mono text-[10px] text-muted-foreground/70">{s.n}</span>
                  <span className="text-[11px] font-medium text-foreground">{s.label}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-hidden">
        <span className="block animate-type whitespace-nowrap font-mono text-[12px] text-muted-foreground">
          scene 02, soft morning light pours across the counter.
        </span>
      </div>

      <div className="mt-4 flex items-center gap-1">
        {STRIP.map((w, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full ${i === 1 ? "bg-primary/80" : "bg-border"}`}
            style={{ flex: w }}
          />
        ))}
      </div>
    </ShowcasePanel>
  );
}
