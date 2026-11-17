# Credit-gate visibility fixes

**Date:** 2026-06-26
**Status:** approved, implementing

## Problem

A user created a video task with only 25 credits. The first pipeline step
(`research`) costs 60 credits (`CONSUMPTION.researchBrief`), so the run can
never start. They expected an "out of credits" prompt but saw none — the
session sat on the "Ready" (idle) badge with an empty preview and no feedback.

The credit model is intentionally **pay-per-step**: the orchestrator charges
each phase before it runs and parks the session in `awaiting-credits` (emitting
`credits.required`) at the first phase it can't afford. There is no up-front
"you need ~400 credits" gate, and we do **not** want one — a task is many small
steps.

## Root cause (Fix A)

The SSE transport names every frame by event type
(`event: ${entry.event.type}`, `apps/server/src/api/sse-writer.ts`). The browser
`EventSource` only delivers a named event to a listener registered for that
exact name. The client's listener list `ALL_EVENT_TYPES`
(`apps/web/src/state/use-session-stream.ts`) drifted from the `ServerEvent`
union and is **missing three types**: `credits.required`, `credits.resumed`,
`intent.unhandled`.

Consequence: the server correctly parks at `research`, persists and replays
`credits.required` over SSE — but the browser drops the frame. The reducer
(which *does* handle `credits.required`) never sees it, the UI never transitions
to `awaiting-credits`, and `CreditsGate` never renders. The session is stuck
showing "Ready". `credits.resumed` ("Credits added — resuming…") and
`intent.unhandled` notices are dropped the same way.

## Scope: four complementary fixes

### Fix A — Client subscribes to every server event type (root cause)

- `packages/shared/src/events.ts`: export a runtime-derived
  `SERVER_EVENT_TYPES` from `ServerEventSchema.options` (mirrors the existing
  `PHASE_IDS = PhaseIdSchema.options` pattern) so the list cannot drift from the
  union.
- `apps/web/src/state/use-session-stream.ts`: import and register listeners for
  `SERVER_EVENT_TYPES` instead of the hand-rolled `ALL_EVENT_TYPES`.
- Tests: shared test asserting `SERVER_EVENT_TYPES` covers the union (incl. the
  three previously-missing types); web `session-page` test that emits a
  `credits.required` frame over the fake stream and asserts the "Out of credits"
  gate renders.

### Fix B — Home: upgrade dialog only when balance ≤ 0

The "can't afford the first step" pre-flight was tried, then dropped: per-step
gating belongs in the session detail page, not the home composer. The one
exception is a **zero balance** — there's no point starting a run you can't pay
a single step of. So `apps/web/src/components/home-composer.tsx` reads the cached
balance at click time (`queryClient.getQueryData(["credits"])`, no extra fetch)
and, only when it's known and `<= 0`, opens the upgrade modal
(`PricingDialog` with a `notice` banner: "You're out of credits. Upgrade to keep
creating videos.") instead of creating a session. An unknown or positive balance
proceeds; the in-session gate handles everything past the first step.
`pricing.ts` keeps `FIRST_PHASE` (used by Fix C); the `minCreditsToStart()`
helper was removed.

The in-session gate (`apps/web/src/components/credits-gate.tsx`) was restyled to
a single line (no figures) with a destructive-tint banner + solid red button so
the pause stands out.

### Fix C — Orchestrator never strands the session silently

- `apps/server/src/orchestrator/session-orchestrator.ts`: in `processMessage`'s
  catch, before rethrowing, if the session isn't already in `error`, set
  `{ kind: "error", phase }` (phase = active phase, else `FIRST_PHASE`) and emit
  `phase.error` with `describeError(err)`. This covers throws outside
  `runPhase`'s own try (intent classify, `startNewProject` setup, a `debit()`
  that itself throws), which currently mark the message row `error` but emit
  nothing — leaving the UI on "Ready" forever.

### Fix D — Status not masked by SSE-only derivation

- `apps/server/src/api/sessions-routes.ts`: `GET /api/sessions/:sid` returns the
  **durable** status (rehydrate from the persisted row) instead of the in-memory
  `getState`, which resets to idle after a restart.
- `apps/web/src/components/session-page.tsx`: derive the displayed status from
  the SSE stream while it is healthy; when the stream is not connected or has
  errored and REST reports a non-idle state, fall back to REST. Show a subtle
  "reconnecting" affordance on SSE error so a degraded live view is visible
  rather than silently reading as "Ready".

## Testing

TDD throughout. Per-fix unit/component tests as above, plus the full suite green
before merge. Implement on the `claude/*` branch, then ff-merge to local `main`
(no push unless requested).

## Out of scope

- No up-front total-cost gate (pay-per-step preserved).
- No change to per-phase pricing or the mid-task gate behavior itself.
