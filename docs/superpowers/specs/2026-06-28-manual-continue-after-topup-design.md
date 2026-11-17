# Manual "Continue" after a credit top-up

**Date:** 2026-06-28
**Status:** approved, implementing

## Problem

When a video pauses for insufficient credits (`awaiting-credits`) and the user
tops up, the run **auto-continues** in the background. The user reported topping
up, re-entering the session, and finding the pipeline had already marched on with
no input from them. They want to decide *when* a paused video resumes — a manual
**Continue** button, not an automatic restart.

## Current behavior

The auto-resume comes from `resumeParked()` in
`apps/server/src/api/billing-routes.ts`, called at the end of both
`POST /api/billing/grant` and `POST /api/billing/subscribe`. It lists the user's
sessions, filters `awaiting-credits`, and calls
`orchestrator.resumeCredits(s.id)` for each — which emits `credits.resumed` and
enqueues `runFromPhase` in the background. So any top-up silently restarts **all**
of that user's parked sessions.

The manual path already exists end-to-end and is unused by the UI:

- `POST /api/sessions/:sid/resume` → `orchestrator.resumeCredits(sid)` (route in
  `apps/server/src/api/sessions-routes.ts`, no-op unless the session is parked).
- `resumeSession(sid)` client helper in `apps/web/src/lib/api-client.ts` — **no
  caller anywhere in the web app.**

`resumeCredits()` emits `credits.resumed` then runs from the parked phase; the
per-phase charge is idempotent per `(session, phase)`, so resuming never
double-charges.

`credits.required` carries `needed` = the **full phase cost** (the `amount`
passed to `debit`, see `pg-credit-repository.ts` / `memory-credit-repository.ts`
`needed: input.amount`), not a shortfall. So `liveBalance >= needed` cleanly
means "the next step is now affordable." The reducer keeps this on
`uiState.creditsRequired.needed`.

## Changes

### Server — stop auto-resuming on top-up

`apps/server/src/api/billing-routes.ts`:

- Delete `resumeParked()` and its two call sites (in `/grant` and `/subscribe`).
- A top-up now only changes the balance; no session runs on its own.

`orchestrator.resumeCredits()` and the `POST /api/sessions/:sid/resume` route are
unchanged — they become reachable **only** via the explicit Continue button.

### Web — balance-aware gate

`apps/web/src/components/credits-gate.tsx` renders whenever
`status.kind === "awaiting-credits"`, now in two sub-states:

- **Can't afford yet** (`liveBalance < needed`, or balance still loading, or
  `needed` unknown): the current red banner — *"Out of credits — top up to
  continue your video."* + a **Buy credits or upgrade** button that opens
  `PricingDialog`.
- **Topped up** (`liveBalance >= needed`): a *"Credits added — ready to
  continue."* banner + a primary **Continue** button → `resumeSession(sid)`, with
  a busy state and an error toast, mirroring `ApprovalGate`.

New inputs the gate needs:

- `sid` and the parked phase's cost `needed`, threaded from `session-page.tsx`
  (reducer already exposes `uiState.creditsRequired`).
- live balance via `useCredits()`.

Fallback: when `needed` is unknown (e.g. the Fix-D REST path repopulates
`awaiting-credits` without replaying `credits.required`, so `creditsRequired` is
null), affordability can't be confirmed → show the Buy state. The server still
re-parks safely if Continue were somehow reached without enough credits.

### Copy & flow

- After purchase, `PricingDialog.onPurchase` already calls `refresh()` (invalidates
  the credits query) → the gate flips from Buy to Continue automatically. No run.
- On reload / re-entry, the session is still durably `awaiting-credits` and the
  now-sufficient balance loads → Continue shows. Still no auto-run.
- `credits.resumed`'s chat notice changes from *"Credits added — resuming…"* to
  *"Resuming…"* (in `apps/web/src/state/session-reducer.ts`). It now fires on the
  manual click; the "credits added" toast already fired at purchase time.

## Testing (TDD)

- **Server** (`apps/server/test/api/billing-routes.test.ts`): `POST
  /api/billing/grant` for a user with an `awaiting-credits` session does **not**
  emit `credits.resumed` and does **not** run the parked phase. The explicit
  `POST /api/sessions/:sid/resume` still does (keep existing coverage).
- **Web** (`apps/web/test/components/credits-gate.test.tsx`): with
  `balance < needed` the Buy button shows and no Continue; with
  `balance >= needed` the Continue button shows and clicking it calls
  `resumeSession`. Plus a `session-page` wiring check that `needed`/`sid` reach
  the gate.
- Full unit suite green and typecheck clean before merge.

## Out of scope

- Per-phase pricing and the `estimateVideoCredits` menu.
- The `awaiting-gate` user-approval flow (separate gate).
- The home-composer ≤0 upgrade dialog (separate, already shipped).

## Workflow

Implement on the `claude/*` branch with TDD (red → green), commit, ff-merge to
local `main`. Push only if requested.

## Follow-up fix (2026-06-29): stale-balance Continue loop

After shipping, a parked session (`script`, needs 10) showed **Continue** while
the chat still read "out of credits"; clicking it flickered
Continue ↔ out-of-credits and never advanced. Root cause (two client defects,
both from the gate reading a balance the SSE stream never refreshed):

1. **Stale balance.** `useCredits()` (`["credits"]`) was invalidated only by the
   pricing dialog after a purchase — never when phases charged over SSE. So the
   gate compared a stale-high balance against `needed`, offered Continue, the
   resume couldn't pay, the run re-parked, and it looped. Fix
   (`use-session-stream.ts`): on `credits.required`, patch the cached balance to
   the event's authoritative `balance` (instant correct affordability) and
   invalidate `["credits"]`; also invalidate on `credits.resumed` / `phase.started`
   so the badge + gate track real charges.
2. **Out-of-credits flash.** `credits.resumed` cleared `creditsRequired` but left
   status at `awaiting-credits`, so the gate painted the red banner for a frame.
   Fix (`session-reducer.ts`): `credits.resumed` flips status to
   `{ kind: "running", phase }` so the gate hides during the resume attempt.

Tests: reducer (`credits.required` parks; `credits.resumed` → running, clears
gate, "Resuming…"), stream (`credits.required` patches + invalidates balance;
`phase.started` invalidates). Existing gate/session-page tests still green.
