# UltraCreator Plan 2 — Orchestrator + IntentRouter + PhaseRegistry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic state machine that drives a session through `research → design → script → [voiceover] → render`, plus the two pluggable pieces it depends on: a `PhaseRegistry` (config-driven phase table) and an `IntentRouter` (user-message → classified intent). The orchestrator runs against **fake phase handlers** so the entire flow is testable without LLM/network/render dependencies. Plan 3 swaps in real Pi-agent handlers; Plan 5 wires this orchestrator behind a Fastify API.

**Architecture:** The orchestrator owns one in-memory `SessionState` per session and a per-session serial queue so messages process in order. On each message it (1) classifies the intent via `IntentRouter.classify(message, state)`, (2) dispatches to the matching handler — `new-project | approve | refine | revise-back | update-brief | abort | branch | ask` — and (3) drives the phase loop. Phase progression is config-driven: `PhaseRegistry.next(phaseId, brief)` walks past disabled phases (voiceover when `withVoiceover=false`). Each phase is executed by a `PhaseHandler` (interface) whose `run(ctx)` yields `ServerEvent`s; the orchestrator forwards them through `EventBus`. `ArtifactStore` (Plan 1) is the only writer of artifact files. Stale propagation: when the user revises back to phase X, every artifact downstream of X is marked stale via `ArtifactStore.markStale`. Abort bypasses the queue and aborts the in-flight phase via `AbortController`.

**Tech Stack:** TypeScript 5.7 strict, zod, vitest. No new runtime deps. Everything builds on Plan 1's `WorkspaceManager`, `EventBus`, `ArtifactStore` and the `@ultracreator/shared` schemas (`Brief`, `PhaseId`, `Intent`, `ServerEvent`, `ArtifactKind`).

**Roadmap context:** Plan 2 of 6. Plan 1 (foundation) is merged. Plan 3 (Pi-agent handlers + providers) replaces the FakePhaseHandlers with real ones. Plan 4 (RenderWorker) replaces the render fake. Plan 5 (Fastify + SSE) exposes the orchestrator over HTTP. Plan 6 (Next.js frontend) consumes it.

---

## File Structure

```
apps/server/src/
  intent/
    intent-router.ts          # IntentRouter interface + RuleBasedIntentRouter + RouterState
  orchestrator/
    state.ts                  # SessionState union (idle | running | awaiting-gate | error | done)
    session-queue.ts          # Per-session serial enqueue (in-memory promise chain)
    stale.ts                  # markStaleDownstream(store, registry, sid, fromPhase)
    session-orchestrator.ts   # SessionOrchestrator class (the state machine)
  phases/
    types.ts                  # PhaseHandler interface + PhaseContext type
    registry.ts               # PhaseConfig, PHASES, PhaseRegistry (getPhase / next / previous / outputs)
    fake-handler.ts           # FakePhaseHandler — deterministic test/dev handler

apps/server/test/
  phase-registry.test.ts
  intent-router.test.ts
  session-queue.test.ts
  stale.test.ts
  orchestrator.test.ts        # all orchestrator behaviors (happy path + per-intent)

packages/shared/src/
  message.ts                  # UserMessageSchema + UserMessage type (added)
  index.ts                    # barrel — re-export message
packages/shared/test/
  schemas.test.ts             # add UserMessage cases
```

**Responsibility boundaries:**
- `PhaseRegistry` — pure config + lookup. No I/O, no state. Knows the phase order, per-phase outputs, gates, and `enabled` predicates.
- `PhaseHandler` — one phase's runtime contract. `run(ctx): AsyncIterable<ServerEvent>`. Writes artifacts via `ctx.artifacts.put`. Yields `phase.progress` events. Plan 2 ships a `FakePhaseHandler`; Plan 3 ships real ones.
- `IntentRouter` — classifies a `UserMessage` + `RouterState` snapshot into a `ClassifiedIntent`. Rule-based for v1 / unit testing; Plan 3 may add an LLM-based implementation.
- `SessionQueue` — generic per-key serial promise queue. Knows nothing about the orchestrator.
- `stale.ts` — pure function: given current phase + registry + store, mark all downstream non-stale artifact versions stale.
- `SessionOrchestrator` — owns `SessionState`, `AbortController` per session, and the initial-message map. Composes everything above. Only this class drives phase execution.

---

## Task 1: UserMessage schema (shared)

**Files:**
- Create: `packages/shared/src/message.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: Write the failing test (append to schemas.test.ts)**

Add to `packages/shared/test/schemas.test.ts`:

```ts
import { UserMessageSchema } from "../src/message.js";

describe("UserMessageSchema", () => {
  it("accepts a first-message payload with text + constraints + uploaded files", () => {
    const v = {
      text: "Make a promo for Acme",
      uploadedFiles: ["uploads/logo.png"],
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
    };
    expect(UserMessageSchema.parse(v)).toEqual(v);
  });

  it("accepts a follow-up message with text only", () => {
    const v = { text: "approve" };
    expect(UserMessageSchema.parse(v)).toEqual(v);
  });

  it("rejects a message missing text", () => {
    expect(() => UserMessageSchema.parse({})).toThrow();
  });

  it("rejects constraints with an invalid aspect ratio", () => {
    const v = {
      text: "hi",
      constraints: { durationSec: 30, aspectRatio: "4:3", withVoiceover: false },
    };
    expect(() => UserMessageSchema.parse(v)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/message.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/message.ts`:

```ts
import { z } from "zod";
import { ConstraintsSchema } from "./constraints.js";

export const UserMessageSchema = z.object({
  text: z.string(),
  uploadedFiles: z.array(z.string()).optional(),
  constraints: ConstraintsSchema.optional(),
});

export type UserMessage = z.infer<typeof UserMessageSchema>;
```

- [ ] **Step 4: Add to the barrel export**

Edit `packages/shared/src/index.ts` — add a new line:

```ts
export * from "./message.js";
```

(The file currently re-exports constraints, brief, design, script, artifact, events, intent. Append the message re-export at the end.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (4 new tests; total now 30).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/message.ts packages/shared/src/index.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add UserMessage schema"
```

---

## Task 2: PhaseRegistry

**Files:**
- Create: `apps/server/src/phases/registry.ts`
- Test: `apps/server/test/phase-registry.test.ts`

`PhaseRegistry` is a thin lookup over a static `PHASES` array. It owns phase order, per-phase outputs (which artifact kinds the phase writes), gates, and the `enabled(brief)` predicate. The orchestrator calls `next(currentId, brief)` to walk to the next *enabled* phase.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/phase-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Brief } from "@ultracreator/shared";
import { PhaseRegistry } from "../src/phases/registry.js";

const baseBrief: Brief = {
  product: { name: "x", tagline: "y", description: "z", category: "c" },
  audience: "a",
  keyMessages: ["m"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

describe("PhaseRegistry", () => {
  const r = new PhaseRegistry();

  it("getPhase returns each phase config in spec order", () => {
    expect(r.getPhase("research").id).toBe("research");
    expect(r.getPhase("design").gates).toEqual(["user-approve"]);
    expect(r.getPhase("script").gates).toEqual(["user-approve"]);
    expect(r.getPhase("voiceover").gates ?? []).toEqual([]);
    expect(r.getPhase("render").gates ?? []).toEqual([]);
  });

  it("research auto-advances to design", () => {
    expect(r.next("research", baseBrief)!.id).toBe("design");
  });

  it("design → script → voiceover when withVoiceover=true", () => {
    const b = { ...baseBrief, constraints: { ...baseBrief.constraints, withVoiceover: true } };
    expect(r.next("design", b)!.id).toBe("script");
    expect(r.next("script", b)!.id).toBe("voiceover");
    expect(r.next("voiceover", b)!.id).toBe("render");
  });

  it("skips voiceover when withVoiceover=false", () => {
    expect(r.next("script", baseBrief)!.id).toBe("render");
  });

  it("render is terminal", () => {
    expect(r.next("render", baseBrief)).toBeNull();
  });

  it("previous walks the canonical chain regardless of enabled()", () => {
    // previous() is for user-driven revise-back navigation, so it ignores
    // enabled() — the user might explicitly target voiceover.
    expect(r.previous("design")!.id).toBe("research");
    expect(r.previous("script")!.id).toBe("design");
    expect(r.previous("voiceover")!.id).toBe("script");
    expect(r.previous("render")!.id).toBe("voiceover");
    expect(r.previous("research")).toBeNull();
  });

  it("outputs returns the artifact kinds each phase writes", () => {
    expect(r.outputs("research")).toEqual(["brief"]);
    expect(r.outputs("design")).toEqual(["design"]);
    expect(r.outputs("script")).toEqual(["script"]);
    expect(r.outputs("voiceover")).toEqual(["narration"]);
    expect(r.outputs("render")).toEqual(["composition", "mp4"]);
  });

  it("downstream returns every phase strictly after the given phase, in order", () => {
    expect(r.downstream("research")).toEqual(["design", "script", "voiceover", "render"]);
    expect(r.downstream("design")).toEqual(["script", "voiceover", "render"]);
    expect(r.downstream("script")).toEqual(["voiceover", "render"]);
    expect(r.downstream("voiceover")).toEqual(["render"]);
    expect(r.downstream("render")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/phase-registry.test.ts`
Expected: FAIL — cannot resolve `../src/phases/registry.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/phases/registry.ts`:

```ts
import type { ArtifactKind, Brief, PhaseId } from "@ultracreator/shared";

export type Gate = "user-approve";

export interface PhaseConfig {
  id: PhaseId;
  outputs: ArtifactKind[];
  gates?: Gate[];
  enabled?: (brief: Brief) => boolean;
}

export const PHASES: readonly PhaseConfig[] = [
  { id: "research", outputs: ["brief"] },
  { id: "design", outputs: ["design"], gates: ["user-approve"] },
  { id: "script", outputs: ["script"], gates: ["user-approve"] },
  {
    id: "voiceover",
    outputs: ["narration"],
    enabled: (brief) => brief.constraints.withVoiceover,
  },
  { id: "render", outputs: ["composition", "mp4"] },
] as const;

export class PhaseRegistry {
  private byId = new Map<PhaseId, PhaseConfig>(PHASES.map((p) => [p.id, p]));

  getPhase(id: PhaseId): PhaseConfig {
    const p = this.byId.get(id);
    if (!p) throw new Error(`Unknown phase: ${id}`);
    return p;
  }

  outputs(id: PhaseId): ArtifactKind[] {
    return this.getPhase(id).outputs;
  }

  /** Next enabled phase after `id`, or null if there is none. */
  next(id: PhaseId, brief: Brief | null): PhaseConfig | null {
    const idx = PHASES.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Unknown phase: ${id}`);
    for (let i = idx + 1; i < PHASES.length; i++) {
      const candidate = PHASES[i]!;
      if (this.isEnabled(candidate, brief)) return candidate;
    }
    return null;
  }

  /** Canonical predecessor (ignores enabled — user may explicitly target a disabled phase). */
  previous(id: PhaseId): PhaseConfig | null {
    const idx = PHASES.findIndex((p) => p.id === id);
    if (idx <= 0) return null;
    return PHASES[idx - 1] ?? null;
  }

  /** All phase ids strictly after `id`, in order, regardless of enabled. */
  downstream(id: PhaseId): PhaseId[] {
    const idx = PHASES.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`Unknown phase: ${id}`);
    return PHASES.slice(idx + 1).map((p) => p.id);
  }

  private isEnabled(p: PhaseConfig, brief: Brief | null): boolean {
    if (!p.enabled) return true;
    // If no brief is available yet, enabled-conditional phases (voiceover) are
    // skipped — callers only ever ask `next()` after research has produced a brief.
    if (!brief) return false;
    return p.enabled(brief);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/phase-registry.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/registry.ts apps/server/test/phase-registry.test.ts
git commit -m "feat(server): add PhaseRegistry (config-driven phase table)"
```

---

## Task 3: PhaseHandler interface + FakePhaseHandler

**Files:**
- Create: `apps/server/src/phases/types.ts`
- Create: `apps/server/src/phases/fake-handler.ts`
- Test: `apps/server/test/fake-handler.test.ts`

`PhaseHandler` is the runtime contract: `run(ctx)` returns an `AsyncIterable<ServerEvent>` that the orchestrator forwards to the bus. Handlers write artifacts through `ctx.artifacts.put` (which emits `artifact.created` itself — handlers MUST NOT re-yield `artifact.created`). `FakePhaseHandler` is the test/dev handler: take a `produce(ctx)` callback that returns the artifacts to write, plus an optional list of progress messages to yield. Plan 3 will add real Pi-agent-backed handlers.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/fake-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-fh-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("FakePhaseHandler", () => {
  it("yields progress events then writes artifacts via the store", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await wm.init("s1");

    const briefData = {
      product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
      audience: "devs",
      keyMessages: ["fast"],
      brandHints: { colors: ["#000"] },
      sourceAssets: { images: [], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    };

    const handler = new FakePhaseHandler({
      phase: "research",
      progress: ["fetching", "summarizing"],
      produce: async () => [{ kind: "brief", data: briefData }],
    });

    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1",
      workspaces: wm,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) {
      yielded.push(e);
    }

    expect(yielded).toEqual([
      { type: "phase.progress", phase: "research", message: "fetching" },
      { type: "phase.progress", phase: "research", message: "summarizing" },
    ]);
    // The store emits artifact.created when produce() writes:
    expect(events).toContainEqual({ type: "artifact.created", kind: "brief", version: 1 });
  });

  it("throws if produce() returns an artifact whose schema is invalid", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await wm.init("s1");

    const handler = new FakePhaseHandler({
      phase: "design",
      produce: async () => [{ kind: "design", data: { mood: "x" } /* missing required fields */ }],
    });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces: wm,
        artifacts: store,
        events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow();
  });

  it("respects abort: throws if signal is aborted before produce()", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await wm.init("s1");

    const controller = new AbortController();
    controller.abort();

    const handler = new FakePhaseHandler({
      phase: "research",
      produce: async () => [],
    });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces: wm,
        artifacts: store,
        events: bus,
        signal: controller.signal,
      })) { /* drain */ }
    }).rejects.toThrow(/abort/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/fake-handler.test.ts`
Expected: FAIL — cannot resolve `../src/phases/fake-handler.js`.

- [ ] **Step 3: Write the interface (`types.ts`)**

Create `apps/server/src/phases/types.ts`:

```ts
import type {
  ArtifactKind,
  LineageRef,
  PhaseId,
  ServerEvent,
  UserMessage,
} from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { EventBus } from "../events/event-bus.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface PhaseContext {
  sessionId: string;
  workspaces: WorkspaceManager;
  artifacts: ArtifactStore;
  events: EventBus;
  /** Present during the first phase of a new project (research). */
  initialMessage?: UserMessage;
  /** Free-form refinement text from the user (refine / revise-back). */
  refinement?: string;
  /** Aborted by the orchestrator when the user issues `abort`. */
  signal: AbortSignal;
}

export interface PhaseHandler {
  readonly phase: PhaseId;
  /** Yields ServerEvents (phase.progress, etc.). Handlers MUST NOT yield artifact.created — ArtifactStore.put emits that itself. */
  run(ctx: PhaseContext): AsyncIterable<ServerEvent>;
}

/** Convenience shape for FakePhaseHandler / future test fixtures. */
export interface ArtifactToWrite {
  kind: ArtifactKind;
  data: unknown;
  derivedFrom?: LineageRef[];
}
```

- [ ] **Step 4: Write the fake (`fake-handler.ts`)**

Create `apps/server/src/phases/fake-handler.ts`:

```ts
import type { PhaseId, ServerEvent } from "@ultracreator/shared";
import type { ArtifactToWrite, PhaseContext, PhaseHandler } from "./types.js";

export interface FakePhaseHandlerOptions {
  phase: PhaseId;
  progress?: string[];
  produce: (ctx: PhaseContext) => Promise<ArtifactToWrite[]>;
}

export class FakePhaseHandler implements PhaseHandler {
  readonly phase: PhaseId;
  private opts: FakePhaseHandlerOptions;

  constructor(opts: FakePhaseHandlerOptions) {
    this.phase = opts.phase;
    this.opts = opts;
  }

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    if (ctx.signal.aborted) throw new Error("Aborted");
    for (const message of this.opts.progress ?? []) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      yield { type: "phase.progress", phase: this.phase, message };
    }
    if (ctx.signal.aborted) throw new Error("Aborted");
    const outputs = await this.opts.produce(ctx);
    for (const out of outputs) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      await ctx.artifacts.put(ctx.sessionId, out.kind, out.data, {
        derivedFrom: out.derivedFrom,
      });
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/fake-handler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/phases/types.ts apps/server/src/phases/fake-handler.ts apps/server/test/fake-handler.test.ts
git commit -m "feat(server): add PhaseHandler interface + FakePhaseHandler"
```

---

## Task 4: IntentRouter + RuleBasedIntentRouter

**Files:**
- Create: `apps/server/src/intent/intent-router.ts`
- Test: `apps/server/test/intent-router.test.ts`

`IntentRouter.classify(message, state)` returns `{ intent, targetPhase? }`. `RuleBasedIntentRouter` is a deterministic keyword-based implementation used for unit tests and as the v1 default. Plan 3 may add an LLM-based router; the interface is the seam.

Classification rules (deterministic, ordered):
1. `/abort`, `abort`, `cancel`, `stop` → `abort`
2. `/back <phase>`, `revise <phase>`, `go back to <phase>` → `revise-back` (with `targetPhase` parsed from the message; falls back to the previous phase if no target is given)
3. `/branch` → `branch`
4. `update <brief-field>` (`duration`, `aspect`, `voiceover`, `audience`) or `/brief` → `update-brief`
5. `state.kind === "idle"` AND `message.constraints` is present → `new-project`
6. `/approve`, `approve`, `ok`, `looks good`, `lgtm`, `ship it` → `approve` (only when state is `awaiting-gate`; otherwise treated as refine)
7. `state.kind === "awaiting-gate" | "error" | "done"` → `refine`
8. Otherwise → `ask`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/intent-router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { UserMessage } from "@ultracreator/shared";
import { RuleBasedIntentRouter, type RouterState } from "../src/intent/intent-router.js";

const idle: RouterState = { kind: "idle" };
const gateDesign: RouterState = { kind: "awaiting-gate", phase: "design" };
const gateScript: RouterState = { kind: "awaiting-gate", phase: "script" };
const runningResearch: RouterState = { kind: "running", phase: "research" };
const doneState: RouterState = { kind: "done", phase: "render" };

const r = new RuleBasedIntentRouter();
const msg = (text: string, extras: Partial<UserMessage> = {}): UserMessage => ({ text, ...extras });

describe("RuleBasedIntentRouter", () => {
  it("classifies abort keywords regardless of state", async () => {
    for (const text of ["/abort", "abort", "cancel", "stop"]) {
      expect((await r.classify(msg(text), runningResearch)).intent).toBe("abort");
    }
  });

  it("classifies new-project when state is idle and constraints are present", async () => {
    const result = await r.classify(
      msg("Make a promo for Acme", { constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false } }),
      idle,
    );
    expect(result.intent).toBe("new-project");
  });

  it("classifies free text in idle without constraints as ask", async () => {
    expect((await r.classify(msg("hello?"), idle)).intent).toBe("ask");
  });

  it("classifies approve keywords at a gate as approve", async () => {
    for (const text of ["/approve", "approve", "ok", "looks good", "lgtm", "ship it"]) {
      expect((await r.classify(msg(text), gateDesign)).intent).toBe("approve");
    }
  });

  it("classifies non-keyword text at a gate as refine", async () => {
    expect((await r.classify(msg("warmer colors please"), gateDesign)).intent).toBe("refine");
  });

  it("classifies approve keywords when not at a gate as refine", async () => {
    // "approve" said while running has no gate to approve — treat as refine.
    expect((await r.classify(msg("approve"), runningResearch)).intent).toBe("refine");
  });

  it("parses targetPhase from revise-back commands", async () => {
    const a = await r.classify(msg("/back design"), gateScript);
    expect(a.intent).toBe("revise-back");
    expect(a.targetPhase).toBe("design");

    const b = await r.classify(msg("go back to research"), gateScript);
    expect(b.intent).toBe("revise-back");
    expect(b.targetPhase).toBe("research");

    const c = await r.classify(msg("revise design"), gateScript);
    expect(c.intent).toBe("revise-back");
    expect(c.targetPhase).toBe("design");
  });

  it("revise-back without an explicit target falls back to the previous phase", async () => {
    const a = await r.classify(msg("/back"), gateScript);
    expect(a.intent).toBe("revise-back");
    expect(a.targetPhase).toBe("design");
  });

  it("classifies brief-update keywords as update-brief", async () => {
    expect((await r.classify(msg("update duration to 60s"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("change aspect ratio to 9:16"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("turn voiceover off"), gateDesign)).intent).toBe("update-brief");
    expect((await r.classify(msg("/brief"), gateDesign)).intent).toBe("update-brief");
  });

  it("classifies /branch as branch", async () => {
    expect((await r.classify(msg("/branch"), gateDesign)).intent).toBe("branch");
  });

  it("classifies refine from done state (post-render touch-ups)", async () => {
    expect((await r.classify(msg("make it bluer"), doneState)).intent).toBe("refine");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/intent-router.test.ts`
Expected: FAIL — cannot resolve `../src/intent/intent-router.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/intent/intent-router.ts`:

```ts
import {
  PHASE_IDS,
  type Intent,
  type PhaseId,
  type UserMessage,
} from "@ultracreator/shared";

/** Minimal state snapshot the router needs — decoupled from SessionOrchestrator. */
export interface RouterState {
  kind: "idle" | "running" | "awaiting-gate" | "error" | "done";
  phase?: PhaseId;
}

export interface ClassifiedIntent {
  intent: Intent;
  /** Set when intent is revise-back. */
  targetPhase?: PhaseId;
}

export interface IntentRouter {
  classify(message: UserMessage, state: RouterState): Promise<ClassifiedIntent>;
}

const ABORT_KEYWORDS = ["/abort", "abort", "cancel", "stop"];
const APPROVE_KEYWORDS = ["/approve", "approve", "ok", "okay", "looks good", "lgtm", "ship it"];
const BRIEF_KEYWORDS = ["duration", "aspect", "ratio", "voiceover", "audience"];
const PHASE_NAMES = PHASE_IDS as readonly PhaseId[];

const PHASE_ORDER: PhaseId[] = [...PHASE_NAMES];
function previousPhase(p: PhaseId): PhaseId | null {
  const idx = PHASE_ORDER.indexOf(p);
  if (idx <= 0) return null;
  return PHASE_ORDER[idx - 1] ?? null;
}

function findPhaseInText(text: string): PhaseId | undefined {
  const lower = text.toLowerCase();
  for (const id of PHASE_NAMES) {
    // word-boundary match so "script" doesn't trigger on "description"
    const re = new RegExp(`\\b${id}\\b`, "i");
    if (re.test(lower)) return id;
  }
  return undefined;
}

function containsAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((n) => lower.includes(n));
}

function isCommand(text: string, prefix: string): boolean {
  return text.trim().toLowerCase().startsWith(prefix);
}

export class RuleBasedIntentRouter implements IntentRouter {
  async classify(message: UserMessage, state: RouterState): Promise<ClassifiedIntent> {
    const text = message.text;

    // 1. abort — bypasses everything
    if (containsAny(text, ABORT_KEYWORDS)) return { intent: "abort" };

    // 2. revise-back
    if (
      isCommand(text, "/back") ||
      /\b(go back to|revise|back to)\b/i.test(text)
    ) {
      const targetPhase = findPhaseInText(text)
        ?? (state.phase ? previousPhase(state.phase) ?? undefined : undefined);
      return { intent: "revise-back", targetPhase };
    }

    // 3. branch
    if (isCommand(text, "/branch")) return { intent: "branch" };

    // 4. update-brief
    if (isCommand(text, "/brief") || containsAny(text, BRIEF_KEYWORDS)) {
      return { intent: "update-brief" };
    }

    // 5. new-project
    if (state.kind === "idle" && message.constraints !== undefined) {
      return { intent: "new-project" };
    }

    // 6. approve keywords — only count as approve at a gate; otherwise refine
    if (containsAny(text, APPROVE_KEYWORDS)) {
      if (state.kind === "awaiting-gate") return { intent: "approve" };
      return { intent: "refine" };
    }

    // 7. refine — any free text while there's something to refine
    if (state.kind === "awaiting-gate" || state.kind === "error" || state.kind === "done") {
      return { intent: "refine" };
    }

    // 8. fallback
    return { intent: "ask" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/intent-router.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/intent/intent-router.ts apps/server/test/intent-router.test.ts
git commit -m "feat(server): add IntentRouter interface + RuleBasedIntentRouter"
```

---

## Task 5: Stale-propagation helper

**Files:**
- Create: `apps/server/src/orchestrator/stale.ts`
- Test: `apps/server/test/stale.test.ts`

When the user revises back to phase X, every artifact downstream of X should be marked stale (kept on disk, flagged via `ArtifactStore.markStale`). `markStaleDownstream` walks `PhaseRegistry.downstream(fromPhase)`, looks up each phase's `outputs`, and marks the **latest non-stale** version of each kind as stale.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/stale.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { markStaleDownstream } from "../src/orchestrator/stale.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-stale-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const brief = {
  product: { name: "x", tagline: "y", description: "z", category: "c" },
  audience: "a",
  keyMessages: ["m"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
};
const design = {
  mood: "x",
  palette: [{ name: "p", hex: "#000" }],
  typography: { heading: "A", body: "B" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const script = {
  totalSec: 30,
  scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "v" }],
};

async function seedFullChain(store: ArtifactStore) {
  await store.put("s1", "brief", brief);
  await store.put("s1", "design", design, { derivedFrom: [{ kind: "brief", version: 1 }] });
  await store.put("s1", "script", script, { derivedFrom: [{ kind: "design", version: 1 }] });
  await store.put("s1", "narration", { audioPath: "n.mp3", durationMs: 10000 });
  await store.put("s1", "composition", { dir: "composition", entry: "index.html" });
  await store.put("s1", "mp4", { path: "output/out.mp4" });
}

describe("markStaleDownstream", () => {
  it("marks design/script/narration/composition/mp4 stale when revising back to research", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    const registry = new PhaseRegistry();
    await wm.init("s1");
    await seedFullChain(store);

    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    await markStaleDownstream(store, registry, "s1", "research");

    const list = await store.list("s1");
    const byKind = Object.fromEntries(list.map((d) => [d.kind, d]));
    expect(byKind.brief!.stale).toBe(false);   // research output is NOT marked stale (target phase is research)
    expect(byKind.design!.stale).toBe(true);
    expect(byKind.script!.stale).toBe(true);
    expect(byKind.narration!.stale).toBe(true);
    expect(byKind.composition!.stale).toBe(true);
    expect(byKind.mp4!.stale).toBe(true);

    for (const kind of ["design", "script", "narration", "composition", "mp4"] as const) {
      expect(events).toContainEqual({ type: "artifact.stale", kind, version: 1 });
    }
  });

  it("only marks downstream of design (script and below)", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    const registry = new PhaseRegistry();
    await wm.init("s1");
    await seedFullChain(store);

    await markStaleDownstream(store, registry, "s1", "design");
    const list = await store.list("s1");
    const byKind = Object.fromEntries(list.map((d) => [d.kind, d]));
    expect(byKind.brief!.stale).toBe(false);
    expect(byKind.design!.stale).toBe(false); // the target phase's output stays valid
    expect(byKind.script!.stale).toBe(true);
    expect(byKind.narration!.stale).toBe(true);
    expect(byKind.composition!.stale).toBe(true);
    expect(byKind.mp4!.stale).toBe(true);
  });

  it("is a no-op when revising back to render (no downstream phases)", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    const registry = new PhaseRegistry();
    await wm.init("s1");
    await seedFullChain(store);

    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));

    await markStaleDownstream(store, registry, "s1", "render");
    expect(events.filter((e) => e.type === "artifact.stale")).toEqual([]);
  });

  it("skips a phase whose output isn't on disk yet", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    const registry = new PhaseRegistry();
    await wm.init("s1");
    // Only brief and design exist.
    await store.put("s1", "brief", brief);
    await store.put("s1", "design", design);

    await markStaleDownstream(store, registry, "s1", "research");
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "design")!.stale).toBe(true);
    // script/narration/composition/mp4 don't exist; nothing to mark.
    expect(list.find((d) => d.kind === "script")).toBeUndefined();
  });

  it("marks only the latest non-stale version when multiple versions exist", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    const registry = new PhaseRegistry();
    await wm.init("s1");
    await store.put("s1", "brief", brief);
    await store.put("s1", "design", design);
    await store.put("s1", "design", { ...design, mood: "premium" });
    // v1 is already not-latest; mark it stale via the store manually for setup:
    await store.markStale("s1", "design", 1);

    await markStaleDownstream(store, registry, "s1", "research");
    const list = await store.list("s1");
    const designs = list.filter((d) => d.kind === "design");
    expect(designs.find((d) => d.version === 1)!.stale).toBe(true); // was already stale
    expect(designs.find((d) => d.version === 2)!.stale).toBe(true); // newly stale
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/stale.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator/stale.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/orchestrator/stale.ts`:

```ts
import type { ArtifactKind, PhaseId } from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { PhaseRegistry } from "../phases/registry.js";

/**
 * Marks every artifact downstream of `fromPhase` as stale.
 *
 * "Downstream" = phases strictly after `fromPhase` per PhaseRegistry.downstream().
 * For each kind output by a downstream phase, the latest non-stale version
 * on disk is flagged via ArtifactStore.markStale. Older already-stale versions
 * are left alone; phases with no artifact yet are skipped.
 *
 * The target phase's own outputs are NOT touched — they remain the basis for
 * the re-run.
 */
export async function markStaleDownstream(
  store: ArtifactStore,
  registry: PhaseRegistry,
  sessionId: string,
  fromPhase: PhaseId,
): Promise<void> {
  const descriptors = await store.list(sessionId);
  const downstreamPhases = registry.downstream(fromPhase);

  const downstreamKinds: ArtifactKind[] = [];
  for (const phase of downstreamPhases) {
    downstreamKinds.push(...registry.outputs(phase));
  }

  for (const kind of downstreamKinds) {
    const versions = descriptors.filter((d) => d.kind === kind);
    if (versions.length === 0) continue;
    const latest = versions.reduce((a, b) => (b.version > a.version ? b : a));
    if (latest.stale) continue;
    await store.markStale(sessionId, kind, latest.version);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/stale.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/stale.ts apps/server/test/stale.test.ts
git commit -m "feat(server): add downstream stale-propagation helper"
```

---

## Task 6: Per-session SessionQueue

**Files:**
- Create: `apps/server/src/orchestrator/session-queue.ts`
- Test: `apps/server/test/session-queue.test.ts`

A tiny per-key serial promise queue. The orchestrator uses it to enforce "one logical lock per session" (spec §8) — messages for the same session run in order; different sessions run concurrently. Errors in one task do not block subsequent tasks for the same session.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/session-queue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SessionQueue } from "../src/orchestrator/session-queue.js";

describe("SessionQueue", () => {
  it("runs tasks for the same session in FIFO order", async () => {
    const q = new SessionQueue();
    const order: number[] = [];
    const t1 = q.enqueue("s1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const t2 = q.enqueue("s1", async () => {
      order.push(2);
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual([1, 2]);
  });

  it("runs tasks for different sessions concurrently", async () => {
    const q = new SessionQueue();
    const order: string[] = [];
    const t1 = q.enqueue("a", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    });
    const t2 = q.enqueue("b", async () => {
      order.push("b"); // should win because a sleeps
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual(["b", "a"]);
  });

  it("propagates the task's resolved value to enqueue's caller", async () => {
    const q = new SessionQueue();
    const v = await q.enqueue("s1", async () => 42);
    expect(v).toBe(42);
  });

  it("propagates task errors to enqueue's caller and keeps the queue alive", async () => {
    const q = new SessionQueue();
    const order: string[] = [];
    const t1 = q.enqueue("s1", async () => { throw new Error("boom"); });
    const t2 = q.enqueue("s1", async () => { order.push("ran"); });
    await expect(t1).rejects.toThrow("boom");
    await t2;
    expect(order).toEqual(["ran"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/session-queue.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator/session-queue.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/orchestrator/session-queue.ts`:

```ts
/**
 * Per-key serial queue: tasks enqueued with the same key run one at a time
 * in FIFO order; tasks under different keys run concurrently. Task errors do
 * not block subsequent tasks (the tail is updated regardless of resolution).
 */
export class SessionQueue {
  private tails = new Map<string, Promise<unknown>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task); // run on both resolve and reject of prev
    // Keep the chain alive even if `next` rejects — swallow at the tail level only.
    this.tails.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/session-queue.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/session-queue.ts apps/server/test/session-queue.test.ts
git commit -m "feat(server): add per-session serial SessionQueue"
```

---

## Task 7: SessionState + SessionOrchestrator skeleton + new-project flow

**Files:**
- Create: `apps/server/src/orchestrator/state.ts`
- Create: `apps/server/src/orchestrator/session-orchestrator.ts`
- Test: `apps/server/test/orchestrator.test.ts`

This task lands the orchestrator class with the new-project flow only. The phase loop, gate handling, error/abort hooks, and event emission are all wired here because new-project exercises the full vertical: classify → start → init workspace → run research handler (auto-advance, no gate) → run design handler (gate) → emit gate.awaiting → settle to `awaiting-gate:design`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/orchestrator.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, ServerEvent, UserMessage } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";
import type { PhaseHandler } from "../src/phases/types.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-orch-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Reusable fixture: a brief built from the initial message's constraints.
const briefFor = (m: UserMessage): Brief => ({
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: m.constraints ?? { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
});

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
  scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "v" }],
};

function buildHandlers(): Map<string, PhaseHandler> {
  return new Map<string, PhaseHandler>([
    ["research", new FakePhaseHandler({
      phase: "research",
      progress: ["scraping"],
      produce: async (ctx) => [{ kind: "brief", data: briefFor(ctx.initialMessage!) }],
    })],
    ["design", new FakePhaseHandler({
      phase: "design",
      produce: async () => [{ kind: "design", data: designData }],
    })],
    ["script", new FakePhaseHandler({
      phase: "script",
      produce: async () => [{ kind: "script", data: scriptData }],
    })],
    ["voiceover", new FakePhaseHandler({
      phase: "voiceover",
      produce: async () => [{ kind: "narration", data: { audioPath: "n.mp3", durationMs: 10000 } }],
    })],
    ["render", new FakePhaseHandler({
      phase: "render",
      produce: async () => [
        { kind: "composition", data: { dir: "composition", entry: "index.html" } },
        { kind: "mp4", data: { path: "output/out.mp4" } },
      ],
    })],
  ]);
}

function buildOrchestrator() {
  const workspaces = new WorkspaceManager(root);
  const events = new EventBus();
  const artifacts = new ArtifactStore(workspaces, events);
  const phases = new PhaseRegistry();
  const intentRouter = new RuleBasedIntentRouter();
  const handlers = buildHandlers() as Map<import("@ultracreator/shared").PhaseId, PhaseHandler>;
  const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers });
  return { orch, workspaces, events, artifacts, phases };
}

describe("SessionOrchestrator: new-project", () => {
  it("getState returns idle for an unknown session", () => {
    const { orch } = buildOrchestrator();
    expect(orch.getState("nope")).toEqual({ kind: "idle" });
  });

  it("runs research → design and settles at awaiting-gate:design", async () => {
    const { orch, events } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    const types = seen.map((e) => e.type);
    // Order: phase.started:research, phase.progress, artifact.created:brief,
    //        phase.started:design, artifact.created:design, gate.awaiting:design
    expect(types).toEqual([
      "phase.started",
      "phase.progress",
      "artifact.created",
      "phase.started",
      "artifact.created",
      "gate.awaiting",
    ]);
    expect(seen[0]).toMatchObject({ type: "phase.started", phase: "research" });
    expect(seen[3]).toMatchObject({ type: "phase.started", phase: "design" });
    expect(seen.at(-1)).toEqual({ type: "gate.awaiting", phase: "design" });
  });

  it("emits phase.error and stops if a handler throws", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async () => { throw new Error("scrape failed"); },
      })],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers });

    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    expect(orch.getState("s1")).toEqual({
      kind: "error",
      phase: "research",
      error: "scrape failed",
    });
    expect(seen.at(-1)).toEqual({ type: "phase.error", phase: "research", error: "scrape failed" });
  });

  it("ignores a non-new-project first message (no constraints)", async () => {
    const { orch } = buildOrchestrator();
    // Classified as "ask" — orchestrator is a no-op.
    await orch.handleMessage("s1", { text: "hi" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../src/orchestrator/session-orchestrator.js`.

- [ ] **Step 3: Write `state.ts`**

Create `apps/server/src/orchestrator/state.ts`:

```ts
import type { PhaseId } from "@ultracreator/shared";

export type SessionState =
  | { kind: "idle" }
  | { kind: "running"; phase: PhaseId }
  | { kind: "awaiting-gate"; phase: PhaseId }
  | { kind: "error"; phase: PhaseId; error: string }
  | { kind: "done"; lastPhase: PhaseId };
```

- [ ] **Step 4: Write `session-orchestrator.ts`**

Create `apps/server/src/orchestrator/session-orchestrator.ts`:

```ts
import type {
  Brief,
  PhaseId,
  UserMessage,
} from "@ultracreator/shared";
import type { ArtifactStore } from "../artifacts/artifact-store.js";
import type { EventBus } from "../events/event-bus.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { IntentRouter, RouterState } from "../intent/intent-router.js";
import type { PhaseHandler, PhaseContext } from "../phases/types.js";
import type { PhaseRegistry } from "../phases/registry.js";
import { SessionQueue } from "./session-queue.js";
import type { SessionState } from "./state.js";

export type { SessionState } from "./state.js";

export interface OrchestratorDeps {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  intentRouter: IntentRouter;
  handlers: ReadonlyMap<PhaseId, PhaseHandler>;
}

export class SessionOrchestrator {
  private states = new Map<string, SessionState>();
  private queue = new SessionQueue();
  private controllers = new Map<string, AbortController>();
  private initialMessages = new Map<string, UserMessage>();

  constructor(private deps: OrchestratorDeps) {}

  getState(sessionId: string): SessionState {
    return this.states.get(sessionId) ?? { kind: "idle" };
  }

  async handleMessage(sessionId: string, message: UserMessage): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      const routerState = this.toRouterState(this.getState(sessionId));
      const { intent } = await this.deps.intentRouter.classify(message, routerState);
      switch (intent) {
        case "new-project":
          await this.startNewProject(sessionId, message);
          break;
        // Other intents land in later tasks. For now, no-op.
        default:
          return;
      }
    });
  }

  // ---- private ----

  private toRouterState(state: SessionState): RouterState {
    switch (state.kind) {
      case "idle":
        return { kind: "idle" };
      case "running":
      case "awaiting-gate":
      case "error":
        return { kind: state.kind, phase: state.phase };
      case "done":
        return { kind: "done", phase: state.lastPhase };
    }
  }

  private async startNewProject(sessionId: string, message: UserMessage): Promise<void> {
    await this.deps.workspaces.init(sessionId);
    this.initialMessages.set(sessionId, message);
    await this.runFromPhase(sessionId, "research");
  }

  private async getBrief(sessionId: string): Promise<Brief | null> {
    const env = await this.deps.artifacts.get<Brief>(sessionId, "brief");
    return env?.data ?? null;
  }

  /**
   * Run `phaseId` and auto-advance through subsequent phases until a gate,
   * error, or the end of the chain is reached.
   */
  private async runFromPhase(
    sessionId: string,
    phaseId: PhaseId,
    refinement?: string,
  ): Promise<void> {
    let current: PhaseId | null = phaseId;
    let nextRefinement = refinement;
    while (current) {
      await this.runPhase(sessionId, current, nextRefinement);
      nextRefinement = undefined;
      const state = this.getState(sessionId);
      // runPhase ended in either awaiting-gate, error, or success-without-gate
      // (state still "running" — i.e. ready to advance).
      if (state.kind !== "running") return;
      const brief = await this.getBrief(sessionId);
      const next = this.deps.phases.next(current, brief);
      if (!next) {
        this.states.set(sessionId, { kind: "done", lastPhase: current });
        return;
      }
      current = next.id;
    }
  }

  private async runPhase(
    sessionId: string,
    phaseId: PhaseId,
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

    const controller = new AbortController();
    this.controllers.set(sessionId, controller);

    const ctx: PhaseContext = {
      sessionId,
      workspaces: this.deps.workspaces,
      artifacts: this.deps.artifacts,
      events: this.deps.events,
      initialMessage: this.initialMessages.get(sessionId),
      refinement,
      signal: controller.signal,
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
    } finally {
      this.controllers.delete(sessionId);
    }

    if (config.gates?.includes("user-approve")) {
      this.states.set(sessionId, { kind: "awaiting-gate", phase: phaseId });
      this.deps.events.emit(sessionId, { type: "gate.awaiting", phase: phaseId });
    }
    // else: stays "running"; runFromPhase will advance to the next phase.
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestrator/state.ts apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): add SessionOrchestrator skeleton + new-project flow"
```

---

## Task 8: Orchestrator — approve (advance through phases + voiceover skip)

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/test/orchestrator.test.ts`

Approve only matters at `awaiting-gate`. It computes the next enabled phase (skipping voiceover when `withVoiceover=false`) and re-enters the loop. Once render completes — render has no gate and no successor — state settles to `{ kind: "done", lastPhase: "render" }`.

- [ ] **Step 1: Write the failing tests (append to orchestrator.test.ts)**

Add to `apps/server/test/orchestrator.test.ts`:

```ts
describe("SessionOrchestrator: approve", () => {
  it("happy path: new-project → approve(design) → approve(script) → done (skips voiceover when withVoiceover=false)", async () => {
    const { orch, events, artifacts } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orch.handleMessage("s1", { text: "looks good" });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    // voiceover was skipped — no narration artifact written.
    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "narration")).toBeUndefined();
    expect(list.find((d) => d.kind === "mp4")).toBeDefined();
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("includes the voiceover phase when withVoiceover=true", async () => {
    const { orch, artifacts } = buildOrchestrator();

    await orch.handleMessage("s1", {
      text: "Make a promo",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
    });
    await orch.handleMessage("s1", { text: "approve" }); // approve design
    await orch.handleMessage("s1", { text: "approve" }); // approve script
    expect(orch.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "narration")).toBeDefined();
  });

  it("approve outside a gate is a no-op", async () => {
    const { orch } = buildOrchestrator();
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
    await orch.handleMessage("s1", { text: "approve" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: FAIL — approve is currently a no-op; state stays at `awaiting-gate:design` after the first "looks good".

- [ ] **Step 3: Implement approve in the orchestrator**

In `apps/server/src/orchestrator/session-orchestrator.ts`, replace the `switch (intent)` body inside `handleMessage` with the expanded form:

```ts
      switch (intent) {
        case "new-project":
          await this.startNewProject(sessionId, message);
          break;
        case "approve":
          await this.approve(sessionId);
          break;
        default:
          return;
      }
```

Then add the `approve` method to the class (place it next to `startNewProject`):

```ts
  private async approve(sessionId: string): Promise<void> {
    const state = this.getState(sessionId);
    if (state.kind !== "awaiting-gate") return;
    const brief = await this.getBrief(sessionId);
    const next = this.deps.phases.next(state.phase, brief);
    if (!next) {
      this.states.set(sessionId, { kind: "done", lastPhase: state.phase });
      return;
    }
    await this.runFromPhase(sessionId, next.id);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): orchestrator approve advances through phases"
```

---

## Task 9: Orchestrator — refine

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/test/orchestrator.test.ts`

Refine re-runs the currently-active phase (the one at the gate, the one that errored, or the last completed phase in `done`) with the user's text as `ctx.refinement`. It writes a new artifact version derived from the previous version of the same kind.

For the test, we need a handler that **observes** the refinement and increments versions. The existing `FakePhaseHandler` already passes `ctx` through to `produce` — we just write a design with `derivedFrom` pointing at the prior version.

- [ ] **Step 1: Write the failing tests (append)**

Add to `apps/server/test/orchestrator.test.ts`:

```ts
describe("SessionOrchestrator: refine", () => {
  it("re-runs the gated phase with the refinement text and creates a new version", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();

    const refinements: string[] = [];
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async (ctx) => [{ kind: "brief", data: briefFor(ctx.initialMessage!) }],
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async (ctx) => {
          if (ctx.refinement) refinements.push(ctx.refinement);
          const existing = await ctx.artifacts.get("s1", "design");
          const data = { ...designData, mood: ctx.refinement ?? "energetic" };
          return [{
            kind: "design",
            data,
            derivedFrom: existing
              ? [{ kind: "design" as const, version: existing.version }]
              : [{ kind: "brief" as const, version: 1 }],
          }];
        },
      })],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers });

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orch.handleMessage("s1", { text: "warmer colors please" });

    expect(refinements).toEqual(["warmer colors please"]);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    const list = await artifacts.list("s1");
    const designs = list.filter((d) => d.kind === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]!.derivedFrom).toEqual([{ kind: "design", version: 1 }]);

    const latest = await artifacts.get<typeof designData>("s1", "design");
    expect(latest!.data.mood).toBe("warmer colors please");
  });

  it("refine in idle state is a no-op", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", { text: "hello?" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: FAIL — refine is still in the `default` branch; the second message classifies as `refine` and no-ops.

- [ ] **Step 3: Implement refine**

Extend `handleMessage`'s switch in `session-orchestrator.ts`:

```ts
      switch (intent) {
        case "new-project":
          await this.startNewProject(sessionId, message);
          break;
        case "approve":
          await this.approve(sessionId);
          break;
        case "refine":
          await this.refine(sessionId, message);
          break;
        default:
          return;
      }
```

Add the `refine` method and a small helper:

```ts
  private async refine(sessionId: string, message: UserMessage): Promise<void> {
    const phase = this.activePhase(sessionId);
    if (!phase) return;
    await this.runFromPhase(sessionId, phase, message.text);
  }

  private activePhase(sessionId: string): PhaseId | null {
    const state = this.getState(sessionId);
    if (state.kind === "running" || state.kind === "awaiting-gate" || state.kind === "error") {
      return state.phase;
    }
    if (state.kind === "done") return state.lastPhase;
    return null;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): orchestrator refine re-runs current phase"
```

---

## Task 10: Orchestrator — revise-back + update-brief

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/test/orchestrator.test.ts`

`revise-back` jumps to the user-specified phase (parsed by `IntentRouter`), marks all downstream artifacts stale via `markStaleDownstream`, and re-enters the loop from the target phase. `update-brief` is identical to `revise-back("research")` in v1 — the user's text becomes the refinement passed to the research handler. The router emits `targetPhase` for `revise-back`; if it's missing (e.g. ambiguous "/back"), the orchestrator falls back to the previous phase via `PhaseRegistry.previous(activePhase)`.

- [ ] **Step 1: Write the failing tests (append)**

Add to `apps/server/test/orchestrator.test.ts`:

```ts
describe("SessionOrchestrator: revise-back + update-brief", () => {
  it("revise-back to design while at script gate: marks script stale and re-enters design", async () => {
    const { orch, events, artifacts } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // now awaiting-gate:script
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });

    await orch.handleMessage("s1", { text: "go back to design and use warmer colors" });

    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    const list = await artifacts.list("s1");
    const script = list.find((d) => d.kind === "script")!;
    expect(script.stale).toBe(true);

    // A new design version was created (v2) — derived per the handler's setup.
    const designs = list.filter((d) => d.kind === "design");
    expect(designs).toHaveLength(2);

    // The stale event for the prior script version was emitted.
    expect(seen).toContainEqual({ type: "artifact.stale", kind: "script", version: 1 });
  });

  it("revise-back without an explicit target falls back to the previous phase", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // awaiting-gate:script
    await orch.handleMessage("s1", { text: "/back" }); // no explicit target → previous(script) = design
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("update-brief at script gate: marks downstream stale and re-runs research", async () => {
    const { orch, artifacts } = buildOrchestrator();
    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await orch.handleMessage("s1", { text: "approve" }); // awaiting-gate:script
    await orch.handleMessage("s1", { text: "change duration to 60s" });

    // Lands at awaiting-gate:design after re-running research + design.
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    const list = await artifacts.list("s1");
    expect(list.find((d) => d.kind === "script")!.stale).toBe(true);
    // research and design both produced new versions (v2).
    expect(list.filter((d) => d.kind === "brief")).toHaveLength(2);
    expect(list.filter((d) => d.kind === "design")).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: FAIL — revise-back / update-brief fall through to the `default` no-op.

- [ ] **Step 3: Implement revise-back and update-brief**

In `apps/server/src/orchestrator/session-orchestrator.ts`, add the import:

```ts
import { markStaleDownstream } from "./stale.js";
```

Extend `handleMessage` — also capture `targetPhase` from the classifier:

```ts
      const routerState = this.toRouterState(this.getState(sessionId));
      const { intent, targetPhase } = await this.deps.intentRouter.classify(message, routerState);
      switch (intent) {
        case "new-project":
          await this.startNewProject(sessionId, message);
          break;
        case "approve":
          await this.approve(sessionId);
          break;
        case "refine":
          await this.refine(sessionId, message);
          break;
        case "revise-back": {
          const target = targetPhase
            ?? this.previousPhaseOfActive(sessionId);
          if (target) await this.reviseBack(sessionId, target, message.text);
          break;
        }
        case "update-brief":
          await this.reviseBack(sessionId, "research", message.text);
          break;
        default:
          return;
      }
```

Add the helper methods:

```ts
  private previousPhaseOfActive(sessionId: string): PhaseId | null {
    const phase = this.activePhase(sessionId);
    if (!phase) return null;
    return this.deps.phases.previous(phase)?.id ?? null;
  }

  private async reviseBack(
    sessionId: string,
    target: PhaseId,
    refinement: string,
  ): Promise<void> {
    await markStaleDownstream(this.deps.artifacts, this.deps.phases, sessionId, target);
    await this.runFromPhase(sessionId, target, refinement);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): orchestrator revise-back + update-brief with stale propagation"
```

---

## Task 11: Orchestrator — abort (bypass queue) + branch/ask no-ops

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/test/orchestrator.test.ts`

Abort is special: it must not sit behind a queued task — the whole point is to interrupt the in-flight run. The orchestrator pre-classifies the message *outside* the queue, and if it is `abort`, calls `controllers.get(sessionId)?.abort()` synchronously. For any other intent it enqueues normally. `branch` and `ask` are explicit v1 no-ops (Plan 3 wires `ask` to the agent; `branch` is deferred).

- [ ] **Step 1: Write the failing tests (append)**

Add to `apps/server/test/orchestrator.test.ts`:

```ts
describe("SessionOrchestrator: abort + branch/ask", () => {
  it("abort cancels the in-flight phase", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();

    const slowResearch = new FakePhaseHandler({
      phase: "research",
      produce: (ctx) => new Promise((_resolve, reject) => {
        if (ctx.signal.aborted) reject(new Error("Aborted"));
        ctx.signal.addEventListener("abort", () => reject(new Error("Aborted")));
        // Never resolves on its own.
      }),
    });
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", slowResearch],
    ]);
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers });

    // Start, but do NOT await — research will hang.
    const started = orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    // Give the research handler a tick to enter `produce`.
    await new Promise((r) => setTimeout(r, 10));
    expect(orch.getState("s1")).toEqual({ kind: "running", phase: "research" });

    // Abort bypasses the queue and aborts the in-flight controller.
    await orch.handleMessage("s1", { text: "abort" });

    // The originally-started call now settles (research rejected → error state).
    await started;

    const state = orch.getState("s1");
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.phase).toBe("research");
      expect(state.error).toMatch(/abort/i);
    }
  });

  it("abort with nothing running is a no-op (no throw, state unchanged)", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", { text: "abort" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });

  it("branch is a v1 no-op", async () => {
    const { orch } = buildOrchestrator();
    await orch.handleMessage("s1", {
      text: "Start",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    const before = orch.getState("s1");
    await orch.handleMessage("s1", { text: "/branch" });
    expect(orch.getState("s1")).toEqual(before);
  });

  it("ask is a v1 no-op", async () => {
    const { orch } = buildOrchestrator();
    // ask is classified for idle-state free text without constraints.
    await orch.handleMessage("s1", { text: "what does this do?" });
    expect(orch.getState("s1")).toEqual({ kind: "idle" });
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: FAIL — abort is queued behind the hanging research, so the `started` promise never settles; the test times out.

- [ ] **Step 3: Implement abort bypass + branch/ask no-ops**

In `apps/server/src/orchestrator/session-orchestrator.ts`, restructure `handleMessage` so the pre-classification check runs outside the queue:

```ts
  async handleMessage(sessionId: string, message: UserMessage): Promise<void> {
    // Pre-classify OUTSIDE the queue so abort can bypass an in-flight phase.
    const preClass = await this.deps.intentRouter.classify(
      message,
      this.toRouterState(this.getState(sessionId)),
    );
    if (preClass.intent === "abort") {
      this.controllers.get(sessionId)?.abort();
      return;
    }

    return this.queue.enqueue(sessionId, async () => {
      // Re-classify inside the queue: state may have advanced while we waited.
      const routerState = this.toRouterState(this.getState(sessionId));
      const { intent, targetPhase } = await this.deps.intentRouter.classify(message, routerState);
      switch (intent) {
        case "new-project":
          await this.startNewProject(sessionId, message);
          break;
        case "approve":
          await this.approve(sessionId);
          break;
        case "refine":
          await this.refine(sessionId, message);
          break;
        case "revise-back": {
          const target = targetPhase ?? this.previousPhaseOfActive(sessionId);
          if (target) await this.reviseBack(sessionId, target, message.text);
          break;
        }
        case "update-brief":
          await this.reviseBack(sessionId, "research", message.text);
          break;
        case "abort":
          // Defensive: state changed between the pre-classify and now; abort
          // again here. Idempotent because controllers map is empty if nothing
          // is running.
          this.controllers.get(sessionId)?.abort();
          break;
        case "branch":
        case "ask":
          // v1 no-ops. Plan 3 wires `ask` to the Pi agent.
          break;
      }
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS (16 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): orchestrator abort bypasses queue; branch/ask are v1 no-ops"
```

---

## Task 12: Full suite + typecheck green

**Files:** none (verification task)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — every suite from Plan 1 still green plus:
- `phase-registry.test.ts` (8)
- `fake-handler.test.ts` (3)
- `intent-router.test.ts` (11)
- `session-queue.test.ts` (4)
- `stale.test.ts` (5)
- `orchestrator.test.ts` (16)
- `schemas.test.ts` total now 30 (added 4 in Task 1)

- [ ] **Step 2: Run the typechecker**

Run: `pnpm typecheck`
Expected: exits 0 with no errors in either `@ultracreator/shared` or `@ultracreator/server`.

- [ ] **Step 3: Final commit if anything changed**

```bash
git add -A
git commit -m "chore: orchestrator engine green (tests + typecheck)" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:**
  - State machine `RESEARCH → DESIGN → SCRIPT → [VOICEOVER] → RENDER` with approval gates on DESIGN and SCRIPT — Tasks 2 (registry) + 7–8 (orchestrator + approve).
  - `IntentRouter.classify(msg, state) → Intent` per §5 — Task 4. The rule-based v1 covers every enum value in `INTENTS`; the LLM-based variant (§9) plugs in behind the same interface in Plan 3.
  - `PhaseRegistry.getPhase / next` — Task 2 (plus `previous` and `downstream` because the orchestrator and stale helper need them).
  - `PhaseHandler.run(ctx) → AsyncIterable<Event>` — Task 3, with `FakePhaseHandler` so the rest of Plan 2 is testable without Pi/LLM.
  - Per-session logical lock (§8 "one logical lock per session") — Task 6 (SessionQueue).
  - Abort cancels the in-flight phase (§8) — Task 11.
  - Stale propagation on revise-back (§7) — Tasks 5 + 10.
  - Multiple-tab broadcast (§8) — covered by Plan 1's `EventBus`; the orchestrator emits through it.
  - Schema-validation failure paths (§8) — already enforced by `ArtifactStore.put` from Plan 1; the FakePhaseHandler test exercises rejection.
- **Out of scope here (later plans):**
  - Real Pi-agent-backed phase handlers + `PiAgentFactory` + `ProviderRegistry` + `GeminiTTSProvider` — Plan 3.
  - `RenderWorker` (child-process isolation, ffmpeg, hyperframes CLI) — Plan 4. The Plan 2 render fake just writes a composition + mp4 descriptor.
  - `events.jsonl` and per-phase transcript persistence (§8 Observability) — wired up alongside the API in Plan 5.
  - Fastify routes (`/sessions`, `/messages`, `/upload`, `/artifacts/*`, `/stream/:sid`) — Plan 5.
  - LLM-based IntentRouter with the contract/replay test harness (§9) — Plan 3.
  - Concurrency-control inside `ArtifactStore` (the Plan 1 docstring notes the orchestrator is responsible for serializing per-session writes; SessionQueue makes good on that).
- **Determinism:** every test in this plan is deterministic, uses temp dirs, and burns zero tokens. Abort test uses a hand-rolled hanging handler + `setTimeout(10ms)` for the "phase has started" checkpoint — flaky window is generous but not infinite; if it ever flakes in CI, raise to 50ms before reaching for `vi.useFakeTimers`.
- **Type-consistency self-check:**
  - `PhaseId` everywhere comes from `@ultracreator/shared` (Plan 1's `events.ts`).
  - `Intent` enum names match between `shared/intent.ts`, `IntentRouter`, and the orchestrator switch.
  - `ServerEvent` discriminator strings match Plan 1's `ServerEventSchema` (`phase.started`, `phase.progress`, `phase.error`, `gate.awaiting`, `artifact.created`, `artifact.stale`, `render.progress`, `render.done`, `render.error`).
  - `ArtifactStore.put` returns `ArtifactEnvelope`; FakePhaseHandler ignores the return (writes only) — matches Plan 1 signature.
  - `PhaseRegistry.outputs("render") = ["composition", "mp4"]` matches both `ARTIFACT_KINDS` from Plan 1 and the render fake handler's `produce` output.
