# Auto-approve switch — design

**Date:** 2026-06-19
**Status:** Approved (design); ready for implementation plan

## Problem

The creator pipeline runs `research → design → script → voiceover → compose → render`.
Two phases — **design** and **script** — carry a `user-approve` gate
([registry.ts](../../../apps/server/src/phases/registry.ts)). Today the session
always parks at each gate (`awaiting-gate`) until the user posts `/approve`. Users
who trust the system want it to run straight through to the finished video without
stopping.

## Goal

Add a standalone switch in the homepage composer that, when **ON** (the default),
makes a session skip both approval gates and run straight through to `render`.
When **OFF**, the session behaves exactly as today (manual approve at both gates).
The user can also take back control of an in-flight auto-running session via a
control on the session page.

## Non-goals

- No new approval gates. Gates remain only after `design` and `script`.
- No change to abort/refine semantics.
- No org/account-level default; the default is per-browser (localStorage).

## Decisions (locked)

1. **Server-side per-session flag** — auto-approve is a property of the *session*,
   stored in the DB, not a client-only behavior. The pipeline genuinely does not
   pause; it runs to completion even if the browser tab is closed.
2. **Default ON, remembered per browser** — the homepage switch defaults ON for
   new users; a user's last choice is persisted in `localStorage`, so turning it
   OFF sticks across visits on that browser.
3. **Mid-run pause control** — the session page exposes a live control to flip the
   flag while a run is in progress. Turning it OFF makes the run park at the *next*
   approval gate; turning it ON resumes auto-passing (and continues immediately if
   currently parked at a gate).

### Rejected alternatives

- **Client auto-clicks Approve** — gates still fire server-side; the browser
  auto-posts `/approve` on `gate.awaiting`. Fragile: stalls the moment the tab is
  closed/navigated away (defeats "run all the way through"), flickers the gate UI,
  and is racy. Rejected.
- **Store the flag in `brief.constraints`** — reuses the existing message→brief
  channel but the flag is only known after `research`, the research LLM would see
  an execution preference it should not, and it cannot be cleanly flipped mid-run
  (a refine/re-run rewrites the brief). Rejected.

## Architecture

The change rides on the existing server-side state machine. The gate is enforced in
exactly one place — `runPhase` in
[session-orchestrator.ts](../../../apps/server/src/orchestrator/session-orchestrator.ts)
(the `if (config.gates?.includes("user-approve"))` branch). Making that branch
conditional on the session's `autoApprove` flag is the load-bearing change; the
`runFromPhase` loop already continues to the next phase whenever `runPhase` leaves
the state as `running`.

### Data model

Add a column to `creator_sessions`
([schema/creator.ts](../../../apps/server/src/db/schema/creator.ts)):

```
auto_approve boolean NOT NULL DEFAULT false
```

`DEFAULT false` is the safe value: any session created by a path that does not set
it stays manual. The client always sends an explicit value, so the product default
(ON) is enforced client-side and never relies on the column default.

A new drizzle migration adds the column. `SessionRecord` gains `autoApprove: boolean`.

### Server units

- **`SessionRepository`** ([session-repository.ts](../../../apps/server/src/sessions/session-repository.ts))
  - `create({ id, userId, autoApprove })` — persists the flag at row creation.
  - `get` → `SessionRecord` now includes `autoApprove`.
  - **new** `setAutoApprove(id, value): Promise<void>` — plain UPDATE, refreshes
    `updatedAt`, silent no-op if the row is absent (mirrors `updateStatus`).
  - The PG impl and the in-memory fake MUST behave identically (existing contract).

- **`POST /api/sessions`** ([sessions-routes.ts](../../../apps/server/src/api/sessions-routes.ts))
  - Accepts an optional JSON body `{ autoApprove?: boolean }` (validated; defaults
    to `false` when absent). Passes it to `sessions.create`.

- **`PATCH /api/sessions/:sid`** (new, same file)
  - Body `{ autoApprove: boolean }`. Requires session ownership (reuse
    `requireOwnedSession`). Calls `sessions.setAutoApprove`.
  - If `autoApprove` is being set to `true` **and** the session is currently
    `awaiting-gate`, also call `orchestrator.approve(sid)` so the parked run resumes
    immediately. (Setting to `false` needs no orchestrator call — the next gate reads
    the flag and parks.)

- **`GET /api/sessions/:sid`** (same file)
  - Response gains `autoApprove: row.autoApprove`.

- **`SessionOrchestrator.runPhase`** ([session-orchestrator.ts](../../../apps/server/src/orchestrator/session-orchestrator.ts))
  - Replace the gate branch with:
    ```
    if (config.gates?.includes("user-approve")) {
      const session = await this.deps.sessions.get(sessionId);
      if (session?.autoApprove) {
        // Emit a phase.progress so the chat log records the auto-pass; reuses the
        // existing "progress" reducer path — no new ServerEvent variant needed.
        this.deps.events.emit(sessionId, {
          type: "phase.progress", phase: phaseId,
          message: `Auto-approved ${phaseId}.`,
        });
        return; // leave state = running; runFromPhase continues to next phase
      }
      await this.setState(sessionId, { kind: "awaiting-gate", phase: phaseId });
      this.deps.events.emit(sessionId, { type: "gate.awaiting", phase: phaseId });
    }
    ```
  - Reading the flag from the repo at gate time (not caching it) is what makes a
    mid-run `PATCH` take effect at the next gate. One extra read at each of the two
    gates — negligible.

### Web units

- **`HomeComposer`** ([home-composer.tsx](../../../apps/web/src/components/home-composer.tsx))
  - New `autoApprove` state, initialized from `localStorage` key `uc.autoApprove`
    (default `true` when absent), persisted on change. SSR-safe (lazy initializer /
    `useEffect` guarded by `typeof window`).
  - Rendered as a standalone labeled switch in the bottom control row (sibling of
    the Audio button, **not** inside the Audio dropdown). Uses the existing
    [`Switch`](../../../apps/web/src/components/ui/switch.tsx) component. Working
    label: **"Auto-pilot"** with a tooltip "Runs straight through to the finished
    video without stopping for review" — final wording adjustable, not load-bearing.
  - `handleGenerate` passes the flag: `createSession({ autoApprove })`.

- **`api-client.ts`** ([api-client.ts](../../../apps/web/src/lib/api-client.ts))
  - `createSession(body?: { autoApprove: boolean })` — sends a JSON body.
  - **new** `patchSession(sid, { autoApprove })` → `PATCH /api/sessions/:sid`.

- **`api-types.ts`** ([api-types.ts](../../../apps/web/src/lib/api-types.ts))
  - `GetSessionResponse` gains `autoApprove: boolean`.

- **Session page** ([session-page.tsx](../../../apps/web/src/components/session-page.tsx))
  - Reads `autoApprove` from `useSession`'s `getSession` data.
  - Renders a live control (switch) reflecting the flag. On toggle: call
    `patchSession`, optimistically update + invalidate the `["session", sid]` query.
  - When the flag is OFF and a gate fires, the existing `ApprovalGate` shows (no
    change needed there — `gate.awaiting` arrives via SSE as today).

### Data flow

**Creation (switch ON):**
```
HomeComposer (switch ON, persisted) → createSession({autoApprove:true})
  → POST /api/sessions → sessions.create({autoApprove:true})  [row.auto_approve=true]
  → postMessage(first msg) → research → design completes
  → runPhase reads autoApprove=true → does NOT park → loop continues
  → script (same) → voiceover/compose/render → done
```

**Mid-run pause (was ON, user turns OFF during research/design/script):**
```
Session page toggle OFF → PATCH /api/sessions/:sid {autoApprove:false}
  → sessions.setAutoApprove(false)
  → next gated phase's runPhase reads false → parks at awaiting-gate
  → gate.awaiting (SSE) → ApprovalGate appears
```

**Resume (parked at gate, user turns ON):**
```
Session page toggle ON → PATCH {autoApprove:true}
  → setAutoApprove(true); state is awaiting-gate → orchestrator.approve(sid)
  → run continues; subsequent gates auto-pass
```

## Known limitation

Gates exist only after `design` and `script`. If the user hits pause once the run
is already in `voiceover/compose/render`, there is no gate left to catch it — only
`abort` stops it. The pause control therefore only bites at the two real gates.

Concrete UX decision: the control stays visible and functional whenever the session
is auto-approving, but once the active phase is past `script` (i.e. `voiceover`,
`compose`, or `render`), it renders a hint — "No review points left; use Stop to
halt." — instead of implying it can pause the run. Deriving "past script" from the
streamed `currentPhase` is sufficient. Adding a review gate before the expensive
`render` phase is a deliberate non-goal here and would be a separate change.

## Testing (TDD)

**Server**
- Orchestrator: a `user-approve` phase with session `autoApprove=true` emits **no**
  `gate.awaiting` and the pipeline advances to the next phase / `done`. With
  `autoApprove=false` it parks at `awaiting-gate` (regression guard for today's
  behavior).
- Orchestrator: flipping the flag false→true is read at the *next* gate (set the
  fake repo's flag mid-run, assert park vs pass).
- Repository fake: `create` carries `autoApprove`; `get` returns it; `setAutoApprove`
  updates it; PG impl and fake agree.
- Routes: `POST /api/sessions` stores the flag; `GET` returns it; `PATCH` updates it
  and, when setting true on an `awaiting-gate` session, triggers `approve`; ownership
  is enforced.

**Web**
- `HomeComposer`: switch defaults ON with empty storage, reflects/persists
  `localStorage`, and `createSession` is called with the chosen value.
- Session page: toggling calls `patchSession` and reflects server state.

## Rollout / compatibility

- The column default `false` makes existing rows and any non-updated client path
  manual — no surprise auto-runs.
- Product default (ON) is purely client-side; no migration backfill needed.
