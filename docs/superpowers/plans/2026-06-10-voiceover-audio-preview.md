# Voiceover Audio Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Voiceover tab's "narration ready." placeholder with a themed multi-track audio player (per-scene narration tracks + BGM track), backed by a new `music` artifact so the frontend can locate the generated BGM.

**Architecture:** New `music` artifact (file-pointer pattern like `narration`) written by the `generate_music` tool and attached to the compose phase's outputs for stale tracking. Web side: the audio-ui.xyz shadcn registry components are already installed under `apps/web/src/components/audio/` (uncommitted) and need adaptation from base-ui idioms to this repo's radix-flavored ui kit; a pure `buildAudioTracks` helper maps narration + music artifacts to player tracks; `VoiceoverPane` renders the player; preview-panel tab visibility extends to "narration OR music".

**Tech Stack:** zod, vitest, React 18 + Next.js, @audio-ui registry components (zustand store), TanStack Query.

**Spec:** `docs/superpowers/specs/2026-06-10-voiceover-audio-preview-design.md`

**Pre-existing state (already done, uncommitted):** `components.json` has the `@audio` registry; `pnpm dlx shadcn@latest add @audio/block-player-widget` has been run (all overwrite prompts declined). New files: `src/components/audio/{player,fader,transport}.tsx`, `src/components/audio/blocks/block-player-widget.tsx`, `src/hooks/use-audio{,-provider}.ts`, `src/lib/{audio-store,html-audio,web-audio}.ts`, several new `src/components/ui/*` files; `package.json`/lockfile updated. `npx tsc --noEmit` in apps/web currently FAILS — Task 4 fixes that.

**Conventions:** commands run from repo root unless noted. Commits end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 1: `music` artifact kind (shared)

**Files:**
- Modify: `packages/shared/src/artifact.ts`
- Test: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/shared/test/schemas.test.ts`, the ARTIFACT_KINDS test at ~line 144 asserts an exact list. Update it to include `"music"` after `"composition"`, and add a MusicDataSchema test. Find:

```ts
    expect(ARTIFACT_KINDS).toEqual([
```

and make its expected array:

```ts
    expect(ARTIFACT_KINDS).toEqual([
      "brief",
      "design",
      "script",
      "narration",
      "composition",
      "music",
      "subtitles",
      "mp4",
    ]);
```

Add a new test next to the other data-schema tests (import `ARTIFACT_DATA_SCHEMAS` is already there):

```ts
  it("validates music artifact data", () => {
    const value = { file: "a1b2.wav", prompt: "cinematic ambient", durationSec: 30 };
    expect(ARTIFACT_DATA_SCHEMAS.music.parse(value)).toEqual(value);
    expect(() => ARTIFACT_DATA_SCHEMAS.music.parse({ file: "x.wav" })).toThrow();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — kinds list mismatch and `ARTIFACT_DATA_SCHEMAS.music` undefined.

- [ ] **Step 3: Implement**

In `packages/shared/src/artifact.ts`:

```ts
export const ARTIFACT_KINDS = [
  "brief",
  "design",
  "script",
  "narration",
  "composition",
  "music",
  "subtitles",
  "mp4",
] as const;
```

Below `CompositionDataSchema` add:

```ts
export const MusicDataSchema = z.object({
  file: z.string(), // bare filename in the composition dir
  prompt: z.string(),
  durationSec: z.number().nonnegative(),
});
export type MusicData = z.infer<typeof MusicDataSchema>;
```

Add to `ARTIFACT_DATA_SCHEMAS`:

```ts
  music: MusicDataSchema,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/shared/test/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/artifact.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add music artifact kind"
```

---

### Task 2: compose phase outputs `music` (server)

**Files:**
- Modify: `apps/server/src/phases/registry.ts`
- Test: `apps/server/test/phase-registry.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/server/test/phase-registry.test.ts` add (or update an existing outputs assertion if one covers compose):

```ts
  it("compose outputs composition and music", () => {
    const r = new PhaseRegistry();
    expect(r.outputs("compose")).toEqual(["composition", "music"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/phase-registry.test.ts`
Expected: FAIL — outputs is `["composition"]`.

- [ ] **Step 3: Implement**

In `apps/server/src/phases/registry.ts` change:

```ts
  { id: "compose", outputs: ["composition"] },
```

to:

```ts
  { id: "compose", outputs: ["composition", "music"] },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/phase-registry.test.ts apps/server/test/stale.test.ts`
Expected: PASS (stale tests confirm no regression in downstream marking).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/registry.ts apps/server/test/phase-registry.test.ts
git commit -m "feat(server): compose phase outputs music artifact"
```

---

### Task 3: `generate_music` writes the music artifact (server)

**Files:**
- Modify: `apps/server/src/tools/music-tools.ts`
- Modify: `apps/server/src/phases/pi-compose-handler.ts` (~line 326, the `makeGenerateMusicTool({...})` call)
- Test: `apps/server/test/generate-music-tool.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/server/test/generate-music-tool.test.ts` add imports:

```ts
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import type { MusicData } from "@ultracreator/shared";
```

Add a test:

```ts
  it("records a music artifact pointing at the generated file", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const store = new ArtifactStore(wm, new EventBus());
    const tool = makeGenerateMusicTool({
      sessionId: "s1",
      workspaces: wm,
      provider: fakeProvider(),
      artifacts: store,
    });
    const res = await tool.execute("c1", { prompt: "cinematic ambient", durationSec: 30 }, signal);
    const fileName = (res.content[0] as { text: string }).text;
    const env = await store.get<MusicData>("s1", "music");
    expect(env?.data).toEqual({ file: fileName, prompt: "cinematic ambient", durationSec: 30 });
  });
```

Also update the two existing tool constructions in this file to pass an `artifacts` store (the option becomes required):

```ts
    const tool = makeGenerateMusicTool({
      sessionId: "s1",
      workspaces: wm,
      provider: fakeProvider(),           // or fakeProvider(calls)
      artifacts: new ArtifactStore(wm, new EventBus()),
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/generate-music-tool.test.ts`
Expected: FAIL — `artifacts` is not a known option / no music artifact written.

- [ ] **Step 3: Implement**

In `apps/server/src/tools/music-tools.ts`:

Add the import:

```ts
import type { ArtifactStore } from "../artifacts/artifact-store.js";
```

Add to `GenerateMusicToolOptions`:

```ts
  /** Records the generated track as a `music` artifact so the UI can find it. */
  artifacts: ArtifactStore;
```

In `execute`, after the `withTransientRetry` call succeeds and before the `return`:

```ts
      await opts.artifacts.put(opts.sessionId, "music", {
        file: fileName,
        prompt,
        durationSec,
      });
```

In `apps/server/src/phases/pi-compose-handler.ts`, the `makeGenerateMusicTool({...})` call (~line 326) gains:

```ts
              artifacts: ctx.artifacts,
```

(`ctx` is the PhaseContext already in scope there — same object the handler uses for `ctx.artifacts.get(...)` at ~line 232.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/generate-music-tool.test.ts apps/server/test/pi-compose-handler.test.ts && pnpm typecheck`
Expected: PASS; typecheck clean (pi-compose-handler tests may construct the tool indirectly — fix any missing `artifacts` the same way).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tools/music-tools.ts apps/server/src/phases/pi-compose-handler.ts apps/server/test/generate-music-tool.test.ts
git commit -m "feat(server): record generated BGM as music artifact"
```

---

### Task 4: adapt the installed audio components (web, typecheck-driven)

**Files:**
- Modify: `apps/web/src/components/audio/player.tsx`
- Modify: `apps/web/src/hooks/use-audio-provider.ts`
- Modify: `apps/web/src/components/ui/button.tsx`
- Modify: `apps/web/src/components/ui/sortable-list.tsx` (only if typecheck still flags it)
- Delete: `apps/web/src/components/audio/blocks/block-player-widget.tsx`
- Plus: commit the rest of the installer output as-is.

The registry code is vendored (copy-paste-own); this task is adaptation of generated code, verified by typecheck + existing suite (TDD exception for vendored/generated code).

- [ ] **Step 1: Fix the hook import paths**

In BOTH `apps/web/src/components/audio/player.tsx` (line ~27) and `apps/web/src/hooks/use-audio-provider.ts` (line ~4) change:

```ts
import { useAudio } from "@/components/hooks/use-audio";
```

to:

```ts
import { useAudio } from "@/hooks/use-audio";
```

- [ ] **Step 2: Add the `icon-sm` button size**

In `apps/web/src/components/ui/button.tsx` size variants:

```ts
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
        "icon-sm": "h-8 w-8",
      },
```

- [ ] **Step 3: Delete the queue/speed components we don't use**

In `apps/web/src/components/audio/player.tsx` delete these five components entirely (each starts at the listed declaration and ends just before the next top-level declaration): `AudioQueueRepeatMode` (~1233), `AudioQueueShuffle` (~1280), `AudioQueuePreferences` (~1326), `AudioQueue` (~1391), `AudioPlaybackSpeed` (~1536). Also delete `demoTracks` if nothing references it after the deletions, any now-unused imports (the phosphor icons / dialog / command imports those components used), and trim the export block to:

```ts
export {
  audioPlayerVariants,
  AudioProvider,
  AudioPlayer,
  AudioPlayerButton,
  AudioPlayerControlBar,
  AudioPlayerControlGroup,
  AudioPlayerTimeDisplay,
  AudioPlayerSeekBar,
  AudioPlayerVolume,
  AudioPlayerPlay,
  AudioPlayerRewind,
  AudioPlayerFastForward,
  AudioPlayerSkipForward,
  AudioPlayerSkipBack,
  AudioTrack,
  AudioTrackList,
};
```

Delete `apps/web/src/components/audio/blocks/block-player-widget.tsx` (it imports the deleted exports; VoiceoverPane replaces it).

- [ ] **Step 4: Patch base-ui idioms to radix in the kept components**

`AudioPlayerButton` (~line 219):

```tsx
  if (tooltipLabel) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent sideOffset={4}>{tooltipLabel}</TooltipContent>
      </Tooltip>
    );
  }
```

`AudioPlayerVolume` trigger (~line 416): convert the `render={...}` form to:

```tsx
      <DropdownMenuTrigger asChild>
        <AudioPlayerButton
          className={cn("hidden md:flex", className)}
          data-slot="audio-volume-button"
          size={size}
          tooltipLabel={
            isMuted
              ? "Muted"
              : `Volume ${Math.round(effectiveVolumePercent)}%`
          }
          variant={variant}
        >
          <Icon className={cn(isMuted && "opacity-40")} />
        </AudioPlayerButton>
      </DropdownMenuTrigger>
```

`AudioPlayerVolume` menu item (~line 451):

```tsx
          <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
```

(Any other `render={...}` / `closeOnClick` occurrences surfaced by typecheck in KEPT components get the same treatment: trigger `render={<X/>}` + children → `<Trigger asChild><X>{children}</X></Trigger>`.)

- [ ] **Step 5: Typecheck until clean**

Run: `cd apps/web && npx tsc --noEmit`
Expected: clean. Iterate on leftovers (unused imports after deletions, `icon-sm` in `sortable-list.tsx` is fixed by Step 2).

- [ ] **Step 6: Run the web suite**

Run: `npx vitest run apps/web` (from repo root)
Expected: same pass/fail profile as before this feature (4 pre-existing failures in session-page/use-session-stream are known).

- [ ] **Step 7: Commit everything from the installer + adaptation**

```bash
git add apps/web/components.json apps/web/package.json pnpm-lock.yaml apps/web/src/components/audio apps/web/src/components/ui apps/web/src/hooks apps/web/src/lib/audio-store.ts apps/web/src/lib/html-audio.ts apps/web/src/lib/web-audio.ts
git commit -m "feat(web): vendor audio-ui player components adapted to radix ui kit"
```

---

### Task 5: `buildAudioTracks` (web, TDD)

**Files:**
- Create: `apps/web/src/lib/audio-tracks.ts`
- Test: `apps/web/test/lib/audio-tracks.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/lib/audio-tracks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { MusicData, NarrationData } from "@ultracreator/shared";
import { buildAudioTracks } from "@/lib/audio-tracks";

const narration: NarrationData = {
  totalMs: 12000,
  segments: [
    { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 5000 },
    { sceneId: "s2", startMs: 5000, durationMs: 2000 }, // silent — no audioFile
    { sceneId: "s3", audioFile: "narration-s3.wav", startMs: 7000, durationMs: 5000 },
  ],
};

const music: MusicData = { file: "abc123.wav", prompt: "cinematic ambient", durationSec: 30 };

describe("buildAudioTracks", () => {
  it("maps narrated scenes and the BGM into ordered tracks", () => {
    const tracks = buildAudioTracks("sid1", narration, music);
    expect(tracks.map((t) => t.id)).toEqual(["narration-s1", "narration-s3", "bgm"]);
    expect(tracks[0]).toMatchObject({
      title: "Scene s1",
      artist: "Voiceover · 0:00 – 0:05",
      duration: 5,
    });
    expect(tracks[0]!.url).toContain("/api/sessions/sid1/files/composition/narration-s1.wav");
    expect(tracks[2]).toMatchObject({
      title: "Background music",
      artist: "cinematic ambient",
      duration: 30,
    });
    expect(tracks[2]!.url).toContain("/api/sessions/sid1/files/composition/abc123.wav");
  });

  it("skips silent scenes", () => {
    const tracks = buildAudioTracks("sid1", narration, null);
    expect(tracks).toHaveLength(2);
  });

  it("handles music-only sessions", () => {
    const tracks = buildAudioTracks("sid1", null, music);
    expect(tracks.map((t) => t.id)).toEqual(["bgm"]);
  });

  it("returns empty for no audio", () => {
    expect(buildAudioTracks("sid1", null, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/lib/audio-tracks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/audio-tracks.ts`:

```ts
import type { MusicData, NarrationData } from "@ultracreator/shared";
import type { Track } from "@/lib/html-audio";
import { fileUrl } from "@/lib/api-client";

function fmt(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Map the narration + music artifacts onto player tracks, narration first. */
export function buildAudioTracks(
  sid: string,
  narration: NarrationData | null,
  music: MusicData | null,
): Track[] {
  const tracks: Track[] = [];
  for (const seg of narration?.segments ?? []) {
    if (!seg.audioFile) continue; // silent scene
    tracks.push({
      id: `narration-${seg.sceneId}`,
      url: fileUrl(sid, `composition/${seg.audioFile}`),
      title: `Scene ${seg.sceneId}`,
      artist: `Voiceover · ${fmt(seg.startMs)} – ${fmt(seg.startMs + seg.durationMs)}`,
      duration: seg.durationMs / 1000,
    });
  }
  if (music) {
    tracks.push({
      id: "bgm",
      url: fileUrl(sid, `composition/${music.file}`),
      title: "Background music",
      artist: music.prompt,
      duration: music.durationSec,
    });
  }
  return tracks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/test/lib/audio-tracks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/audio-tracks.ts apps/web/test/lib/audio-tracks.test.ts
git commit -m "feat(web): buildAudioTracks maps narration and music artifacts to player tracks"
```

---

### Task 6: tab visibility helper (web, TDD)

**Files:**
- Create: `apps/web/src/lib/preview-tabs.ts`
- Test: `apps/web/test/lib/preview-tabs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/lib/preview-tabs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ArtifactDescriptor } from "@ultracreator/shared";
import { resolvePreviewTabs } from "@/lib/preview-tabs";

const d = (kind: ArtifactDescriptor["kind"], version = 1, stale = false): ArtifactDescriptor =>
  ({ kind, version, stale } as ArtifactDescriptor);

describe("resolvePreviewTabs", () => {
  it("returns tabs in pipeline order for present artifacts", () => {
    const tabs = resolvePreviewTabs([d("script"), d("brief")]);
    expect(tabs.map((t) => t.kind)).toEqual(["brief", "script"]);
  });

  it("shows the voiceover tab for narration", () => {
    expect(resolvePreviewTabs([d("narration")]).map((t) => t.kind)).toEqual(["narration"]);
  });

  it("shows the voiceover tab for music-only sessions", () => {
    expect(resolvePreviewTabs([d("music")]).map((t) => t.kind)).toEqual(["narration"]);
  });

  it("marks the voiceover tab stale when either source is stale", () => {
    const tabs = resolvePreviewTabs([d("narration", 1, false), d("music", 1, true)]);
    expect(tabs).toEqual([{ kind: "narration", stale: true }]);
  });

  it("uses the latest version per kind for staleness", () => {
    const tabs = resolvePreviewTabs([d("brief", 1, true), d("brief", 2, false)]);
    expect(tabs).toEqual([{ kind: "brief", stale: false }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/lib/preview-tabs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/web/src/lib/preview-tabs.ts`:

```ts
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
      .map((s) =>
        artifacts.filter((a) => a.kind === s).sort((a, b) => b.version - a.version)[0],
      )
      .filter((x): x is ArtifactDescriptor => x !== undefined);
    if (latest.length === 0) continue;
    tabs.push({ kind, stale: latest.some((x) => x.stale) });
  }
  return tabs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/test/lib/preview-tabs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/preview-tabs.ts apps/web/test/lib/preview-tabs.test.ts
git commit -m "feat(web): resolvePreviewTabs covers music in the voiceover tab"
```

---

### Task 7: `VoiceoverPane` + preview-panel integration (web)

**Files:**
- Create: `apps/web/src/components/voiceover-pane.tsx`
- Modify: `apps/web/src/components/preview-panel.tsx`

- [ ] **Step 1: Create the pane**

`apps/web/src/components/voiceover-pane.tsx`:

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import { Music } from "lucide-react";
import type { MusicData, NarrationData } from "@ultracreator/shared";
import { getArtifact } from "@/lib/api-client";
import { buildAudioTracks } from "@/lib/audio-tracks";
import {
  AudioPlayer,
  AudioPlayerControlBar,
  AudioPlayerControlGroup,
  AudioPlayerPlay,
  AudioPlayerSeekBar,
  AudioPlayerSkipBack,
  AudioPlayerSkipForward,
  AudioPlayerTimeDisplay,
  AudioPlayerVolume,
  AudioTrackList,
} from "@/components/audio/player";

interface Props {
  sid: string;
  stale: boolean;
}

export function VoiceoverPane({ sid, stale }: Props): React.ReactElement {
  const narration = useQuery({
    queryKey: ["artifact", sid, "narration"],
    queryFn: () => getArtifact(sid, "narration"),
  });
  const music = useQuery({
    queryKey: ["artifact", sid, "music"],
    queryFn: () => getArtifact(sid, "music"),
  });

  if (narration.isLoading || music.isLoading) {
    return <div className="h-64 animate-pulse rounded-2xl bg-muted" />;
  }

  const tracks = buildAudioTracks(
    sid,
    (narration.data?.data as NarrationData | undefined) ?? null,
    (music.data?.data as MusicData | undefined) ?? null,
  );

  if (tracks.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-2xl bg-card px-8 py-12 text-center shadow-xs">
        <Music className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No audio generated yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {stale && (
        <p className="text-xs text-destructive">
          This audio is stale — it predates your latest revision.
        </p>
      )}
      <AudioPlayer
        tracks={tracks}
        className="flex flex-col gap-4 rounded-2xl bg-card p-4 shadow-xs"
      >
        <AudioTrackList media="index" className="max-h-64 w-full rounded-xl border p-1" />
        <AudioPlayerControlBar variant="stacked">
          <AudioPlayerControlGroup>
            <AudioPlayerTimeDisplay />
            <AudioPlayerSeekBar />
            <AudioPlayerTimeDisplay remaining />
          </AudioPlayerControlGroup>
          <AudioPlayerControlGroup>
            <AudioPlayerSkipBack />
            <AudioPlayerPlay />
            <AudioPlayerSkipForward />
            <AudioPlayerVolume />
          </AudioPlayerControlGroup>
        </AudioPlayerControlBar>
      </AudioPlayer>
    </div>
  );
}
```

(Prop names like `media="index"` and `variant="stacked"` exist in the installed `player.tsx`; if TS flags a mismatch, follow the installed component's actual props.)

- [ ] **Step 2: Integrate into preview-panel**

In `apps/web/src/components/preview-panel.tsx`:

Imports:

```ts
import { resolvePreviewTabs } from "@/lib/preview-tabs";
import { VoiceoverPane } from "./voiceover-pane";
```

Replace the `tabs` useMemo body:

```ts
  const tabs = useMemo(() => {
    const resolved = resolvePreviewTabs(artifacts);
    return resolved
      .map((t) => {
        const stage = STAGES.find((s) => s.kind === t.kind);
        return stage ? { ...stage, stale: t.stale } : null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
  }, [artifacts]);
```

In `ArtifactPane`, replace the switch's `narration` handling — `narration` moves out of the fallback group into its own case **before** the data query is required (the pane does its own queries):

```ts
  switch (kind) {
    case "brief":
      return <BriefCard sid={sid} brief={q.data.data as never} stale={stale} />;
    ...
    case "narration":
      return <VoiceoverPane sid={sid} stale={stale} />;
    case "composition":
    case "subtitles":
    case "music":
      return <p className="text-sm text-muted-foreground">{kind} ready.</p>;
  }
```

IMPORTANT detail: `ArtifactPane` currently early-returns a skeleton while `getArtifact(sid, kind)` loads, and for music-only sessions `getArtifact(sid, "narration")` returns null forever — so move the `narration` case ABOVE the `if (q.isLoading || !q.data)` guard, or simplest: at the top of `ArtifactPane`:

```ts
  if (kind === "narration") return <VoiceoverPane sid={sid} stale={stale} />;
```

and leave the rest of the function unchanged (then the switch keeps `narration` in the fallback group, which is now unreachable — remove `narration` from that group's case labels and add `music` to it).

- [ ] **Step 3: Typecheck + web suite**

Run: `cd apps/web && npx tsc --noEmit && cd ../.. && npx vitest run apps/web`
Expected: typecheck clean; same test profile as before (4 known pre-existing failures).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/voiceover-pane.tsx apps/web/src/components/preview-panel.tsx
git commit -m "feat(web): multi-track audio preview in the voiceover tab"
```

---

### Task 8: full verification

- [ ] **Step 1:** `npx vitest run` — expect: only the 4 known pre-existing failures (session-page ×2, use-session-stream ×2).
- [ ] **Step 2:** `pnpm typecheck` — expect: clean.
- [ ] **Step 3:** Fix anything new, commit fixes.

## Out of scope (per spec)

- Simultaneous multi-track playback aligned to startMs.
- Regenerating audio from the pane.
