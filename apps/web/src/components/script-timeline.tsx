"use client";
import type { Script } from "@ultracreator/shared";
import { Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Props {
  script: Script;
  stale?: boolean;
}

function formatTimestamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ScriptTimeline({ script, stale = false }: Props): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Script · {script.totalSec}s</CardTitle>
          {stale && <Badge variant="destructive">stale</Badge>}
        </div>
        {/* Segmented overview: every slot is filled, so it reads as a timeline, not progress */}
        <div aria-hidden className="flex h-1.5 w-full gap-[3px] pt-1">
          {script.scenes.map((scene) => (
            <div
              key={scene.id}
              data-testid="timeline-segment"
              className="h-full min-w-1 rounded-full bg-primary/30"
              style={{ flexGrow: scene.durationSec, flexBasis: 0 }}
            />
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2">
          {script.scenes.map((scene, index) => (
            <li key={scene.id} className="rounded-xl bg-muted/50 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                  <span className="flex h-5 w-5 items-center justify-center rounded-md bg-foreground/[0.06] text-[10px] font-medium text-foreground/70">
                    {index + 1}
                  </span>
                  <span>{formatTimestamp(scene.startSec)}</span>
                  <span className="text-muted-foreground/40">→</span>
                  <span>{formatTimestamp(scene.startSec + scene.durationSec)}</span>
                </div>
                <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  <Clock aria-hidden className="h-3 w-3" />
                  {scene.durationSec}s
                </span>
              </div>
              <div className="mt-2.5 text-sm font-medium">{scene.visual}</div>
              {scene.onScreenText && (
                <div className="mt-1 text-xs">
                  <Badge variant="secondary" className="mr-2">
                    on-screen
                  </Badge>
                  <span className="uppercase tracking-wide">{scene.onScreenText}</span>
                </div>
              )}
              {scene.narration && (
                <p className="mt-1 text-xs text-muted-foreground">“{scene.narration}”</p>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
