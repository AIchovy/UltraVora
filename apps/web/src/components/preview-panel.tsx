"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Palette, ListVideo, AudioLines, Film, Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ArtifactDescriptor, ArtifactKind, Brief } from "@ultracreator/shared";
import { ApiError, getArtifact, restoreMp4Version } from "@/lib/api-client";
import { resolvePreviewTabs } from "@/lib/preview-tabs";
import { cn } from "@/lib/utils";
import { BriefCard } from "./brief-card";
import { VoiceoverPane } from "./voiceover-pane";
import { DesignBoard } from "./design-board";
import { ScriptTimeline } from "./script-timeline";
import { VideoPreview, type RegenerationInfo } from "./video-preview";
import { AssetManager } from "./asset-manager";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

/** Pipeline order, left to right — also the auto-advance priority (last = newest). */
const STAGES: { kind: ArtifactKind; label: string; icon: typeof FileText }[] = [
  { kind: "brief", label: "Brief", icon: FileText },
  { kind: "design", label: "Design", icon: Palette },
  { kind: "script", label: "Script", icon: ListVideo },
  // Covers narration AND bgm (see resolvePreviewTabs), hence "Audio".
  { kind: "narration", label: "Audio", icon: AudioLines },
  { kind: "mp4", label: "Video", icon: Film },
];

interface Props {
  sid: string;
  artifacts: ArtifactDescriptor[];
  loading?: boolean;
  /** Non-null while a run is re-generating artifacts that already exist. */
  regenerating?: RegenerationInfo | null;
}

export function PreviewPanel({ sid, artifacts, loading = false, regenerating = null }: Props): React.ReactElement {
  // Tabs in pipeline order; the voiceover tab also covers the music artifact.
  const tabs = useMemo(() => {
    return resolvePreviewTabs(artifacts)
      .map((t) => {
        const stage = STAGES.find((s) => s.kind === t.kind);
        return stage ? { ...stage, stale: t.stale } : null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  }, [artifacts]);

  // Every rendered cut, oldest → newest: the Video pane's version strip.
  const mp4Versions = useMemo(
    () =>
      artifacts
        .filter((a) => a.kind === "mp4")
        .map((a) => a.version)
        .sort((a, b) => a - b),
    [artifacts],
  );

  const newest = tabs[tabs.length - 1]?.kind ?? null;
  const [selected, setSelected] = useState<ArtifactKind | null>(newest);
  const pinnedRef = useRef(false);

  // Follow the pipeline forward until the user manually picks a tab.
  useEffect(() => {
    if (!pinnedRef.current && newest) setSelected(newest);
  }, [newest]);

  // Keep selection valid if the chosen tab disappears.
  useEffect(() => {
    if (selected && !tabs.some((t) => t.kind === selected)) setSelected(newest);
  }, [tabs, selected, newest]);

  if (tabs.length === 0) {
    if (loading) return <PreviewSkeleton />;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm font-medium">Nothing to preview yet</p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            Describe your video on the left. The brief, design, script, and final cut appear here as the agent works.
          </p>
        </div>
      </div>
    );
  }

  const active = selected ?? newest!;
  const activeStale = tabs.find((t) => t.kind === active)?.stale ?? false;

  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pt-4">
        <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-1">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.kind === active;
            return (
              <button
                key={tab.kind}
                type="button"
                aria-pressed={isActive}
                onClick={() => {
                  pinnedRef.current = true;
                  setSelected(tab.kind);
                }}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-card text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
                {tab.stale && <span className="h-1.5 w-1.5 rounded-full bg-destructive" title="stale" />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-auto px-5 pb-5 pt-4">
        <div className="mx-auto max-w-3xl">
          <ArtifactPane
            sid={sid}
            kind={active}
            stale={activeStale}
            regenerating={regenerating}
            mp4Versions={mp4Versions}
          />
        </div>
      </div>
    </div>
  );
}

interface PaneProps {
  sid: string;
  kind: ArtifactKind;
  stale: boolean;
  regenerating: RegenerationInfo | null;
  /** All rendered mp4 versions, oldest → newest (used by the Video pane only). */
  mp4Versions: number[];
}

function ArtifactPane({ sid, kind, stale, regenerating, mp4Versions }: PaneProps): React.ReactElement {
  // The voiceover pane queries narration + music itself (either may be absent).
  if (kind === "narration") return <VoiceoverPane sid={sid} stale={stale} />;
  // The video pane manages its own version history (watch/restore old cuts).
  if (kind === "mp4") return <Mp4Pane sid={sid} regenerating={regenerating} versions={mp4Versions} />;
  return <SingleArtifactPane sid={sid} kind={kind} stale={stale} />;
}

function SingleArtifactPane({ sid, kind, stale }: Omit<PaneProps, "regenerating" | "mp4Versions">): React.ReactElement {
  const q = useQuery({
    queryKey: ["artifact", sid, kind],
    queryFn: () => getArtifact(sid, kind),
  });
  if (q.isLoading || !q.data) {
    return <PaneSkeleton />;
  }
  switch (kind) {
    case "brief":
      return <BriefCard sid={sid} brief={q.data.data as never} stale={stale} />;
    case "design":
      return <DesignPane sid={sid} design={q.data.data as never} stale={stale} />;
    case "script":
      return <ScriptTimeline script={q.data.data as never} stale={stale} />;
    case "mp4": // unreachable — ArtifactPane routes mp4 to Mp4Pane
    case "narration": // unreachable — ArtifactPane routes narration to VoiceoverPane
    case "composition":
    case "music":
    case "subtitles":
      return <p className="text-sm text-muted-foreground">{kind} ready.</p>;
  }
}

/**
 * Video pane with version history. Users can watch any previous cut and
 * promote it back to "current"; the selection follows the newest version
 * whenever a re-render lands (same "follow the newest" rule as the tabs).
 */
function Mp4Pane({
  sid,
  regenerating,
  versions,
}: {
  sid: string;
  regenerating: RegenerationInfo | null;
  versions: number[];
}): React.ReactElement {
  const qc = useQueryClient();
  const latest = versions[versions.length - 1];
  // null = follow the latest version; a number = pinned to that older cut.
  const [pinned, setPinned] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  // A new version landed (adjustment re-render finished) — snap back to it.
  useEffect(() => {
    setPinned(null);
  }, [latest]);

  const viewing = pinned ?? latest;
  const isLatest = viewing === latest;

  // The latest view keeps the un-versioned key so the SSE artifact.created
  // invalidation (["artifact", sid, "mp4"]) refetches it; old versions are
  // immutable, so their versioned keys can cache forever.
  const q = useQuery({
    queryKey: isLatest ? ["artifact", sid, "mp4"] : ["artifact", sid, "mp4", viewing],
    queryFn: () => getArtifact(sid, "mp4", isLatest ? undefined : viewing),
  });

  async function restore(): Promise<void> {
    if (viewing === undefined) return;
    setRestoring(true);
    try {
      await restoreMp4Version(sid, viewing);
      // Belt and braces with the server's artifact.created SSE event.
      setPinned(null);
      void qc.invalidateQueries({ queryKey: ["artifact", sid, "mp4"] });
      void qc.invalidateQueries({ queryKey: ["artifacts", sid] });
      void qc.invalidateQueries({ queryKey: ["session", sid] });
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? "A run is in progress — try again when it finishes."
          : err instanceof Error
            ? err.message
            : "Could not restore this version.",
      );
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-3">
      {q.isLoading || !q.data ? (
        <PaneSkeleton />
      ) : (
        <VideoPreview
          sid={sid}
          mp4Path={(q.data.data as { path: string }).path.replace(/^.*\/output\//, "output/")}
          // Only the latest cut is being replaced by a re-render; an old cut
          // the user is reviewing is final.
          regenerating={isLatest ? regenerating : null}
        />
      )}
      {versions.length >= 2 && (
        <div className="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-1">
          {versions.map((v) => {
            const isActive = v === viewing;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={isActive}
                onClick={() => setPinned(v === latest ? null : v)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  isActive ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === latest ? `V${v} · Current` : `V${v}`}
              </button>
            );
          })}
        </div>
      )}
      {!isLatest && (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/70 px-3.5 py-2">
          <span className="text-xs text-muted-foreground">Viewing V{viewing} (older version)</span>
          <Button size="sm" variant="outline" disabled={restoring} onClick={() => void restore()}>
            {restoring && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
            Use this version
          </Button>
        </div>
      )}
    </div>
  );
}

function DesignPane({ sid, design, stale }: { sid: string; design: never; stale: boolean }): React.ReactElement {
  const brief = useQuery({
    queryKey: ["artifact", sid, "brief"],
    queryFn: () => getArtifact(sid, "brief"),
  });
  const hints = (brief.data?.data as Brief | undefined)?.brandHints;
  const images = (brief.data?.data as Brief | undefined)?.sourceAssets.images;
  // While the brief is loading, leave presentAssets undefined so the board
  // doesn't briefly hide every brief-tracked visual.
  const presentAssets = brief.data
    ? [...(images ?? []), ...(hints?.logoFile ? [hints.logoFile] : [])]
    : undefined;
  return (
    <div className="space-y-4">
      <AssetManager sid={sid} logoFile={hints?.logoFile} images={images} />
      <DesignBoard design={design} sid={sid} stale={stale} presentAssets={presentAssets} />
    </div>
  );
}

function PreviewSkeleton(): React.ReactElement {
  return (
    <div className="flex h-full flex-col" role="status" aria-label="Loading preview">
      <div className="px-5 pt-4">
        <Skeleton className="h-9 w-64 rounded-full" />
      </div>
      <div className="flex-1 px-5 pb-5 pt-4">
        <div className="mx-auto max-w-3xl">
          <PaneSkeleton />
        </div>
      </div>
    </div>
  );
}

function PaneSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-64" />
      <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3">
        <Skeleton className="aspect-video rounded-lg" />
        <Skeleton className="aspect-video rounded-lg" />
        <Skeleton className="aspect-video rounded-lg" />
      </div>
    </div>
  );
}
