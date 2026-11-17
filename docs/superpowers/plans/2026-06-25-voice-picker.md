# Voice Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick the Gemini TTS voice (音色) for their video's voiceover, audition any voice inline, and drive the real TTS call with that choice (today every video uses the hardcoded `"Kore"`).

**Architecture:** Add a `voice` field to the shared `ConstraintsSchema`, carry it from the settings dialog through `HomeComposer` → `POST /messages` → `Brief.constraints` → `VoiceoverPhaseHandler` → `GeminiTTSProvider` (which already honors `input.voice`). A new voice catalog in `packages/shared` is the single source of truth for names + tags. Preview audio is pre-generated once by a manual script that uploads one sample clip per voice to the public GCS bucket `YOUR_PUBLIC_BUCKET`; the picker plays those clips directly by URL.

**Tech Stack:** TypeScript, zod (shared schemas), React 19 + Tailwind v4 (apps/web), Fastify + `@google/genai` + `@google-cloud/storage` (apps/server), Vitest (+ jsdom for web), tsx (scripts).

---

## Conventions

- **Run tests from the repo root** (path resolution doubles if run from a package dir):
  `pnpm exec vitest run --workspace ./vitest.suites.ts <filter>`
- **Typecheck** a package: `pnpm -F @ultracreator/<pkg> exec tsc --noEmit` (pkgs: `shared`, `server`, `web`).
- Branch: stay on `claude/charming-varahamihira-a40f68`. Commit per task.
- The 30 voices + tags are the source table in the spec (`docs/superpowers/specs/2026-06-25-voice-picker-design.md`). Tag spellings are copied verbatim (e.g. "Gravely", "Easy-going").

## File structure

New:
- `packages/shared/src/voices.ts` — voice catalog (`ALLOWED_VOICES`, `Voice`, `VoiceSchema`, `DEFAULT_VOICE`, `VOICES` with tags).
- `packages/shared/test/voices.test.ts` — catalog tests.
- `apps/web/src/lib/voice-sample-url.ts` — builds the public sample URL for a voice.
- `apps/web/src/components/voice-picker.tsx` — the radiogroup + audition control.
- `apps/server/scripts/generate-voice-samples.ts` — one-time sample generator/uploader.

Modified:
- `packages/shared/src/constraints.ts` — add `voice`.
- `packages/shared/src/index.ts` — export `./voices.js`.
- `packages/shared/test/schemas.test.ts` — `voice` validation cases.
- `apps/server/src/phases/voiceover-handler.ts` — read brief, pass `voice`.
- `apps/server/test/voiceover-handler.test.ts` — voice pass-through cases.
- `apps/server/package.json` — add `voices:gen` script.
- `apps/web/src/components/composer-settings-dialog.tsx` — render the picker.
- `apps/web/test/components/composer-settings-dialog.test.tsx` — picker tests.
- `apps/web/src/components/home-composer.tsx` — persist + send `voice`.
- `apps/web/test/components/home-composer.test.tsx` — assert `voice` in payload.
- `apps/web/test/components/home-composer-settings.test.tsx` — persist/restore voice.
- `apps/web/.env.local.example` — document `NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL`.

---

## Task 1: Voice catalog (shared)

**Files:**
- Create: `packages/shared/src/voices.ts`
- Create: `packages/shared/test/voices.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/voices.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  VOICES,
  ALLOWED_VOICES,
  VoiceSchema,
  DEFAULT_VOICE,
} from "../src/voices.js";

describe("voice catalog", () => {
  it("lists 30 voices, each with a name and exactly two non-empty tags", () => {
    expect(VOICES).toHaveLength(30);
    for (const v of VOICES) {
      expect(typeof v.name).toBe("string");
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.tags).toHaveLength(2);
      expect(v.tags[0].length).toBeGreaterThan(0);
      expect(v.tags[1].length).toBeGreaterThan(0);
    }
  });

  it("ALLOWED_VOICES matches the catalog names with no duplicates", () => {
    expect(ALLOWED_VOICES).toEqual(VOICES.map((v) => v.name));
    expect(new Set(ALLOWED_VOICES).size).toBe(ALLOWED_VOICES.length);
  });

  it("DEFAULT_VOICE is Kore and is a known voice", () => {
    expect(DEFAULT_VOICE).toBe("Kore");
    expect(ALLOWED_VOICES).toContain(DEFAULT_VOICE);
  });

  it("VoiceSchema accepts a known voice and rejects an unknown one", () => {
    expect(VoiceSchema.parse("Puck")).toBe("Puck");
    expect(() => VoiceSchema.parse("Nope")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts voices.test`
Expected: FAIL — cannot resolve `../src/voices.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/voices.ts`:

```ts
import { z } from "zod";

/**
 * The prebuilt Gemini TTS voices we expose, in display order (alphabetical).
 * Single source of truth for: the schema (validation), the picker UI
 * (labels + tags), and the sample-generation script (which voices to render).
 */
export const ALLOWED_VOICES = [
  "Achernar",
  "Achird",
  "Algenib",
  "Algieba",
  "Alnilam",
  "Aoede",
  "Autonoe",
  "Callirrhoe",
  "Charon",
  "Despina",
  "Enceladus",
  "Erinome",
  "Fenrir",
  "Gacrux",
  "Iapetus",
  "Kore",
  "Laomedeia",
  "Leda",
  "Orus",
  "Puck",
  "Pulcherrima",
  "Rasalgethi",
  "Sadachbia",
  "Sadaltager",
  "Schedar",
  "Sulafat",
  "Umbriel",
  "Vindemiatrix",
  "Zephyr",
  "Zubenelgenubi",
] as const;

export type Voice = (typeof ALLOWED_VOICES)[number];

export const VoiceSchema = z.enum(ALLOWED_VOICES);

export const DEFAULT_VOICE: Voice = "Kore";

/** [descriptor, pitch] tags per voice (spellings copied verbatim from source). */
const VOICE_TAGS: Record<Voice, readonly [string, string]> = {
  Achernar: ["Soft", "Higher pitch"],
  Achird: ["Friendly", "Lower middle pitch"],
  Algenib: ["Gravely", "Lower pitch"],
  Algieba: ["Smooth", "Lower pitch"],
  Alnilam: ["Firm", "Lower middle pitch"],
  Aoede: ["Breezy", "Middle pitch"],
  Autonoe: ["Bright", "Middle pitch"],
  Callirrhoe: ["Easy-going", "Middle pitch"],
  Charon: ["Informative", "Lower pitch"],
  Despina: ["Smooth", "Middle pitch"],
  Enceladus: ["Breathy", "Lower pitch"],
  Erinome: ["Clear", "Middle pitch"],
  Fenrir: ["Excitable", "Lower middle pitch"],
  Gacrux: ["Mature", "Middle pitch"],
  Iapetus: ["Clear", "Lower middle pitch"],
  Kore: ["Firm", "Middle pitch"],
  Laomedeia: ["Upbeat", "Higher pitch"],
  Leda: ["Youthful", "Higher pitch"],
  Orus: ["Firm", "Lower middle pitch"],
  Puck: ["Upbeat", "Middle pitch"],
  Pulcherrima: ["Forward", "Middle pitch"],
  Rasalgethi: ["Informative", "Middle pitch"],
  Sadachbia: ["Lively", "Lower pitch"],
  Sadaltager: ["Knowledgeable", "Middle pitch"],
  Schedar: ["Even", "Lower middle pitch"],
  Sulafat: ["Warm", "Middle pitch"],
  Umbriel: ["Easy-going", "Lower pitch"],
  Vindemiatrix: ["Gentle", "Middle pitch"],
  Zephyr: ["Bright", "Higher pitch"],
  Zubenelgenubi: ["Casual", "Lower middle pitch"],
};

export interface VoiceMeta {
  name: Voice;
  tags: readonly [string, string];
}

export const VOICES: readonly VoiceMeta[] = ALLOWED_VOICES.map((name) => ({
  name,
  tags: VOICE_TAGS[name],
}));
```

Add the barrel export to `packages/shared/src/index.ts` (after the `constraints.js` line):

```ts
export * from "./voices.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts voices.test`
Expected: PASS (4 tests).

Also typecheck shared: `pnpm -F @ultracreator/shared exec tsc --noEmit`
Expected: no errors. (If `z.enum(ALLOWED_VOICES)` complains about a `readonly` tuple on this zod version, change to `z.enum([...ALLOWED_VOICES] as [Voice, ...Voice[]])`. zod 3.24 accepts the `as const` form, so this should not be needed.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/voices.ts packages/shared/src/index.ts packages/shared/test/voices.test.ts
git commit -m "feat(shared): voice catalog (30 Gemini voices, tags, schema)"
```

---

## Task 2: `voice` field on ConstraintsSchema (shared)

**Files:**
- Modify: `packages/shared/src/constraints.ts`
- Modify: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/shared/test/schemas.test.ts`, inside the existing `describe("ConstraintsSchema", ...)` block, add:

```ts
  it("accepts a constraints object with a valid voice", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true, voice: "Puck" };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("accepts a constraints object with no voice (optional)", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("rejects an unknown voice", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true, voice: "Nope" };
    expect(() => ConstraintsSchema.parse(value)).toThrow();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts schemas.test`
Expected: FAIL — the "rejects an unknown voice" case throws-as-expected only after the field exists; before the change, `voice: "Nope"` is stripped/ignored so `parse` succeeds and "rejects an unknown voice" FAILS (no throw), and "accepts ... valid voice" FAILS (parsed result drops `voice`, not equal).

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/constraints.ts`, add the import and the field:

```ts
import { z } from "zod";
import { VoiceSchema } from "./voices.js";
```

Then inside `ConstraintsSchema`, after the `bgm` line:

```ts
  /** Gemini prebuilt voice for the narration. Absent → backend default (Kore). */
  voice: VoiceSchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts schemas.test`
Expected: PASS.

Typecheck: `pnpm -F @ultracreator/shared exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constraints.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add optional voice to ConstraintsSchema"
```

---

## Task 3: Voiceover handler passes the chosen voice (server)

**Files:**
- Modify: `apps/server/src/phases/voiceover-handler.ts`
- Modify: `apps/server/test/voiceover-handler.test.ts`

- [ ] **Step 1: Write the failing test**

In `apps/server/test/voiceover-handler.test.ts`, add a capturing provider near `FlakyTTSProvider` (after its class definition):

```ts
/** Records the `voice` passed to each synthesize call; writes valid silence WAVs. */
class CapturingTTSProvider implements TTSProvider {
  readonly id = "capturing";
  voices: (string | undefined)[] = [];
  private inner = new StubTTSProvider();
  async synthesize(input: TTSInput): Promise<TTSResult> {
    this.voices.push(input.voice);
    return this.inner.synthesize(input);
  }
}
```

Then add two tests inside `describe("VoiceoverPhaseHandler", ...)`:

```ts
  it("passes brief.constraints.voice to every synthesize call", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", {
      ...briefData,
      constraints: { ...briefData.constraints, voice: "Puck" },
    });
    await store.put("s1", "design", designData);
    await store.put("s1", "script", scriptWithNarration, {
      derivedFrom: [{ kind: "design", version: 1 }],
    });

    const capturing = new CapturingTTSProvider();
    const providers = new ProviderRegistry();
    providers.register("tts", capturing);
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    expect(capturing.voices).toEqual(["Puck", "Puck"]); // both narrated scenes
  });

  it("passes undefined voice when the brief omits it (provider falls back to default)", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
    await workspaces.init("s1");
    await seed(store, scriptWithNarration); // briefData has no voice

    const capturing = new CapturingTTSProvider();
    const providers = new ProviderRegistry();
    providers.register("tts", capturing);
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces, artifacts: store, events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    expect(capturing.voices).toEqual([undefined, undefined]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts voiceover-handler.test`
Expected: FAIL — "passes brief.constraints.voice" gets `[undefined, undefined]` (handler never reads the brief / never sets `voice`).

- [ ] **Step 3: Write minimal implementation**

In `apps/server/src/phases/voiceover-handler.ts`:

Add `Brief` to the shared type import (line 2):

```ts
import type { Brief, LineageRef, PhaseId, Script, ServerEvent } from "@ultracreator/shared";
```

After fetching the script artifact (after the `if (!scriptEnv) throw ...` line), read the brief's voice:

```ts
    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    const voice = briefEnv?.data.constraints.voice; // undefined → provider default
```

In the `provider.synthesize({ ... })` call, add `voice`:

```ts
          result = await provider.synthesize({
            text: scene.narration!.trim(),
            outputPath,
            voice,
            signal: ctx.signal,
          });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts voiceover-handler.test`
Expected: PASS (all existing + 2 new).

Typecheck: `pnpm -F @ultracreator/server exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/voiceover-handler.ts apps/server/test/voiceover-handler.test.ts
git commit -m "feat(server): voiceover phase uses brief.constraints.voice"
```

---

## Task 4: Voice picker UI + sample-URL helper (web)

**Files:**
- Create: `apps/web/src/lib/voice-sample-url.ts`
- Create: `apps/web/src/components/voice-picker.tsx`
- Modify: `apps/web/src/components/composer-settings-dialog.tsx`
- Modify: `apps/web/test/components/composer-settings-dialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Replace the `setup()` default props in `apps/web/test/components/composer-settings-dialog.test.tsx` to include the new voice props (add the two lines before `...overrides`):

```ts
    voice: "Kore" as const,
    onVoiceChange: vi.fn(),
```

Add these tests inside `describe("<ComposerSettingsDialog>", ...)`:

```ts
  it("hides the voice picker until voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: false });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(screen.queryByRole("radiogroup", { name: "voice" })).toBeNull();
  });

  it("shows the voice picker with the selected voice checked when voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: true, voice: "Puck" });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const group = await screen.findByRole("radiogroup", { name: "voice" });
    expect(within(group).getByRole("radio", { name: "Puck" })).toBeChecked();
  });

  it("picking a voice reports it", async () => {
    const user = userEvent.setup();
    const props = setup({ voiceover: true });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const group = await screen.findByRole("radiogroup", { name: "voice" });
    await user.click(within(group).getByRole("radio", { name: "Zephyr" }));
    expect(props.onVoiceChange).toHaveBeenCalledWith("Zephyr");
  });

  it("auditioning a voice plays its sample clip", async () => {
    const playSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const user = userEvent.setup();
    const { container } = (() => {
      setup({ voiceover: true });
      return { container: document.body };
    })();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    await user.click(await screen.findByRole("button", { name: "preview Puck" }));
    expect(playSpy).toHaveBeenCalled();
    const audio = container.querySelector("audio");
    expect(audio?.src).toContain("/Puck.wav");
  });
```

(Keep the existing `screen`/`within` import; `within` is already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts composer-settings-dialog.test`
Expected: FAIL — no `radiogroup` named "voice"; TS error on unknown props `voice`/`onVoiceChange`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/lib/voice-sample-url.ts`:

```ts
/**
 * Public URL of a voice's pre-generated audition clip. The clips live in the
 * public GCS bucket `YOUR_PUBLIC_BUCKET` under `voices/<Name>.wav`; override
 * the base with NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL (e.g. to point at a CDN).
 */
const BASE =
  process.env.NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL ??
  "https://storage.googleapis.com/YOUR_PUBLIC_BUCKET/voices";

export function voiceSampleUrl(name: string): string {
  return `${BASE}/${name}.wav`;
}
```

Create `apps/web/src/components/voice-picker.tsx`:

```tsx
"use client";
import { useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { VOICES, type Voice } from "@ultracreator/shared";
import { voiceSampleUrl } from "@/lib/voice-sample-url";
import { cn } from "@/lib/utils";

interface Props {
  voice: Voice;
  onVoiceChange: (v: Voice) => void;
}

export function VoicePicker({ voice, onVoiceChange }: Props): React.ReactElement {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<Voice | null>(null);

  function stop(): void {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    setPlaying(null);
  }

  function preview(name: Voice): void {
    const a = audioRef.current;
    if (!a) return;
    if (playing === name) {
      stop();
      return;
    }
    a.pause();
    a.src = voiceSampleUrl(name);
    setPlaying(name);
    // Media errors (offline, missing object) just reset the button — no toast.
    void a.play().catch(() => setPlaying(null));
  }

  return (
    <div
      role="radiogroup"
      aria-label="voice"
      className="max-h-56 space-y-1 overflow-y-auto rounded-xl bg-muted/60 p-1.5"
    >
      {/* Single shared element, kept out of the a11y tree. */}
      <audio ref={audioRef} aria-hidden className="hidden" onEnded={() => setPlaying(null)} />
      {VOICES.map((v) => {
        const selected = v.name === voice;
        const isPlaying = playing === v.name;
        return (
          <div
            key={v.name}
            className={cn(
              "flex items-center gap-2 rounded-lg px-2.5 py-2 transition-colors",
              selected ? "bg-card shadow-raised" : "hover:bg-card/60",
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={v.name}
              onClick={() => onVoiceChange(v.name)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded-md"
            >
              <span className="text-sm font-medium text-foreground">{v.name}</span>
              <span aria-hidden className="flex flex-wrap gap-1">
                {v.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </span>
            </button>
            <button
              type="button"
              aria-label={`preview ${v.name}`}
              onClick={() => preview(v.name)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isPlaying ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
```

Wire it into `apps/web/src/components/composer-settings-dialog.tsx`:

1. Import the catalog type and the picker (top of file, with the other imports):

```tsx
import { VoicePicker } from "@/components/voice-picker";
import {
  ALLOWED_DURATIONS,
  ALLOWED_ASPECT_RATIOS,
  type AspectRatio,
  type Duration,
  type Voice,
} from "@ultracreator/shared";
```

(Replace the existing `@ultracreator/shared` import block so it also imports `Voice`.)

2. Add to the `Props` interface (after `onBgmChange`):

```tsx
  voice: Voice;
  onVoiceChange: (v: Voice) => void;
```

3. Add `voice` and `onVoiceChange` to the destructured params of `ComposerSettingsDialog`.

4. In the `Audio` `Section`, render the picker right after the Voiceover `AudioRow` (before its following `<RowDivider />`), revealed only when voiceover is on:

```tsx
              <AudioRow icon={Mic2} label="Voiceover" helper="AI narration spoken over your video">
                <Switch checked={voiceover} onCheckedChange={onVoiceoverChange} aria-label="voiceover" />
              </AudioRow>
              {voiceover && (
                <div className="pb-3 pl-13">
                  <VoicePicker voice={voice} onVoiceChange={onVoiceChange} />
                </div>
              )}
              <RowDivider />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts composer-settings-dialog.test`
Expected: PASS (existing 4 + new 4).

Typecheck: `pnpm -F @ultracreator/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/voice-sample-url.ts apps/web/src/components/voice-picker.tsx apps/web/src/components/composer-settings-dialog.tsx apps/web/test/components/composer-settings-dialog.test.tsx
git commit -m "feat(web): voice picker with audition in the settings dialog"
```

---

## Task 5: Persist + send the voice (home-composer)

**Files:**
- Modify: `apps/web/src/components/home-composer.tsx`
- Modify: `apps/web/test/components/home-composer.test.tsx`
- Modify: `apps/web/test/components/home-composer-settings.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/components/home-composer.test.tsx`, extend the first test's payload assertion (after the `expect(body.constraints).toMatchObject(...)` line):

```ts
    expect(body.constraints.voice).toBe("Kore"); // default voice rides along
```

In `apps/web/test/components/home-composer-settings.test.tsx`, add a test:

```ts
  it("persists and restores the chosen voice", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    // Reveal the picker, then pick a voice.
    await user.click(await screen.findByRole("switch", { name: /voiceover/i }));
    const group = await screen.findByRole("radiogroup", { name: "voice" });
    await user.click(within(group).getByRole("radio", { name: "Zephyr" }));
    expect(localStorage.getItem("uc.voice")).toBe(JSON.stringify("Zephyr"));
  });
```

Add `within` to the testing-library import in that file:

```ts
import { screen, within } from "@testing-library/react";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts home-composer`
Expected: FAIL — `body.constraints.voice` is `undefined`; no `radiogroup` "voice" rendered (HomeComposer doesn't pass voice props yet).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/components/home-composer.tsx`:

1. Extend the shared import (line 7) to include the voice exports:

```tsx
import {
  type AspectRatio,
  type Duration,
  type AssetRef,
  type Voice,
  ALLOWED_VOICES,
  DEFAULT_VOICE,
} from "@ultracreator/shared";
```

2. Add a voice guard + persistent state near the other `usePersistentState` calls (after the `bgm` line):

```tsx
  const isVoice = (v: unknown): v is Voice =>
    typeof v === "string" && (ALLOWED_VOICES as readonly string[]).includes(v);
  const [voice, setVoice] = usePersistentState<Voice>("uc.voice", DEFAULT_VOICE, isVoice);
```

3. Add `voice` to the posted constraints in `handleGenerate` (after `bgm,`):

```tsx
          voice,
```

4. Pass the props to `<ComposerSettingsDialog>` (after `onBgmChange={setBgm}`):

```tsx
          voice={voice}
          onVoiceChange={setVoice}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts home-composer`
Expected: PASS.

Typecheck: `pnpm -F @ultracreator/web exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/home-composer.tsx apps/web/test/components/home-composer.test.tsx apps/web/test/components/home-composer-settings.test.tsx
git commit -m "feat(web): persist voice choice and send it with the first message"
```

---

## Task 6: Sample-generation script + env doc (server)

No unit test — the script needs a real `GEMINI_API_KEY` and GCP write creds, so it is run manually and excluded from CI (it lives under `scripts/`, which the vitest workspace does not include).

**Files:**
- Create: `apps/server/scripts/generate-voice-samples.ts`
- Modify: `apps/server/package.json`
- Modify: `apps/web/.env.local.example`

- [ ] **Step 1: Create the script**

Create `apps/server/scripts/generate-voice-samples.ts`:

```ts
/**
 * One-time, manually-run generator for the voice audition clips used by the
 * settings-dialog voice picker. For each catalog voice it synthesizes one
 * shared sample line via Gemini TTS, then uploads it to the PUBLIC bucket
 * `YOUR_PUBLIC_BUCKET` at `voices/<Name>.wav`. Re-run when the voice list
 * changes (it overwrites existing objects).
 *
 * Env:
 *   GEMINI_API_KEY                 required — Gemini TTS
 *   GOOGLE_APPLICATION_CREDENTIALS required — SA with write to the bucket
 *   VOICE_SAMPLE_BUCKET            optional — defaults to YOUR_PUBLIC_BUCKET
 *
 * Run: pnpm -F @ultracreator/server voices:gen
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VOICES } from "@ultracreator/shared";
import { GeminiTTSProvider } from "../src/providers/gemini-tts.js";
import { GcsStorageGateway } from "../src/storage/gcs-storage-gateway.js";

const SAMPLE_LINE =
  "Bright mornings, better coffee. Discover what your product can be.";
const BUCKET = process.env.VOICE_SAMPLE_BUCKET ?? "YOUR_PUBLIC_BUCKET";
const PREFIX = "voices";

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");

  const tts = new GeminiTTSProvider({ apiKey });
  const storage = new GcsStorageGateway({ bucketName: BUCKET });
  const tmp = mkdtempSync(join(tmpdir(), "uc-voice-samples-"));

  for (const v of VOICES) {
    const outputPath = join(tmp, `${v.name}.wav`);
    process.stdout.write(`synth ${v.name}… `);
    await tts.synthesize({ text: SAMPLE_LINE, voice: v.name, outputPath });
    const key = `${PREFIX}/${v.name}.wav`;
    const { size } = await storage.upload(outputPath, key);
    console.log(`uploaded ${key} (${size} bytes)`);
  }

  console.log(`Done: ${VOICES.length} voices → gs://${BUCKET}/${PREFIX}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package script**

In `apps/server/package.json`, add to `"scripts"` (after `"start"`):

```json
    "voices:gen": "tsx scripts/generate-voice-samples.ts",
```

- [ ] **Step 3: Document the web env var**

Append to `apps/web/.env.local.example`:

```
# Optional: base URL for the voice-picker audition clips. Defaults to the public
# bucket below. Point at a CDN domain if you front the bucket with one.
# NEXT_PUBLIC_VOICE_SAMPLE_BASE_URL=https://storage.googleapis.com/YOUR_PUBLIC_BUCKET/voices
```

- [ ] **Step 4: Sanity-check it loads (no network)**

Run: `pnpm -F @ultracreator/server exec tsx -e "import('./scripts/generate-voice-samples.ts').catch(e=>{console.log('threw:', e.message); process.exit(0)})"`
Expected: it imports and immediately throws `GEMINI_API_KEY is required` (proves the module + its imports resolve). It must NOT throw a module-resolution / syntax error.

(Running the real generation — `pnpm -F @ultracreator/server voices:gen` with the two env vars set — is a manual step performed once by the operator; not part of CI.)

- [ ] **Step 5: Commit**

```bash
git add apps/server/scripts/generate-voice-samples.ts apps/server/package.json apps/web/.env.local.example
git commit -m "feat(server): script to generate + upload voice audition samples"
```

---

## Task 7: Full verification + visual check

**Files:** none (verification only).

- [ ] **Step 1: Run the whole unit suite**

Run: `pnpm exec vitest run --workspace ./vitest.suites.ts`
Expected: all PASS (web + server + shared), no new failures.

- [ ] **Step 2: Typecheck every touched package**

Run:
```bash
pnpm -F @ultracreator/shared exec tsc --noEmit
pnpm -F @ultracreator/server exec tsc --noEmit
pnpm -F @ultracreator/web exec tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Lint the web changes (if a lint script exists)**

Run: `pnpm -F @ultracreator/web lint` (skip if the package has no `lint` script).
Expected: clean (no em-dashes in user-visible strings; no new warnings).

- [ ] **Step 4: Visual check the picker in the browser**

Start the dev server (preview_start, port 3117 per `.claude/launch.json`), open the logged-in home, open the settings dialog, toggle Voiceover on, and confirm the voice list renders with tag chips + ▶ buttons and that the selected row is highlighted. Take a `preview_screenshot`.

Note: audition playback will only produce sound after the manual `voices:gen` run has populated the bucket; absent that, the ▶ button is still present and simply no-ops on a missing clip (by design). The picker layout/selection is fully verifiable without audio.

- [ ] **Step 5: Final commit (only if Step 4 required a tweak)**

```bash
git add -A
git commit -m "fix(web): voice picker visual polish"
```

---

## Self-review notes (already reconciled against the spec)

- Spec §1 catalog → Task 1. §2 constraints.voice → Task 2. §3 backend → Task 3.
  §4 script + bucket upload → Task 6. §5 preview URL → Task 4 (`voice-sample-url`).
  §6 state wiring → Task 5. §7 dialog UI → Task 4. Testing matrix → Tasks 1–5 + 7.
- Type consistency: `Voice`, `VoiceSchema`, `ALLOWED_VOICES`, `DEFAULT_VOICE`,
  `VOICES`/`VoiceMeta`, `voiceSampleUrl`, `VoicePicker` are defined once and used
  with the same names/signatures throughout.
- No placeholders: every code step is complete.
- Out of scope (spec non-goals): inline `Composer`, per-scene voices,
  on-demand preview endpoint. Not touched.
```

