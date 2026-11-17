import { Play } from "lucide-react";
import { ShowcasePanel } from "./showcase-panel";

// Staggered phases so the bars read as a moving waveform, not a row in sync.
const BARS = [0, 140, 280, 90, 360, 200, 60, 420, 160, 300, 110, 380, 230, 70, 340, 180];

const LANES = [
  { label: "footage", segs: [3, 2, 4] },
  { label: "voice", segs: [5, 3] },
  { label: "music", segs: [8] },
  { label: "captions", segs: [2, 2, 2, 1] },
];

/** Stage 05 + 06 — the voiceover waveform, the layered tracks composing
 *  together, and the final cut rendering to a play-ready frame. */
export function RenderAnim(): React.ReactElement {
  return (
    <ShowcasePanel label="compose & render">
      <div className="space-y-4">
        <div className="flex h-10 items-end gap-[3px]">
          {BARS.map((d, i) => (
            <span
              key={i}
              className="flex-1 origin-bottom animate-wave rounded-full bg-primary/55"
              style={{ height: "100%", animationDelay: `${d}ms` }}
            />
          ))}
        </div>

        <div className="space-y-1.5">
          {LANES.map((lane) => (
            <div key={lane.label} className="flex items-center gap-2">
              <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground/70">
                {lane.label}
              </span>
              <div className="flex flex-1 gap-1">
                {lane.segs.map((s, i) => (
                  <span
                    key={i}
                    className={`h-2 rounded-full ${i % 2 === 0 ? "bg-foreground/20" : "bg-foreground/10"}`}
                    style={{ flex: s }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-foreground">
          <span className="relative flex h-11 w-11 items-center justify-center">
            <span className="absolute inset-0 animate-sheen rounded-full bg-background/25" />
            <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-background/20 backdrop-blur-sm">
              <Play className="ml-0.5 h-4 w-4 fill-background text-background" />
            </span>
          </span>
          <span className="absolute inset-x-3 bottom-2 truncate text-center text-[10px] text-background/80">
            Morning light. Real moments. One mug.
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
            render
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full origin-left animate-fill rounded-full bg-primary/70" />
          </div>
        </div>
      </div>
    </ShowcasePanel>
  );
}
