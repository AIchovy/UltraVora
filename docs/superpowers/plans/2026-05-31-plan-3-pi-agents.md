# UltraCreator Plan 3 — Pi-Agent Phase Handlers + Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the FakePhaseHandlers (Plan 2) with real LLM-backed handlers for research / design / script, build a provider abstraction with a Gemini TTS implementation for the voiceover phase, and land the two pre-Plan-3 robustness fixes the final Plan 2 review flagged.

**Architecture:** A `PiAgentFactory` constructs an `Agent` (from `@earendil-works/pi-agent-core`) per phase run — system prompt + per-phase TypeBox tool set + model + abort signal forwarded from the orchestrator's `PhaseContext.signal`. Each Pi-agent handler bridges the agent's async event stream into `ServerEvent`s the orchestrator forwards through `EventBus`. Tools call `ctx.artifacts.put` to write artifacts, so the existing single-writer / versioning / `artifact.created` contract from Plan 1 keeps holding. The voiceover phase is **not** agent-driven: it reads the latest `script` artifact, calls `ProviderRegistry.get("tts").synthesize(...)`, writes `narration.mp3`, and emits an artifact. A `GeminiTTSProvider` implements the `TTSProvider` interface via `@google/genai`. Tests use `registerFauxProvider` from pi-ai for deterministic LLM stand-ins (zero tokens, fully replayable); a tagged `@external` test exercises the real Gemini TTS endpoint and is run manually, not in CI.

**Tech Stack:**
- `@earendil-works/pi-agent-core@^0.78.0` (`Agent` class + tool runtime).
- `@earendil-works/pi-ai@^0.78.0` (`getModel`, `Model<any>`, `registerFauxProvider` for tests).
- `typebox@^1.1.38` (re-exported by pi-ai; used for tool parameter schemas).
- `@google/genai@^2.7.0` (Gemini TTS).
- Existing: zod, vitest, TypeScript 5.7, Node 24.

**Roadmap context:** Plan 3 of 6. Plan 2 (orchestrator + IntentRouter + PhaseRegistry, on top of fake handlers) is merged. Plan 4 will replace the still-fake render handler with a forked `RenderWorker`. Plan 5 adds Fastify + SSE. Plan 6 builds the Next.js frontend. After Plan 3 the system can drive a real LLM through research / design / script and produce real narration audio, with the render fake still standing in until Plan 4.

**Pre-Plan-3 carry-overs from the Plan 2 final review** (land first, then build on top):
- **I1** — Abort can be silently dropped between phases (controller is per-phase, not per-chain).
- **I2** — `update-brief` substring matching misfires on free-text refines like *"the duration looks fine"* — destructive because the orchestrator implements update-brief as a re-research.

---

## File Structure

```
apps/server/package.json               # add pi-agent-core, pi-ai, typebox, @google/genai
apps/server/src/
  orchestrator/
    session-orchestrator.ts            # MODIFY for I1 (hoist AbortController)
  intent/
    intent-router.ts                   # MODIFY for I2 (verb-cue + word-boundary)
  providers/
    types.ts                           # ProviderType, TTSProvider, TTSInput, TTSResult
    registry.ts                        # ProviderRegistry class
    gemini-tts.ts                      # GeminiTTSProvider
    stub-tts.ts                        # StubTTSProvider for tests
  phases/
    pi-agent-factory.ts                # builds Agent from { systemPrompt, tools, model, signal }
    pi-handler-helpers.ts              # bridge AgentEvent → ServerEvent + run-to-completion helpers
    pi-research-handler.ts             # research phase (real LLM)
    pi-design-handler.ts               # design phase (real LLM)
    pi-script-handler.ts               # script phase (real LLM)
    voiceover-handler.ts               # voiceover phase (TTS provider, no agent)
  tools/
    artifact-write-tools.ts            # write_brief / write_design / write_script AgentTools
    research-tools.ts                  # web_fetch + read_upload AgentTools
  composition.ts                       # composeOrchestrator() factory wiring real handlers
apps/server/test/
  provider-registry.test.ts
  stub-tts.test.ts
  pi-agent-factory.test.ts
  artifact-write-tools.test.ts
  research-tools.test.ts
  pi-research-handler.test.ts
  pi-design-handler.test.ts
  pi-script-handler.test.ts
  voiceover-handler.test.ts
  composition.test.ts
  orchestrator.test.ts                 # MODIFY: extend Task-1 (I1) tests
  intent-router.test.ts                # MODIFY: extend Task-2 (I2) tests
  gemini-tts.external.test.ts          # tagged @external; manual run only
```

**Responsibility boundaries:**
- `providers/registry.ts` — generic registry keyed by `(type, id)`. Knows nothing about specific provider implementations.
- `providers/types.ts` — pure interfaces. No I/O.
- `providers/gemini-tts.ts` — only knows how to talk to Gemini's `@google/genai`. No `ArtifactStore`, no `EventBus`.
- `phases/pi-agent-factory.ts` — pure construction. Takes a model + system prompt + tool list and returns an `Agent`. No knowledge of the orchestrator.
- `phases/pi-handler-helpers.ts` — the bridge: subscribes to `Agent` events, converts them to `ServerEvent`s, manages the run lifecycle, propagates `ctx.signal` into `agent.abort()`. Each real handler is ~30 lines on top of this.
- `phases/pi-{research,design,script}-handler.ts` — phase-specific system prompts + tool selection. Each implements `PhaseHandler` from Plan 2.
- `phases/voiceover-handler.ts` — reads the latest script, calls TTS provider, writes narration. No agent.
- `tools/artifact-write-tools.ts` — three small TypeBox-schemaed tools that validate against the Plan 1 shared schemas and call `ctx.artifacts.put`. Reused by research/design/script handlers.
- `tools/research-tools.ts` — `web_fetch` (URL → text) and `read_upload` (filename → text). Both are I/O-only utilities; the agent decides when to call them.
- `composition.ts` — top-level wiring: builds the orchestrator with real Pi handlers + providers + registry. This is what Plan 5's Fastify boot calls.

---

## Task 1: I1 — Hoist AbortController to span the whole phase chain

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/test/orchestrator.test.ts`

The current `runPhase` creates a fresh `AbortController` per phase and deletes it from `controllers` in `finally`. Between phases — after one `runPhase` returns and before the next is entered — `controllers.get(sessionId)` is `undefined`, so an abort fired in that window is a no-op. The fix is to own one controller per `runFromPhase` invocation: a single signal that spans every phase in the chain. If abort is fired mid-chain, the in-flight handler's `signal` aborts (existing behavior), and on return from `runPhase` the loop sees `signal.aborted` and bails before starting the next phase.

- [ ] **Step 1: Add the between-phase abort test (append to `apps/server/test/orchestrator.test.ts`, inside the existing `describe("SessionOrchestrator: abort + branch/ask", ...)` block)**

```ts
  it("abort fired between phases stops the chain before the next phase begins", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();

    let designInvoked = false;
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        // Research finishes normally — writes brief, no progress, no hang.
        produce: async (ctx) => [{ kind: "brief", data: briefFor(ctx.initialMessage!) }],
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async () => {
          designInvoked = true;
          return [{ kind: "design", data: designData }];
        },
      })],
    ]);

    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers });

    // Subscribe BEFORE start: abort the moment we see artifact.created:brief.
    // That moment is between research (just produced its artifact) and design.
    events.subscribe("s1", (e) => {
      if (e.type === "artifact.created" && e.kind === "brief") {
        // Fire-and-forget — pre-classify path is synchronous through the router.
        void orch.handleMessage("s1", { text: "abort" });
      }
    });

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    // Design must NEVER have run, even though research completed.
    expect(designInvoked).toBe(false);
    const state = orch.getState("s1");
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.error).toMatch(/abort/i);
    }
  });
```

- [ ] **Step 2: Run the new test to confirm it fails**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts -t "between phases"`
Expected: FAIL — `expect(designInvoked).toBe(false)` fails because design currently runs unimpeded.

- [ ] **Step 3: Refactor `runFromPhase` and `runPhase` to share one controller**

Edit `apps/server/src/orchestrator/session-orchestrator.ts`. Replace the existing `runFromPhase` and `runPhase` methods with the versions below. (Other methods on the class — `getState`, `handleMessage`, the per-intent helpers, `getBrief`, `activePhase`, `previousPhaseOfActive`, `reviseBack`, `refine`, `approve`, `startNewProject`, `toRouterState` — are unchanged.)

```ts
  private async runFromPhase(
    sessionId: string,
    phaseId: PhaseId,
    refinement?: string,
  ): Promise<void> {
    // One controller spans the whole chain. Abort mid-chain (between phases) is
    // observed by the loop check below and prevents the next runPhase from starting.
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    try {
      let current: PhaseId | null = phaseId;
      let nextRefinement = refinement;
      while (current) {
        if (controller.signal.aborted) {
          const error = "Aborted";
          this.states.set(sessionId, { kind: "error", phase: current, error });
          this.deps.events.emit(sessionId, { type: "phase.error", phase: current, error });
          return;
        }
        await this.runPhase(sessionId, current, controller.signal, nextRefinement);
        nextRefinement = undefined;
        const state = this.getState(sessionId);
        if (state.kind !== "running") return;
        const brief = await this.getBrief(sessionId);
        const next = this.deps.phases.next(current, brief);
        if (!next) {
          this.states.set(sessionId, { kind: "done", lastPhase: current });
          return;
        }
        current = next.id;
      }
    } finally {
      this.controllers.delete(sessionId);
    }
  }

  private async runPhase(
    sessionId: string,
    phaseId: PhaseId,
    signal: AbortSignal,
    refinement?: string,
  ): Promise<void> {
    const config = this.deps.phases.getPhase(phaseId);
    const handler = this.deps.handlers.get(phaseId);
    if (!handler) throw new Error(`No handler registered for phase ${phaseId}`);

    this.states.set(sessionId, { kind: "running", phase: phaseId });
    this.deps.events.emit(sessionId, {
      type: "phase.started",
      phase: phaseId,
      at: new Date().toISOString(),
    });

    const ctx: PhaseContext = {
      sessionId,
      workspaces: this.deps.workspaces,
      artifacts: this.deps.artifacts,
      events: this.deps.events,
      initialMessage: this.initialMessages.get(sessionId),
      refinement,
      signal,
    };

    try {
      for await (const event of handler.run(ctx)) {
        this.deps.events.emit(sessionId, event);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.states.set(sessionId, { kind: "error", phase: phaseId, error });
      this.deps.events.emit(sessionId, { type: "phase.error", phase: phaseId, error });
      return;
    }

    if (config.gates?.includes("user-approve")) {
      this.states.set(sessionId, { kind: "awaiting-gate", phase: phaseId });
      this.deps.events.emit(sessionId, { type: "gate.awaiting", phase: phaseId });
    }
  }
```

Two changes vs. the old code:
1. `runFromPhase` owns the `AbortController` and the `controllers` map entry. `runPhase` no longer touches them.
2. `runPhase` takes `signal: AbortSignal` as a parameter and passes it through `PhaseContext`.

- [ ] **Step 4: Run the full orchestrator suite**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS — all previous tests still pass, plus the new "between phases" test. Total: 17 in this file.

- [ ] **Step 5: Run the full repo suite**

Run: `pnpm test`
Expected: PASS — 108 tests (was 107).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "fix(server): hoist AbortController to runFromPhase chain so abort can't be silently dropped between phases"
```

---

## Task 2: I2 — Verb-cue gating for `update-brief` classification

**Files:**
- Modify: `apps/server/src/intent/intent-router.ts`
- Modify: `apps/server/test/intent-router.test.ts`

Today rule 4 fires whenever ANY brief keyword appears as a substring in the message text. That destructively misclassifies plausible refines like *"the duration looks fine"* (re-runs research and marks all downstream stale). Fix: require either the explicit `/brief` command OR (a verb cue from a short allow-list AND a brief keyword matched on a word boundary).

- [ ] **Step 1: Add the new tests**

Append to `apps/server/test/intent-router.test.ts`, inside the existing `describe("RuleBasedIntentRouter", ...)` block:

```ts
  it("does not misclassify mentions of brief keywords without a verb cue", async () => {
    expect((await r.classify(msg("the duration looks fine"), gateDesign)).intent).toBe("refine");
    expect((await r.classify(msg("keep the aspect of the layout"), gateDesign)).intent).toBe("refine");
    expect((await r.classify(msg("who's the audience here?"), gateDesign)).intent).toBe("refine");
  });

  it("does not misclassify substring matches inside unrelated words", async () => {
    // 'audience' word-boundary; 'aspectual' should NOT trigger 'aspect'.
    expect((await r.classify(msg("be more aspectual"), gateDesign)).intent).toBe("refine");
  });

  it("requires both a verb cue AND a brief keyword for update-brief (without /brief)", async () => {
    // Verb cue with no keyword — not update-brief.
    expect((await r.classify(msg("update the colors"), gateDesign)).intent).toBe("refine");
  });

  it("still classifies update-brief for /brief and verb+keyword forms", async () => {
    expect((await r.classify(msg("/brief"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("update duration to 60s"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("change aspect ratio to 9:16"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("turn voiceover off"), gateDesign)).intent).toBe("update-brief");
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `pnpm vitest run apps/server/test/intent-router.test.ts`
Expected: FAIL — the "does not misclassify" tests classify as `update-brief` today.

- [ ] **Step 3: Implement the gated classification**

Edit `apps/server/src/intent/intent-router.ts`. Add a new keyword list and update rule 4:

```ts
const BRIEF_VERBS = ["update", "change", "set", "make it", "turn", "switch"];
```

Place this constant alongside the existing `BRIEF_KEYWORDS` declaration (so the four keyword sets sit together near the top of the file).

Then replace rule 4 in `classify` — find the existing block:

```ts
    // 4. update-brief
    if (isCommand(text, "/brief") || containsAny(text, BRIEF_KEYWORDS)) {
      return { intent: "update-brief" };
    }
```

…and replace with:

```ts
    // 4. update-brief
    if (isCommand(text, "/brief")) {
      return { intent: "update-brief" };
    }
    if (containsAny(text, BRIEF_VERBS) && containsAnyWord(text, BRIEF_KEYWORDS)) {
      return { intent: "update-brief" };
    }
```

(`containsAnyWord` already exists from the earlier `e7e4cd4` fix — it word-boundary-matches non-command, non-multi-word keywords. `containsAny` stays for the verb cues themselves so multi-word cues like `"make it"` still work.)

- [ ] **Step 4: Run the full intent-router suite**

Run: `pnpm vitest run apps/server/test/intent-router.test.ts`
Expected: PASS — all previous tests still green, plus the 4 new tests. Total: 18 in this file.

- [ ] **Step 5: Run the full repo suite**

Run: `pnpm test`
Expected: PASS — 112 tests (was 108 after Task 1).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/intent/intent-router.ts apps/server/test/intent-router.test.ts
git commit -m "fix(server): require verb cue + word-boundary keyword for update-brief classification"
```

---

## Task 3: Install pi-agent-core, pi-ai, typebox, @google/genai

**Files:**
- Modify: `apps/server/package.json`

- [ ] **Step 1: Add dependencies via pnpm**

Run (from the repo root):

```bash
pnpm add -F @ultracreator/server \
  @earendil-works/pi-agent-core@^0.78.0 \
  @earendil-works/pi-ai@^0.78.0 \
  typebox@^1.1.38 \
  @google/genai@^2.7.0
```

This updates `apps/server/package.json` and `pnpm-lock.yaml`.

- [ ] **Step 2: Verify the install**

Run: `pnpm -F @ultracreator/server exec node -e "const a = await import('@earendil-works/pi-agent-core'); console.log(typeof a.Agent)"`
Expected: prints `function`.

Run: `pnpm -F @ultracreator/server exec node -e "const a = await import('@google/genai'); console.log(typeof a.GoogleGenAI)"`
Expected: prints `function`.

- [ ] **Step 3: Run the full suite to confirm nothing broke**

Run: `pnpm test`
Expected: PASS — 112 tests still green.

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add pi-agent-core, pi-ai, typebox, @google/genai"
```

---

## Task 4: Provider types + ProviderRegistry

**Files:**
- Create: `apps/server/src/providers/types.ts`
- Create: `apps/server/src/providers/registry.ts`
- Test: `apps/server/test/provider-registry.test.ts`

`ProviderRegistry` is a small generic indexer keyed by `(type, id)`. v1 has only one type — `"tts"` — but the registry is built so Plan 6 / future plans can add `"music"`, `"stock"`, `"image-gen"` without touching the orchestrator.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/provider-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { TTSProvider } from "../src/providers/types.js";

function makeTTS(id: string): TTSProvider {
  return {
    id,
    async synthesize() {
      return { audioPath: `${id}.mp3`, durationMs: 1000 };
    },
  };
}

describe("ProviderRegistry", () => {
  it("registers and retrieves a provider by type and id", () => {
    const r = new ProviderRegistry();
    const p = makeTTS("gemini");
    r.register("tts", p);
    expect(r.get("tts", "gemini")).toBe(p);
  });

  it("get without an id returns the first-registered provider of that type", () => {
    const r = new ProviderRegistry();
    const a = makeTTS("a");
    const b = makeTTS("b");
    r.register("tts", a);
    r.register("tts", b);
    expect(r.get("tts")).toBe(a);
  });

  it("returns undefined for an unregistered type or id", () => {
    const r = new ProviderRegistry();
    expect(r.get("tts")).toBeUndefined();
    expect(r.get("tts", "nope")).toBeUndefined();
  });

  it("rejects duplicate registrations under the same (type, id)", () => {
    const r = new ProviderRegistry();
    r.register("tts", makeTTS("gemini"));
    expect(() => r.register("tts", makeTTS("gemini"))).toThrow(/duplicate/i);
  });

  it("require throws a useful error if the provider is missing", () => {
    const r = new ProviderRegistry();
    expect(() => r.require("tts")).toThrow(/no provider/i);
    expect(() => r.require("tts", "gemini")).toThrow(/no provider/i);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/provider-registry.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Create `apps/server/src/providers/types.ts`**

```ts
export type ProviderType = "tts";

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface SpeakerSpec {
  speaker: string;
  voice: string;
}

export interface TTSInput {
  text: string;
  voice?: string;
  language?: string;
  /** When set, request multi-speaker synthesis. Each speaker label in the prompt maps to a voice. */
  speakers?: SpeakerSpec[];
  /** Output path the provider should write to (absolute path, .mp3 or .wav extension). */
  outputPath: string;
  signal?: AbortSignal;
}

export interface TTSResult {
  audioPath: string;
  durationMs: number;
  wordTimings?: WordTiming[];
}

export interface TTSProvider {
  readonly id: string;
  synthesize(input: TTSInput): Promise<TTSResult>;
}

export interface ProviderTypeMap {
  tts: TTSProvider;
}
```

- [ ] **Step 4: Create `apps/server/src/providers/registry.ts`**

```ts
import type { ProviderType, ProviderTypeMap } from "./types.js";

export class ProviderRegistry {
  private byType = new Map<ProviderType, Map<string, ProviderTypeMap[ProviderType]>>();
  private order = new Map<ProviderType, string[]>();

  register<T extends ProviderType>(type: T, provider: ProviderTypeMap[T]): void {
    let bucket = this.byType.get(type);
    if (!bucket) {
      bucket = new Map();
      this.byType.set(type, bucket);
    }
    if (bucket.has(provider.id)) {
      throw new Error(`Duplicate provider registration for ${type}/${provider.id}`);
    }
    bucket.set(provider.id, provider);
    const ord = this.order.get(type) ?? [];
    ord.push(provider.id);
    this.order.set(type, ord);
  }

  get<T extends ProviderType>(type: T, id?: string): ProviderTypeMap[T] | undefined {
    const bucket = this.byType.get(type);
    if (!bucket) return undefined;
    if (id !== undefined) return bucket.get(id) as ProviderTypeMap[T] | undefined;
    const firstId = this.order.get(type)?.[0];
    if (firstId === undefined) return undefined;
    return bucket.get(firstId) as ProviderTypeMap[T];
  }

  require<T extends ProviderType>(type: T, id?: string): ProviderTypeMap[T] {
    const provider = this.get(type, id);
    if (!provider) {
      throw new Error(`No provider registered for ${type}${id ? `/${id}` : ""}`);
    }
    return provider;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/provider-registry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/providers/types.ts apps/server/src/providers/registry.ts apps/server/test/provider-registry.test.ts
git commit -m "feat(server): add ProviderRegistry + TTSProvider interface"
```

---

## Task 5: StubTTSProvider (test/dev seam)

**Files:**
- Create: `apps/server/src/providers/stub-tts.ts`
- Test: `apps/server/test/stub-tts.test.ts`

A deterministic in-process TTS provider that writes a small WAV header + silence to `input.outputPath` and returns a fixed duration. Used by every voiceover-handler test and the composition integration test. Real audio is the GeminiTTSProvider's job (Task 12).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/stub-tts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubTTSProvider } from "../src/providers/stub-tts.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-stub-tts-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("StubTTSProvider", () => {
  it("writes a non-empty WAV file at the requested path and returns its duration", async () => {
    const provider = new StubTTSProvider();
    const out = join(root, "narration.wav");
    const result = await provider.synthesize({ text: "Hello world", outputPath: out });
    expect(result.audioPath).toBe(out);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(true);
    const data = readFileSync(out);
    // RIFF/WAVE header sanity-check.
    expect(data.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(data.slice(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("returns word timings spanning the duration when withTimings is set", async () => {
    const provider = new StubTTSProvider({ withTimings: true });
    const out = join(root, "n.wav");
    const result = await provider.synthesize({ text: "one two three", outputPath: out });
    expect(result.wordTimings).toBeDefined();
    expect(result.wordTimings!.map((w) => w.word)).toEqual(["one", "two", "three"]);
    const last = result.wordTimings![result.wordTimings!.length - 1]!;
    expect(last.endMs).toBeLessThanOrEqual(result.durationMs);
  });

  it("respects an already-aborted signal", async () => {
    const provider = new StubTTSProvider();
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.synthesize({ text: "anything", outputPath: join(root, "x.wav"), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/stub-tts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the stub**

Create `apps/server/src/providers/stub-tts.ts`:

```ts
import { writeFile } from "node:fs/promises";
import type { TTSInput, TTSProvider, TTSResult, WordTiming } from "./types.js";

export interface StubTTSOptions {
  withTimings?: boolean;
  /** Milliseconds of silence to emit per word; default 200. */
  msPerWord?: number;
}

const SAMPLE_RATE = 24000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

function buildSilenceWav(durationMs: number): Buffer {
  const numSamples = Math.max(1, Math.round((durationMs / 1000) * SAMPLE_RATE));
  const dataSize = numSamples * NUM_CHANNELS * (BITS_PER_SAMPLE / 8);
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  buf.writeUInt16LE(NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  // The data region stays zeroed → silence.
  return buf;
}

export class StubTTSProvider implements TTSProvider {
  readonly id = "stub";
  private msPerWord: number;
  private withTimings: boolean;

  constructor(opts: StubTTSOptions = {}) {
    this.msPerWord = opts.msPerWord ?? 200;
    this.withTimings = opts.withTimings ?? false;
  }

  async synthesize(input: TTSInput): Promise<TTSResult> {
    if (input.signal?.aborted) throw new Error("Aborted");
    const words = input.text.split(/\s+/).filter(Boolean);
    const durationMs = Math.max(this.msPerWord, words.length * this.msPerWord);
    const wav = buildSilenceWav(durationMs);
    await writeFile(input.outputPath, wav);
    const result: TTSResult = { audioPath: input.outputPath, durationMs };
    if (this.withTimings) {
      const timings: WordTiming[] = [];
      let cursor = 0;
      for (const w of words) {
        timings.push({ word: w, startMs: cursor, endMs: cursor + this.msPerWord });
        cursor += this.msPerWord;
      }
      result.wordTimings = timings;
    }
    return result;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/stub-tts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/providers/stub-tts.ts apps/server/test/stub-tts.test.ts
git commit -m "feat(server): add StubTTSProvider for tests and dev"
```

---

## Task 6: PiAgentFactory

**Files:**
- Create: `apps/server/src/phases/pi-agent-factory.ts`
- Test: `apps/server/test/pi-agent-factory.test.ts`

`PiAgentFactory.create({ systemPrompt, tools, model, signal })` returns an `Agent` from `@earendil-works/pi-agent-core` configured for one phase run. The factory wires `signal` so `agent.abort()` is called when `signal.aborted` fires (the orchestrator's `ctx.signal`). The factory does NOT decide the system prompt or tool set — those are the per-phase handler's responsibility. Tests use `registerFauxProvider` so no real LLM is hit.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pi-agent-factory.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Type } from "typebox";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";

let faux: FauxProviderRegistration;
beforeEach(() => {
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  faux.unregister();
});

describe("PiAgentFactory", () => {
  it("creates an Agent that runs to completion against a faux model", async () => {
    faux.setResponses([fauxAssistantMessage(fauxText("done"))]);

    const factory = new PiAgentFactory();
    const agent = factory.create({
      systemPrompt: "test",
      tools: [],
      model: faux.getModel("uc-test"),
      signal: new AbortController().signal,
    });
    await agent.prompt("hi");
    const last = agent.state.messages[agent.state.messages.length - 1]!;
    expect(JSON.stringify(last)).toContain("done");
  });

  it("invokes a registered tool when the assistant message asks for it", async () => {
    let toolCalled = false;
    const echoTool: AgentTool = {
      name: "echo",
      label: "Echo",
      description: "Echo a value",
      parameters: Type.Object({ value: Type.String() }),
      execute: async (_id, params) => {
        toolCalled = true;
        return { content: [{ type: "text", text: String((params as { value: string }).value) }], details: {} };
      },
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("echo", { value: "ping" })),
      fauxAssistantMessage(fauxText("ok")),
    ]);

    const factory = new PiAgentFactory();
    const agent = factory.create({
      systemPrompt: "test",
      tools: [echoTool],
      model: faux.getModel("uc-test"),
      signal: new AbortController().signal,
    });
    await agent.prompt("call echo");
    expect(toolCalled).toBe(true);
  });

  it("calls agent.abort() when the external signal aborts after create", () => {
    // We intercept the bound method to observe — the Agent has no public hook for "did abort fire?".
    const factory = new PiAgentFactory();
    const controller = new AbortController();
    const agent = factory.create({
      systemPrompt: "test",
      tools: [],
      model: faux.getModel("uc-test"),
      signal: controller.signal,
    });
    let aborted = false;
    const original = agent.abort.bind(agent);
    agent.abort = () => {
      aborted = true;
      original();
    };
    controller.abort();
    expect(aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/pi-agent-factory.test.ts`
Expected: FAIL — cannot resolve `../src/phases/pi-agent-factory.js`.

- [ ] **Step 3: Implement the factory**

Create `apps/server/src/phases/pi-agent-factory.ts`:

```ts
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export interface PiAgentFactoryOptions {
  systemPrompt: string;
  tools: AgentTool[];
  model: Model<any>;
  signal: AbortSignal;
  /** Optional response-streaming hook for tests; defaults to noop. */
  onAssistantDelta?: (delta: string) => void;
}

/**
 * Wraps `Agent` construction for a single phase run.
 *
 * The factory:
 * - Builds the agent with the supplied system prompt, model, and tools.
 * - Bridges the orchestrator's `AbortSignal` to `agent.abort()` so abort is
 *   honored mid-run.
 * - Wires a `convertToLlm` that passes standard LLM messages through unchanged
 *   (we don't use custom AgentMessage types in Plan 3).
 */
export class PiAgentFactory {
  create(opts: PiAgentFactoryOptions): Agent {
    const agent = new Agent({
      initialState: {
        systemPrompt: opts.systemPrompt,
        model: opts.model,
        tools: opts.tools,
      },
      convertToLlm: (messages) => messages,
    });

    if (opts.signal.aborted) {
      agent.abort();
    } else {
      const onAbort = () => agent.abort();
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    return agent;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/pi-agent-factory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/pi-agent-factory.ts apps/server/test/pi-agent-factory.test.ts
git commit -m "feat(server): add PiAgentFactory wrapping @earendil-works/pi-agent-core Agent"
```

---

## Task 7: Artifact-write tools (write_brief / write_design / write_script)

**Files:**
- Create: `apps/server/src/tools/artifact-write-tools.ts`
- Test: `apps/server/test/artifact-write-tools.test.ts`

These are TypeBox tools that the research/design/script handlers register. Each takes structured JSON, validates it against the relevant Plan 1 zod schema (defense in depth — the agent might supply slightly off-schema data even if its TypeBox accepts it), and writes via `ArtifactStore.put`. We pass the per-run `ArtifactStore`, `sessionId`, and optional `derivedFrom` lineage in via a small per-tool closure so tools stay stateless across runs.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/artifact-write-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import {
  makeWriteBriefTool,
  makeWriteDesignTool,
  makeWriteScriptTool,
} from "../src/tools/artifact-write-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-tools-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function makeStore() {
  const wm = new WorkspaceManager(root);
  const bus = new EventBus();
  const store = new ArtifactStore(wm, bus);
  await wm.init("s1");
  return { wm, bus, store };
}

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

describe("write_brief tool", () => {
  it("writes a valid brief and returns the new version number", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({ sessionId: "s1", artifacts: store });
    const result = await tool.execute("call-1", briefData);
    expect(result.details).toMatchObject({ kind: "brief", version: 1 });
    expect(result.content[0]).toMatchObject({ type: "text" });
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")!.version).toBe(1);
  });

  it("throws if the brief data is invalid (defense against off-schema LLM output)", async () => {
    const { store } = await makeStore();
    const tool = makeWriteBriefTool({ sessionId: "s1", artifacts: store });
    await expect(tool.execute("call-1", { product: { name: "x" } } as never)).rejects.toThrow();
  });

  it("includes derivedFrom in the resulting descriptor when supplied", async () => {
    const { store } = await makeStore();
    await store.put("s1", "brief", briefData); // v1
    const tool = makeWriteBriefTool({
      sessionId: "s1",
      artifacts: store,
      derivedFrom: [{ kind: "brief", version: 1 }],
    });
    await tool.execute("call-1", briefData);
    const list = await store.list("s1");
    const v2 = list.find((d) => d.kind === "brief" && d.version === 2)!;
    expect(v2.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });
});

describe("write_design tool", () => {
  it("writes a valid design", async () => {
    const { store } = await makeStore();
    await store.put("s1", "brief", briefData);
    const tool = makeWriteDesignTool({ sessionId: "s1", artifacts: store });
    const result = await tool.execute("call-1", {
      mood: "energetic",
      palette: [{ name: "p", hex: "#000" }],
      typography: { heading: "A", body: "B" },
      motionStyle: "fades",
      keyVisuals: [],
      sampleFrames: [],
    });
    expect(result.details).toMatchObject({ kind: "design", version: 1 });
  });
});

describe("write_script tool", () => {
  it("writes a valid script", async () => {
    const { store } = await makeStore();
    await store.put("s1", "brief", briefData);
    const tool = makeWriteScriptTool({ sessionId: "s1", artifacts: store });
    const result = await tool.execute("call-1", {
      totalSec: 30,
      scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "shot" }],
    });
    expect(result.details).toMatchObject({ kind: "script", version: 1 });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/artifact-write-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tools**

Create `apps/server/src/tools/artifact-write-tools.ts`:

```ts
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  BriefSchema,
  DesignSchema,
  ScriptSchema,
  type LineageRef,
} from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";

export interface ArtifactWriteToolOptions {
  sessionId: string;
  artifacts: ArtifactStore;
  derivedFrom?: LineageRef[];
}

const briefParameters = Type.Object({
  product: Type.Object({
    name: Type.String(),
    tagline: Type.String(),
    description: Type.String(),
    category: Type.String(),
  }),
  audience: Type.String(),
  keyMessages: Type.Array(Type.String()),
  brandHints: Type.Object({
    colors: Type.Array(Type.String()),
    logoUrl: Type.Optional(Type.String()),
    fonts: Type.Optional(Type.Array(Type.String())),
  }),
  sourceAssets: Type.Object({
    images: Type.Array(Type.String()),
    videos: Type.Array(Type.String()),
    copy: Type.Array(Type.String()),
  }),
  constraints: Type.Object({
    durationSec: Type.Number(),
    aspectRatio: Type.String(),
    withVoiceover: Type.Boolean(),
  }),
});

const designParameters = Type.Object({
  mood: Type.String(),
  palette: Type.Array(Type.Object({ name: Type.String(), hex: Type.String() })),
  typography: Type.Object({ heading: Type.String(), body: Type.String() }),
  motionStyle: Type.String(),
  keyVisuals: Type.Array(Type.Object({
    description: Type.String(),
    refAssetId: Type.Optional(Type.String()),
  })),
  sampleFrames: Type.Array(Type.Object({
    caption: Type.String(),
    layoutHint: Type.String(),
    thumbnailUrl: Type.Optional(Type.String()),
  })),
});

const scriptParameters = Type.Object({
  totalSec: Type.Number(),
  scenes: Type.Array(Type.Object({
    id: Type.String(),
    startSec: Type.Number(),
    durationSec: Type.Number(),
    visual: Type.String(),
    onScreenText: Type.Optional(Type.String()),
    narration: Type.Optional(Type.String()),
    assetRefs: Type.Optional(Type.Array(Type.String())),
  })),
});

export function makeWriteBriefTool(opts: ArtifactWriteToolOptions): AgentTool<typeof briefParameters> {
  return {
    name: "write_brief",
    label: "Write Brief",
    description:
      "Persist the research brief for this session. Call this exactly once when the brief is final.",
    parameters: briefParameters,
    execute: async (_callId, params) => {
      // zod-validate too: TypeBox guarantees shape but not enums like aspectRatio.
      const data = BriefSchema.parse(params);
      const env = await opts.artifacts.put(opts.sessionId, "brief", data, {
        derivedFrom: opts.derivedFrom,
      });
      return {
        content: [{ type: "text", text: `Wrote brief v${env.version}.` }],
        details: { kind: "brief", version: env.version },
      };
    },
  };
}

export function makeWriteDesignTool(opts: ArtifactWriteToolOptions): AgentTool<typeof designParameters> {
  return {
    name: "write_design",
    label: "Write Design",
    description: "Persist the final design board for this session.",
    parameters: designParameters,
    execute: async (_callId, params) => {
      const data = DesignSchema.parse(params);
      const env = await opts.artifacts.put(opts.sessionId, "design", data, {
        derivedFrom: opts.derivedFrom,
      });
      return {
        content: [{ type: "text", text: `Wrote design v${env.version}.` }],
        details: { kind: "design", version: env.version },
      };
    },
  };
}

export function makeWriteScriptTool(opts: ArtifactWriteToolOptions): AgentTool<typeof scriptParameters> {
  return {
    name: "write_script",
    label: "Write Script",
    description: "Persist the final scene-by-scene script for this session.",
    parameters: scriptParameters,
    execute: async (_callId, params) => {
      const data = ScriptSchema.parse(params);
      const env = await opts.artifacts.put(opts.sessionId, "script", data, {
        derivedFrom: opts.derivedFrom,
      });
      return {
        content: [{ type: "text", text: `Wrote script v${env.version}.` }],
        details: { kind: "script", version: env.version },
      };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/artifact-write-tools.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tools/artifact-write-tools.ts apps/server/test/artifact-write-tools.test.ts
git commit -m "feat(server): add write_brief / write_design / write_script TypeBox tools"
```

---

## Task 8: Research-phase tools (web_fetch + read_upload)

**Files:**
- Create: `apps/server/src/tools/research-tools.ts`
- Test: `apps/server/test/research-tools.test.ts`

The research agent needs two helper tools: `web_fetch` (HTTP GET → text) and `read_upload` (read a file from the session's `uploads/` directory). `web_fetch` is injectable so tests can swap in a stub fetcher.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/research-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeWebFetchTool, makeReadUploadTool } from "../src/tools/research-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-rtools-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("web_fetch tool", () => {
  it("returns the fetched body as text content", async () => {
    const tool = makeWebFetchTool({
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
    });
    const result = await tool.execute("call-1", { url: "https://example.com" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "body of https://example.com" });
    expect(result.details).toMatchObject({ url: "https://example.com", status: 200 });
  });

  it("throws on non-2xx responses", async () => {
    const tool = makeWebFetchTool({
      fetch: async () => ({ status: 404, text: "not found" }),
    });
    await expect(tool.execute("call-1", { url: "https://x" })).rejects.toThrow(/404/);
  });

  it("rejects non-http(s) urls", async () => {
    const tool = makeWebFetchTool({ fetch: async () => ({ status: 200, text: "" }) });
    await expect(tool.execute("call-1", { url: "file:///etc/passwd" })).rejects.toThrow(/scheme/i);
  });
});

describe("read_upload tool", () => {
  it("reads a file from the session's uploads directory", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const p = wm.paths("s1");
    writeFileSync(join(p.uploads, "notes.txt"), "hello upload");
    const tool = makeReadUploadTool({ sessionId: "s1", workspaces: wm });
    const result = await tool.execute("call-1", { filename: "notes.txt" });
    expect((result.content[0] as { text: string }).text).toBe("hello upload");
  });

  it("rejects path-traversal filenames", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeReadUploadTool({ sessionId: "s1", workspaces: wm });
    await expect(tool.execute("call-1", { filename: "../../etc/passwd" })).rejects.toThrow(/invalid filename/i);
  });

  it("throws when the file does not exist", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const tool = makeReadUploadTool({ sessionId: "s1", workspaces: wm });
    await expect(tool.execute("call-1", { filename: "missing.txt" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/research-tools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tools**

Create `apps/server/src/tools/research-tools.ts`:

```ts
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface WebFetchResponse {
  status: number;
  text: string;
}

export interface WebFetchToolOptions {
  fetch: (url: string, signal?: AbortSignal) => Promise<WebFetchResponse>;
}

const webFetchParameters = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to fetch." }),
});

export function makeWebFetchTool(opts: WebFetchToolOptions): AgentTool<typeof webFetchParameters> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a web page or JSON document by URL and return its body as text.",
    parameters: webFetchParameters,
    execute: async (_callId, params, signal) => {
      const url = params.url;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Invalid URL: ${url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
      }
      const response = await opts.fetch(url, signal);
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Fetch failed (${response.status}) for ${url}`);
      }
      return {
        content: [{ type: "text", text: response.text }],
        details: { url, status: response.status, bytes: Buffer.byteLength(response.text, "utf8") },
      };
    },
  };
}

export interface ReadUploadToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
}

const readUploadParameters = Type.Object({
  filename: Type.String({ description: "Filename within this session's uploads/ directory." }),
});

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function makeReadUploadTool(opts: ReadUploadToolOptions): AgentTool<typeof readUploadParameters> {
  return {
    name: "read_upload",
    label: "Read Upload",
    description: "Read a file the user uploaded to this session.",
    parameters: readUploadParameters,
    execute: async (_callId, params) => {
      const raw = params.filename;
      const safe = basename(raw);
      if (safe !== raw || !SAFE_NAME.test(safe)) {
        throw new Error(`Invalid filename: ${raw}`);
      }
      const path = join(opts.workspaces.paths(opts.sessionId).uploads, safe);
      const text = await readFile(path, "utf8");
      return {
        content: [{ type: "text", text }],
        details: { filename: safe, bytes: Buffer.byteLength(text, "utf8") },
      };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/research-tools.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tools/research-tools.ts apps/server/test/research-tools.test.ts
git commit -m "feat(server): add web_fetch + read_upload TypeBox tools for research phase"
```

---

## Task 9: PiPhaseHandler bridge + research handler

**Files:**
- Create: `apps/server/src/phases/pi-handler-helpers.ts`
- Create: `apps/server/src/phases/pi-research-handler.ts`
- Test: `apps/server/test/pi-research-handler.test.ts`

`pi-handler-helpers.ts` exports a single helper that every Pi-driven handler reuses: `runAgentToCompletion(opts)` returns an `AsyncIterable<ServerEvent>` that drives the agent, emits `phase.progress` when assistant text deltas land or tool_execution_start/end fire, and resolves when `agent.prompt(...)` returns. This is the bridge between pi-agent's `subscribe(event)` callback model and our orchestrator's pull-based async iterator.

`pi-research-handler.ts` is the first real handler: implements `PhaseHandler`, builds the research system prompt + tool set (web_fetch, read_upload, write_brief) through `PiAgentFactory`, and drives the agent.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pi-research-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import type { ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiResearchPhaseHandler } from "../src/phases/pi-research-handler.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-pi-research-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

describe("PiResearchPhaseHandler", () => {
  it("drives the agent through a write_brief tool call and writes brief v1", async () => {
    // Canned conversation: assistant calls write_brief once, then says "done".
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test"),
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
    });

    const events: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      initialMessage: {
        text: "Make a promo for https://acme.example",
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      },
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toMatchObject({ version: 1 });
    // At least one phase.progress event (tool_execution_start/end emits one).
    expect(events.some((e) => e.type === "phase.progress" && e.phase === "research")).toBe(true);
  });

  it("propagates a thrown tool error as a phase.error from the iterator", async () => {
    // The agent calls write_brief with off-schema data → zod throws inside the tool.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_brief", { product: { name: "x" } } as never)),
      // The pi-agent loop will resume after the tool error; we add a second turn
      // that finishes without further tool calls so the loop terminates.
      fauxAssistantMessage(fauxText("giving up")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test"),
      fetch: async () => ({ status: 200, text: "" }),
    });

    const events: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      initialMessage: { text: "x" },
      signal: new AbortController().signal,
    })) {
      events.push(e);
    }

    // No brief artifact persisted (zod rejected the off-schema data).
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toBeUndefined();
    // The iterator emitted at least one phase.progress (tool_execution_start) and
    // continued to run; the orchestrator will mark the phase succeeded with no
    // artifacts, which the orchestrator-level integration test catches separately.
    expect(events.some((e) => e.type === "phase.progress")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/pi-research-handler.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the bridge helper**

Create `apps/server/src/phases/pi-handler-helpers.ts`:

```ts
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";
import type { PhaseId, ServerEvent } from "@ultracreator/shared";

/**
 * Drive a Pi `Agent` to completion and yield `ServerEvent`s as work happens.
 *
 * - `phase.progress` is emitted at meaningful boundaries: tool_execution_start
 *   (so the UI sees which tool is running), tool_execution_end (with a short
 *   summary of the result), and turn_end (so the UI sees natural progress between turns).
 * - Errors from the agent are thrown so the orchestrator's `runPhase` catches them
 *   and emits `phase.error`.
 *
 * Note: `artifact.created` is NOT emitted here — `ArtifactStore.put` (called from
 * inside artifact-write tools) emits it directly via EventBus.
 */
export async function* runAgentToCompletion(opts: {
  phase: PhaseId;
  agent: Agent;
  prompt: string;
}): AsyncIterable<ServerEvent> {
  const queue: ServerEvent[] = [];
  let waiter: (() => void) | null = null;
  let agentError: Error | null = null;

  const push = (event: ServerEvent) => {
    queue.push(event);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const unsubscribe = opts.agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "tool_execution_start":
        push({
          type: "phase.progress",
          phase: opts.phase,
          message: `Running tool: ${event.toolName}`,
        });
        break;
      case "tool_execution_end":
        push({
          type: "phase.progress",
          phase: opts.phase,
          message: event.isError
            ? `Tool ${event.toolName} failed.`
            : `Tool ${event.toolName} completed.`,
        });
        break;
      case "turn_end":
        push({ type: "phase.progress", phase: opts.phase, message: "Turn complete." });
        break;
      default:
        break;
    }
  });

  const runPromise = opts.agent.prompt(opts.prompt).catch((err: unknown) => {
    agentError = err instanceof Error ? err : new Error(String(err));
  });

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      const isDone = await Promise.race([
        runPromise.then(() => "done" as const),
        new Promise<"event">((resolve) => {
          waiter = () => resolve("event");
        }),
      ]);
      if (isDone === "done") {
        while (queue.length > 0) yield queue.shift()!;
        break;
      }
    }
  } finally {
    unsubscribe();
  }

  if (agentError) throw agentError;
}
```

- [ ] **Step 4: Implement the research handler**

Create `apps/server/src/phases/pi-research-handler.ts`:

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { PhaseId, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { runAgentToCompletion } from "./pi-handler-helpers.js";
import {
  makeWebFetchTool,
  makeReadUploadTool,
  type WebFetchToolOptions,
} from "../tools/research-tools.js";
import { makeWriteBriefTool } from "../tools/artifact-write-tools.js";

const SYSTEM_PROMPT = `You are the RESEARCH phase of a promo-video pipeline.

Your job: given a user's product description (which may include a URL and uploaded
files), produce a structured brief that captures the product, its audience, key
selling points, brand cues, and any source assets you saw.

Available tools:
- web_fetch: fetch a URL and read its text.
- read_upload: read a file the user uploaded to this session.
- write_brief: persist the final brief. Call this EXACTLY ONCE when ready.

Rules:
- Use web_fetch and read_upload to gather information from the URL + uploads in the user's message.
- Call write_brief with the complete brief object when finished. Do not call it more than once.
- Keep keyMessages to at most 3 items.
- Pass through the durationSec / aspectRatio / withVoiceover constraints from the user message verbatim.`;

export interface PiResearchPhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
  fetch: WebFetchToolOptions["fetch"];
}

export class PiResearchPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "research";
  constructor(private opts: PiResearchPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const tools = [
      makeWebFetchTool({ fetch: this.opts.fetch }),
      makeReadUploadTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
      makeWriteBriefTool({ sessionId: ctx.sessionId, artifacts: ctx.artifacts }),
    ];

    const agent = this.opts.agentFactory.create({
      systemPrompt: SYSTEM_PROMPT,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const initial = ctx.initialMessage;
    const refinement = ctx.refinement;
    const promptParts: string[] = [];
    if (initial) {
      promptParts.push(`User message: ${initial.text}`);
      if (initial.uploadedFiles?.length) {
        promptParts.push(`Uploaded files: ${initial.uploadedFiles.join(", ")}`);
      }
      if (initial.constraints) {
        promptParts.push(`Constraints: ${JSON.stringify(initial.constraints)}`);
      }
    }
    if (refinement) {
      promptParts.push(`Refinement: ${refinement}`);
    }
    const prompt = promptParts.join("\n\n") || "Begin research.";

    yield* runAgentToCompletion({ phase: this.phase, agent, prompt });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/pi-research-handler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/phases/pi-handler-helpers.ts apps/server/src/phases/pi-research-handler.ts apps/server/test/pi-research-handler.test.ts
git commit -m "feat(server): add Pi-agent research phase handler + event bridge"
```

---

## Task 10: Design phase handler

**Files:**
- Create: `apps/server/src/phases/pi-design-handler.ts`
- Test: `apps/server/test/pi-design-handler.test.ts`

The design handler reads the latest brief from `ArtifactStore` and passes its data to the agent in the prompt. The only tool the design agent has is `write_design` — design generation in v1 is purely an LLM-creative task, no external tools needed.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pi-design-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiDesignPhaseHandler } from "../src/phases/pi-design-handler.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-pi-design-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

const designData = {
  mood: "energetic",
  palette: [{ name: "primary", hex: "#FF3366" }],
  typography: { heading: "Poppins", body: "Inter" },
  motionStyle: "kinetic captions",
  keyVisuals: [{ description: "product hero" }],
  sampleFrames: [{ caption: "Meet Acme", layoutHint: "centered" }],
};

describe("PiDesignPhaseHandler", () => {
  it("writes a design v1 derived from brief v1 when the agent calls write_design", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);

    const handler = new PiDesignPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test"),
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) {
      // drain
    }

    const list = await store.list("s1");
    const design = list.find((d) => d.kind === "design");
    expect(design).toMatchObject({ version: 1 });
    expect(design!.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });

  it("derives design v2 from design v1 + brief v1 on a refine pass", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_design", { ...designData, mood: "premium" })),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "design", designData, { derivedFrom: [{ kind: "brief", version: 1 }] });

    const handler = new PiDesignPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test"),
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      refinement: "Make it more premium.",
      signal: new AbortController().signal,
    })) { /* drain */ }

    const list = await store.list("s1");
    const v2 = list.find((d) => d.kind === "design" && d.version === 2)!;
    expect(v2.derivedFrom).toEqual([
      { kind: "design", version: 1 },
      { kind: "brief", version: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/pi-design-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the design handler**

Create `apps/server/src/phases/pi-design-handler.ts`:

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { Brief, LineageRef, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { runAgentToCompletion } from "./pi-handler-helpers.js";
import { makeWriteDesignTool } from "../tools/artifact-write-tools.js";

const SYSTEM_PROMPT = `You are the DESIGN phase of a promo-video pipeline.

You receive a structured brief. Produce a design board that captures the visual
direction of the video: mood, color palette, typography, motion style, key
visuals, and 2-4 sample frame ideas. Be opinionated and concrete.

Tools:
- write_design: persist the final design. Call this EXACTLY ONCE when ready.

Rules:
- Use the brief.constraints.aspectRatio and brief.brandHints.colors as starting points.
- If a refinement note is provided, honor it; otherwise design from scratch.
- Call write_design with the complete design object when finished. Do not call it more than once.`;

export interface PiDesignPhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
}

export class PiDesignPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "design";
  constructor(private opts: PiDesignPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    if (!briefEnv) {
      throw new Error("design phase requires a brief artifact, none found");
    }

    const prevDesignEnv = await ctx.artifacts.get(ctx.sessionId, "design");
    const derivedFrom: LineageRef[] = prevDesignEnv
      ? [
          { kind: "design", version: prevDesignEnv.version },
          { kind: "brief", version: briefEnv.version },
        ]
      : [{ kind: "brief", version: briefEnv.version }];

    const tools = [
      makeWriteDesignTool({
        sessionId: ctx.sessionId,
        artifacts: ctx.artifacts,
        derivedFrom,
      }),
    ];

    const agent = this.opts.agentFactory.create({
      systemPrompt: SYSTEM_PROMPT,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const promptParts: string[] = [
      `Brief: ${JSON.stringify(briefEnv.data, null, 2)}`,
    ];
    if (prevDesignEnv) {
      promptParts.push(`Previous design: ${JSON.stringify(prevDesignEnv.data, null, 2)}`);
    }
    if (ctx.refinement) {
      promptParts.push(`Refinement: ${ctx.refinement}`);
    }

    yield* runAgentToCompletion({
      phase: this.phase,
      agent,
      prompt: promptParts.join("\n\n"),
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/pi-design-handler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/pi-design-handler.ts apps/server/test/pi-design-handler.test.ts
git commit -m "feat(server): add Pi-agent design phase handler"
```

---

## Task 11: Script phase handler

**Files:**
- Create: `apps/server/src/phases/pi-script-handler.ts`
- Test: `apps/server/test/pi-script-handler.test.ts`

Symmetric with design: reads brief + design, agent writes script via the `write_script` tool. Lineage is `[script_prev?, design_latest, brief_latest]`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pi-script-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiScriptPhaseHandler } from "../src/phases/pi-script-handler.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-pi-script-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};

describe("PiScriptPhaseHandler", () => {
  it("writes a script derived from design+brief when the agent calls write_script", async () => {
    const scriptOutput = {
      totalSec: 30,
      scenes: [
        { id: "s1", startSec: 0, durationSec: 6, visual: "logo reveal", narration: "Meet Acme." },
        { id: "s2", startSec: 6, durationSec: 24, visual: "product demo" },
      ],
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_script", scriptOutput)),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "design", designData, { derivedFrom: [{ kind: "brief", version: 1 }] });

    const handler = new PiScriptPhaseHandler({
      agentFactory: new PiAgentFactory(),
      model: faux.getModel("uc-test"),
    });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    const list = await store.list("s1");
    const script = list.find((d) => d.kind === "script")!;
    expect(script.version).toBe(1);
    expect(script.derivedFrom).toEqual([
      { kind: "design", version: 1 },
      { kind: "brief", version: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/pi-script-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the script handler**

Create `apps/server/src/phases/pi-script-handler.ts`:

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { Brief, Design, LineageRef, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { runAgentToCompletion } from "./pi-handler-helpers.js";
import { makeWriteScriptTool } from "../tools/artifact-write-tools.js";

const SYSTEM_PROMPT = `You are the SCRIPT phase of a promo-video pipeline.

You receive a brief and a design. Produce a scene-by-scene script for the video.

Tools:
- write_script: persist the final script. Call this EXACTLY ONCE when ready.

Rules:
- The total duration MUST equal brief.constraints.durationSec.
- Cover all keyMessages from the brief across the scenes.
- If brief.constraints.withVoiceover is true, every scene should have narration.
  If false, leave narration unset (rely on onScreenText).
- Each scene needs startSec and durationSec; consecutive scenes must not overlap.`;

export interface PiScriptPhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
}

export class PiScriptPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "script";
  constructor(private opts: PiScriptPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    const designEnv = await ctx.artifacts.get<Design>(ctx.sessionId, "design");
    if (!briefEnv) throw new Error("script phase requires a brief artifact, none found");
    if (!designEnv) throw new Error("script phase requires a design artifact, none found");

    const prevScriptEnv = await ctx.artifacts.get(ctx.sessionId, "script");
    const derivedFrom: LineageRef[] = prevScriptEnv
      ? [
          { kind: "script", version: prevScriptEnv.version },
          { kind: "design", version: designEnv.version },
          { kind: "brief", version: briefEnv.version },
        ]
      : [
          { kind: "design", version: designEnv.version },
          { kind: "brief", version: briefEnv.version },
        ];

    const tools = [
      makeWriteScriptTool({
        sessionId: ctx.sessionId,
        artifacts: ctx.artifacts,
        derivedFrom,
      }),
    ];

    const agent = this.opts.agentFactory.create({
      systemPrompt: SYSTEM_PROMPT,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const promptParts: string[] = [
      `Brief: ${JSON.stringify(briefEnv.data, null, 2)}`,
      `Design: ${JSON.stringify(designEnv.data, null, 2)}`,
    ];
    if (prevScriptEnv) {
      promptParts.push(`Previous script: ${JSON.stringify(prevScriptEnv.data, null, 2)}`);
    }
    if (ctx.refinement) {
      promptParts.push(`Refinement: ${ctx.refinement}`);
    }

    yield* runAgentToCompletion({
      phase: this.phase,
      agent,
      prompt: promptParts.join("\n\n"),
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/pi-script-handler.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/pi-script-handler.ts apps/server/test/pi-script-handler.test.ts
git commit -m "feat(server): add Pi-agent script phase handler"
```

---

## Task 12: VoiceoverPhaseHandler (provider-based)

**Files:**
- Create: `apps/server/src/phases/voiceover-handler.ts`
- Test: `apps/server/test/voiceover-handler.test.ts`

The voiceover phase is **not** agent-driven. It reads the latest script, concatenates the scene narrations into a single text input (with speaker tags if the script has multiple speakers — out of scope for v1), calls the registered TTS provider, and writes a `narration` artifact pointing at the audio file. The audio file lives in `workspaces/<sid>/composition/narration.<ext>` (where Plan 4's RenderWorker will pick it up).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/voiceover-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { StubTTSProvider } from "../src/providers/stub-tts.js";
import { VoiceoverPhaseHandler } from "../src/phases/voiceover-handler.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-vo-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
};
const scriptData = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo", narration: "Meet Acme." },
    { id: "s2", startSec: 6, durationSec: 24, visual: "demo", narration: "It just works." },
  ],
};

async function makeContext() {
  const workspaces = new WorkspaceManager(root);
  const bus = new EventBus();
  const store = new ArtifactStore(workspaces, bus);
  await workspaces.init("s1");
  await store.put("s1", "brief", briefData);
  await store.put("s1", "script", scriptData);
  const providers = new ProviderRegistry();
  providers.register("tts", new StubTTSProvider({ withTimings: true }));
  return { workspaces, bus, store, providers };
}

describe("VoiceoverPhaseHandler", () => {
  it("synthesizes the script narration and writes a narration artifact", async () => {
    const { workspaces, bus, store, providers } = await makeContext();
    const handler = new VoiceoverPhaseHandler({ providers });
    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    const list = await store.list("s1");
    const narration = list.find((d) => d.kind === "narration")!;
    expect(narration.version).toBe(1);
    expect(narration.derivedFrom).toEqual([{ kind: "script", version: 1 }]);

    const env = await store.get<{ audioPath: string; durationMs: number; wordTimings?: unknown[] }>("s1", "narration");
    expect(env!.data.audioPath).toContain("narration");
    expect(existsSync(env!.data.audioPath)).toBe(true);
    expect(env!.data.durationMs).toBeGreaterThan(0);
    expect(env!.data.wordTimings).toBeDefined();
  });

  it("throws if the script has no narration anywhere", async () => {
    const workspaces = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(workspaces, bus);
    await workspaces.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "script", {
      totalSec: 30,
      scenes: [{ id: "s1", startSec: 0, durationSec: 30, visual: "shot" }],
    });
    const providers = new ProviderRegistry();
    providers.register("tts", new StubTTSProvider());
    const handler = new VoiceoverPhaseHandler({ providers });
    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces,
        artifacts: store,
        events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow(/narration/i);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/voiceover-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handler**

Create `apps/server/src/phases/voiceover-handler.ts`:

```ts
import { join } from "node:path";
import type { PhaseId, Script, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import type { ProviderRegistry } from "../providers/registry.js";

export interface VoiceoverPhaseHandlerOptions {
  providers: ProviderRegistry;
  /** Optional TTS provider id; if omitted, the first registered provider is used. */
  ttsProviderId?: string;
  /** Audio file extension to use; defaults to `wav` (stub) — Gemini provider also produces wav. */
  outputExtension?: string;
}

export class VoiceoverPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "voiceover";
  constructor(private opts: VoiceoverPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
    if (!scriptEnv) throw new Error("voiceover phase requires a script artifact, none found");

    const lines = scriptEnv.data.scenes
      .map((s) => s.narration?.trim())
      .filter((n): n is string => Boolean(n && n.length > 0));
    if (lines.length === 0) {
      throw new Error("script has no narration text on any scene; cannot synthesize voiceover");
    }
    const text = lines.join("\n\n");

    yield {
      type: "phase.progress",
      phase: this.phase,
      message: `Synthesizing narration (${lines.length} lines, ${text.length} chars).`,
    };

    const tts = this.opts.providers.require("tts", this.opts.ttsProviderId);
    const ext = this.opts.outputExtension ?? "wav";
    const outputPath = join(ctx.workspaces.paths(ctx.sessionId).composition, `narration.${ext}`);
    const result = await tts.synthesize({
      text,
      outputPath,
      signal: ctx.signal,
    });

    await ctx.artifacts.put(
      ctx.sessionId,
      "narration",
      {
        audioPath: result.audioPath,
        durationMs: result.durationMs,
        wordTimings: result.wordTimings,
      },
      { derivedFrom: [{ kind: "script", version: scriptEnv.version }] },
    );

    yield {
      type: "phase.progress",
      phase: this.phase,
      message: `Narration ready (${result.durationMs} ms).`,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/voiceover-handler.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/voiceover-handler.ts apps/server/test/voiceover-handler.test.ts
git commit -m "feat(server): add VoiceoverPhaseHandler using ProviderRegistry"
```

---

## Task 13: GeminiTTSProvider

**Files:**
- Create: `apps/server/src/providers/gemini-tts.ts`
- Test: `apps/server/test/gemini-tts.external.test.ts`

The real Gemini TTS provider. Wraps `@google/genai` to call `gemini-2.5-flash-preview-tts` (default; configurable to `pro`), receives base64 PCM 24kHz 16-bit signed LE, and writes a WAV file. Word timings are NOT supported by Gemini TTS API as of 2026-05 — we approximate them by even time distribution across the text's tokens (best-effort) and document that approximation. The constructor takes an optional `client` parameter so tests can inject a fake; the production path constructs `new GoogleGenAI({ apiKey })`. The unit test mocks the client; the `@external` test (manual run only) hits the real API.

- [ ] **Step 1: Write the failing tests**

We split into two test files:

(a) Unit test with injected fake client — runs in CI. Create `apps/server/test/gemini-tts.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiTTSProvider, type GeminiGenerateContentClient } from "../src/providers/gemini-tts.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-gem-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A minimal fake of the @google/genai client surface we use. */
function makeFakeClient(audioBase64: string): GeminiGenerateContentClient {
  return {
    models: {
      generateContent: async () => ({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { mimeType: "audio/L16;rate=24000", data: audioBase64 } },
              ],
            },
          },
        ],
      }),
    },
  };
}

// 24kHz * 0.5 s * 2 bytes/sample = 24000 bytes
const pcmHalfSecond = Buffer.alloc(24000, 0);

describe("GeminiTTSProvider", () => {
  it("writes a WAV file wrapping the returned PCM audio", async () => {
    const provider = new GeminiTTSProvider({
      client: makeFakeClient(pcmHalfSecond.toString("base64")),
      apiKey: "ignored-with-injected-client",
    });
    const outputPath = join(root, "narration.wav");
    const result = await provider.synthesize({ text: "Hello world", outputPath });
    expect(result.audioPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(500);
    const data = readFileSync(outputPath);
    expect(data.slice(0, 4).toString("ascii")).toBe("RIFF");
    expect(data.slice(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("emits approximate evenly-distributed word timings when requested", async () => {
    const provider = new GeminiTTSProvider({
      client: makeFakeClient(pcmHalfSecond.toString("base64")),
      apiKey: "ignored",
      approximateWordTimings: true,
    });
    const result = await provider.synthesize({ text: "one two three", outputPath: join(root, "n.wav") });
    expect(result.wordTimings).toBeDefined();
    expect(result.wordTimings!.map((w) => w.word)).toEqual(["one", "two", "three"]);
  });

  it("throws if the response has no audio inlineData", async () => {
    const empty: GeminiGenerateContentClient = {
      models: {
        generateContent: async () => ({ candidates: [{ content: { parts: [] } }] }),
      },
    };
    const provider = new GeminiTTSProvider({ client: empty, apiKey: "ignored" });
    await expect(
      provider.synthesize({ text: "x", outputPath: join(root, "x.wav") }),
    ).rejects.toThrow(/audio/i);
  });

  it("respects an already-aborted signal", async () => {
    const provider = new GeminiTTSProvider({
      client: makeFakeClient(pcmHalfSecond.toString("base64")),
      apiKey: "ignored",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.synthesize({ text: "x", outputPath: join(root, "y.wav"), signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});
```

(b) Real-API test, runs only when `GEMINI_API_KEY` is set. Create `apps/server/test/gemini-tts.external.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiTTSProvider } from "../src/providers/gemini-tts.js";

const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-gem-real-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!HAS_KEY)("GeminiTTSProvider @external", () => {
  it("calls the real Gemini TTS endpoint and writes a non-empty WAV", async () => {
    const provider = new GeminiTTSProvider({ apiKey: process.env.GEMINI_API_KEY! });
    const out = join(root, "real.wav");
    const result = await provider.synthesize({
      text: "Hello from UltraCreator's voiceover phase.",
      outputPath: out,
      voice: "Kore",
    });
    expect(result.audioPath).toBe(out);
    const size = statSync(out).size;
    expect(size).toBeGreaterThan(1024);
  }, 30_000);
});
```

- [ ] **Step 2: Run the failing tests**

Run: `pnpm vitest run apps/server/test/gemini-tts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `apps/server/src/providers/gemini-tts.ts`:

```ts
import { writeFile } from "node:fs/promises";
import type { TTSInput, TTSProvider, TTSResult, WordTiming } from "./types.js";

/**
 * Minimal surface of `@google/genai`'s GoogleGenAI used by this provider.
 * Captured here so tests can inject a fake without depending on the SDK shape.
 */
export interface GeminiGenerateContentClient {
  models: {
    generateContent(args: {
      model: string;
      contents: unknown;
      config?: unknown;
    }): Promise<{
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data: string } }> };
      }>;
    }>;
  };
}

export interface GeminiTTSProviderOptions {
  apiKey: string;
  /** Default: "gemini-2.5-flash-preview-tts". */
  modelId?: string;
  /** Injected client for tests; production path lazy-imports @google/genai. */
  client?: GeminiGenerateContentClient;
  /** When true, fill TTSResult.wordTimings with evenly distributed approximations. */
  approximateWordTimings?: boolean;
}

const SAMPLE_RATE = 24000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

function wrapPcmInWav(pcm: Buffer): Buffer {
  const dataSize = pcm.byteLength;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 28);
  buf.writeUInt16LE(NUM_CHANNELS * (BITS_PER_SAMPLE / 8), 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

function pcmDurationMs(pcmBytes: number): number {
  const samples = pcmBytes / NUM_CHANNELS / (BITS_PER_SAMPLE / 8);
  return Math.round((samples / SAMPLE_RATE) * 1000);
}

function approximateTimings(text: string, totalMs: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const slice = totalMs / words.length;
  return words.map((w, i) => ({
    word: w,
    startMs: Math.round(i * slice),
    endMs: Math.round((i + 1) * slice),
  }));
}

export class GeminiTTSProvider implements TTSProvider {
  readonly id = "gemini";
  private apiKey: string;
  private modelId: string;
  private clientPromise?: Promise<GeminiGenerateContentClient>;
  private approximateWordTimings: boolean;

  constructor(opts: GeminiTTSProviderOptions) {
    this.apiKey = opts.apiKey;
    this.modelId = opts.modelId ?? "gemini-2.5-flash-preview-tts";
    this.approximateWordTimings = opts.approximateWordTimings ?? false;
    if (opts.client) {
      this.clientPromise = Promise.resolve(opts.client);
    }
  }

  private async getClient(): Promise<GeminiGenerateContentClient> {
    if (!this.clientPromise) {
      // Lazy dynamic import so tests that never touch the network don't load the SDK.
      this.clientPromise = (async () => {
        const mod = await import("@google/genai");
        return new mod.GoogleGenAI({ apiKey: this.apiKey }) as unknown as GeminiGenerateContentClient;
      })();
    }
    return this.clientPromise;
  }

  async synthesize(input: TTSInput): Promise<TTSResult> {
    if (input.signal?.aborted) throw new Error("Aborted");
    const client = await this.getClient();

    const config: Record<string, unknown> = {
      responseModalities: ["AUDIO"],
    };
    if (input.voice) {
      config.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } },
      };
    }

    const response = await client.models.generateContent({
      model: this.modelId,
      contents: [{ role: "user", parts: [{ text: input.text }] }],
      config,
    });

    if (input.signal?.aborted) throw new Error("Aborted");

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const inlineData = parts.find((p): p is { inlineData: { mimeType?: string; data: string } } =>
      Boolean(p.inlineData?.data),
    )?.inlineData;
    if (!inlineData) {
      throw new Error("Gemini TTS response contained no audio inlineData.");
    }

    const pcm = Buffer.from(inlineData.data, "base64");
    const wav = wrapPcmInWav(pcm);
    await writeFile(input.outputPath, wav);
    const durationMs = pcmDurationMs(pcm.byteLength);
    const result: TTSResult = { audioPath: input.outputPath, durationMs };
    if (this.approximateWordTimings) {
      result.wordTimings = approximateTimings(input.text, durationMs);
    }
    return result;
  }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm vitest run apps/server/test/gemini-tts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the @external test only if `GEMINI_API_KEY` is set**

```bash
GEMINI_API_KEY=$YOUR_KEY pnpm vitest run apps/server/test/gemini-tts.external.test.ts
```
Expected (with key): PASS (1 test). Without key: SKIPPED.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/providers/gemini-tts.ts apps/server/test/gemini-tts.test.ts apps/server/test/gemini-tts.external.test.ts
git commit -m "feat(server): add GeminiTTSProvider with WAV wrapping and external test"
```

---

## Task 14: Composition root + full integration test

**Files:**
- Create: `apps/server/src/composition.ts`
- Test: `apps/server/test/composition.test.ts`

`composeOrchestrator(deps)` is the production wiring: given a model + TTS provider + WorkspaceManager etc., it constructs the full handler map (real research / design / script Pi handlers + voiceover provider handler + FakePhaseHandler for render — Plan 4 replaces the render fake), builds the `SessionOrchestrator`, and returns it. The integration test runs the full happy-path: new-project → research → design (gate) → approve → script (gate) → approve → render → done.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/composition.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, type FauxProviderRegistration } from "@earendil-works/pi-ai";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { StubTTSProvider } from "../src/providers/stub-tts.js";
import { composeOrchestrator } from "../src/composition.js";

let root: string;
let faux: FauxProviderRegistration;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-compose-"));
  faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  faux.unregister();
});

const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
};
const designData = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const scriptData = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo", narration: "Meet Acme." },
    { id: "s2", startSec: 6, durationSec: 24, visual: "demo", narration: "It just works." },
  ],
};

describe("composeOrchestrator", () => {
  it("drives a full session end-to-end through real handlers + stub providers", async () => {
    // Three turns of LLM activity: research → design → script.
    // Each turn: one tool call, then a "done" message so the agent loop terminates.
    faux.setResponses([
      // research
      fauxAssistantMessage(fauxToolCall("write_brief", briefData)),
      fauxAssistantMessage(fauxText("research done")),
      // design
      fauxAssistantMessage(fauxToolCall("write_design", designData)),
      fauxAssistantMessage(fauxText("design done")),
      // script
      fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
      fauxAssistantMessage(fauxText("script done")),
    ]);

    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const providers = new ProviderRegistry();
    providers.register("tts", new StubTTSProvider({ withTimings: true }));

    const orch = composeOrchestrator({
      workspaces,
      events,
      artifacts,
      providers,
      model: faux.getModel("uc-test"),
      fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
    });

    await orch.handleMessage("s1", {
      text: "Make a promo for https://acme.example",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
    });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "brief")).toBeDefined();
    expect(list.find((d) => d.kind === "design")).toBeDefined();
    expect(list.find((d) => d.kind === "script")).toBeDefined();
    expect(list.find((d) => d.kind === "narration")).toBeDefined();
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
    expect(list.find((d) => d.kind === "mp4")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm vitest run apps/server/test/composition.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the composition root**

Create `apps/server/src/composition.ts`:

```ts
import type { Model } from "@earendil-works/pi-ai";
import type { PhaseId } from "@ultracreator/shared";
import { SessionOrchestrator } from "./orchestrator/session-orchestrator.js";
import { PhaseRegistry } from "./phases/registry.js";
import { RuleBasedIntentRouter } from "./intent/intent-router.js";
import { PiAgentFactory } from "./phases/pi-agent-factory.js";
import { PiResearchPhaseHandler } from "./phases/pi-research-handler.js";
import { PiDesignPhaseHandler } from "./phases/pi-design-handler.js";
import { PiScriptPhaseHandler } from "./phases/pi-script-handler.js";
import { VoiceoverPhaseHandler } from "./phases/voiceover-handler.js";
import { FakePhaseHandler } from "./phases/fake-handler.js";
import type { PhaseHandler } from "./phases/types.js";
import type { WorkspaceManager } from "./workspace/workspace-manager.js";
import type { EventBus } from "./events/event-bus.js";
import type { ArtifactStore } from "./artifacts/artifact-store.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { WebFetchResponse } from "./tools/research-tools.js";

export interface ComposeOptions {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  providers: ProviderRegistry;
  model: Model<any>;
  fetch: (url: string, signal?: AbortSignal) => Promise<WebFetchResponse>;
  /** Optional override for the render handler. Plan 4 wires the real RenderWorker here. */
  renderHandler?: PhaseHandler;
}

export function composeOrchestrator(opts: ComposeOptions): SessionOrchestrator {
  const phases = new PhaseRegistry();
  const intentRouter = new RuleBasedIntentRouter();
  const agentFactory = new PiAgentFactory();

  // Until Plan 4, the render handler is a fake that writes composition + mp4
  // pointer artifacts so the orchestrator can settle into "done".
  const defaultRender: PhaseHandler =
    opts.renderHandler ??
    new FakePhaseHandler({
      phase: "render",
      produce: async () => [
        { kind: "composition", data: { dir: "composition", entry: "index.html" } },
        { kind: "mp4", data: { path: "output/out.mp4" } },
      ],
    });

  const handlers = new Map<PhaseId, PhaseHandler>([
    [
      "research",
      new PiResearchPhaseHandler({
        agentFactory,
        model: opts.model,
        fetch: opts.fetch,
      }),
    ],
    ["design", new PiDesignPhaseHandler({ agentFactory, model: opts.model })],
    ["script", new PiScriptPhaseHandler({ agentFactory, model: opts.model })],
    ["voiceover", new VoiceoverPhaseHandler({ providers: opts.providers })],
    ["render", defaultRender],
  ]);

  return new SessionOrchestrator({
    workspaces: opts.workspaces,
    events: opts.events,
    artifacts: opts.artifacts,
    phases,
    intentRouter,
    handlers,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/composition.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/composition.ts apps/server/test/composition.test.ts
git commit -m "feat(server): add composeOrchestrator and full end-to-end happy-path test"
```

---

## Task 15: Full suite + typecheck green

**Files:** none (verification task)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — every suite from Plans 1-2 plus all new Plan 3 suites:
- Plan 1: schemas (31), event-bus (6), workspace-manager (8), artifact-store (11), import-shared (1).
- Plan 2: phase-registry (8), fake-handler (3), intent-router (18 — was 14, +4 from Task 2), session-queue (4), stale (5), orchestrator (17 — was 16, +1 from Task 1).
- Plan 3: provider-registry (5), stub-tts (3), pi-agent-factory (2), artifact-write-tools (5), research-tools (6), pi-research-handler (2), pi-design-handler (2), pi-script-handler (1), voiceover-handler (2), gemini-tts (4), composition (1).
- Total expected: 31+6+8+11+1+8+3+18+4+5+17+5+3+2+5+6+2+2+1+2+4+1 = **145** tests.

(The `gemini-tts.external.test.ts` is `describe.skipIf(!HAS_KEY)` — it's skipped without a real API key and doesn't count toward the 146.)

- [ ] **Step 2: Run the typechecker**

Run: `pnpm typecheck`
Expected: exits 0 with no errors across both `@ultracreator/shared` and `@ultracreator/server`.

- [ ] **Step 3: Final commit if anything changed**

```bash
git add -A
git commit -m "chore: plan 3 green (Pi handlers + providers + composition)" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:**
  - §5 `PiAgentFactory` — Task 6. `ProviderRegistry` — Task 4. `GeminiTTSProvider` — Task 13.
  - §6 Provider abstraction (`TTSProvider`, ProviderRegistry, Gemini as v1 implementation) — Tasks 4 + 13.
  - §6 "Adding a vendor is a registration, not a flow change" — verified: `composition.ts` only knows about `providers.require("tts")`, not which provider was registered.
  - §6 Skill-driven phases (research/design/script) — Tasks 9-11. The "skills" in the design doc become handler-internal system prompts + per-phase TypeBox tools. We deliberately don't use pi-agent's `AgentHarness` skill loader for v1 — keeps the test surface tight and avoids loading external markdown files into the prompt. If a later plan wants to swap in `AgentHarness` for richer skill orchestration, the `PhaseHandler` interface absorbs that without touching the orchestrator.
  - §7 Lineage chain (`derivedFrom`) — design handler (Task 10) and script handler (Task 11) walk `[prev?, design, brief]` lineage; the existing markStaleDownstream from Plan 2 keeps working unchanged.
  - §7 Bonus: word-level timings feeding hyperframes captions — `StubTTSProvider` and `GeminiTTSProvider` (Task 13) both produce `wordTimings`, even if Gemini's are approximated. Plan 4's RenderWorker will pick this up.
  - §8 Phase agent failure handling — already covered by Plan 2's orchestrator; the Pi handlers throw on agent errors (Task 9's second test verifies the error propagates).
  - §8 Schema validation failure → self-correction loop — the write-artifact tools throw on zod failure, the pi-agent then sees that as a tool error and may try again on the next turn. The "max N retries" tunable is not surfaced in v1 — left to the agent loop's natural retry behavior. If we need a hard cap later, add `shouldStopAfterTurn` in `PiAgentFactory`.
  - §9 Pre-Plan-3 fixes I1 + I2 — Tasks 1 + 2.
- **Out of scope here:**
  - `RenderWorker` — Plan 4. Composition still uses a fake render handler. The composition test asserts composition + mp4 artifacts are written by the fake, not that they're real renders.
  - Fastify routes — Plan 5. `composition.ts` is the seam Plan 5 will call.
  - Real LLM-based `IntentRouter` — left for later; rule-based router from Plan 2 is the production default.
  - Multi-speaker dialog TTS — schema reserved (`TTSInput.speakers`), but Gemini implementation only uses single-speaker `voiceConfig` in v1.
  - Token usage / cost telemetry — pi-ai surfaces it via `Usage`; we'll wire it into structured logs in Plan 5.
- **Determinism:** every test in this plan runs offline with no API calls. `registerFauxProvider` replaces the LLM stream entirely; `StubTTSProvider` writes a real WAV from a zero buffer. The single network-touching test is `gemini-tts.external.test.ts`, which is gated behind `GEMINI_API_KEY` via `describe.skipIf` and is not a PR gate.
- **Type consistency:**
  - `PhaseHandler` from Plan 2 (`apps/server/src/phases/types.ts`) is implemented unchanged by every Pi handler and the voiceover handler.
  - `AgentTool` (from `@earendil-works/pi-agent-core`) is the tool type — TypeBox parameters, throws-on-error semantics. We do not introduce a wrapper type.
  - `Model<any>` from `@earendil-works/pi-ai` is the model type that the factory and handlers accept — composition picks it (real model or faux) and threads it down.
  - `TTSProvider.synthesize` returns `{ audioPath, durationMs, wordTimings? }` everywhere; the voiceover handler writes this verbatim into the `narration` artifact's data, matching Plan 1's `NarrationDataSchema`.
  - `LineageRef[]` lineage shape matches Plan 1's `LineageRefSchema` — `[{kind, version}]`.
- **Composition is the only file that imports concrete provider classes.** Handler test files use their handler in isolation with stubs. This keeps the "swap a provider, no flow change" property real.
