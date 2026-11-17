# LLM Intent Router — Design

**Date:** 2026-06-10
**Status:** Approved (pending spec review)

## Problem

User chat messages are classified by `RuleBasedIntentRouter` — a pure
English-keyword rule list. Anything the rules don't recognize falls to the
`ask` intent, which is a silent no-op. In practice this means a user who
watches a phase fail and types "重试" (or any phrasing not in the keyword
tables) gets no reaction at all: no retry, no error, no feedback. The
keyword tables are English-only, so every non-English message that isn't
caught by a state-dependent fallback rule is dropped.

Verified behavior at HEAD (b080819):

| Session state | Free text ("重试"/"retry") | Result |
|---|---|---|
| `error` | → `refine` (rule fallthrough) | re-runs failed phase — works |
| `idle` | → `ask` | silent no-op |
| `running` (live) | only abort pre-check applies | queued behind the chain |

The `error`-state path only works as a side effect of the refine
fallthrough rule. There is no semantic understanding anywhere in the
intent layer.

## Goal

Replace keyword matching with LLM classification for natural-language
messages, so intent is understood in any language and phrasing, while
keeping slash commands deterministic and keeping the system fully
functional when the LLM is unavailable.

Out of scope: wiring `ask` to a conversational Pi agent (original Plan 3
follow-up), retrying individual failed tools inside a phase.

## Design

### 1. `LLMIntentRouter` (new, `apps/server/src/intent/llm-intent-router.ts`)

Implements the existing `IntentRouter` interface (already async — designed
for this). Constructor options:

```ts
{
  model: Model<any>;
  getApiKey?: (provider: string) => string | undefined;
  fallback: IntentRouter;          // RuleBasedIntentRouter in production
  completeFn?: typeof complete;    // injectable for tests (pi-ai `complete`)
  timeoutMs?: number;              // default 10_000
}
```

`classify(message, state)` is three-stage:

1. **Deterministic fast-path (no LLM call):**
   - Message starts with `/` (slash command) → delegate to `fallback`.
   - `state.kind === "idle"` and `message.constraints !== undefined` →
     `new-project` (structural signal, not linguistic).
2. **LLM classification:** one `complete()` call.
   - System prompt (English): definitions of the 8 intents and which
     session states they apply to, the current state (`kind`, `phase`),
     the phase list, and an instruction to output strict JSON only:
     `{"intent": "...", "targetPhase": "..."}` (`targetPhase` only for
     `revise-back`).
   - User content: the raw message text.
   - Response parsing: strip optional code fences, `JSON.parse`, validate
     with zod (`intent` ∈ `INTENTS`, `targetPhase` ∈ `PHASE_IDS`,
     unknown keys stripped).
3. **Fallback:** any failure — request error, timeout (AbortSignal at
   `timeoutMs`), unparseable output, schema violation — returns
   `fallback.classify(message, state)`. `classify` never throws.

`RuleBasedIntentRouter` is unchanged in role: it remains the fallback and
the default for tests/offline use.

### 2. Orchestrator message flow (unchanged shape, one LLM call per message)

`handleMessage` keeps its two-stage structure:

- **Pre-classify outside the queue** exists only for the abort bypass. It
  stays rule-based (instant, deterministic, works when the LLM is down).
  `ABORT_KEYWORDS` gains common Chinese forms: 停止, 取消, 中止. CJK
  keywords are matched by substring (the `\b` word-boundary regex does not
  work for CJK); English single words keep word-boundary matching.
- **In-queue classification** is the LLM call, preserving the existing
  "classify against settled state" semantics (a message sent mid-run is
  classified against the state after the chain settles).

Net cost: at most one LLM call per user message.

### 3. `intent.unhandled` feedback event

New `ServerEvent` variant:

```ts
{ type: "intent.unhandled", message: string }
```

Emitted by the orchestrator when the dispatched intent is a no-op
(`ask`, `branch`), e.g. "I can't act on that message right now — you can
refine the current result, approve it, or say abort." The web
`session-reducer` appends it to the chat as a system notice. No other UI
state changes.

### 4. Wiring

- `composeOrchestrator` options gain `intentModel?: Model<any>` and
  `intentRouterOverride?: IntentRouter` (matching the existing
  `*Override` naming). Router selection:
  - `intentRouterOverride` set → use it (tests).
  - else if an API key for the intent model's provider is available
    (via the same key-resolution used for Pi agents) →
    `new LLMIntentRouter({ model: intentModel ?? opts.model, getApiKey,
    fallback: new RuleBasedIntentRouter() })`.
  - else → `RuleBasedIntentRouter` alone. This keeps existing
    integration tests (which pass no API keys) on the rule router with
    zero LLM-timeout waits.
- `server.ts` reads `INTENT_LLM_MODEL` (same provider as `LLM_PROVIDER`);
  unset → reuse the main model.

### 5. Error handling summary

| Failure | Behavior |
|---|---|
| LLM request error / timeout | fall back to rule router, log at warn |
| Invalid JSON / unknown intent | fall back to rule router |
| Model returns `approve` off-gate etc. | orchestrator guards already no-op these |
| No API key configured | rule router only (today's behavior) |

### 6. Testing (TDD)

- `llm-intent-router.test.ts` (unit, injected `completeFn`):
  - slash command → fallback used, `completeFn` never called
  - idle+constraints → `new-project`, no LLM call
  - valid JSON (bare and code-fenced) → parsed intent
  - `revise-back` with valid/invalid `targetPhase`
  - invalid intent string → fallback result
  - `completeFn` rejects → fallback result
  - timeout → fallback result
- `intent-router.test.ts`: Chinese abort keywords (停止/取消/中止)
  classified as abort; CJK substring matching doesn't false-positive on
  English text.
- `orchestrator.test.ts` additions: error state + "重试" with an
  LLM router whose fake `completeFn` returns `refine` → phase re-runs;
  `ask` dispatch emits `intent.unhandled`.
- `session-reducer.test.ts`: `intent.unhandled` appends a chat notice.

## Alternatives considered

- **Full LLM (no fast-path):** slash commands become slow and
  nondeterministic; abort depends on LLM availability. Rejected.
- **Rules-first, LLM for fallthrough only:** cheapest, but rule
  false-positives (English keyword collisions) keep shadowing the LLM and
  two interleaved layers are harder to reason about. Rejected.
