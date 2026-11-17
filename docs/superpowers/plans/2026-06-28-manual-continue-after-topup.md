# Manual "Continue" after a credit top-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-resuming a credit-parked video when the user tops up; instead surface a manual **Continue** button in the in-session gate that appears once the balance covers the next step.

**Architecture:** Remove the server's auto-resume hook (`resumeParked`) from the billing routes so a top-up only changes the balance. The existing `POST /api/sessions/:sid/resume` route + `resumeSession()` client helper become the manual trigger. The in-session `CreditsGate` reads the live balance (`useCredits()`) and the parked phase's cost (`needed`, threaded from `session-page.tsx`): while `balance < needed` it shows the red "Buy credits" banner; once `balance >= needed` it flips to a primary **Continue** button calling `resumeSession(sid)`.

**Tech Stack:** Fastify + Zod (server), Next.js App Router + React Query + Radix/lucide + Tailwind v4 (web), Vitest + Testing Library.

---

## File Structure

- `apps/server/src/api/billing-routes.ts` — **modify**: delete `resumeParked()` and its two call sites.
- `apps/server/test/api/billing-routes.test.ts` — **modify**: expose the orchestrator + sessions from `makeApp`; add a "grant does not auto-resume" test.
- `apps/web/src/components/credits-gate.tsx` — **modify**: add `sid` + `needed` props, read `useCredits()`, render Buy vs. Continue.
- `apps/web/test/components/credits-gate.test.tsx` — **create**: unit tests for the two gate states.
- `apps/web/src/components/session-page.tsx` — **modify**: pass `sid` + `needed` to `CreditsGate`.
- `apps/web/test/components/session-page.test.tsx` — **modify**: add a wiring test (Continue shows when the live balance already covers the parked step).
- `apps/web/src/state/session-reducer.ts` — **modify**: trim the `credits.resumed` chat notice to "Resuming…".

No new files on the server beyond tests; the `/resume` route and `resumeSession()` helper already exist.

---

## Task 1: Server — a top-up no longer auto-resumes parked sessions

**Files:**
- Modify: `apps/server/test/api/billing-routes.test.ts` (expose orchestrator/sessions in `makeApp`; new test)
- Modify: `apps/server/src/api/billing-routes.ts:22-30,112,149`

Context: `resumeParked(userId)` runs at the end of `POST /api/billing/grant` and
`POST /api/billing/subscribe`; it calls `orchestrator.resumeCredits()` on every
`awaiting-credits` session the user owns. We assert it is no longer invoked by
spying on `orchestrator.resumeCredits`. The authed test user is
`TEST_USER.id === "u-test"` (from `apps/server/test/helpers/fake-auth.ts`); a
parked session is created by inserting a row and setting its status via
`InMemorySessionRepository.updateStatus`.

- [ ] **Step 1: Expose the orchestrator + sessions from `makeApp`**

In `apps/server/test/api/billing-routes.test.ts`, add two module-scoped vars next
to the existing `let credits` (line 23):

```ts
let credits: MemoryCreditRepository;
let orchestrator: SessionOrchestrator;
let sessions: InMemorySessionRepository;
```

Inside `makeApp`, change the local `const sessions` / `const orchestrator`
declarations to assign the module vars instead (so the test can reach them):

```ts
  credits = new MemoryCreditRepository();
  sessions = new InMemorySessionRepository();
  orchestrator = new SessionOrchestrator({
    workspaces,
    events,
    artifacts,
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(),
    sessions,
    messages: new InMemoryMessageStore(),
    credits,
  });
```

(Delete the prior `const sessions = new InMemorySessionRepository();` and
`const orchestrator = new SessionOrchestrator({...})` lines — they are replaced by
the assignments above. The `deps` object below already references `orchestrator`
and `sessions`, so it is unchanged.)

- [ ] **Step 2: Write the failing test**

Add inside `describe("billing routes", ...)`:

```ts
  it("POST /api/billing/grant does NOT auto-resume a parked session", async () => {
    // A session parked for credits, owned by the authed test user.
    await sessions.create({ id: "parked1", userId: "u-test" });
    await sessions.updateStatus("parked1", {
      status: "awaiting-credits",
      currentPhase: "research",
      error: null,
    });
    const resumeSpy = vi.spyOn(orchestrator, "resumeCredits");

    const res = await app.inject({
      method: "POST",
      url: "/api/billing/grant",
      payload: { credits: 100 },
    });

    expect(res.statusCode).toBe(200);
    expect(resumeSpy).not.toHaveBeenCalled();
    // The session stays parked; only an explicit /resume continues it.
    expect((await sessions.get("parked1"))?.status).toBe("awaiting-credits");
  });
```

Add `vi` to the vitest import at the top of the file:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
```

And add the `SessionOrchestrator` type import if not already present (it is
imported at line 10 — confirm `import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";`).

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -F @ultracreator/server test -- billing-routes`
Expected: FAIL — `resumeSpy` WAS called (current `resumeParked` auto-resumes), so
`expect(resumeSpy).not.toHaveBeenCalled()` fails.

- [ ] **Step 4: Remove the auto-resume from the billing routes**

In `apps/server/src/api/billing-routes.ts`, delete the `resumeParked` helper
(lines 22-30):

```ts
  // Resume any of the user's credit-parked sessions once they can pay again.
  async function resumeParked(userId: string): Promise<void> {
    const owned = await deps.sessions.listByUser(userId);
    await Promise.all(
      owned
        .filter((s) => s.status === "awaiting-credits")
        .map((s) => deps.orchestrator.resumeCredits(s.id)),
    );
  }
```

Delete its call in `/api/billing/grant` (line 112): remove `await resumeParked(userId);`.

Delete its call in `/api/billing/subscribe` (line 149): remove `await resumeParked(userId);`.

Update the two now-stale comments so they don't promise auto-resume:
- Line 77 `// DEV purchase stub: grant credits, then resume parked sessions.` →
  `// DEV purchase stub: grant credits. The user resumes any parked session manually.`
- Lines 116-117 `// DEV subscription stub: activate the tier + grant the first period's credits,` /
  `// then resume parked sessions. Monthly refresh happens lazily in GET /api/credits.` →
  `// DEV subscription stub: activate the tier + grant the first period's credits.`
  `// Monthly refresh happens lazily in GET /api/credits. Parked runs resume manually.`

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @ultracreator/server test -- billing-routes`
Expected: PASS (all billing-route tests, including the existing `/resume` no-op).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api/billing-routes.ts apps/server/test/api/billing-routes.test.ts
git commit -m "fix(credits): a top-up no longer auto-resumes parked sessions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Web — balance-aware CreditsGate (Buy vs. Continue)

**Files:**
- Create: `apps/web/test/components/credits-gate.test.tsx`
- Modify: `apps/web/src/components/credits-gate.tsx`

Context: today the gate takes only `state` and always shows "Buy credits or
upgrade". It will now take `sid` and `needed` (the parked phase's full cost) and
read the live balance via `useCredits()`. `resumeSession(sid)` (already in
`apps/web/src/lib/api-client.ts`) POSTs to `/api/sessions/:sid/resume`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/components/credits-gate.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreditsGate } from "@/components/credits-gate";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

const parked = { kind: "awaiting-credits", phase: "research" } as const;
const creditsBody = (balance: number) => ({
  balance,
  breakdown: { subscription: 0, bonus: 0, purchased: balance },
  subscription: null,
});

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});
afterEach(() => vi.restoreAllMocks());

describe("<CreditsGate>", () => {
  it("renders nothing unless the run is parked for credits", () => {
    renderWithQuery(<CreditsGate state={{ kind: "idle" }} sid="sid1" needed={60} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows Buy (not Continue) while the balance can't cover the step", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(JSON.stringify(creditsBody(25)), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const { qc } = renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={60} />);
    qc.setQueryData(["credits"], creditsBody(25));

    expect(await screen.findByRole("button", { name: /buy credits or upgrade/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("falls back to Buy when the step cost is unknown", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(JSON.stringify(creditsBody(9999)), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const { qc } = renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={null} />);
    qc.setQueryData(["credits"], creditsBody(9999));

    expect(await screen.findByRole("button", { name: /buy credits or upgrade/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("shows Continue once the balance covers the step, and resumes on click", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(JSON.stringify(creditsBody(100)), { status: 200 });
      if (url.endsWith("/api/sessions/sid1/resume")) return new Response(null, { status: 202 });
      return new Response("not found", { status: 404 });
    });
    const { qc } = renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={60} />);
    qc.setQueryData(["credits"], creditsBody(100));

    const btn = await screen.findByRole("button", { name: /continue/i });
    expect(screen.queryByRole("button", { name: /buy credits or upgrade/i })).toBeNull();

    await userEvent.click(btn);
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([u, i]) =>
            String(u).endsWith("/api/sessions/sid1/resume") &&
            (i as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -F @ultracreator/web test -- credits-gate`
Expected: FAIL — the component doesn't accept `sid`/`needed` and never renders a
Continue button (TypeScript/match errors on the new props and `/continue/i`).

- [ ] **Step 3: Implement the balance-aware gate**

Replace the entire contents of `apps/web/src/components/credits-gate.tsx`:

```tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { CreditCard, Play, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resumeSession } from "@/lib/api-client";
import { useCredits } from "@/state/use-credits";
import { PricingDialog } from "./pricing/pricing-dialog";
import type { UiState } from "@/state/session-reducer";

interface Props {
  state: UiState["status"];
  sid: string;
  /** Full credit cost of the parked phase (from credits.required). null = unknown. */
  needed: number | null;
}

/**
 * In-session credit gate. Shown when a run pauses for insufficient credits.
 *
 * Two states, both driven by the live balance (not the stale event balance):
 * - balance < needed (or unknown): red "out of credits" banner + a Buy button
 *   that opens the pricing modal.
 * - balance >= needed (topped up): a "ready to continue" banner + a Continue
 *   button that resumes the parked run. We do NOT auto-resume on top-up — the
 *   user decides when the video continues.
 */
export function CreditsGate({ state, sid, needed }: Props): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const { data } = useCredits();
  if (state.kind !== "awaiting-credits") return null;

  const balance = data?.balance;
  const canContinue = needed !== null && balance !== undefined && balance >= needed;

  if (canContinue) {
    return (
      <div className="rounded-2xl bg-accent p-3 shadow-xs">
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-accent-foreground">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" />
            <span>Credits added — ready to continue your video.</span>
          </p>
          <Button
            size="sm"
            className="shrink-0 rounded-lg"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await resumeSession(sid);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Couldn't continue");
              } finally {
                setBusy(false);
              }
            }}
          >
            <Play className="mr-1 h-3.5 w-3.5" /> Continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-destructive/10 p-3 shadow-xs">
      <div className="flex items-center justify-between gap-3">
        <p role="alert" className="flex min-w-0 items-center gap-2 text-sm font-medium text-destructive">
          <Sparkles className="h-4 w-4 shrink-0" />
          <span>Out of credits — top up to continue your video.</span>
        </p>
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0 rounded-lg"
          onClick={() => setOpen(true)}
        >
          <CreditCard className="mr-1 h-3.5 w-3.5" /> Buy credits or upgrade
        </Button>
      </div>
      <PricingDialog open={open} onOpenChange={setOpen} mode="app" />
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @ultracreator/web test -- credits-gate`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/credits-gate.tsx apps/web/test/components/credits-gate.test.tsx
git commit -m "feat(web): balance-aware credit gate with a manual Continue button

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Web — thread `sid` + `needed` through SessionPage

**Files:**
- Modify: `apps/web/src/components/session-page.tsx:83`
- Modify: `apps/web/test/components/session-page.test.tsx`

Context: the reducer keeps the parked phase's cost on
`stream.uiState.creditsRequired.needed`; on the REST-fallback path it is null
(the gate then shows Buy). `sid` is already a prop of `SessionPage`.

- [ ] **Step 1: Write the failing wiring test**

Add inside `describe("<SessionPage> integration", ...)` in
`apps/web/test/components/session-page.test.tsx`:

```ts
  it("shows Continue (not Buy) when the live balance already covers the parked step", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [], title: "Promo" }), { status: 200 });
      }
      if (url.endsWith("/api/credits")) {
        return new Response(
          JSON.stringify({ balance: 100, breakdown: { subscription: 0, bonus: 0, purchased: 100 }, subscription: null }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());

    // Server parked at research (needs 60). The wallet already holds 100, so the
    // gate must offer Continue rather than Buy.
    await act(async () => {
      FakeEventSource.instances[0]!.emit(
        "credits.required",
        JSON.stringify({ seq: 1, at: "t", event: { type: "credits.required", phase: "research", needed: 60, balance: 25 } }),
        "1",
      );
    });

    expect(await screen.findByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy credits or upgrade/i })).toBeNull();
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @ultracreator/web test -- session-page`
Expected: FAIL — the gate still receives no `needed`/`sid`, so it renders Buy and
the `/continue/i` query finds nothing.

- [ ] **Step 3: Pass `sid` + `needed` to the gate**

In `apps/web/src/components/session-page.tsx`, replace line 83:

```tsx
          <CreditsGate state={sessionState} />
```

with:

```tsx
          <CreditsGate
            state={sessionState}
            sid={sid}
            needed={stream.uiState.creditsRequired?.needed ?? null}
          />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -F @ultracreator/web test -- session-page`
Expected: PASS — including the existing "renders the out-of-credits gate when a
credits.required frame arrives" test (its `/api/credits` is unmocked → balance
undefined → Buy state, so `buy credits or upgrade` still matches).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/session-page.tsx apps/web/test/components/session-page.test.tsx
git commit -m "feat(web): pass parked-step cost + sid into the credit gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Web — trim the resume chat notice to "Resuming…"

**Files:**
- Modify: `apps/web/src/state/session-reducer.ts` (`case "credits.resumed"`)

Context: the notice previously read "Credits added — resuming…" on auto-resume.
The "credits added" toast already fires at purchase; the notice now fires on the
manual Continue click, so it should just say "Resuming…". No existing test
asserts the old string (verified by grep), so this is a one-line change.

- [ ] **Step 1: Update the notice**

In `apps/web/src/state/session-reducer.ts`, in `case "credits.resumed":`, change:

```ts
        chat: [...state.chat, { kind: "notice", message: "Credits added — resuming…" }],
```

to:

```ts
        chat: [...state.chat, { kind: "notice", message: "Resuming…" }],
```

- [ ] **Step 2: Run the reducer tests to verify nothing broke**

Run: `pnpm -F @ultracreator/web test -- session-reducer`
Expected: PASS (no assertion targeted the old copy).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/state/session-reducer.ts
git commit -m "fix(web): trim resume notice to 'Resuming…' (manual continue)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full verification + merge

- [ ] **Step 1: Typecheck + full unit suites**

Run: `pnpm -r typecheck` → expect exit 0.
Run: `pnpm -F @ultracreator/server test && pnpm -F @ultracreator/web test && pnpm -F @ultracreator/shared test` → expect all green.

- [ ] **Step 2: Browser verification (preview)**

Start the web preview, open a session parked in `awaiting-credits`:
- Confirm the red "Out of credits" gate with **Buy credits or upgrade**.
- Buy enough credits → gate flips to the "Credits added — ready to continue" banner with a **Continue** button; the run does **not** start on its own.
- Click **Continue** → the run resumes (a "Resuming…" notice, then `phase.started`).
Capture a screenshot of the Continue state.

- [ ] **Step 3: ff-merge to local main**

```bash
git checkout main
git merge --ff-only claude/friendly-wiles-1b2f49
git checkout claude/friendly-wiles-1b2f49
```

(Push only if the user asks.)

---

## Self-Review

- **Spec coverage:** server auto-resume removed (Task 1); balance-aware Buy/Continue gate (Task 2); `sid`+`needed` wiring incl. null fallback (Task 2 unknown-cost test + Task 3); "Resuming…" copy (Task 4); tests + verification (Tasks 1-5). All spec sections map to a task.
- **Placeholders:** none — every code/test step is concrete.
- **Type consistency:** `CreditsGate` props `{ state, sid, needed: number | null }` are defined in Task 2 and consumed identically in Task 3; `resumeSession(sid)` and `useCredits()` match existing signatures; `creditsBody` test shape matches `CreditsResponse`.
