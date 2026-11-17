# LLM Intent Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace keyword-only intent classification with LLM classification for natural-language messages (any language), keep slash commands/abort deterministic, fall back to rules when the LLM is unavailable, and stop silently dropping unhandled messages.

**Architecture:** A new `LLMIntentRouter` wraps the existing `RuleBasedIntentRouter` as fallback: slash commands and `idle+constraints` short-circuit deterministically, everything else makes one `complete()` call (pi-ai) that returns strict JSON validated with zod. The orchestrator's pre-queue abort bypass becomes a pure keyword check (`isAbortText`) so each message costs at most one LLM call. A new `intent.unhandled` server event gives the user feedback when an intent is a no-op.

**Tech Stack:** TypeScript, pi-ai (`complete`), zod, vitest, Fastify SSE (existing), Next.js web app.

**Spec:** `docs/superpowers/specs/2026-06-10-llm-intent-router-design.md`

**Conventions used below:**
- All commands run from the repo root.
- Test command pattern: `npx vitest run apps/server/test/<file>.test.ts` (server) and `npx vitest run apps/web/test/<path>.test.ts` (web).
- Commit messages follow the repo's conventional-commit style and end with the Claude trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 1: `intent.unhandled` server event (shared schema)

**Files:**
- Modify: `packages/shared/src/events.ts`
- Test: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing describe block in `packages/shared/test/schemas.test.ts`:

```ts
it("parses intent.unhandled events", () => {
  const ev = { type: "intent.unhandled", message: "I can't act on that message right now." };
  expect(ServerEventSchema.parse(ev)).toEqual(ev);
});
```

(`ServerEventSchema` is already imported in that file; if not, add `import { ServerEventSchema } from "../src/events.js";`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — zod discriminated-union error: `intent.unhandled` is not a known `type`.

- [ ] **Step 3: Add the event variant**

In `packages/shared/src/events.ts`, append a new variant inside the `ServerEventSchema` discriminated union array (after the `agent.tool_end` object):

```ts
  z.object({ type: z.literal("intent.unhandled"), message: z.string() }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/shared/test/schemas.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add intent.unhandled server event"
```

---

### Task 2: CJK abort keywords + exported `isAbortText`

**Files:**
- Modify: `apps/server/src/intent/intent-router.ts`
- Test: `apps/server/test/intent-router.test.ts`

Background: abort must bypass a running phase instantly and must not depend on LLM availability, so it stays keyword-based. `\b` word boundaries don't work around CJK characters, so CJK needles are substring-matched — but only on short messages, because a false-positive abort kills a running chain while a false negative is still caught by the in-queue LLM classification.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/test/intent-router.test.ts` (uses the existing `r`, `msg`, `runningResearch` helpers). Also add the import:

```ts
import { RuleBasedIntentRouter, isAbortText, type RouterState } from "../src/intent/intent-router.js";
```

```ts
describe("abort keywords (CJK)", () => {
  it("classifies short Chinese abort words as abort", async () => {
    for (const text of ["停止", "取消", "中止", "取消吧"]) {
      expect((await r.classify(msg(text), runningResearch)).intent).toBe("abort");
    }
  });

  it("does not treat longer messages mentioning 取消 as abort", async () => {
    const result = await r.classify(msg("把取消按钮改成红色"), runningResearch);
    expect(result.intent).not.toBe("abort");
  });

  it("exports isAbortText for the orchestrator's pre-queue bypass", () => {
    expect(isAbortText("/abort")).toBe(true);
    expect(isAbortText("stop")).toBe(true);
    expect(isAbortText("停止")).toBe(true);
    expect(isAbortText("把取消按钮改成红色")).toBe(false);
    expect(isAbortText("make it warmer")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/test/intent-router.test.ts`
Expected: FAIL — `isAbortText` is not exported; "停止" classifies as `ask`.

- [ ] **Step 3: Implement**

In `apps/server/src/intent/intent-router.ts`:

Replace the `ABORT_KEYWORDS` constant:

```ts
const ABORT_KEYWORDS = ["/abort", "abort", "cancel", "stop"];
const CJK_ABORT_KEYWORDS = ["停止", "取消", "中止"];
// CJK keywords are substring-matched (\b has no meaning around CJK), so they
// only count on short messages: a false-positive abort kills a running chain,
// while a missed abort is still caught by the in-queue classification.
const CJK_ABORT_MAX_LEN = 6;
```

Add the exported predicate (above the `RuleBasedIntentRouter` class):

```ts
/**
 * Pure keyword abort check. Used by the orchestrator's pre-queue bypass so
 * abort stays instant and independent of LLM availability.
 */
export function isAbortText(text: string): boolean {
  if (containsAnyWord(text, ABORT_KEYWORDS)) return true;
  const trimmed = text.trim();
  if (trimmed.length > CJK_ABORT_MAX_LEN) return false;
  return CJK_ABORT_KEYWORDS.some((k) => trimmed.includes(k));
}
```

Change rule 1 in `RuleBasedIntentRouter.classify` from:

```ts
    // 1. abort — bypasses everything
    if (containsAnyWord(text, ABORT_KEYWORDS)) return { intent: "abort" };
```

to:

```ts
    // 1. abort — bypasses everything
    if (isAbortText(text)) return { intent: "abort" };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/intent-router.test.ts`
Expected: PASS (all existing tests too).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/intent/intent-router.ts apps/server/test/intent-router.test.ts
git commit -m "feat(server): add CJK abort keywords and isAbortText predicate"
```

---

### Task 3: Orchestrator — keyword pre-check + `intent.unhandled` emission

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Test: `apps/server/test/orchestrator.test.ts`

Two changes: (a) the pre-queue abort bypass becomes `isAbortText` instead of a full `classify()` call — otherwise an injected LLM router would be called twice per message; (b) no-op intents (`ask`, `branch`) emit `intent.unhandled` instead of dropping the message silently.

- [ ] **Step 1: Write the failing test**

In `apps/server/test/orchestrator.test.ts`, find the existing test `"ask is a v1 no-op"` (in the `"SessionOrchestrator: abort + branch/ask"` describe, around line 412). Replace it with:

```ts
  it("ask emits intent.unhandled instead of silently dropping the message", async () => {
    const { orch, events } = buildOrchestrator();
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    // idle state, no constraints → classified as ask
    await orch.handleMessage("s1", { text: "hello?" });

    expect(orch.getState("s1")).toEqual({ kind: "idle" });
    const last = seen.at(-1);
    expect(last).toMatchObject({ type: "intent.unhandled" });
  });
```

(If the original test asserted "no events emitted", this replaces that expectation.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/test/orchestrator.test.ts`
Expected: FAIL — `seen.at(-1)` is `undefined` (no event emitted).

- [ ] **Step 3: Implement**

In `apps/server/src/orchestrator/session-orchestrator.ts`:

Add the import:

```ts
import { isAbortText } from "../intent/intent-router.js";
```

Replace the pre-classify block at the top of `handleMessage`:

```ts
    await this.rehydrateState(sessionId);
    // Pre-classify OUTSIDE the queue so abort can bypass an in-flight phase.
    const preClass = await this.deps.intentRouter.classify(
      message,
      this.toRouterState(this.getState(sessionId)),
    );
    if (preClass.intent === "abort") {
      this.controllers.get(sessionId)?.abort();
      return;
    }
```

with:

```ts
    await this.rehydrateState(sessionId);
    // Abort bypasses the queue so it can interrupt an in-flight phase. It's a
    // pure keyword check (not a classify() call) so it stays instant, costs no
    // LLM round-trip, and works when the LLM is down. Non-keyword abort
    // phrasings are still caught by the in-queue classification below.
    if (isAbortText(message.text)) {
      this.controllers.get(sessionId)?.abort();
      return;
    }
```

Replace the `branch`/`ask` cases in the in-queue switch:

```ts
        case "branch":
        case "ask":
          // v1 no-ops. Plan 3 wires `ask` to the Pi agent.
          break;
```

with:

```ts
        case "branch":
        case "ask":
          // Plan 3 wires `ask` to the Pi agent. Until then, tell the user we
          // couldn't act instead of dropping the message silently.
          this.deps.events.emit(sessionId, {
            type: "intent.unhandled",
            message:
              "I can't act on that message yet. You can refine the current result, approve it at a gate, or say \"abort\".",
          });
          break;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS — including all existing abort tests (the keyword pre-check covers the same texts the old pre-classify caught via rule 1).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): keyword abort pre-check + intent.unhandled feedback event"
```

---

### Task 4: `LLMIntentRouter` — deterministic fast-paths

**Files:**
- Create: `apps/server/src/intent/llm-intent-router.ts`
- Create: `apps/server/test/llm-intent-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/llm-intent-router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import type { UserMessage } from "@ultracreator/shared";
import type { ClassifiedIntent, IntentRouter, RouterState } from "../src/intent/intent-router.js";
import { LLMIntentRouter, type CompleteFn } from "../src/intent/llm-intent-router.js";

const idle: RouterState = { kind: "idle" };
const errorResearch: RouterState = { kind: "error", phase: "research" };
const gateDesign: RouterState = { kind: "awaiting-gate", phase: "design" };

const msg = (text: string, extras: Partial<UserMessage> = {}): UserMessage => ({ text, ...extras });
const fakeModel = { provider: "anthropic", id: "claude-test" } as unknown as Model<any>;

/** Fallback that records calls and returns a fixed result. */
class RecordingFallback implements IntentRouter {
  calls = 0;
  constructor(private result: ClassifiedIntent = { intent: "ask" }) {}
  async classify(): Promise<ClassifiedIntent> {
    this.calls++;
    return this.result;
  }
}

/** completeFn stub returning a single text block. */
const textResponse = (text: string): ReturnType<CompleteFn> =>
  Promise.resolve({ content: [{ type: "text", text }], stopReason: "stop" });

function build(opts: {
  completeFn?: CompleteFn;
  fallback?: IntentRouter;
  timeoutMs?: number;
} = {}) {
  const fallback = opts.fallback ?? new RecordingFallback();
  let llmCalls = 0;
  const completeFn: CompleteFn = (...args) => {
    llmCalls++;
    return (opts.completeFn ?? (() => textResponse('{"intent":"ask"}')))(...args);
  };
  const router = new LLMIntentRouter({
    model: fakeModel,
    fallback,
    completeFn,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return { router, fallback: fallback as RecordingFallback, getLlmCalls: () => llmCalls };
}

describe("LLMIntentRouter: deterministic fast-paths", () => {
  it("delegates slash commands to the fallback without calling the LLM", async () => {
    const fallback = new RecordingFallback({ intent: "abort" });
    const { router, getLlmCalls } = build({ fallback });
    const result = await router.classify(msg("/abort"), gateDesign);
    expect(result).toEqual({ intent: "abort" });
    expect(fallback.calls).toBe(1);
    expect(getLlmCalls()).toBe(0);
  });

  it("classifies idle+constraints as new-project without calling the LLM", async () => {
    const { router, fallback, getLlmCalls } = build();
    const result = await router.classify(
      msg("Make a promo", { constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false } }),
      idle,
    );
    expect(result).toEqual({ intent: "new-project" });
    expect(fallback.calls).toBe(0);
    expect(getLlmCalls()).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/test/llm-intent-router.test.ts`
Expected: FAIL — cannot resolve `../src/intent/llm-intent-router.js`.

- [ ] **Step 3: Implement the router skeleton with fast-paths**

Create `apps/server/src/intent/llm-intent-router.ts`:

```ts
import { complete, type Context, type Model } from "@earendil-works/pi-ai";
import { z } from "zod";
import { INTENTS, PHASE_IDS, type UserMessage } from "@ultracreator/shared";
import type { ClassifiedIntent, IntentRouter, RouterState } from "./intent-router.js";

/**
 * Structural subset of pi-ai's `complete()` — narrow enough for tests to fake
 * without building a full AssistantMessage.
 */
export type CompleteFn = (
  model: Model<any>,
  context: Context,
  options?: {
    apiKey?: string;
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
  },
) => Promise<{
  content: ReadonlyArray<{ type: string; text?: string }>;
  stopReason: string;
  errorMessage?: string;
}>;

const LLMIntentSchema = z.object({
  intent: z.enum(INTENTS),
  targetPhase: z.enum(PHASE_IDS).optional(),
});

export interface LLMIntentRouterOptions {
  model: Model<any>;
  /** Used when the LLM call fails, times out, or returns unusable output. */
  fallback: IntentRouter;
  getApiKey?: (provider: string) => string | undefined;
  /** Injectable for tests; defaults to pi-ai's `complete`. */
  completeFn?: CompleteFn;
  /** Default 10s — classification must never stall the message queue for long. */
  timeoutMs?: number;
}

/**
 * Classifies user messages with one LLM completion per message. Slash
 * commands and structural signals (idle + constraints) short-circuit
 * deterministically; every failure mode falls back to the rule router, so
 * this class never throws from `classify`.
 */
export class LLMIntentRouter implements IntentRouter {
  private readonly model: Model<any>;
  private readonly fallback: IntentRouter;
  private readonly getApiKey?: (provider: string) => string | undefined;
  private readonly completeFn: CompleteFn;
  private readonly timeoutMs: number;

  constructor(opts: LLMIntentRouterOptions) {
    this.model = opts.model;
    this.fallback = opts.fallback;
    this.getApiKey = opts.getApiKey;
    this.completeFn = opts.completeFn ?? (complete as CompleteFn);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async classify(message: UserMessage, state: RouterState): Promise<ClassifiedIntent> {
    // Explicit commands stay deterministic regardless of LLM availability.
    if (message.text.trim().startsWith("/")) {
      return this.fallback.classify(message, state);
    }
    // First message from the composer carries constraints — a structural
    // signal, not a linguistic one.
    if (state.kind === "idle" && message.constraints !== undefined) {
      return { intent: "new-project" };
    }
    try {
      return await this.classifyWithLLM(message, state);
    } catch {
      return this.fallback.classify(message, state);
    }
  }

  private async classifyWithLLM(message: UserMessage, state: RouterState): Promise<ClassifiedIntent> {
    throw new Error("not implemented yet");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/llm-intent-router.test.ts`
Expected: PASS (both fast-path tests; the stub `classifyWithLLM` is not reached by them).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/intent/llm-intent-router.ts apps/server/test/llm-intent-router.test.ts
git commit -m "feat(server): LLMIntentRouter skeleton with deterministic fast-paths"
```

---

### Task 5: `LLMIntentRouter` — LLM classification happy path

**Files:**
- Modify: `apps/server/src/intent/llm-intent-router.ts`
- Test: `apps/server/test/llm-intent-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/test/llm-intent-router.test.ts`:

```ts
describe("LLMIntentRouter: LLM classification", () => {
  it("parses a bare JSON intent from the model", async () => {
    const { router, fallback } = build({
      completeFn: () => textResponse('{"intent":"refine"}'),
    });
    const result = await router.classify(msg("重试"), errorResearch);
    expect(result).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(0);
  });

  it("parses a code-fenced JSON intent", async () => {
    const { router } = build({
      completeFn: () => textResponse('```json\n{"intent":"approve"}\n```'),
    });
    const result = await router.classify(msg("看起来不错,继续"), gateDesign);
    expect(result).toEqual({ intent: "approve" });
  });

  it("keeps targetPhase for revise-back", async () => {
    const { router } = build({
      completeFn: () => textResponse('{"intent":"revise-back","targetPhase":"script"}'),
    });
    const result = await router.classify(msg("回到脚本阶段重写"), gateDesign);
    expect(result).toEqual({ intent: "revise-back", targetPhase: "script" });
  });

  it("drops targetPhase for non-revise-back intents", async () => {
    const { router } = build({
      completeFn: () => textResponse('{"intent":"refine","targetPhase":"design"}'),
    });
    const result = await router.classify(msg("warmer colors"), gateDesign);
    expect(result).toEqual({ intent: "refine" });
  });

  it("sends state and message to the model and resolves the api key", async () => {
    let capturedContext: Context | undefined;
    let capturedOptions: Parameters<CompleteFn>[2];
    const router = new LLMIntentRouter({
      model: fakeModel,
      fallback: new RecordingFallback(),
      getApiKey: (provider) => (provider === "anthropic" ? "key-123" : undefined),
      completeFn: (_m, context, options) => {
        capturedContext = context;
        capturedOptions = options;
        return textResponse('{"intent":"refine"}');
      },
    });
    await router.classify(msg("重试"), errorResearch);
    expect(capturedContext?.systemPrompt).toContain("kind=error");
    expect(capturedContext?.systemPrompt).toContain("phase=research");
    expect(capturedContext?.messages).toHaveLength(1);
    expect(capturedContext?.messages[0]).toMatchObject({ role: "user", content: "重试" });
    expect(capturedOptions?.apiKey).toBe("key-123");
  });
});
```

Also add the `Context` type import at the top of the test file:

```ts
import type { Context, Model } from "@earendil-works/pi-ai";
```

(replacing the existing `import type { Model } ...` line).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/test/llm-intent-router.test.ts`
Expected: FAIL — "not implemented yet" surfaces as the fallback result (`{ intent: "ask" }`), not the parsed intent.

- [ ] **Step 3: Implement `classifyWithLLM` and the prompt**

In `apps/server/src/intent/llm-intent-router.ts`, replace the `classifyWithLLM` stub and add the helpers at module scope:

```ts
  private async classifyWithLLM(message: UserMessage, state: RouterState): Promise<ClassifiedIntent> {
    const context: Context = {
      systemPrompt: buildSystemPrompt(state),
      messages: [{ role: "user", content: message.text, timestamp: Date.now() }],
    };
    const apiKey = this.getApiKey?.(this.model.provider);
    const response = await this.withTimeout((signal) =>
      this.completeFn(this.model, context, {
        signal,
        maxTokens: 200,
        temperature: 0,
        ...(apiKey ? { apiKey } : {}),
      }),
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage ?? `LLM stopReason "${response.stopReason}"`);
    }
    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
    const parsed = LLMIntentSchema.parse(JSON.parse(extractJson(text)));
    // targetPhase only carries meaning for revise-back.
    if (parsed.intent === "revise-back") {
      return { intent: parsed.intent, ...(parsed.targetPhase ? { targetPhase: parsed.targetPhase } : {}) };
    }
    return { intent: parsed.intent };
  }

  /**
   * Races the request against a hard timer AND aborts the underlying request.
   * The race matters because a misbehaving transport may ignore the signal.
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`intent classification timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
```

Module-scope helpers (below the class):

```ts
function buildSystemPrompt(state: RouterState): string {
  return [
    "You classify one user chat message from a video-creation session into exactly one intent.",
    "",
    `Pipeline phases in order: ${PHASE_IDS.join(", ")}.`,
    `Current session state: kind=${state.kind}${state.phase ? `, phase=${state.phase}` : ""}.`,
    "",
    "Intents:",
    '- "new-project": start a new video project (only meaningful when kind=idle).',
    '- "approve": accept the current result and continue (only meaningful when kind=awaiting-gate).',
    '- "refine": adjust or re-run the CURRENT phase. Retry/redo requests after a failure (kind=error) are refine.',
    '- "revise-back": go back to an EARLIER phase and redo from there; set targetPhase.',
    '- "update-brief": change global constraints (duration, aspect ratio, voiceover, audience).',
    '- "branch": explicitly fork an alternative version.',
    '- "abort": stop or cancel the current run.',
    '- "ask": a question or chatter that requires none of the above actions.',
    "",
    'The message may be in any language (e.g. Chinese "重试" means retry).',
    'Reply with ONLY a JSON object, no prose: {"intent":"<intent>"} or {"intent":"revise-back","targetPhase":"<phase>"}.',
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/llm-intent-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/intent/llm-intent-router.ts apps/server/test/llm-intent-router.test.ts
git commit -m "feat(server): LLM intent classification with strict JSON parsing"
```

---

### Task 6: `LLMIntentRouter` — fallback paths

**Files:**
- Modify: `apps/server/src/intent/llm-intent-router.ts` (only if a test exposes a gap — the `try/catch` from Task 4 should already cover these)
- Test: `apps/server/test/llm-intent-router.test.ts`

- [ ] **Step 1: Write the failing/verifying tests**

Append to `apps/server/test/llm-intent-router.test.ts`:

```ts
describe("LLMIntentRouter: fallback paths", () => {
  it("falls back when the model returns non-JSON", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({ fallback, completeFn: () => textResponse("I think you want a retry.") });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back when the model returns an unknown intent", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({ fallback, completeFn: () => textResponse('{"intent":"retry"}') });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back when the request rejects", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({ fallback, completeFn: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back when the model reports stopReason error", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    const { router } = build({
      fallback,
      completeFn: () => Promise.resolve({ content: [], stopReason: "error", errorMessage: "overloaded" }),
    });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
  });

  it("falls back on timeout and aborts the request", async () => {
    const fallback = new RecordingFallback({ intent: "refine" });
    let aborted = false;
    const { router } = build({
      fallback,
      timeoutMs: 20,
      completeFn: (_m, _c, options) =>
        new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    expect(await router.classify(msg("重试"), errorResearch)).toEqual({ intent: "refine" });
    expect(fallback.calls).toBe(1);
    expect(aborted).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run apps/server/test/llm-intent-router.test.ts`
Expected: PASS — the `try/catch` in `classify` plus `withTimeout` already cover all five. If any FAILS, fix the implementation (not the test) until green.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/llm-intent-router.test.ts apps/server/src/intent/llm-intent-router.ts
git commit -m "test(server): LLM intent router fallback paths"
```

---

### Task 7: Orchestrator integration — "重试" after a failure re-runs the phase

**Files:**
- Test: `apps/server/test/orchestrator.test.ts`

Pure test addition proving the end-to-end behavior that motivated this feature.

- [ ] **Step 1: Write the test**

Add a new describe at the bottom of `apps/server/test/orchestrator.test.ts`. It reuses the file's existing imports plus two new ones:

```ts
import { LLMIntentRouter } from "../src/intent/llm-intent-router.js";
import type { Model } from "@earendil-works/pi-ai";
```

```ts
describe("SessionOrchestrator: LLM intent router integration", () => {
  it("re-runs a failed phase when the LLM classifies '重试' as refine", async () => {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const phases = new PhaseRegistry();
    let researchRuns = 0;
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async (ctx) => {
          researchRuns++;
          if (researchRuns === 1) throw new Error("scrape failed");
          return [{ kind: "brief", data: briefFor(ctx.initialMessage!) }];
        },
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async () => [{ kind: "design", data: designData }],
      })],
    ]);
    const intentRouter = new LLMIntentRouter({
      model: { provider: "anthropic", id: "claude-test" } as unknown as Model<any>,
      fallback: new RuleBasedIntentRouter(),
      completeFn: () => Promise.resolve({
        content: [{ type: "text", text: '{"intent":"refine"}' }],
        stopReason: "stop",
      }),
    });
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers });

    await orch.handleMessage("s1", {
      text: "Make a promo",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch.getState("s1")).toMatchObject({ kind: "error", phase: "research" });

    await orch.handleMessage("s1", { text: "重试" });
    expect(researchRuns).toBe(2);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run apps/server/test/orchestrator.test.ts`
Expected: PASS. (If it fails, debug with the superpowers:systematic-debugging skill — do not weaken the assertion.)

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/orchestrator.test.ts
git commit -m "test(server): LLM router retries failed phase on 重试"
```

---

### Task 8: Wiring — `selectIntentRouter` in composeOrchestrator

**Files:**
- Modify: `apps/server/src/compose-orchestrator.ts`
- Create: `apps/server/test/select-intent-router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/test/select-intent-router.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { selectIntentRouter } from "../src/compose-orchestrator.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { LLMIntentRouter } from "../src/intent/llm-intent-router.js";

const anthropicModel = { provider: "anthropic", id: "claude-test" } as unknown as Model<any>;
const googleModel = { provider: "google", id: "gemini-test" } as unknown as Model<any>;

describe("selectIntentRouter", () => {
  it("uses the explicit override when provided", () => {
    const override = new RuleBasedIntentRouter();
    const router = selectIntentRouter({ model: anthropicModel, intentRouterOverride: override });
    expect(router).toBe(override);
  });

  it("returns the rule router when no API key matches the model provider", () => {
    const router = selectIntentRouter({ model: anthropicModel, geminiApiKey: "g-key" });
    expect(router).toBeInstanceOf(RuleBasedIntentRouter);
  });

  it("returns the LLM router when the model provider has a key", () => {
    const router = selectIntentRouter({ model: anthropicModel, anthropicApiKey: "a-key" });
    expect(router).toBeInstanceOf(LLMIntentRouter);
  });

  it("prefers intentModel over the main model", () => {
    const router = selectIntentRouter({
      model: anthropicModel,
      intentModel: googleModel,
      geminiApiKey: "g-key",
    });
    expect(router).toBeInstanceOf(LLMIntentRouter);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/test/select-intent-router.test.ts`
Expected: FAIL — `selectIntentRouter` is not exported.

- [ ] **Step 3: Implement**

In `apps/server/src/compose-orchestrator.ts`:

Add imports:

```ts
import type { IntentRouter } from "./intent/intent-router.js";
import { LLMIntentRouter } from "./intent/llm-intent-router.js";
```

(`RuleBasedIntentRouter` is already imported.)

Add to `ComposeOrchestratorOptions` (after `geminiApiKey`):

```ts
  /**
   * Optional dedicated model for intent classification (e.g. a fast/cheap
   * model). Defaults to `model`.
   */
  intentModel?: Model<any>;
  /** Optional intent router override. Wins over LLM/rule selection (tests). */
  intentRouterOverride?: IntentRouter;
```

Add the exported selection function (above `composeOrchestrator`):

```ts
/**
 * Pick the intent router: explicit override (tests) > LLM router when the
 * intent model's provider has an API key > rule router alone. The key check
 * keeps keyless environments (existing integration tests, offline dev) on the
 * rule router with zero LLM-timeout waits.
 */
export function selectIntentRouter(
  opts: Pick<
    ComposeOrchestratorOptions,
    "model" | "intentModel" | "intentRouterOverride" | "anthropicApiKey" | "openrouterApiKey" | "geminiApiKey"
  >,
): IntentRouter {
  if (opts.intentRouterOverride) return opts.intentRouterOverride;
  const getApiKey = (provider: string): string | undefined => {
    if (provider === "anthropic") return opts.anthropicApiKey;
    if (provider === "openrouter") return opts.openrouterApiKey;
    if (provider === "google") return opts.geminiApiKey;
    return undefined;
  };
  const model = opts.intentModel ?? opts.model;
  const fallback = new RuleBasedIntentRouter();
  if (!getApiKey(model.provider)) return fallback;
  return new LLMIntentRouter({ model, getApiKey, fallback });
}
```

In `composeOrchestrator`, replace:

```ts
  const intentRouter = new RuleBasedIntentRouter();
```

with:

```ts
  const intentRouter = selectIntentRouter(opts);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/test/select-intent-router.test.ts apps/server/test/compose-orchestrator-integration.test.ts`
Expected: PASS — the integration test passes no API keys, so it stays on the rule router and its behavior is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/compose-orchestrator.ts apps/server/test/select-intent-router.test.ts
git commit -m "feat(server): wire LLM intent router selection into composeOrchestrator"
```

---

### Task 9: `INTENT_LLM_MODEL` env in the production bootstrap

**Files:**
- Modify: `apps/server/src/api/server.ts`

`server.ts` is the untested production bootstrap ("Tests build their own dep graph through createApp() directly"), so this task is verified by typecheck only.

- [ ] **Step 1: Implement**

In `apps/server/src/api/server.ts`:

Add below `const LLM_MODEL = process.env.LLM_MODEL;`:

```ts
/**
 * Optional dedicated model for intent classification (same provider as
 * LLM_PROVIDER). Unset → the main model classifies intents too.
 */
const INTENT_LLM_MODEL = process.env.INTENT_LLM_MODEL;
```

Add below `const model = resolveModel();`:

```ts
function resolveIntentModel() {
  if (!INTENT_LLM_MODEL) return undefined;
  switch (LLM_PROVIDER) {
    case "anthropic": return getModel("anthropic", INTENT_LLM_MODEL as any);
    case "openrouter": return getModel("openrouter", INTENT_LLM_MODEL as any);
    case "gemini": return getModel("google", INTENT_LLM_MODEL as any);
    default: return undefined;
  }
}

const intentModel = resolveIntentModel();
```

In the `composeOrchestrator({ ... })` call, add after `geminiApiKey: GEMINI_API_KEY,`:

```ts
  ...(intentModel ? { intentModel } : {}),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean exit.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/api/server.ts
git commit -m "feat(server): INTENT_LLM_MODEL env for a dedicated intent model"
```

---

### Task 10: Web — render `intent.unhandled` as a chat notice

**Files:**
- Modify: `apps/web/src/state/session-reducer.ts`
- Modify: `apps/web/src/lib/group-conversation.ts`
- Modify: `apps/web/src/components/chat-stream.tsx`
- Test: `apps/web/test/state/session-reducer.test.ts`
- Test: `apps/web/test/lib/group-conversation.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/state/session-reducer.test.ts`:

```ts
it("intent.unhandled appends a notice chat row without touching status", () => {
  const ev: ServerEvent = { type: "intent.unhandled", message: "I can't act on that message yet." };
  const next = reduce(initialUiState, ev);
  expect(next.status).toEqual({ kind: "idle" });
  expect(next.chat).toEqual([{ kind: "notice", message: "I can't act on that message yet." }]);
});
```

Add to `apps/web/test/lib/group-conversation.test.ts` (follow the file's existing helper style for building `ChatItem[]`):

```ts
it("passes notice items through as standalone blocks and closes an open phase", () => {
  const blocks = groupConversation([
    { kind: "phase-start", phase: "research", at: "2026-06-01T00:00:00.000Z" },
    { kind: "notice", message: "I can't act on that message yet." },
  ]);
  expect(blocks).toEqual([
    { kind: "phase", phase: "research", steps: [], artifacts: [], status: "done" },
    { kind: "notice", message: "I can't act on that message yet." },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/state/session-reducer.test.ts apps/web/test/lib/group-conversation.test.ts`
Expected: FAIL — reducer hits `default` (no chat row); `notice` is not a `ChatItem` kind (type error at test compile is also acceptable as the failure mode).

- [ ] **Step 3: Implement**

`apps/web/src/state/session-reducer.ts` — add to the `ChatItem` union:

```ts
  | { kind: "notice"; message: string }
```

and a new case in `reduce` (before `default`):

```ts
    case "intent.unhandled":
      return {
        ...state,
        chat: [...state.chat, { kind: "notice", message: event.message }],
      };
```

`apps/web/src/lib/group-conversation.ts` — add to the `ConversationBlock` union:

```ts
  | { kind: "notice"; message: string }
```

and a new case in the `groupConversation` switch:

```ts
      case "notice":
        closePhase(true);
        blocks.push({ kind: "notice", message: item.message });
        break;
```

`apps/web/src/components/chat-stream.tsx` — add `Info` to the existing `lucide-react` import, then a new case in `BlockRenderer`'s switch:

```tsx
    case "notice":
      return (
        <motion.div {...enter} transition={{ duration: 0.18 }} className="flex justify-start pl-9">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            {block.message}
          </span>
        </motion.div>
      );
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run apps/web/test/state/session-reducer.test.ts apps/web/test/lib/group-conversation.test.ts && pnpm typecheck`
Expected: tests PASS; typecheck clean (the exhaustive `BlockRenderer` switch fails the build if the `notice` case is missing).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/session-reducer.ts apps/web/src/lib/group-conversation.ts apps/web/src/components/chat-stream.tsx apps/web/test/state/session-reducer.test.ts apps/web/test/lib/group-conversation.test.ts
git commit -m "feat(web): render intent.unhandled as a chat notice"
```

---

### Task 11: Full verification

- [ ] **Step 1: Run the entire suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean exit.

- [ ] **Step 3: Fix anything that broke, then commit any fixes**

If a pre-existing test depended on the old behavior (e.g. asserting the exact event list after an `ask` no-op), update it to expect the `intent.unhandled` event — that behavior change is intentional per the spec.

---

## Out of scope (per spec)

- Wiring `ask` to a conversational Pi agent (original Plan 3 follow-up).
- Retrying individual failed tools inside a phase.
- An external (real-model) classification test — can be added later under `vitest.external.config.ts` if wanted.
