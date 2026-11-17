# Auto-approve Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-ON "Auto-pilot" switch to the homepage composer that makes a session skip the design/script approval gates and run straight to the rendered video, plus a live control on the session page to take back manual control mid-run.

**Architecture:** Auto-approve is a per-session boolean persisted on the `creator_sessions` row. The single gate-enforcement point in `SessionOrchestrator.runPhase` reads the flag: when true it does not park, so the existing `runFromPhase` loop flows to the next phase. A new `PATCH /api/sessions/:sid` flips the flag mid-run (and resumes a parked run when set true). The homepage switch (last choice remembered in `localStorage`) sends the flag at session creation; the session page reads it from `GET /api/sessions/:sid`.

**Tech Stack:** TypeScript, Fastify, Drizzle/Postgres, Zod, React/Next.js, TanStack Query, Radix Switch, Vitest + Testing Library.

**Spec:** [docs/superpowers/specs/2026-06-19-auto-approve-switch-design.md](../specs/2026-06-19-auto-approve-switch-design.md)

---

## File structure

| File | Change |
|------|--------|
| `apps/server/src/db/schema/creator.ts` | add `auto_approve` column |
| `apps/server/drizzle/0004_*.sql` | generated migration (ALTER TABLE) |
| `apps/server/src/sessions/session-repository.ts` | `SessionRecord.autoApprove`, `create` input, `setAutoApprove` |
| `apps/server/src/sessions/pg-session-repository.ts` | map + write the column, `setAutoApprove` |
| `apps/server/test/helpers/in-memory-session-repository.ts` | mirror the above |
| `apps/server/src/orchestrator/session-orchestrator.ts` | gate reads flag; `setAutoApprove` method |
| `apps/server/src/api/sessions-routes.ts` | POST body, GET field, new PATCH route |
| `apps/web/src/lib/api-types.ts` | `GetSessionResponse.autoApprove` |
| `apps/web/src/lib/api-client.ts` | `createSession` body, `patchSession` |
| `apps/web/src/components/home-composer.tsx` | Auto-pilot switch + localStorage |
| `apps/web/src/components/auto-approve-control.tsx` | **new** session-page control |
| `apps/web/src/components/session-page.tsx` | wire the control in |

**Commands** (run from repo root):
- Single test file: `pnpm test -- <path>` (append `-t "<name>"` to narrow to one case).
- Typecheck everything: `pnpm typecheck`
- Generate migration: `pnpm --filter @ultracreator/server db:generate`

> The `*.pg.test.ts` suite needs a local Postgres at `postgres://admin@localhost:5432` (the existing pg tests already assume it). If Postgres is unavailable, run the non-pg tests and note the pg test as unverified — do not delete it.

---

## Task 1: Add the `auto_approve` column + migration

**Files:**
- Modify: `apps/server/src/db/schema/creator.ts:18-36`
- Create: `apps/server/drizzle/0004_*.sql` (name auto-generated)

No standalone test — validated by Task 2's repository test. `boolean` is already imported in this file.

- [ ] **Step 1: Add the column to the Drizzle schema**

In `apps/server/src/db/schema/creator.ts`, inside the `creatorSession` `pgTable` column object, add the column after the `error` line (before `createdAt`):

```typescript
    error: text("error"), // error string when in error state | null
    // Per-session execution mode: when true the orchestrator skips the
    // design/script user-approve gates and runs straight to render.
    autoApprove: boolean("auto_approve").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @ultracreator/server db:generate`
Expected: a new file `apps/server/drizzle/0004_<random>.sql` is created and `drizzle/meta/` is updated. Confirm the SQL body is exactly:

```sql
ALTER TABLE "creator_sessions" ADD COLUMN "auto_approve" boolean DEFAULT false NOT NULL;
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no type errors introduced).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/schema/creator.ts apps/server/drizzle
git commit -m "feat(server): add auto_approve column to creator_sessions"
```

---

## Task 2: Carry `autoApprove` through SessionRepository

**Files:**
- Modify: `apps/server/src/sessions/session-repository.ts:5-39`
- Modify: `apps/server/src/sessions/pg-session-repository.ts:14-73`
- Modify: `apps/server/test/helpers/in-memory-session-repository.ts:8-57`
- Test: `apps/server/test/sessions/pg-session-repository.pg.test.ts` (extend existing; needs local Postgres)

- [ ] **Step 1: Write the failing repository test**

In `apps/server/test/sessions/pg-session-repository.pg.test.ts`, add these `it(...)` blocks inside the existing top-level `describe` (the file's `beforeEach` already truncates tables and seeds users `u1`/`u2`, and `repo` is the `PgSessionRepository`):

```typescript
  it("create stores autoApprove and setAutoApprove updates it", async () => {
    await repo.create({ id: "s-aa", userId: "u1", autoApprove: true });
    expect((await repo.get("s-aa"))?.autoApprove).toBe(true);
    await repo.setAutoApprove("s-aa", false);
    expect((await repo.get("s-aa"))?.autoApprove).toBe(false);
  });

  it("create defaults autoApprove to false when omitted", async () => {
    await repo.create({ id: "s-def", userId: "u1" });
    expect((await repo.get("s-def"))?.autoApprove).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- apps/server/test/sessions/pg-session-repository.pg.test.ts`
Expected: FAIL — `setAutoApprove` does not exist on the repository / `autoApprove` missing on the record (compile/type error).

- [ ] **Step 3: Extend the interface**

In `apps/server/src/sessions/session-repository.ts`, add `autoApprove` to `SessionRecord` and `setAutoApprove` + the `create` input field to the interface:

```typescript
export interface SessionRecord {
  id: string;
  userId: string;
  title: string | null;
  status: SessionStatus;
  currentPhase: PhaseId | null;
  error: string | null;
  /** When true, the orchestrator auto-passes the design/script gates. */
  autoApprove: boolean;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}
```

```typescript
export interface SessionRepository {
  create(input: { id: string; userId: string; autoApprove?: boolean }): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  /** The user's sessions, ordered by updatedAt descending. */
  listByUser(userId: string): Promise<SessionRecord[]>;
  /** Plain UPDATE; silent no-op if the row is absent. Refreshes updatedAt to now. */
  updateStatus(id: string, update: SessionStatusUpdate): Promise<void>;
  /** Sets title only when it is currently null (first message names the session). */
  setTitleIfEmpty(id: string, title: string): Promise<void>;
  /** Plain UPDATE of the auto-approve flag; silent no-op if the row is absent. */
  setAutoApprove(id: string, value: boolean): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- [ ] **Step 4: Update the Postgres implementation**

In `apps/server/src/sessions/pg-session-repository.ts`, add `autoApprove` to `toRecord`, set it on `create`, and add `setAutoApprove`:

```typescript
function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    status: row.status as SessionStatus,
    currentPhase: (row.currentPhase as PhaseId | null) ?? null,
    error: row.error,
    autoApprove: row.autoApprove,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

```typescript
  async create(input: { id: string; userId: string; autoApprove?: boolean }): Promise<void> {
    await this.db
      .insert(creatorSession)
      .values({ id: input.id, userId: input.userId, autoApprove: input.autoApprove ?? false })
      .onConflictDoNothing({ target: creatorSession.id });
  }
```

Add this method alongside `setTitleIfEmpty`:

```typescript
  async setAutoApprove(id: string, value: boolean): Promise<void> {
    await this.db
      .update(creatorSession)
      .set({ autoApprove: value, updatedAt: new Date() })
      .where(eq(creatorSession.id, id));
  }
```

- [ ] **Step 5: Update the in-memory fake**

In `apps/server/test/helpers/in-memory-session-repository.ts`, set `autoApprove` on `create`'s record literal and add `setAutoApprove`:

```typescript
  async create(input: { id: string; userId: string; autoApprove?: boolean }): Promise<void> {
    if (this.rows.has(input.id)) return;
    const now = new Date().toISOString();
    this.rows.set(input.id, {
      id: input.id,
      userId: input.userId,
      title: null,
      status: "idle",
      currentPhase: null,
      error: null,
      autoApprove: input.autoApprove ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }
```

Add alongside `setTitleIfEmpty`:

```typescript
  async setAutoApprove(id: string, value: boolean): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return; // plain UPDATE semantics
    row.autoApprove = value;
    row.updatedAt = new Date().toISOString();
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test -- apps/server/test/sessions/pg-session-repository.pg.test.ts`
Expected: PASS. Then `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sessions apps/server/test/helpers/in-memory-session-repository.ts apps/server/test/sessions/pg-session-repository.pg.test.ts
git commit -m "feat(server): plumb autoApprove through SessionRepository"
```

---

## Task 3: Gate logic + orchestrator `setAutoApprove`

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts:420-465` (gate branch) and add a public method
- Test: `apps/server/test/orchestrator.test.ts` (extend existing)

- [ ] **Step 1: Write the failing tests**

In `apps/server/test/orchestrator.test.ts`, ensure `vi` is in the vitest import (`import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"`), then add these tests inside the existing `describe`. They use the file's `buildOrchestrator` helper, which returns `{ orch, events, sessions, ... }`:

```typescript
  it("autoApprove=true skips both gates and runs straight to done", async () => {
    const { orch, events, sessions } = buildOrchestrator();
    await sessions.create({ id: "auto1", userId: "u", autoApprove: true });
    const seen: ServerEvent[] = [];
    events.subscribe("auto1", (e) => seen.push(e));

    await orch.handleMessage("auto1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });

    expect(orch.getState("auto1")).toEqual({ kind: "done", lastPhase: "render" });
    expect(seen.some((e) => e.type === "gate.awaiting")).toBe(false);
    expect(
      seen.filter((e) => e.type === "phase.progress" && e.message.startsWith("Auto-approved")).length,
    ).toBe(2);
  });

  it("flipping autoApprove on at a gate resumes to done", async () => {
    const { orch, sessions } = buildOrchestrator();
    await sessions.create({ id: "flip1", userId: "u", autoApprove: false });

    await orch.handleMessage("flip1", {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(orch.getState("flip1")).toEqual({ kind: "awaiting-gate", phase: "design" });

    await orch.setAutoApprove("flip1", true);
    await vi.waitFor(() =>
      expect(orch.getState("flip1")).toEqual({ kind: "done", lastPhase: "render" }),
    );
  });

  it("setAutoApprove on a non-gated session only persists the flag", async () => {
    const { orch, sessions } = buildOrchestrator();
    await sessions.create({ id: "idle1", userId: "u", autoApprove: false });
    await orch.setAutoApprove("idle1", true);
    expect((await sessions.get("idle1"))?.autoApprove).toBe(true);
    expect(orch.getState("idle1")).toEqual({ kind: "idle" });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- apps/server/test/orchestrator.test.ts`
Expected: FAIL — `orch.setAutoApprove` is not a function; the autoApprove=true case still parks at `awaiting-gate`.

- [ ] **Step 3: Make the gate read the flag**

In `apps/server/src/orchestrator/session-orchestrator.ts`, replace the gate branch at the end of `runPhase` (currently lines 460-463):

```typescript
    if (config.gates?.includes("user-approve")) {
      const session = await this.deps.sessions.get(sessionId);
      if (session?.autoApprove) {
        // Auto-pilot: don't park. Record the auto-pass in the chat log via the
        // existing phase.progress path (no new ServerEvent variant), then leave
        // the state as `running` so runFromPhase advances to the next phase.
        this.deps.events.emit(sessionId, {
          type: "phase.progress",
          phase: phaseId,
          message: `Auto-approved ${phaseId}.`,
        });
        return;
      }
      await this.setState(sessionId, { kind: "awaiting-gate", phase: phaseId });
      this.deps.events.emit(sessionId, { type: "gate.awaiting", phase: phaseId });
    }
```

- [ ] **Step 4: Add the `setAutoApprove` method**

In the same file, add this public method to the `SessionOrchestrator` class (e.g. directly after the `handleMessage` method). It awaits the durable flag write so a follow-up `GET` is consistent, then fire-and-forgets the resume through the per-session queue (mirrors how the messages route fire-and-forgets `handleMessage`):

```typescript
  /**
   * Toggle a session's auto-approve flag. The write is awaited (so a subsequent
   * GET reflects it); when turning it on while parked at a gate, the parked run
   * is resumed in the background via the per-session queue.
   */
  async setAutoApprove(sessionId: string, value: boolean): Promise<void> {
    await this.rehydrateState(sessionId);
    await this.deps.sessions.setAutoApprove(sessionId, value);
    if (value && this.getState(sessionId).kind === "awaiting-gate") {
      void this.queue.enqueue(sessionId, () => this.approve(sessionId));
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- apps/server/test/orchestrator.test.ts`
Expected: PASS (including the pre-existing gate tests — with no row created, `sessions.get` returns null and the session still parks, so they are unaffected). Then `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): auto-approve gate skip + orchestrator.setAutoApprove"
```

---

## Task 4: API routes — POST body, GET field, PATCH

**Files:**
- Modify: `apps/server/src/api/sessions-routes.ts`
- Test: `apps/server/test/api/sessions-routes.test.ts` (extend existing; in-memory, no Postgres)

- [ ] **Step 1: Write the failing route tests**

In `apps/server/test/api/sessions-routes.test.ts`, add these tests inside the existing `describe` (the file's `beforeEach` builds `deps` with `InMemorySessionRepository` and `fakeAuthService()` → authenticated user `u-test`, and exposes `deps` and `app`):

```typescript
  it("POST /api/sessions stores autoApprove from the body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json() as { sessionId: string };
    expect((await deps.sessions.get(sessionId))?.autoApprove).toBe(true);
  });

  it("POST /api/sessions defaults autoApprove to false when the body is empty", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    const { sessionId } = res.json() as { sessionId: string };
    expect((await deps.sessions.get(sessionId))?.autoApprove).toBe(false);
  });

  it("GET /api/sessions/:sid returns autoApprove", async () => {
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { autoApprove: boolean }).autoApprove).toBe(true);
  });

  it("PATCH /api/sessions/:sid updates autoApprove", async () => {
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    const res = await app.inject({ method: "PATCH", url: `/api/sessions/${sessionId}`, payload: { autoApprove: false } });
    expect(res.statusCode).toBe(204);
    expect((await deps.sessions.get(sessionId))?.autoApprove).toBe(false);
  });

  it("PATCH /api/sessions/:sid 400s on an invalid body", async () => {
    const { sessionId } = (
      await app.inject({ method: "POST", url: "/api/sessions", payload: { autoApprove: true } })
    ).json() as { sessionId: string };
    const res = await app.inject({ method: "PATCH", url: `/api/sessions/${sessionId}`, payload: { autoApprove: "nope" } });
    expect(res.statusCode).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- apps/server/test/api/sessions-routes.test.ts`
Expected: FAIL — POST ignores the body (autoApprove false), GET has no `autoApprove`, PATCH route returns 404 (route does not exist).

- [ ] **Step 3: Implement the routes**

In `apps/server/src/api/sessions-routes.ts`, add the zod import at the top:

```typescript
import { z } from "zod";
```

Add a body schema near the top of `registerSessionsRoutes` (before the route registrations):

```typescript
  const AutoApproveBodySchema = z.object({ autoApprove: z.boolean() });
```

Update `POST /api/sessions` to read the optional flag and pass it to `create`:

```typescript
  app.post("/api/sessions", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) {
      // The guard already enforces auth on /api/sessions*; this is defense-in-depth.
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const parsed = AutoApproveBodySchema.partial().safeParse(req.body ?? {});
    const autoApprove = parsed.success ? (parsed.data.autoApprove ?? false) : false;
    const sessionId = newSessionId();
    await deps.sessions.create({ id: sessionId, userId, autoApprove });
    await deps.workspaces.init(sessionId);
    await deps.eventLog.attach(sessionId);
    reply.code(201).send({ sessionId });
  });
```

Update the `GET /api/sessions/:sid` reply to include the flag:

```typescript
      reply.send({ state, artifacts, title: row?.title ?? null, autoApprove: row?.autoApprove ?? false });
```

Add the PATCH route (place it after the GET route, before DELETE):

```typescript
  app.patch<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const parsed = AutoApproveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid body" });
        return;
      }
      // Awaits the durable flag write; any resume runs in the background.
      await deps.orchestrator.setAutoApprove(sid, parsed.data.autoApprove);
      reply.code(204).send();
    },
  );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- apps/server/test/api/sessions-routes.test.ts`
Expected: PASS. Then `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/sessions-routes.ts apps/server/test/api/sessions-routes.test.ts
git commit -m "feat(server): autoApprove on POST/GET + PATCH /api/sessions/:sid"
```

---

## Task 5: Web API client + types

**Files:**
- Modify: `apps/web/src/lib/api-types.ts:28-32`
- Modify: `apps/web/src/lib/api-client.ts:38-46`
- Test: `apps/web/test/lib/api-client.test.ts` (extend existing)

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/lib/api-client.test.ts`, add `patchSession` to the import from `@/lib/api-client`, then add these tests (the file already defines `mockFetch` and `BASE`):

```typescript
  it("createSession POSTs autoApprove in the body", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ autoApprove: false });
      return new Response(JSON.stringify({ sessionId: "abc" }), { status: 201 });
    });
    await createSession({ autoApprove: false });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("patchSession PATCHes /api/sessions/:sid with the flag", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/s1`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ autoApprove: true });
      return new Response(null, { status: 204 });
    });
    await patchSession("s1", { autoApprove: true });
    expect(spy).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- apps/web/test/lib/api-client.test.ts`
Expected: FAIL — `patchSession` is not exported; `createSession` sends no body.

- [ ] **Step 3: Extend the response type**

In `apps/web/src/lib/api-types.ts`:

```typescript
export interface GetSessionResponse {
  state: SessionState;
  artifacts: ArtifactDescriptor[];
  title: string | null;
  autoApprove: boolean;
}
```

- [ ] **Step 4: Update the client**

In `apps/web/src/lib/api-client.ts`, replace `createSession` and add `patchSession`:

```typescript
export async function createSession(opts: { autoApprove: boolean } = { autoApprove: true }): Promise<CreateSessionResponse> {
  const out = await jsonFetch<CreateSessionResponse>(`${apiBase()}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ autoApprove: opts.autoApprove }),
  });
  if (!out) throw new ApiError(0, "createSession: empty response");
  return out;
}

export async function patchSession(sid: string, body: { autoApprove: boolean }): Promise<void> {
  await jsonFetch<null>(`${apiBase()}/api/sessions/${sid}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test -- apps/web/test/lib/api-client.test.ts`
Expected: PASS (the pre-existing bare `createSession()` test still passes — it does not assert on the body). Then `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api-types.ts apps/web/src/lib/api-client.ts apps/web/test/lib/api-client.test.ts
git commit -m "feat(web): createSession autoApprove body + patchSession client"
```

---

## Task 6: Homepage Auto-pilot switch

**Files:**
- Modify: `apps/web/src/components/home-composer.tsx`
- Test: `apps/web/test/components/home-composer.test.tsx` (**new**)

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/home-composer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  uploadFiles: vi.fn(async () => ({ files: [] })),
  postMessage: vi.fn(async () => {}),
}));
import { createSession } from "@/lib/api-client";

function renderComposer() {
  return renderWithQuery(
    <HomeComposer
      text="A promo for Acme"
      onTextChange={() => {}}
      duration={30}
      onDurationChange={() => {}}
      aspect="16:9"
      onAspectChange={() => {}}
      placeholder="describe…"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("<HomeComposer> auto-pilot", () => {
  it("defaults the switch ON and sends autoApprove:true on generate", async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.getByRole("switch", { name: "auto-pilot" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ autoApprove: true }));
  });

  it("persists an OFF choice to localStorage and sends autoApprove:false", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("switch", { name: "auto-pilot" }));
    expect(localStorage.getItem("uc.autoApprove")).toBe("false");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ autoApprove: false }));
  });

  it("starts OFF when localStorage says so", async () => {
    localStorage.setItem("uc.autoApprove", "false");
    renderComposer();
    await waitFor(() => expect(screen.getByRole("switch", { name: "auto-pilot" })).not.toBeChecked());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- apps/web/test/components/home-composer.test.tsx`
Expected: FAIL — no `switch` named "auto-pilot"; `createSession` called with no args.

- [ ] **Step 3: Add state + persistence**

In `apps/web/src/components/home-composer.tsx`, add state next to the other `useState` hooks (around line 57). `useEffect` and `useState` are already imported:

```typescript
  const [autoApprove, setAutoApprove] = useState(true);
  useEffect(() => {
    const stored = localStorage.getItem("uc.autoApprove");
    if (stored !== null) setAutoApprove(stored === "true");
  }, []);
  function toggleAutoApprove(v: boolean) {
    setAutoApprove(v);
    localStorage.setItem("uc.autoApprove", String(v));
  }
```

- [ ] **Step 4: Pass the flag to createSession**

In `handleGenerate`, change the `createSession()` call (currently line 80):

```typescript
      const { sessionId } = await createSession({ autoApprove });
```

- [ ] **Step 5: Render the switch**

In the control row `<div className="flex flex-wrap items-center gap-2">`, insert this label between the Audio settings `</div>` (closes around line 262) and the `<Button onClick={handleGenerate} ...>` (line 264). `Switch` is already imported:

```tsx
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          <Switch checked={autoApprove} onCheckedChange={toggleAutoApprove} aria-label="auto-pilot" />
          <span>Auto-pilot</span>
        </label>
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test -- apps/web/test/components/home-composer.test.tsx`
Expected: PASS. Then `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/home-composer.tsx apps/web/test/components/home-composer.test.tsx
git commit -m "feat(web): Auto-pilot switch in the home composer"
```

---

## Task 7: Session-page pause control

**Files:**
- Create: `apps/web/src/components/auto-approve-control.tsx`
- Modify: `apps/web/src/components/session-page.tsx`
- Test: `apps/web/test/components/auto-approve-control.test.tsx` (**new**)

> No new SessionPage test: it mounts an `EventSource` SSE stream that jsdom does not provide. The pause logic lives in the isolated `AutoApproveControl` (unit-tested below); the SessionPage edit is a small wiring change verified by `pnpm typecheck`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/auto-approve-control.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutoApproveControl } from "@/components/auto-approve-control";
import { renderWithQuery } from "../helpers/render-with-query";

vi.mock("@/lib/api-client", () => ({ patchSession: vi.fn(async () => {}) }));
import { patchSession } from "@/lib/api-client";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<AutoApproveControl>", () => {
  it("toggling off PATCHes autoApprove=false", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AutoApproveControl sid="s1" autoApprove currentPhase="design" />);
    await user.click(screen.getByRole("switch", { name: "auto-pilot" }));
    expect(patchSession).toHaveBeenCalledWith("s1", { autoApprove: false });
  });

  it("shows the no-gates hint once the run is past the script gate", () => {
    renderWithQuery(<AutoApproveControl sid="s1" autoApprove currentPhase="compose" />);
    expect(screen.getByText("No review points left; use Stop to halt.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- apps/web/test/components/auto-approve-control.test.tsx`
Expected: FAIL — the module `@/components/auto-approve-control` does not exist.

- [ ] **Step 3: Create the control component**

Create `apps/web/src/components/auto-approve-control.tsx`:

```tsx
"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { PhaseId } from "@ultracreator/shared";
import { Switch } from "@/components/ui/switch";
import { patchSession } from "@/lib/api-client";
import type { GetSessionResponse } from "@/lib/api-types";

// Phases that run after the last user-approve gate (script). Once the run is in
// one of these there is no gate left for "pause" to catch.
const PAST_LAST_GATE: PhaseId[] = ["voiceover", "compose", "render"];

interface Props {
  sid: string;
  autoApprove: boolean;
  currentPhase: PhaseId | null;
}

export function AutoApproveControl({ sid, autoApprove, currentPhase }: Props): React.ReactElement {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const noGatesLeft = autoApprove && currentPhase !== null && PAST_LAST_GATE.includes(currentPhase);

  async function toggle(value: boolean): Promise<void> {
    setBusy(true);
    // Optimistic: reflect the flip immediately in the session query.
    qc.setQueryData<GetSessionResponse | null>(["session", sid], (prev) =>
      prev ? { ...prev, autoApprove: value } : prev,
    );
    try {
      await patchSession(sid, { autoApprove: value });
    } catch (err) {
      qc.setQueryData<GetSessionResponse | null>(["session", sid], (prev) =>
        prev ? { ...prev, autoApprove: !value } : prev,
      );
      toast.error(err instanceof Error ? err.message : "Could not update auto-pilot");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["session", sid] });
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-2xl bg-card p-3 text-sm shadow-xs">
      <Switch checked={autoApprove} onCheckedChange={toggle} disabled={busy} aria-label="auto-pilot" />
      <span className="font-medium">Auto-pilot</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {noGatesLeft
          ? "No review points left; use Stop to halt."
          : autoApprove
            ? "Running straight to the video."
            : "Pausing at the next review point."}
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- apps/web/test/components/auto-approve-control.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire it into the session page**

In `apps/web/src/components/session-page.tsx`, add the import after the `ApprovalGate` import (line 8):

```tsx
import { AutoApproveControl } from "./auto-approve-control";
```

Then in the composer block, add the control just before `<ApprovalGate ... />` (line 61), shown only while the session is live:

```tsx
        <div className="space-y-2.5 p-3.5" ref={composerRef}>
          {(sessionState.kind === "running" || sessionState.kind === "awaiting-gate") && (
            <AutoApproveControl
              sid={sid}
              autoApprove={data?.autoApprove ?? false}
              currentPhase={stream.uiState.currentPhase}
            />
          )}
          <ApprovalGate
            sid={sid}
            state={sessionState}
            onRefineRequested={() => composerRef.current?.querySelector("textarea")?.focus()}
          />
          <Composer sid={sid} onUserMessage={(text, files) => stream.addUserMessage(text, files)} />
        </div>
```

- [ ] **Step 6: Verify wiring**

Run: `pnpm typecheck`
Expected: PASS (`data?.autoApprove` resolves via the `GetSessionResponse.autoApprove` field added in Task 5; `stream.uiState.currentPhase` is `PhaseId | null`).

- [ ] **Step 7: Run the full web + server suites**

Run: `pnpm test -- apps/web` then `pnpm test -- apps/server`
Expected: PASS (no regressions). If a local Postgres is unavailable, the `*.pg.test.ts` files will error on connect — note them as unverified rather than deleting.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/auto-approve-control.tsx apps/web/src/components/session-page.tsx apps/web/test/components/auto-approve-control.test.tsx
git commit -m "feat(web): session-page Auto-pilot pause control"
```

---

## Self-review notes

- **Spec coverage:** session-level flag (T1–T2), gate skip + auto-pass notice (T3), POST/GET/PATCH + resume-on-enable (T3–T4), homepage switch with localStorage default-ON (T6), live pause control with the past-script hint (T7). All spec sections map to a task.
- **Type consistency:** `setAutoApprove(id, value)` is identical across the interface, PG impl, fake, and orchestrator. `createSession({ autoApprove })` (client) ↔ `AutoApproveBodySchema` (server) ↔ `create({ ..., autoApprove })` (repo). `GetSessionResponse.autoApprove` is produced by GET (T4) and consumed by the session page + control (T7).
- **Backward compatibility:** column defaults `false`; `sessions.get` returning `null` in `runPhase` keeps today's "always park" behavior, so existing orchestrator/route tests are unaffected.
