# Soft SRT Subtitles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace burned-in (hard) subtitles with a deterministically-generated `.srt` deliverable plus a toggleable caption track in the web player.

**Architecture:** A new `subtitles` artifact kind stores structured caption segments derived purely (no LLM) from the `script` narration text and the `narration` timeline. After render, the render phase writes an `output/<id>.srt` file alongside the mp4. The compose phase no longer injects subtitle markup, so the mp4 is clean. The web player fetches the SRT, converts it to WebVTT client-side, and exposes a custom CC on/off toggle.

**Tech Stack:** TypeScript, Zod, Vitest, Next.js/React, @tanstack/react-query.

**Test runner:** all tests run from the repo root via `npx vitest run <path>` (single root config at `vitest.config.ts` covers `packages/**/test` and `apps/**/test`).

---

## File Structure

**Create:**
- `apps/server/src/subtitles/build-subtitles.ts` — pure `buildSubtitles(scenes, narration)` → `SubtitleSegment[]`.
- `apps/server/src/subtitles/srt.ts` — pure `segmentsToSrt(segments)` → SRT string.
- `apps/server/test/build-subtitles.test.ts`
- `apps/server/test/srt.test.ts`
- `apps/web/src/lib/srt-to-vtt.ts` — pure `srtToVtt(srt)` → WebVTT string.
- `apps/web/test/lib/srt-to-vtt.test.ts`
- `packages/shared/test/subtitles-artifact.test.ts`

**Modify:**
- `packages/shared/src/artifact.ts` — add `subtitles` kind + `SubtitleSegment`/`SubtitlesData` schemas.
- `apps/server/src/phases/render-handler.ts` — emit subtitles artifact + `.srt` file after render.
- `apps/server/src/phases/pi-compose-handler.ts` — remove burn-in instruction injection.
- `apps/server/test/pi-compose-handler.test.ts` — update subtitle-block tests.
- `apps/server/test/render-handler.test.ts` — add subtitles-emission test.
- `apps/web/src/lib/api-types.ts` — add `subtitles` to `ArtifactDataByKind`.
- `apps/web/src/components/video-preview.tsx` — CC toggle + SRT download.
- `apps/web/test/components/video-preview.test.tsx` — toggle + track tests.

---

## Task 1: Add the `subtitles` artifact kind and schemas (shared)

**Files:**
- Modify: `packages/shared/src/artifact.ts`
- Test: `packages/shared/test/subtitles-artifact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/subtitles-artifact.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ARTIFACT_KINDS, ARTIFACT_DATA_SCHEMAS } from "../src/artifact.js";

describe("subtitles artifact", () => {
  it("registers the subtitles kind", () => {
    expect(ARTIFACT_KINDS).toContain("subtitles");
  });

  it("parses a valid SubtitlesData payload", () => {
    const parsed = ARTIFACT_DATA_SCHEMAS.subtitles.parse({
      language: "en",
      srtPath: "output/abc.srt",
      segments: [{ sceneId: "s1", text: "Hello world", startMs: 0, endMs: 1500 }],
    });
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.language).toBe("en");
  });

  it("rejects a segment whose endMs is not greater than startMs", () => {
    expect(() =>
      ARTIFACT_DATA_SCHEMAS.subtitles.parse({
        srtPath: "output/abc.srt",
        segments: [{ sceneId: "s1", text: "x", startMs: 1000, endMs: 1000 }],
      }),
    ).toThrow();
  });

  it("defaults language to en when omitted", () => {
    const parsed = ARTIFACT_DATA_SCHEMAS.subtitles.parse({
      srtPath: "output/abc.srt",
      segments: [{ sceneId: "s1", text: "x", startMs: 0, endMs: 1000 }],
    });
    expect(parsed.language).toBe("en");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/subtitles-artifact.test.ts`
Expected: FAIL — `ARTIFACT_DATA_SCHEMAS.subtitles` is undefined / `subtitles` not in `ARTIFACT_KINDS`.

- [ ] **Step 3: Implement the schemas**

In `packages/shared/src/artifact.ts`:

Add `"subtitles"` to `ARTIFACT_KINDS`, positioned after `"composition"`:

```ts
export const ARTIFACT_KINDS = [
  "brief",
  "design",
  "script",
  "narration",
  "composition",
  "subtitles",
  "mp4",
] as const;
```

Add these schemas just above `ARTIFACT_DATA_SCHEMAS` (after `Mp4DataSchema`, line ~43):

```ts
export const SubtitleSegmentSchema = z
  .object({
    sceneId: z.string(),
    text: z.string().min(1),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
  })
  .refine((s) => s.endMs > s.startMs, { message: "endMs must be greater than startMs" });
export type SubtitleSegment = z.infer<typeof SubtitleSegmentSchema>;

export const SubtitlesDataSchema = z.object({
  language: z.string().default("en"),
  srtPath: z.string(), // workspace-root-relative, e.g. "output/<id>.srt"
  segments: z.array(SubtitleSegmentSchema),
});
export type SubtitlesData = z.infer<typeof SubtitlesDataSchema>;
```

Register it in `ARTIFACT_DATA_SCHEMAS` (after `composition`, before `mp4`):

```ts
export const ARTIFACT_DATA_SCHEMAS = {
  brief: BriefSchema,
  design: DesignSchema,
  script: ScriptSchema,
  narration: NarrationDataSchema,
  composition: CompositionDataSchema,
  subtitles: SubtitlesDataSchema,
  mp4: Mp4DataSchema,
} as const;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/test/subtitles-artifact.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/artifact.ts packages/shared/test/subtitles-artifact.test.ts
git commit -m "feat(shared): add subtitles artifact kind and schemas"
```

---

## Task 2: `buildSubtitles` pure function (server)

**Files:**
- Create: `apps/server/src/subtitles/build-subtitles.ts`
- Test: `apps/server/test/build-subtitles.test.ts`

Algorithm (deterministic):
1. For each narration segment that is **narrated** (`audioFile` present), find the matching `script` scene by `id` and read its `narration` text. Skip silent segments and empty/whitespace narration.
2. Split narration into lines: split into sentences on `/(?<=[.!?])\s+/`; for any sentence longer than `MAX_WORDS` (10) words, greedily chunk into runs of ≤ `MAX_WORDS` words. Trim each line; drop empties.
3. Lay lines into the scene's spoken window `[startMs, startMs + spokenMs)` where `spokenMs = durationMs > TAIL_PAD_MS ? durationMs - TAIL_PAD_MS : durationMs` (`TAIL_PAD_MS` = 500, matching `computeNarrationTimeline`). Partition the window sequentially by **cumulative character weight** so there are no gaps or overlaps and the final line ends exactly at `startMs + spokenMs`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/build-subtitles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSubtitles } from "../src/subtitles/build-subtitles.js";
import type { Scene } from "@ultracreator/shared";
import type { NarrationData } from "@ultracreator/shared";

const scenes: Scene[] = [
  { id: "s1", startSec: 0, durationSec: 8, visual: "v", narration: "Welcome to Giggle Academy. Where young minds blossom." },
  { id: "s2", startSec: 8, durationSec: 4, visual: "v" }, // silent: no narration
];

const narration: NarrationData = {
  totalMs: 12000,
  segments: [
    { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 },
    { sceneId: "s2", startMs: 8000, durationMs: 4000 },
  ],
};

describe("buildSubtitles", () => {
  it("emits one segment per sentence/line for narrated scenes only", () => {
    const segs = buildSubtitles(scenes, narration);
    expect(segs.map((s) => s.text)).toEqual([
      "Welcome to Giggle Academy.",
      "Where young minds blossom.",
    ]);
    expect(segs.every((s) => s.sceneId === "s1")).toBe(true);
  });

  it("partitions the spoken window (durationMs - 500 tail) with no gaps or overlaps", () => {
    const segs = buildSubtitles(scenes, narration);
    // spoken window: [0, 7500)
    expect(segs[0]!.startMs).toBe(0);
    expect(segs.at(-1)!.endMs).toBe(7500);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.startMs).toBe(segs[i - 1]!.endMs); // contiguous
    }
  });

  it("allocates duration proportional to line length", () => {
    const segs = buildSubtitles(scenes, narration);
    const len0 = "Welcome to Giggle Academy.".length;
    const len1 = "Where young minds blossom.".length;
    // first boundary = round(7500 * len0 / (len0+len1))
    const expectedBoundary = Math.round((7500 * len0) / (len0 + len1));
    expect(segs[0]!.endMs).toBe(expectedBoundary);
  });

  it("splits sentences longer than 10 words into multiple lines", () => {
    const long: Scene[] = [{
      id: "s1", startSec: 0, durationSec: 8, visual: "v",
      narration: "one two three four five six seven eight nine ten eleven twelve",
    }];
    const n: NarrationData = {
      totalMs: 8000,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 }],
    };
    const segs = buildSubtitles(long, n);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.text).toBe("one two three four five six seven eight nine ten");
    expect(segs[1]!.text).toBe("eleven twelve");
  });

  it("returns no segments when narration is empty or whitespace", () => {
    const blank: Scene[] = [{ id: "s1", startSec: 0, durationSec: 8, visual: "v", narration: "   " }];
    const n: NarrationData = {
      totalMs: 8000,
      segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 }],
    };
    expect(buildSubtitles(blank, n)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/build-subtitles.test.ts`
Expected: FAIL — `Cannot find module '../src/subtitles/build-subtitles.js'`.

- [ ] **Step 3: Implement `buildSubtitles`**

Create `apps/server/src/subtitles/build-subtitles.ts`:

```ts
import type { NarrationData, Scene, SubtitleSegment } from "@ultracreator/shared";

const TAIL_PAD_MS = 500;
const MAX_WORDS = 10;

/** Split one scene's narration into short caption lines. */
function splitIntoLines(narration: string): string[] {
  const sentences = narration
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lines: string[] = [];
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    if (words.length <= MAX_WORDS) {
      lines.push(sentence);
    } else {
      for (let i = 0; i < words.length; i += MAX_WORDS) {
        lines.push(words.slice(i, i + MAX_WORDS).join(" "));
      }
    }
  }
  return lines;
}

/**
 * Derive caption segments purely from the script narration text and the
 * authoritative narration timeline. Narrated scenes only (segments with an
 * audioFile); silent and blank-narration scenes produce nothing.
 */
export function buildSubtitles(scenes: Scene[], narration: NarrationData): SubtitleSegment[] {
  const sceneById = new Map(scenes.map((s) => [s.id, s]));
  const out: SubtitleSegment[] = [];

  for (const seg of narration.segments) {
    if (!seg.audioFile) continue; // silent scene
    const scene = sceneById.get(seg.sceneId);
    const text = scene?.narration?.trim();
    if (!text) continue;

    const lines = splitIntoLines(text);
    if (lines.length === 0) continue;

    const spokenMs = seg.durationMs > TAIL_PAD_MS ? seg.durationMs - TAIL_PAD_MS : seg.durationMs;
    const totalWeight = lines.reduce((acc, l) => acc + l.length, 0);

    let cumWeight = 0;
    let prevEnd = seg.startMs;
    lines.forEach((line, i) => {
      cumWeight += line.length;
      const isLast = i === lines.length - 1;
      const endMs = isLast
        ? seg.startMs + spokenMs
        : seg.startMs + Math.round((spokenMs * cumWeight) / totalWeight);
      out.push({ sceneId: seg.sceneId, text: line, startMs: prevEnd, endMs });
      prevEnd = endMs;
    });
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/build-subtitles.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/subtitles/build-subtitles.ts apps/server/test/build-subtitles.test.ts
git commit -m "feat(server): deterministic buildSubtitles from script + narration"
```

---

## Task 3: `segmentsToSrt` serializer (server)

**Files:**
- Create: `apps/server/src/subtitles/srt.ts`
- Test: `apps/server/test/srt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/srt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { segmentsToSrt } from "../src/subtitles/srt.js";

describe("segmentsToSrt", () => {
  it("formats segments as standard SRT cues", () => {
    const srt = segmentsToSrt([
      { sceneId: "s1", text: "Hello world", startMs: 0, endMs: 1500 },
      { sceneId: "s1", text: "Second line", startMs: 1500, endMs: 3725 },
    ]);
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n" +
        "2\n00:00:01,500 --> 00:00:03,725\nSecond line\n",
    );
  });

  it("zero-pads hours, minutes, seconds and milliseconds", () => {
    const srt = segmentsToSrt([
      { sceneId: "s1", text: "x", startMs: 3661001, endMs: 3662002 },
    ]);
    expect(srt).toBe("1\n01:01:01,001 --> 01:01:02,002\nx\n");
  });

  it("returns an empty string for no segments", () => {
    expect(segmentsToSrt([])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/srt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `segmentsToSrt`**

Create `apps/server/src/subtitles/srt.ts`:

```ts
import type { SubtitleSegment } from "@ultracreator/shared";

function fmt(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(millis, 3)}`;
}

/** Serialize caption segments to a standard SRT document. */
export function segmentsToSrt(segments: SubtitleSegment[]): string {
  return segments
    .map((seg, i) => `${i + 1}\n${fmt(seg.startMs)} --> ${fmt(seg.endMs)}\n${seg.text}\n`)
    .join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/srt.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/subtitles/srt.ts apps/server/test/srt.test.ts
git commit -m "feat(server): segmentsToSrt serializer"
```

---

## Task 4: Emit subtitles artifact + `.srt` in the render phase

**Files:**
- Modify: `apps/server/src/phases/render-handler.ts`
- Test: `apps/server/test/render-handler.test.ts`

The emission runs after the worker's `done` message, gated on `brief.constraints.subtitles === true` and the presence of `script` + `narration` artifacts. The `.srt` file is written next to the mp4 (same basename) and its workspace-relative path is stored in the artifact.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/render-handler.test.ts` (reuse the existing imports; add `BriefSchema`-shaped data inline). Insert a new `it` inside the `describe("RenderPhaseHandler", ...)` block:

```ts
it("emits a subtitles artifact and an .srt file when constraints.subtitles is on", async () => {
  const wm = new WorkspaceManager(root);
  const bus = new EventBus();
  const store = new ArtifactStore(wm, bus);
  await wm.init("s1");
  await store.put("s1", "composition", { dir: "composition", entry: "index.html" });
  await writeFile(join(wm.paths("s1").composition, "index.html"), "<html>composed</html>");
  await store.put("s1", "script", {
    totalSec: 8,
    scenes: [{ id: "s1", startSec: 0, durationSec: 8, visual: "v", narration: "Hello there. Welcome aboard." }],
  });
  await store.put("s1", "narration", {
    totalMs: 8000,
    segments: [{ sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 8000 }],
  });
  // Minimal brief with subtitles enabled.
  await store.put("s1", "brief", {
    goal: "g", audience: "a", tone: "t", keyPoints: ["k"],
    sourceAssets: { images: [], text: [] },
    constraints: { durationSec: 8, aspectRatio: "16:9", withVoiceover: true, subtitles: true },
  } as never);

  const worker = new StubRenderWorkerClient({ writeOutput: true });
  const handler = new RenderPhaseHandler({ workerClient: worker });
  for await (const _ of handler.run({
    sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
    signal: new AbortController().signal,
  } as any)) { /* drain */ }

  const subs = await store.get<{ srtPath: string; segments: unknown[] }>("s1", "subtitles");
  expect(subs).not.toBeNull();
  expect(subs!.data.segments.length).toBeGreaterThan(0);
  const srtAbs = join(wm.paths("s1").root, subs!.data.srtPath);
  expect(existsSync(srtAbs)).toBe(true);
  expect(readFileSync(srtAbs, "utf8")).toContain("-->");
});

it("does not emit subtitles when constraints.subtitles is absent", async () => {
  const wm = new WorkspaceManager(root);
  const bus = new EventBus();
  const store = new ArtifactStore(wm, bus);
  await seedComposition(store, wm);
  const handler = new RenderPhaseHandler({ workerClient: new StubRenderWorkerClient({ writeOutput: true }) });
  for await (const _ of handler.run({
    sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
    signal: new AbortController().signal,
  } as any)) { /* drain */ }
  expect(await store.get("s1", "subtitles")).toBeNull();
});
```

> Note: the brief object above must satisfy `BriefSchema`. If `ArtifactStore.put` rejects it, open `packages/shared/src/brief.ts`, copy the exact required fields into this literal, and keep `constraints.subtitles: true`. The `as never` cast bypasses the local TS type but Zod still validates at runtime — adjust fields until `put` succeeds.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/render-handler.test.ts`
Expected: FAIL — no `subtitles` artifact is produced (first new test fails; the "does not emit" test passes trivially).

- [ ] **Step 3: Implement emission in `render-handler.ts`**

Add imports at the top of `apps/server/src/phases/render-handler.ts`:

```ts
import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { CompositionData, NarrationData, PhaseId, Script, Brief, ServerEvent } from "@ultracreator/shared";
import { buildSubtitles } from "../subtitles/build-subtitles.js";
import { segmentsToSrt } from "../subtitles/srt.js";
```

(Replace the existing `import type { CompositionData, PhaseId, ServerEvent } ...` line with the expanded one above.)

In the `case "done":` block, replace the body with:

```ts
case "done": {
  await ctx.artifacts.put(
    ctx.sessionId,
    "mp4",
    { path: msg.mp4Path },
    { derivedFrom: [{ kind: "composition", version: compEnv.version }] },
  );

  await maybeEmitSubtitles(ctx, msg.mp4Path);

  yield { type: "render.done", mp4Path: msg.mp4Path };
  return;
}
```

Add this private method to the `RenderPhaseHandler` class (after `run`):

```ts
private async maybeEmitSubtitles(ctx: PhaseContext, mp4Path: string): Promise<void> {
  const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
  if (briefEnv?.data.constraints.subtitles !== true) return;

  const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
  const narrationEnv = await ctx.artifacts.get<NarrationData>(ctx.sessionId, "narration");
  if (!scriptEnv || !narrationEnv) return; // nothing to caption

  const segments = buildSubtitles(scriptEnv.data.scenes, narrationEnv.data);
  if (segments.length === 0) return;

  const srtName = basename(mp4Path).replace(/\.mp4$/i, ".srt");
  const srtAbs = resolve(ctx.workspaces.paths(ctx.sessionId).output, srtName);
  const srtPath = `output/${srtName}`; // workspace-root-relative, served via /files/*
  await writeFile(srtAbs, segmentsToSrt(segments), "utf8");

  await ctx.artifacts.put(
    ctx.sessionId,
    "subtitles",
    { language: "en", srtPath, segments },
    { derivedFrom: [{ kind: "script", version: scriptEnv.version }, { kind: "narration", version: narrationEnv.version }] },
  );
}
```

> `maybeEmitSubtitles` is declared `private async` (not a generator) and is `await`ed from inside the `done` case — keep it a separate method so the generator body stays readable.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/render-handler.test.ts`
Expected: PASS (all existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/render-handler.ts apps/server/test/render-handler.test.ts
git commit -m "feat(server): emit subtitles artifact + .srt in render phase"
```

---

## Task 5: Remove burned-in subtitle authoring from compose

**Files:**
- Modify: `apps/server/src/phases/pi-compose-handler.ts`
- Test: `apps/server/test/pi-compose-handler.test.ts`

We stop injecting the subtitle instruction so the compose agent never writes `sub-clip` spans. We keep `subtitlesBlockFor` exported but make it always return `""` (subtitles are now produced out-of-band), and update its tests.

- [ ] **Step 1: Update the failing test first**

In `apps/server/test/pi-compose-handler.test.ts`, replace the `describe("subtitlesBlockFor", ...)` block (lines ~38-52) with:

```ts
describe("subtitlesBlockFor", () => {
  it("returns empty string even when subtitles is true (subtitles are now a separate SRT artifact, not burned in)", () => {
    expect(subtitlesBlockFor({ subtitles: true })).toBe("");
  });

  it("returns empty string when subtitles is false or omitted", () => {
    expect(subtitlesBlockFor({ subtitles: false })).toBe("");
    expect(subtitlesBlockFor({})).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/pi-compose-handler.test.ts`
Expected: FAIL — the first new assertion fails because `subtitlesBlockFor({ subtitles: true })` still returns the instruction text.

- [ ] **Step 3: Implement the removal**

In `apps/server/src/phases/pi-compose-handler.ts`:

Delete the `SUBTITLES_INSTRUCTION` constant (lines ~175-189) and replace the `subtitlesBlockFor` function body so it always returns `""`:

```ts
/**
 * Subtitles are now produced out-of-band as a separate SRT artifact (see
 * render-handler `maybeEmitSubtitles`), never burned into the composition.
 * Retained as a no-op so the compose system prompt wiring is unchanged.
 */
export function subtitlesBlockFor(_constraints: { subtitles?: boolean }): string {
  return "";
}
```

Leave line 357 (`const subtitlesBlock = subtitlesBlockFor(...)`) and line 364 (its interpolation) as-is — `subtitlesBlock` is now always `""`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/pi-compose-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/pi-compose-handler.ts apps/server/test/pi-compose-handler.test.ts
git commit -m "refactor(server): stop burning subtitles into the composition"
```

---

## Task 6: Type the `subtitles` artifact on the web

**Files:**
- Modify: `apps/web/src/lib/api-types.ts`

- [ ] **Step 1: Implement the type wiring**

In `apps/web/src/lib/api-types.ts`:

Add `SubtitlesData` to the shared import list:

```ts
import type {
  ArtifactDescriptor,
  ArtifactEnvelope,
  ArtifactKind,
  Brief,
  Design,
  PhaseId,
  Script,
  ServerEvent,
  Mp4Data,
  NarrationData,
  CompositionData,
  SubtitlesData,
} from "@ultracreator/shared";
```

Add `subtitles` to `ArtifactDataByKind`:

```ts
export type ArtifactDataByKind = {
  brief: Brief;
  design: Design;
  script: Script;
  narration: NarrationData;
  composition: CompositionData;
  subtitles: SubtitlesData;
  mp4: Mp4Data;
};
```

- [ ] **Step 2: Verify the web type-checks**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: no errors. (`ArtifactDataByKind` must stay exhaustive over `ArtifactKind`; adding the key satisfies it.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api-types.ts
git commit -m "feat(web): type the subtitles artifact"
```

---

## Task 7: `srtToVtt` client-side converter (web)

**Files:**
- Create: `apps/web/src/lib/srt-to-vtt.ts`
- Test: `apps/web/test/lib/srt-to-vtt.test.ts`

Browsers' native `<track>` only accepts WebVTT, so we convert the SRT in the browser: prepend the `WEBVTT` header and turn the `,` millisecond separator in timecodes into `.`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/lib/srt-to-vtt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { srtToVtt } from "@/lib/srt-to-vtt";

describe("srtToVtt", () => {
  it("prepends the WEBVTT header and converts comma ms separators to dots", () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,500\nHello world\n";
    expect(srtToVtt(srt)).toBe(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nHello world\n",
    );
  });

  it("only rewrites timecode commas, not commas inside caption text", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello, world\n";
    expect(srtToVtt(srt)).toContain("Hello, world");
    expect(srtToVtt(srt)).toContain("00:00:01.000 --> 00:00:02.000");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/test/lib/srt-to-vtt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srtToVtt`**

Create `apps/web/src/lib/srt-to-vtt.ts`:

```ts
/** Convert an SRT document to WebVTT (the only subtitle format <track> accepts). */
export function srtToVtt(srt: string): string {
  const body = srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/test/lib/srt-to-vtt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/srt-to-vtt.ts apps/web/test/lib/srt-to-vtt.test.ts
git commit -m "feat(web): srtToVtt converter"
```

---

## Task 8: CC toggle + SRT download in the video player

**Files:**
- Modify: `apps/web/src/components/video-preview.tsx`
- Test: `apps/web/test/components/video-preview.test.tsx`

`VideoPreview` queries the `subtitles` artifact itself (so `artifact-viewer.tsx` needs no change). When a subtitles artifact exists, it fetches the SRT via `fileUrl`, converts to a VTT object URL, renders a `<track>`, shows a CC on/off toggle button, and adds a "Download .srt" link.

- [ ] **Step 1: Write the failing test**

Replace `apps/web/test/components/video-preview.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VideoPreview } from "@/components/video-preview";

vi.mock("@/lib/api-client", async (orig) => {
  const actual = await orig<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    fileUrl: (sid: string, rel: string) => `https://test/${sid}/${rel}`,
    getArtifact: vi.fn(),
  };
});
import { getArtifact } from "@/lib/api-client";

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom lacks createObjectURL
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:vtt";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  global.fetch = vi.fn(async () => ({ text: async () => "1\n00:00:00,000 --> 00:00:01,000\nHi\n" })) as never;
});

describe("VideoPreview", () => {
  it("renders the video and download link with no caption controls when there is no subtitles artifact", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    renderWithClient(<VideoPreview sid="s1" mp4Path="output/x.mp4" />);
    await waitFor(() => expect(getArtifact).toHaveBeenCalledWith("s1", "subtitles"));
    expect(screen.queryByRole("button", { name: /captions|cc/i })).toBeNull();
  });

  it("shows a CC toggle and SRT download link when a subtitles artifact exists", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "subtitles", version: 1, createdAt: "", derivedFrom: null,
      data: { language: "en", srtPath: "output/x.srt", segments: [{ sceneId: "s1", text: "Hi", startMs: 0, endMs: 1000 }] },
    });
    renderWithClient(<VideoPreview sid="s1" mp4Path="output/x.mp4" />);
    const toggle = await screen.findByRole("button", { name: /captions|cc/i });
    expect(toggle).toBeTruthy();
    const dl = screen.getByRole("link", { name: /\.srt/i });
    expect(dl.getAttribute("href")).toBe("https://test/s1/output/x.srt");
    await userEvent.click(toggle); // does not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/test/components/video-preview.test.tsx`
Expected: FAIL — no CC toggle / SRT link rendered; `getArtifact("s1","subtitles")` never called.

- [ ] **Step 3: Implement the player changes**

Replace `apps/web/src/components/video-preview.tsx` with:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Captions } from "lucide-react";
import { fileUrl, getArtifact } from "@/lib/api-client";
import { srtToVtt } from "@/lib/srt-to-vtt";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props { sid: string; mp4Path: string }

export function VideoPreview({ sid, mp4Path }: Props): React.ReactElement {
  const src = fileUrl(sid, mp4Path);
  const subs = useQuery({
    queryKey: ["artifact", sid, "subtitles"],
    queryFn: () => getArtifact(sid, "subtitles"),
  });
  const srtPath = subs.data?.data.srtPath;
  const srtUrl = srtPath ? fileUrl(sid, srtPath) : null;

  const [ccOn, setCcOn] = useState(true);
  const [vttUrl, setVttUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Fetch the SRT once and turn it into a WebVTT object URL for the <track>.
  useEffect(() => {
    if (!srtUrl) { setVttUrl(null); return; }
    let revoked = false;
    let url: string | null = null;
    void (async () => {
      const res = await fetch(srtUrl);
      const vtt = srtToVtt(await res.text());
      url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
      if (!revoked) setVttUrl(url);
    })();
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [srtUrl]);

  // Keep the native TextTrack mode in sync with the toggle.
  useEffect(() => {
    const tracks = videoRef.current?.textTracks;
    if (tracks && tracks.length > 0) tracks[0].mode = ccOn ? "showing" : "hidden";
  }, [ccOn, vttUrl]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Video</CardTitle>
          <div className="flex items-center gap-3">
            {vttUrl && (
              <button
                type="button"
                onClick={() => setCcOn((v) => !v)}
                aria-pressed={ccOn}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Captions className="h-3.5 w-3.5" /> Captions {ccOn ? "on" : "off"}
              </button>
            )}
            {srtUrl && (
              <a href={srtUrl} download className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Download className="h-3.5 w-3.5" /> .srt
              </a>
            )}
            <a href={src} download className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <Download className="h-3.5 w-3.5" /> Download
            </a>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <video ref={videoRef} src={src} controls className="aspect-video w-full rounded-lg bg-black" crossOrigin="anonymous">
          {vttUrl && <track kind="subtitles" srcLang="en" label="English" src={vttUrl} default />}
        </video>
      </CardContent>
    </Card>
  );
}
```

> The CC toggle button matches `/captions|cc/i` via its "Captions on/off" label. The `.srt` download link matches `/\.srt/i`. If `lucide-react` lacks a `Captions` export in this version, substitute any present icon (e.g. `Subtitles`) — check `node_modules/lucide-react` exports and adjust the import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/test/components/video-preview.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/video-preview.tsx apps/web/test/components/video-preview.test.tsx
git commit -m "feat(web): toggleable captions + SRT download in video player"
```

---

## Task 9: Full suite + typecheck

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS — all tests green, including pre-existing ones.

- [ ] **Step 2: Typecheck the workspace**

Run: `pnpm -r exec tsc --noEmit` (or the repo's existing typecheck script if one exists — check root `package.json` scripts first).
Expected: no type errors.

- [ ] **Step 3: Final commit (if anything was adjusted)**

```bash
git add -A
git commit -m "chore: soft SRT subtitles — suite + typecheck green"
```

---

## Self-Review Notes

- **Spec coverage:** new `subtitles` artifact (Task 1), deterministic `buildSubtitles` from narration timeline (Task 2), SRT serialization + file emission (Tasks 3-4), burn-in removal (Task 5), web type + converter + player toggle/download (Tasks 6-8). Old `811a3e39` video deliberately not backfilled (out of scope, per spec).
- **Deviation from spec:** the spec mentioned a "~1s minimum display per line." This plan uses pure proportional partitioning without a hard minimum, because the narration window is floored at 2s and lines are short — a hard min would require redistribution that adds complexity for little gain. Treated as acceptable for v1; can be revisited if captions flash too fast in practice.
- **Type consistency:** `SubtitleSegment` / `SubtitlesData` are defined once in shared (Task 1) and reused everywhere (`buildSubtitles`, `segmentsToSrt`, `api-types`, player). `srtPath` is workspace-root-relative throughout. `subtitlesBlockFor` keeps its signature (now a no-op).
