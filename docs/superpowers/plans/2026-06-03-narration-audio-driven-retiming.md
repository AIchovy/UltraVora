# Narration Audio-Driven Retiming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synthesize TTS narration per scene and recompute the scene timeline from real audio durations so each scene's visuals play in sync with its own narration (no trailing silence or cut-off).

**Architecture:** A pure `computeNarrationTimeline` function turns per-scene audio durations into an authoritative timeline. `voiceover` synthesizes each narrated scene to its own `narration-<sceneId>.wav`, measures durations, and stores the timeline in the upgraded `narration` artifact. `compose` consumes that timeline (when present) to set exact per-scene `data-start`/`data-duration` and add one `<audio>` per narrated scene; with no narration it falls back to the `script` timeline unchanged. The `script` artifact is never mutated.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Node, run via `tsx` (no build). Zod schemas in `packages/shared`. Pi agent for compose. Tests: `vitest` from repo ROOT. Typecheck: `npm run typecheck`.

**Conventions (read before starting):**
- Run a single test: `npx vitest run apps/server/test/<name>.test.ts` from repo root (`/path/to/UltraVora`). Shared-package tests: `npx vitest run packages/shared/test/<name>.test.ts`.
- Typecheck everything: `npm run typecheck` from repo root.
- `NarrationData` is in **milliseconds**. hyperframes `data-start`/`data-duration` are in **seconds** — compose converts ms→seconds at the prompt boundary.
- Provider `synthesize({ text, outputPath, signal })` returns `{ audioPath, durationMs, wordTimings? }` (see `apps/server/src/providers/types.ts`). `StubTTSProvider` returns `durationMs = max(msPerWord, wordCount*msPerWord)` with `msPerWord` default 200.

---

### Task 1: Upgrade the `NarrationData` schema

**Files:**
- Modify: `packages/shared/src/artifact.ts:19-26`
- Test: `packages/shared/test/narration-schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/narration-schema.test.ts
import { describe, it, expect } from "vitest";
import { NarrationDataSchema } from "../src/artifact.js";

describe("NarrationDataSchema", () => {
  it("accepts a per-scene timeline", () => {
    const v = NarrationDataSchema.parse({
      totalMs: 9000,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 3000 },
        { sceneId: "s2", startMs: 3000, durationMs: 6000 },
      ],
    });
    expect(v.segments).toHaveLength(2);
    expect(v.segments[1].audioFile).toBeUndefined();
  });

  it("rejects the old single-file shape", () => {
    const r = NarrationDataSchema.safeParse({ audioPath: "x.wav", durationMs: 5 });
    expect(r.success).toBe(false);
  });

  it("rejects negative timing values", () => {
    const r = NarrationDataSchema.safeParse({
      totalMs: -1,
      segments: [{ sceneId: "s1", startMs: 0, durationMs: 10 }],
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/narration-schema.test.ts`
Expected: FAIL — first test rejects (schema still requires `audioPath`/`durationMs`).

- [ ] **Step 3: Implement — replace the schema**

In `packages/shared/src/artifact.ts`, replace the current `NarrationDataSchema` block (lines 19-26) with:

```ts
export const NarrationSegmentSchema = z.object({
  sceneId: z.string(),
  audioFile: z.string().optional(), // bare filename in the composition dir; absent for silent scenes
  startMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type NarrationSegment = z.infer<typeof NarrationSegmentSchema>;

export const NarrationDataSchema = z.object({
  totalMs: z.number().nonnegative(),
  segments: z.array(NarrationSegmentSchema),
});
export type NarrationData = z.infer<typeof NarrationDataSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/test/narration-schema.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Typecheck (expected to FAIL with known downstream errors)**

Run: `npm run typecheck`
Expected: FAILS in `apps/server/src/phases/voiceover-handler.ts` and `apps/server/src/phases/pi-compose-handler.ts` (they still reference `narrationEnv.data.audioPath`/`durationMs`). This is EXPECTED — Tasks 3 and 4 fix those. Do NOT fix them here. Note the errors are confined to those two files.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/artifact.ts packages/shared/test/narration-schema.test.ts
git commit -m "feat(shared): upgrade NarrationData to a per-scene timeline"
```
End the commit body with this trailer (own line, after a blank line):
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

---

### Task 2: Pure `computeNarrationTimeline` function

**Files:**
- Create: `apps/server/src/phases/narration-timeline.ts`
- Test: `apps/server/test/narration-timeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/narration-timeline.test.ts
import { describe, it, expect } from "vitest";
import { computeNarrationTimeline } from "../src/phases/narration-timeline.js";

const scenes = [
  { id: "s1", durationSec: 6 },
  { id: "s2", durationSec: 6 },
  { id: "s3", durationSec: 6 },
];

describe("computeNarrationTimeline", () => {
  it("uses audio duration + tail pad for narrated scenes, planned duration for silent ones", () => {
    // s1 narrated 3000ms, s2 silent, s3 narrated 5000ms; defaults tailPad=500, minScene=2000
    const t = computeNarrationTimeline(scenes, { s1: 3000, s3: 5000 });
    expect(t.segments).toEqual([
      { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 3500 },
      { sceneId: "s2", startMs: 3500, durationMs: 6000 },
      { sceneId: "s3", audioFile: "narration-s3.wav", startMs: 9500, durationMs: 5500 },
    ]);
    expect(t.totalMs).toBe(15000);
  });

  it("applies the minimum scene floor to very short narration", () => {
    const t = computeNarrationTimeline([{ id: "s1", durationSec: 6 }], { s1: 800 });
    // 800 + 500 = 1300 < 2000 floor → 2000
    expect(t.segments[0].durationMs).toBe(2000);
    expect(t.totalMs).toBe(2000);
  });

  it("honors custom tailPadMs and minSceneMs", () => {
    const t = computeNarrationTimeline([{ id: "s1", durationSec: 6 }], { s1: 1000 }, {
      tailPadMs: 0,
      minSceneMs: 0,
    });
    expect(t.segments[0].durationMs).toBe(1000);
  });

  it("returns all-silent timeline (planned durations) when no audio provided", () => {
    const t = computeNarrationTimeline(scenes, {});
    expect(t.segments.map((s) => s.durationMs)).toEqual([6000, 6000, 6000]);
    expect(t.segments.every((s) => s.audioFile === undefined)).toBe(true);
    expect(t.totalMs).toBe(18000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/narration-timeline.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/phases/narration-timeline.ts
import type { NarrationData } from "@ultracreator/shared";

export interface RetimingScene {
  id: string;
  durationSec: number;
}

export interface RetimingOptions {
  /** Silence added after each narrated scene's audio. Default 500ms. */
  tailPadMs?: number;
  /** Floor for a narrated scene's duration. Default 2000ms. */
  minSceneMs?: number;
}

/**
 * Build the authoritative narration timeline. Narrated scenes (those whose id
 * appears in `audioDurationMsBySceneId`) get `audioDurationMs + tailPad`, floored
 * at `minSceneMs`; silent scenes keep their planned duration. Starts are the
 * running cumulative sum in scene order.
 */
export function computeNarrationTimeline(
  scenes: RetimingScene[],
  audioDurationMsBySceneId: Record<string, number>,
  opts: RetimingOptions = {},
): NarrationData {
  const tailPadMs = opts.tailPadMs ?? 500;
  const minSceneMs = opts.minSceneMs ?? 2000;

  let cursor = 0;
  const segments = scenes.map((scene) => {
    const audioMs = audioDurationMsBySceneId[scene.id];
    const narrated = audioMs !== undefined;
    const durationMs = narrated
      ? Math.max(audioMs + tailPadMs, minSceneMs)
      : Math.round(scene.durationSec * 1000);
    const startMs = cursor;
    cursor += durationMs;
    return narrated
      ? { sceneId: scene.id, audioFile: `narration-${scene.id}.wav`, startMs, durationMs }
      : { sceneId: scene.id, startMs, durationMs };
  });

  return { totalMs: cursor, segments };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/narration-timeline.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/narration-timeline.ts apps/server/test/narration-timeline.test.ts
git commit -m "feat(server): pure computeNarrationTimeline retiming function"
```
End the commit body with the trailer:
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

Note: `audioFile` naming (`narration-<sceneId>.wav`) MUST match the output path the voiceover handler writes in Task 3. Keep them identical.

---

### Task 3: Per-scene synthesis in the voiceover handler

**Files:**
- Modify: `apps/server/src/phases/voiceover-handler.ts` (whole `run` body)
- Test: `apps/server/test/voiceover-handler.test.ts` (update assertions for the new shape)

- [ ] **Step 1: Update the existing test for the new per-scene shape**

In `apps/server/test/voiceover-handler.test.ts`, replace the FIRST test (`"joins narration lines, writes a narration artifact with the audio path"`, lines 54-87) with the two tests below. Leave the other two tests (no-op, and no-provider) unchanged.

```ts
  it("synthesizes each narrated scene and writes a per-scene timeline artifact", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration);

    const providers = new ProviderRegistry();
    providers.register("tts", new StubTTSProvider()); // 200ms/word silence WAVs

    const handler = new VoiceoverPhaseHandler({ providers });

    const events: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) events.push(e);

    const env = await store.get("s1", "narration");
    const data = env!.data as {
      totalMs: number;
      segments: { sceneId: string; audioFile?: string; startMs: number; durationMs: number }[];
    };
    // Both scenes are narrated → both have audioFile, in order, non-overlapping.
    expect(data.segments.map((s) => s.sceneId)).toEqual(["s1", "s2"]);
    expect(data.segments[0].audioFile).toBe("narration-s1.wav");
    expect(data.segments[1].audioFile).toBe("narration-s2.wav");
    expect(data.segments[0].startMs).toBe(0);
    expect(data.segments[1].startMs).toBe(data.segments[0].durationMs);
    expect(data.totalMs).toBe(data.segments[1].startMs + data.segments[1].durationMs);

    // Per-scene wav files were written into the composition dir.
    const comp = workspaces.paths("s1").composition;
    expect(existsSync(join(comp, "narration-s1.wav"))).toBe(true);
    expect(existsSync(join(comp, "narration-s2.wav"))).toBe(true);

    expect(events.some((e) => e.type === "phase.progress" && /synth/i.test(e.message))).toBe(true);
  });

  it("keeps planned duration for silent scenes interleaved with narrated ones", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");
    const mixed = {
      totalSec: 18,
      scenes: [
        { id: "s1", startSec: 0, durationSec: 6, visual: "logo", narration: "Meet Acme." },
        { id: "s2", startSec: 6, durationSec: 6, visual: "quiet shot" },
        { id: "s3", startSec: 12, durationSec: 6, visual: "demo", narration: "It works." },
      ],
    };
    await seed(store, mixed);

    const providers = new ProviderRegistry();
    providers.register("tts", new StubTTSProvider());
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    const env = await store.get("s1", "narration");
    const data = env!.data as { segments: { sceneId: string; audioFile?: string; durationMs: number }[] };
    expect(data.segments.map((s) => s.audioFile)).toEqual([
      "narration-s1.wav", undefined, "narration-s3.wav",
    ]);
    expect(data.segments[1].durationMs).toBe(6000); // planned 6s kept for the silent scene
    // Only narrated scenes produced wav files.
    const comp = workspaces.paths("s1").composition;
    expect(existsSync(join(comp, "narration-s2.wav"))).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/voiceover-handler.test.ts`
Expected: FAIL — the handler still writes a single `narration.wav` with `{audioPath,durationMs}`, so `segments` is undefined.

- [ ] **Step 3: Rewrite the voiceover handler `run` body**

Replace the body of `run()` in `apps/server/src/phases/voiceover-handler.ts` (the method, keeping the class/imports) with this. Add the imports shown.

```ts
import { join } from "node:path";
import type { LineageRef, PhaseId, Script, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { computeNarrationTimeline } from "./narration-timeline.js";

export interface VoiceoverPhaseHandlerOptions {
  providers: ProviderRegistry;
  /** Optional explicit provider id; defaults to the first registered TTS provider. */
  providerId?: string;
}

export class VoiceoverPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "voiceover";
  constructor(private opts: VoiceoverPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
    if (!scriptEnv) throw new Error("voiceover phase requires a script artifact, none found");

    const scenes = scriptEnv.data.scenes;
    const narrated = scenes.filter(
      (s) => typeof s.narration === "string" && s.narration.trim().length > 0,
    );

    if (narrated.length === 0) {
      yield {
        type: "phase.progress",
        phase: this.phase,
        message: "Script has no narration; skipping TTS.",
      };
      return;
    }

    // Eager get so a missing-provider error surfaces BEFORE we yield progress.
    const provider = this.opts.providers.require("tts", this.opts.providerId);

    const composition = ctx.workspaces.paths(ctx.sessionId).composition;
    const audioDurationMsBySceneId: Record<string, number> = {};

    for (const scene of narrated) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      yield {
        type: "phase.progress",
        phase: this.phase,
        message: `Synthesizing narration for scene ${scene.id} via ${provider.id} provider…`,
      };
      const outputPath = join(composition, `narration-${scene.id}.wav`);
      const result = await provider.synthesize({
        text: scene.narration!.trim(),
        outputPath,
        signal: ctx.signal,
      });
      audioDurationMsBySceneId[scene.id] = result.durationMs;
    }

    const timeline = computeNarrationTimeline(
      scenes.map((s) => ({ id: s.id, durationSec: s.durationSec })),
      audioDurationMsBySceneId,
    );

    const derivedFrom: LineageRef[] = [{ kind: "script", version: scriptEnv.version }];
    await ctx.artifacts.put(ctx.sessionId, "narration", timeline, { derivedFrom });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/voiceover-handler.test.ts`
Expected: PASS (all four — two rewritten + the unchanged no-op and no-provider tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/voiceover-handler.ts apps/server/test/voiceover-handler.test.ts
git commit -m "feat(server): voiceover synthesizes per scene and writes a retimed timeline"
```
End the commit body with the trailer:
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

---

### Task 4: Pure `buildNarrationPromptBlock` helper

**Files:**
- Create: `apps/server/src/phases/narration-prompt.ts`
- Test: `apps/server/test/narration-prompt.test.ts`

This extracts the ms→seconds prompt-building into a pure, precisely-testable function (the compose handler is hard to assert on because the agent prompt is internal). Task 5 wires it into the handler.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/narration-prompt.test.ts
import { describe, it, expect } from "vitest";
import { buildNarrationPromptBlock } from "../src/phases/narration-prompt.js";

describe("buildNarrationPromptBlock", () => {
  it("emits exact seconds and an audio-clip instruction per narrated scene", () => {
    const { block, totalDurationSec } = buildNarrationPromptBlock({
      totalMs: 12000,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 6000 },
        { sceneId: "s2", audioFile: "narration-s2.wav", startMs: 6000, durationMs: 6000 },
      ],
    });
    expect(totalDurationSec).toBe("12.00");
    expect(block).toContain('scene s1: data-start="0.00" data-duration="6.00"');
    expect(block).toContain('scene s2: data-start="6.00" data-duration="6.00"');
    expect(block).toContain('narration-s1.wav');
    expect(block).toContain('data-track-index="0"');
    // mentions the root duration
    expect(block).toContain("12.00");
  });

  it("marks silent scenes and omits an audio clip for them", () => {
    const { block } = buildNarrationPromptBlock({
      totalMs: 9500,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 3500 },
        { sceneId: "s2", startMs: 3500, durationMs: 6000 },
      ],
    });
    expect(block).toContain('scene s2: data-start="3.50" data-duration="6.00" (silent)');
    // the silent scene has no audio filename on its line
    const s2Line = block.split("\n").find((l) => l.includes("scene s2"))!;
    expect(s2Line).not.toContain(".wav");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/narration-prompt.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// apps/server/src/phases/narration-prompt.ts
import type { NarrationData } from "@ultracreator/shared";

/**
 * Turn the (millisecond) narration timeline into a prompt block for the compose
 * agent, converting to seconds. Returns the block plus the root total duration
 * (seconds, 2dp) so the handler can set both the prompt's "Total duration" line
 * and the root data-duration consistently.
 */
export function buildNarrationPromptBlock(data: NarrationData): {
  block: string;
  totalDurationSec: string;
} {
  const totalDurationSec = (data.totalMs / 1000).toFixed(2);
  const lines = data.segments.map((seg) => {
    const startSec = (seg.startMs / 1000).toFixed(2);
    const durSec = (seg.durationMs / 1000).toFixed(2);
    const tail = seg.audioFile
      ? ` narration audio "${seg.audioFile}" (add <audio data-track-index="0" data-start="${startSec}" data-duration="${durSec}">)`
      : " (silent)";
    return `- scene ${seg.sceneId}: data-start="${startSec}" data-duration="${durSec}"${tail}`;
  });
  const block =
    `\n\nNARRATION TIMELINE (authoritative — use these EXACT data-start/data-duration for ` +
    `each scene clip; set the root data-duration to ${totalDurationSec}). Add one audio clip ` +
    `per narrated scene exactly as specified:\n${lines.join("\n")}`;
  return { block, totalDurationSec };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/test/narration-prompt.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/narration-prompt.ts apps/server/test/narration-prompt.test.ts
git commit -m "feat(server): pure buildNarrationPromptBlock (ms→seconds prompt builder)"
```
End the commit body with the trailer:
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

---

### Task 5: Wire the timeline into the compose handler

**Files:**
- Modify: `apps/server/src/phases/pi-compose-handler.ts` (narration block ~lines 136-146; prompt assembly ~lines 163-170)
- Test: `apps/server/test/pi-compose-handler.test.ts` (add one regression case)

The per-scene wav files are already written into the composition dir by voiceover (Task 3), so the handler does NOT copy them again — it just builds the prompt from the timeline and sets the root duration. The existing-no-narration tests must keep passing (fallback path).

- [ ] **Step 1: Add a failing test**

Add this inside `describe("PiComposePhaseHandler", ...)` in `apps/server/test/pi-compose-handler.test.ts`. With the OLD handler code (reading `narrationEnv.data.audioPath`) this throws/crashes on the new artifact shape, so it fails until the handler is updated.

```ts
  it("authors the composition when a per-scene narration timeline is present", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, wm); // brief/design/script + logo asset

    const comp = wm.paths("s1").composition;
    await writeFile(join(comp, "narration-s1.wav"), Buffer.from("RIFF", "ascii"));
    await writeFile(join(comp, "narration-s2.wav"), Buffer.from("RIFF", "ascii"));
    await store.put("s1", "narration", {
      totalMs: 12000,
      segments: [
        { sceneId: "s1", audioFile: "narration-s1.wav", startMs: 0, durationMs: 6000 },
        { sceneId: "s2", audioFile: "narration-s2.wav", startMs: 6000, durationMs: 6000 },
      ],
    });

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
    // The narration artifact was consumed without error; per-scene audio remains in place.
    expect(existsSync(join(comp, "narration-s1.wav"))).toBe(true);
    expect(existsSync(join(comp, "narration-s2.wav"))).toBe(true);
  });
```

Note: relies on `writeFile`, `join`, `existsSync` (all already imported at the top of this test file) and the existing `seed`, `VALID_HTML`, `passRunner` helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/pi-compose-handler.test.ts`
Expected: FAIL — the handler still references `narrationEnv.data.audioPath`/`durationMs` (now undefined under the new shape), so it errors before persisting the composition.

- [ ] **Step 3: Replace the narration block**

In `apps/server/src/phases/pi-compose-handler.ts`, add the import near the other phase imports:

```ts
import { buildNarrationPromptBlock } from "./narration-prompt.js";
```

Replace the narration block (the `let narrationLine = "" ... }` section, ~lines 136-146) with:

```ts
    let narrationBlock = "";
    let narrationTotalSec: string | null = null;
    if (narrationEnv) {
      const built = buildNarrationPromptBlock(narrationEnv.data);
      narrationBlock = built.block;
      narrationTotalSec = built.totalDurationSec;
      // Per-scene wavs were written into the composition dir by the voiceover phase;
      // no copy is needed here.
    }
```

- [ ] **Step 4: Update the prompt assembly**

Replace the prompt assembly (~lines 163-170) with:

```ts
    const totalDurationSec = narrationTotalSec ?? String(scriptEnv.data.totalSec);

    const prompt = [
      `Resolution: ${resolution.width}x${resolution.height} (aspectRatio ${briefEnv.data.constraints.aspectRatio}).`,
      `Total duration: ${totalDurationSec}s.`,
      `Design: ${JSON.stringify(designEnv.data, null, 2)}`,
      `Script scenes (each "visual" is a directive to realize, NOT literal text): ${JSON.stringify(scriptEnv.data.scenes, null, 2)}`,
      `Available asset files (reference by bare filename, next to index.html):\n${assetsBlock}${narrationBlock}`,
      `Author index.html now via write_composition_file.`,
    ].join("\n\n");
```

Note: `basename` is still used by the asset-copy loop earlier in the file, so leave the `node:path` import alone. `copyFile` likewise remains used by the asset-copy loop.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/server/test/pi-compose-handler.test.ts`
Expected: PASS — the new narration-timeline case plus all existing cases (existing tests seed no narration → fallback path, `totalDurationSec = scriptEnv.data.totalSec`).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean, exit 0. This clears the Task 1 downstream errors (voiceover + compose now use the new shape).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/phases/pi-compose-handler.ts apps/server/test/pi-compose-handler.test.ts
git commit -m "feat(server): compose uses the per-scene narration timeline (audio-driven)"
```
End the commit body with the trailer:
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>

---

### Task 6: Full-suite regression + typecheck

**Files:** none (verification only).

- [ ] **Step 1: Run the whole server suite**

Run: `npx vitest run apps/server`
Expected: PASS — all suites green. In particular confirm `apps/server/test/pipeline-e2e.test.ts` still passes (it injects its own faux model / render stub; its script fixture has no narration → compose hits the fallback path, so the change is transparent to it).

- [ ] **Step 2: Run the shared suite**

Run: `npx vitest run packages/shared`
Expected: PASS — including the new `narration-schema.test.ts`.

- [ ] **Step 3: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: No commit** (verification task). If a regression surfaced (e.g. another reader of the old `narration.audioPath`/`durationMs` shape that the file-structure survey missed), fix it under the owning task and re-run. To find stragglers, run: `grep -rn "\.audioPath\|narration.*durationMs\|wordTimings" apps/server/src` and confirm no remaining references to the removed fields.

---

## Notes for the implementer

- **Do not mutate the `script` artifact.** The timeline lives only in the `narration` artifact. Compose falls back to `scriptEnv.data.totalSec` / `scriptEnv.data.scenes` when no narration exists.
- **ms vs seconds:** the artifact and `computeNarrationTimeline` are in milliseconds; convert to seconds only when writing the compose prompt (`.toFixed(2)`).
- **Filename contract:** voiceover writes `narration-<sceneId>.wav`; `computeNarrationTimeline` sets `audioFile` to the same string; compose references it by that bare name. All three must agree.
- **Out of scope (per spec):** captions from word timings (the field is removed), TTS rate/voice control, music. Do not add them.
```
