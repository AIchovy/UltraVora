import type { ArtifactDescriptor, ArtifactKind } from "@ultracreator/shared";

export interface PreviewTab {
  kind: ArtifactKind;
  stale: boolean;
}

/**
 * Pipeline order of the preview tabs. A tab appears when any of its source
 * kinds has an artifact; the voiceover tab covers both narration and music so
 * BGM-only sessions (voiceover off, bgm on) still get the tab.
 */
const TAB_SOURCES: { kind: ArtifactKind; sources: ArtifactKind[] }[] = [
  { kind: "brief", sources: ["brief"] },
  { kind: "design", sources: ["design"] },
  { kind: "script", sources: ["script"] },
  { kind: "narration", sources: ["narration", "music"] },
  { kind: "mp4", sources: ["mp4"] },
];

export function resolvePreviewTabs(artifacts: ArtifactDescriptor[]): PreviewTab[] {
  const tabs: PreviewTab[] = [];
  for (const { kind, sources } of TAB_SOURCES) {
    const latest = sources
      .map((s) => artifacts.filter((a) => a.kind === s).sort((a, b) => b.version - a.version)[0])
      .filter((x): x is ArtifactDescriptor => x !== undefined);
    if (latest.length === 0) continue;
    tabs.push({ kind, stale: latest.some((x) => x.stale) });
  }
  return tabs;
}
