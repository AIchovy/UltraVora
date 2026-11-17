# Product Plaza & Public Promo Videos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user publish a generated promo video to a public "Product Plaza" — the first public generation per account is free — where anyone can browse public videos, follow the link to the creator's product, and like a video once.

**Architecture:** A "public video" is simply a `creator_sessions` row with `is_public = true` and `status = 'done'`. We extend that table (publicity + a denormalised `like_count` + the product URL) and add a `video_likes` table (unique per user+session). The per-phase credit charge is waived when a public session claims the account's one free grant. New unguarded `/api/public/*` routes list/serve/like public videos; the existing owner-gated file streamer is factored into a shared helper. The web app adds a composer toggle, a sidebar tab, a `/plaza` gallery (in-app + logged-out), and a `/v/[sid]` share page.

**Tech Stack:** TypeScript, Fastify 5, Drizzle ORM + Postgres, better-auth, Next.js App Router, React Query v5, shadcn/ui, Tailwind, Vitest (+ jsdom for web).

**Spec:** `docs/superpowers/specs/2026-07-01-product-plaza-public-videos-design.md`

**Conventions used below**
- Run one test file: `pnpm test <filename-substring>` (the root `test` script forwards the filter to vitest). Full suite: `pnpm test`. Types: `pnpm typecheck`.
- PG integration tests are `*.pg.test.ts` (run serially against a local Postgres; each does `DROP SCHEMA public CASCADE` + migrate in `beforeAll`).
- Repo pattern: every persistence interface has a PG impl **and** an in-memory fake in `apps/server/test/helpers/` that must behave identically.
- Commit after every green task.

**v1 simplifications (intentional, noted in spec)**
- No `aspectRatio` on the summary — cards use `object-cover` in a fixed aspect box.
- Plaza list returns the top `limit` (default 60, max 100) — cursor pagination deferred.
- `/v/[sid]` is client-rendered (no OG/social metadata) in v1.

---

## Task 1: Shared `PublicVideoSummary` + `PublicVideoSort` types

**Files:**
- Create: `packages/shared/src/public-video.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/public-video.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/test/public-video.test.ts
import { describe, it, expect } from "vitest";
import { PUBLIC_VIDEO_SORTS, isPublicVideoSort } from "../src/public-video.js";

describe("public-video", () => {
  it("lists the two sort orders", () => {
    expect(PUBLIC_VIDEO_SORTS).toEqual(["recent", "likes"]);
  });

  it("validates sort strings", () => {
    expect(isPublicVideoSort("recent")).toBe(true);
    expect(isPublicVideoSort("likes")).toBe(true);
    expect(isPublicVideoSort("nope")).toBe(false);
    expect(isPublicVideoSort(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test public-video`
Expected: FAIL — cannot find module `../src/public-video.js`.

- [ ] **Step 3: Create the module**

```ts
// packages/shared/src/public-video.ts

/** Sort orders for the Product Plaza listing. */
export const PUBLIC_VIDEO_SORTS = ["recent", "likes"] as const;
export type PublicVideoSort = (typeof PUBLIC_VIDEO_SORTS)[number];

export function isPublicVideoSort(v: unknown): v is PublicVideoSort {
  return typeof v === "string" && (PUBLIC_VIDEO_SORTS as readonly string[]).includes(v);
}

/** One public video as shown on the Plaza / share page. */
export interface PublicVideoSummary {
  /** Owning creator_session id; also the playback + like key. */
  sid: string;
  title: string | null;
  author: { name: string; image: string | null };
  /** Outbound product link the creator entered (null if none). */
  productUrl: string | null;
  likeCount: number;
  createdAt: string; // ISO
  /** Whether the requesting viewer has liked it (false when logged out). */
  likedByMe: boolean;
}
```

- [ ] **Step 4: Export from the shared index**

Add to `packages/shared/src/index.ts` (keep the list alphabetical-ish, matching existing order — append after `./pricing.js`):

```ts
export * from "./public-video.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test public-video`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/public-video.ts packages/shared/src/index.ts packages/shared/test/public-video.test.ts
git commit -m "feat(shared): PublicVideoSummary + PublicVideoSort types"
```

---

## Task 2: Database schema — publicity columns + `video_likes`

**Files:**
- Modify: `apps/server/src/db/schema/creator.ts`
- Generate: `apps/server/drizzle/<timestamp>_*.sql` (via drizzle-kit)

- [ ] **Step 1: Add columns to `creator_sessions`**

In `apps/server/src/db/schema/creator.ts`, add these fields inside the `creator_sessions` column object, after `autoApprove` (line ~32):

```ts
    // Product Plaza: publicity + denormalised like counter + outbound product
    // link. A "public video" is is_public=true AND status='done'. free_grant
    // marks the ONE session that consumed the account's free public generation.
    isPublic: boolean("is_public").notNull().default(false),
    productUrl: text("product_url"), // outbound link; null when none entered
    freeGrant: boolean("free_grant").notNull().default(false),
    likeCount: integer("like_count").notNull().default(0),
```

Add two indexes to the table's index callback (alongside `userUpdatedIdx`):

```ts
    publicCreatedIdx: index("creator_sessions_public_created_at_idx").on(t.isPublic, t.createdAt),
    publicLikesIdx: index("creator_sessions_public_like_count_idx").on(t.isPublic, t.likeCount),
```

- [ ] **Step 2: Add the `video_likes` table**

Append to `apps/server/src/db/schema/creator.ts` (after the `sessionMessage` table):

```ts
// One row per (user, public video) like. The unique index enforces the
// one-like-per-user-per-video rule; creator_sessions.like_count is the
// denormalised counter kept in step with inserts/deletes here.
export const videoLike = pgTable(
  "video_likes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    sessionUserKey: uniqueIndex("video_likes_session_id_user_id_key").on(t.sessionId, t.userId),
  }),
);
```

(`bigserial`, `integer`, `boolean`, `index`, `uniqueIndex`, `timestamp`, `text`, `user` are all already imported at the top of this file.)

- [ ] **Step 3: Generate the migration**

Run: `pnpm -F @ultracreator/server db:generate`
Expected: a new file appears under `apps/server/drizzle/` containing `ALTER TABLE "creator_sessions" ADD COLUMN ...`, `CREATE TABLE "video_likes" ...`, and the two `CREATE INDEX` statements. Open it and sanity-check.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (schema is valid TS).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/schema/creator.ts apps/server/drizzle/
git commit -m "feat(db): public-video columns on creator_sessions + video_likes table"
```

---

## Task 3: SessionRepository — publicity fields + create() extension

**Files:**
- Modify: `apps/server/src/sessions/session-repository.ts`
- Modify: `apps/server/src/sessions/pg-session-repository.ts`
- Modify: `apps/server/test/helpers/in-memory-session-repository.ts`
- Test: `apps/server/test/sessions/in-memory-session-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/server/test/sessions/in-memory-session-repository.test.ts`:

```ts
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";

describe("public-video fields", () => {
  it("defaults publicity fields on a plain create", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    const row = await repo.get("s1");
    expect(row).toMatchObject({
      isPublic: false,
      productUrl: null,
      freeGrant: false,
      likeCount: 0,
    });
  });

  it("stores isPublic + productUrl from create", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s2", userId: "u1", isPublic: true, productUrl: "https://acme.com" });
    const row = await repo.get("s2");
    expect(row).toMatchObject({ isPublic: true, productUrl: "https://acme.com" });
  });
});
```

(If the test file has no `describe`/imports yet, add `import { describe, it, expect } from "vitest";` at the top.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test in-memory-session-repository`
Expected: FAIL — `create` rejects the extra keys / `row` lacks `isPublic`.

- [ ] **Step 3: Extend the interface + record type**

In `apps/server/src/sessions/session-repository.ts`, add to `SessionRecord` (after `autoApprove`):

```ts
  /** Product Plaza publicity (set at creation, immutable in v1). */
  isPublic: boolean;
  /** Outbound product link, or null. */
  productUrl: string | null;
  /** True when this session consumed the account's one free public grant. */
  freeGrant: boolean;
  /** Denormalised like counter. */
  likeCount: number;
```

Change the `create` signature in the `SessionRepository` interface:

```ts
  create(input: {
    id: string;
    userId: string;
    autoApprove?: boolean;
    isPublic?: boolean;
    productUrl?: string | null;
  }): Promise<void>;
```

- [ ] **Step 4: Update the PG impl**

In `apps/server/src/sessions/pg-session-repository.ts`, extend `toRecord` (add after `autoApprove: row.autoApprove,`):

```ts
    isPublic: row.isPublic,
    productUrl: row.productUrl,
    freeGrant: row.freeGrant,
    likeCount: row.likeCount,
```

Update `create`:

```ts
  async create(input: {
    id: string;
    userId: string;
    autoApprove?: boolean;
    isPublic?: boolean;
    productUrl?: string | null;
  }): Promise<void> {
    await this.db
      .insert(creatorSession)
      .values({
        id: input.id,
        userId: input.userId,
        autoApprove: input.autoApprove ?? false,
        isPublic: input.isPublic ?? false,
        productUrl: input.productUrl ?? null,
      })
      .onConflictDoNothing({ target: creatorSession.id });
  }
```

- [ ] **Step 5: Update the in-memory fake**

In `apps/server/test/helpers/in-memory-session-repository.ts`, change `create`:

```ts
  async create(input: {
    id: string;
    userId: string;
    autoApprove?: boolean;
    isPublic?: boolean;
    productUrl?: string | null;
  }): Promise<void> {
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
      isPublic: input.isPublic ?? false,
      productUrl: input.productUrl ?? null,
      freeGrant: false,
      likeCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm test in-memory-session-repository` → PASS.
Run: `pnpm typecheck` → PASS (create's new params are optional, so existing callers still compile).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sessions/session-repository.ts apps/server/src/sessions/pg-session-repository.ts apps/server/test/helpers/in-memory-session-repository.ts apps/server/test/sessions/in-memory-session-repository.test.ts
git commit -m "feat(server): SessionRepository carries publicity fields"
```

---

## Task 4: SessionRepository — `claimFreePublicGrant` + `hasFreePublicGrant`

**Files:**
- Modify: `apps/server/src/sessions/session-repository.ts`
- Modify: `apps/server/src/sessions/pg-session-repository.ts`
- Modify: `apps/server/test/helpers/in-memory-session-repository.ts`
- Test: `apps/server/test/sessions/in-memory-session-repository.test.ts`
- Test (PG): `apps/server/test/sessions/free-grant.pg.test.ts`

- [ ] **Step 1: Write the failing unit test**

Append to `apps/server/test/sessions/in-memory-session-repository.test.ts`:

```ts
describe("free public grant", () => {
  it("grants the first public session and refuses a second for the same user", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "a", userId: "u1", isPublic: true });
    await repo.create({ id: "b", userId: "u1", isPublic: true });

    expect(await repo.hasFreePublicGrant("u1")).toBe(false);
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.hasFreePublicGrant("u1")).toBe(true);
    // Second distinct session for the same user loses.
    expect(await repo.claimFreePublicGrant("b", "u1")).toBe(false);
    // Re-claiming the holding session is idempotent.
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
  });

  it("is per-user", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "a", userId: "u1", isPublic: true });
    await repo.create({ id: "c", userId: "u2", isPublic: true });
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.claimFreePublicGrant("c", "u2")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test in-memory-session-repository`
Expected: FAIL — `claimFreePublicGrant`/`hasFreePublicGrant` are not functions.

- [ ] **Step 3: Add to the interface**

In `apps/server/src/sessions/session-repository.ts`, add to `SessionRepository`:

```ts
  /**
   * Claim the account's one-time free public generation for this session.
   * Returns true when `sessionId` holds the grant afterwards — either it just
   * claimed it (no other session of `userId` had it) or it already held it
   * (idempotent). Returns false when another session already holds it.
   */
  claimFreePublicGrant(sessionId: string, userId: string): Promise<boolean>;
  /** True when any of the user's sessions already holds the free public grant. */
  hasFreePublicGrant(userId: string): Promise<boolean>;
```

- [ ] **Step 4: Implement in the PG repo**

In `apps/server/src/sessions/pg-session-repository.ts`, add `sql` to the drizzle import:

```ts
import { eq, desc, and, isNull, sql } from "drizzle-orm";
```

Add the methods to the class:

```ts
  async claimFreePublicGrant(sessionId: string, userId: string): Promise<boolean> {
    // Serialize per-user claims with an advisory lock so two concurrent public
    // runs can't both pass the "no holder yet" check and both go free.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
      const holder = await tx
        .select({ id: creatorSession.id })
        .from(creatorSession)
        .where(and(eq(creatorSession.userId, userId), eq(creatorSession.freeGrant, true)))
        .limit(1);
      if (holder[0]) return holder[0].id === sessionId;
      await tx
        .update(creatorSession)
        .set({ freeGrant: true })
        .where(eq(creatorSession.id, sessionId));
      return true;
    });
  }

  async hasFreePublicGrant(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: creatorSession.id })
      .from(creatorSession)
      .where(and(eq(creatorSession.userId, userId), eq(creatorSession.freeGrant, true)))
      .limit(1);
    return rows.length > 0;
  }
```

- [ ] **Step 5: Implement in the in-memory fake**

In `apps/server/test/helpers/in-memory-session-repository.ts`, add:

```ts
  async claimFreePublicGrant(sessionId: string, userId: string): Promise<boolean> {
    const holder = [...this.rows.values()].find((r) => r.userId === userId && r.freeGrant);
    if (holder) return holder.id === sessionId;
    const row = this.rows.get(sessionId);
    if (!row) return false;
    row.freeGrant = true;
    return true;
  }

  async hasFreePublicGrant(userId: string): Promise<boolean> {
    return [...this.rows.values()].some((r) => r.userId === userId && r.freeGrant);
  }
```

- [ ] **Step 6: Run unit test + typecheck**

Run: `pnpm test in-memory-session-repository` → PASS.
Run: `pnpm typecheck` → PASS.

- [ ] **Step 7: Write the PG integration test**

There is no shared PG-test helper in this repo — each `*.pg.test.ts` bootstraps a real DB inline (create DB if absent, `DROP SCHEMA public`, migrate from `../drizzle`). This mirrors `apps/server/test/restart-recovery.pg.test.ts` exactly. From `test/sessions/`, the migrations folder is `../../drizzle`.

```ts
// apps/server/test/sessions/free-grant.pg.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgSessionRepository } from "../../src/sessions/pg-session-repository.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const testDbName = new URL(TEST_URL).pathname.slice(1);

let pool: pg.Pool;
let repo: PgSessionRepository;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${testDbName}`).catch((e: { code?: string }) => {
    if (e.code !== "42P04") throw e; // ignore "already exists"
  });
  await admin.end();
  pool = new pg.Pool({ connectionString: TEST_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await migrate(drizzle(pool), { migrationsFolder });
  repo = new PgSessionRepository(drizzle(pool));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
});

describe("PgSessionRepository free public grant", () => {
  it("grants once per account", async () => {
    await repo.create({ id: "a", userId: "u1", isPublic: true });
    await repo.create({ id: "b", userId: "u1", isPublic: true });
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.claimFreePublicGrant("b", "u1")).toBe(false);
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.hasFreePublicGrant("u1")).toBe(true);
  });
});
```

- [ ] **Step 8: Run the PG test**

Run: `pnpm test free-grant.pg`
Expected: PASS (needs local Postgres running). If Postgres is unavailable in this environment, note it and rely on the unit test; the PG test still lands for CI.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/sessions/session-repository.ts apps/server/src/sessions/pg-session-repository.ts apps/server/test/helpers/in-memory-session-repository.ts apps/server/test/sessions/in-memory-session-repository.test.ts apps/server/test/sessions/free-grant.pg.test.ts
git commit -m "feat(server): one-free-public-grant claim on SessionRepository"
```

---

## Task 5: `POST /api/sessions` accepts `isPublic` + `productUrl`

**Files:**
- Modify: `apps/server/src/api/sessions-routes.ts`
- Test: `apps/server/test/api/sessions-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/api/sessions-routes.test.ts` (inside the existing `describe("sessions routes", …)`):

```ts
  it("POST /api/sessions persists isPublic + productUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { autoApprove: true, isPublic: true, productUrl: "https://acme.com" },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json() as { sessionId: string };
    const row = await deps.sessions.get(sessionId);
    expect(row).toMatchObject({ isPublic: true, productUrl: "https://acme.com" });
  });

  it("POST /api/sessions rejects a malformed productUrl", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: { isPublic: true, productUrl: "not-a-url" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/sessions still works with no body (defaults private)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions" });
    expect(res.statusCode).toBe(201);
    const { sessionId } = res.json() as { sessionId: string };
    expect(await deps.sessions.get(sessionId)).toMatchObject({ isPublic: false, productUrl: null });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test sessions-routes`
Expected: FAIL — `isPublic` not persisted; malformed URL returns 201.

- [ ] **Step 3: Extend the route body schema + create call**

In `apps/server/src/api/sessions-routes.ts`, replace `AutoApproveBodySchema` and the POST handler's parse/create with:

```ts
  const AutoApproveBodySchema = z.object({ autoApprove: z.boolean() });
  const CreateBodySchema = z.object({
    autoApprove: z.boolean().optional(),
    isPublic: z.boolean().optional(),
    productUrl: z.string().url().optional(),
  });

  app.post("/api/sessions", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    // Tolerate a missing/empty body (autoApprove defaults false, private). A
    // present-but-malformed productUrl is a hard 400 (don't store junk links).
    const raw = req.body ?? {};
    const parsed = CreateBodySchema.safeParse(raw);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid body" });
      return;
    }
    const { autoApprove = false, isPublic = false, productUrl } = parsed.data;
    const sessionId = newSessionId();
    await deps.sessions.create({
      id: sessionId,
      userId,
      autoApprove,
      isPublic,
      productUrl: productUrl ?? null,
    });
    await deps.workspaces.init(sessionId);
    await deps.eventLog.attach(sessionId);
    reply.code(201).send({ sessionId });
  });
```

(`AutoApproveBodySchema` is still used by the PATCH handler below — leave that handler unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test sessions-routes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/sessions-routes.ts apps/server/test/api/sessions-routes.test.ts
git commit -m "feat(server): POST /api/sessions accepts isPublic + productUrl"
```

---

## Task 6: Waive per-phase charge for a free public session

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts` (`chargeForPhase`, ~line 577)
- Create: `apps/server/test/credits/free-public-gating.test.ts`

This test reuses the exact harness shape from `apps/server/test/credits/credit-gating.test.ts` (InMemory repos + `FakePhaseHandler`s for `research` + `design`). Key insight: with `withVoiceover:false` and no auto-approve, a `new-project` runs `research → design` then parks at design's `user-approve` gate — so registering just those two handlers is enough; the run never reaches an unregistered phase.

- [ ] **Step 1: Write the failing test**

```ts
// apps/server/test/credits/free-public-gating.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId } from "@ultracreator/shared";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { EventBus } from "../../src/events/event-bus.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { FakePhaseHandler } from "../../src/phases/fake-handler.js";
import type { PhaseHandler } from "../../src/phases/types.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { MemoryCreditRepository } from "../../src/credits/memory-credit-repository.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-free-public-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const brief: Brief = {
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

function build(
  sessions: InMemorySessionRepository,
  credits: MemoryCreditRepository,
  counters: { research: number; design: number },
): SessionOrchestrator {
  const events = new EventBus();
  return new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events,
    artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map<PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({ phase: "research", produce: async () => { counters.research++; return [{ kind: "brief", data: brief }]; } })],
      ["design", new FakePhaseHandler({ phase: "design", produce: async () => { counters.design++; return [{ kind: "design", data: designData }]; } })],
    ]),
    sessions,
    messages: new InMemoryMessageStore(),
    credits,
  });
}

const newProject = {
  text: "Make a promo for Acme",
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
} as const;

describe("free public generation", () => {
  it("runs a public session with zero balance and never charges", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "pub1", userId: "u1", isPublic: true });
    const credits = new MemoryCreditRepository(); // balance 0
    const debitSpy = vi.spyOn(credits, "debit");
    const counters = { research: 0, design: 0 };
    const orch = build(sessions, credits, counters);

    await orch.handleMessage("pub1", newProject);

    // Public → free: research + design both ran (not blocked on credits); the run
    // parks at design's normal approval gate, NOT awaiting-credits.
    expect(orch.getState("pub1")).toEqual({ kind: "awaiting-gate", phase: "design" });
    expect(counters).toEqual({ research: 1, design: 1 });
    expect(debitSpy).not.toHaveBeenCalled();
    expect(await sessions.hasFreePublicGrant("u1")).toBe(true);
  });

  it("charges a second public session normally once the grant is used", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "pub1", userId: "u1", isPublic: true });
    await sessions.claimFreePublicGrant("pub1", "u1"); // consume the one free grant
    await sessions.create({ id: "pub2", userId: "u1", isPublic: true });
    const credits = new MemoryCreditRepository(); // balance 0 → cannot pay
    const counters = { research: 0, design: 0 };
    const orch = build(sessions, credits, counters);

    await orch.handleMessage("pub2", newProject);

    // No free grant left → parks in awaiting-credits at research (needs 60, has 0).
    expect(orch.getState("pub2")).toEqual({ kind: "awaiting-credits", phase: "research" });
    expect(counters.research).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test free-public-gating`
Expected: FAIL — the first test parks in `awaiting-credits` (charge not yet waived), and `debitSpy` was called.

- [ ] **Step 3: Implement the waiver**

In `apps/server/src/orchestrator/session-orchestrator.ts`, replace the body of `chargeForPhase` with:

```ts
  private async chargeForPhase(sessionId: string, phaseId: PhaseId): Promise<DebitResult | null> {
    const credits = this.deps.credits;
    if (!credits) return null;
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return null;

    // Public sessions are free ONCE per account. Claiming is idempotent per
    // session, so every phase of the granted session re-reads as free.
    if (session.isPublic) {
      const free = await this.deps.sessions.claimFreePublicGrant(sessionId, session.userId);
      // balanceAfter is unused on the success path (runPhase only checks .ok);
      // we don't widen the orchestrator's credits dep just to report it.
      if (free) return { ok: true, balanceAfter: 0, deduplicated: false };
    }

    const ctx = await this.phaseCreditContext(sessionId);
    return credits.debit({
      userId: session.userId,
      amount: phaseCredits(phaseId, ctx),
      idempotencyKey: `${sessionId}:${phaseId}`,
      reason: "consumption",
      ref: { sessionId, phase: phaseId },
    });
  }
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test free-public-gating` → PASS.
Run: `pnpm test credit-gating` → PASS (existing credit-gate behaviour unchanged for private sessions).
Run: `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/credits/free-public-gating.test.ts
git commit -m "feat(server): waive per-phase charge for the free public generation"
```

---

## Task 7: `GET /api/credits` reports `freePublicAvailable`

**Files:**
- Modify: `apps/server/src/api/billing-routes.ts`
- Test: `apps/server/test/api/billing-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/api/billing-routes.test.ts` (match its existing harness — it builds an app with `deps.credits` + `deps.sessions`):

```ts
  it("reports freePublicAvailable=true before any grant, false after", async () => {
    const before = await app.inject({ method: "GET", url: "/api/credits" });
    expect((before.json() as { freePublicAvailable: boolean }).freePublicAvailable).toBe(true);

    // Consume the grant on a public session.
    await deps.sessions.create({ id: "pub", userId: "u-test", isPublic: true });
    await deps.sessions.claimFreePublicGrant("pub", "u-test");

    const after = await app.inject({ method: "GET", url: "/api/credits" });
    expect((after.json() as { freePublicAvailable: boolean }).freePublicAvailable).toBe(false);
  });
```

(If the billing test harness doesn't already inject a `sessions` dep, add `sessions: new InMemorySessionRepository()` to its `deps` — import from `../helpers/in-memory-session-repository.js`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test billing-routes`
Expected: FAIL — `freePublicAvailable` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/server/src/api/billing-routes.ts`, inside the `GET /api/credits` handler, compute the flag once (right after the `userId` guard) and include it in **both** send paths:

```ts
    const freePublicAvailable = !(await deps.sessions.hasFreePublicGrant(userId));
    if (!credits) {
      reply.send({ balance: 0, subscription: null, freePublicAvailable });
      return;
    }
```

and change the final send to:

```ts
    reply.send({ balance, breakdown, subscription, freePublicAvailable });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test billing-routes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/billing-routes.ts apps/server/test/api/billing-routes.test.ts
git commit -m "feat(server): GET /api/credits reports freePublicAvailable"
```

---

## Task 8: Extract a shared workspace-file streamer

**Files:**
- Create: `apps/server/src/api/file-serving.ts`
- Modify: `apps/server/src/api/files-routes.ts`
- Test (existing, must stay green): `apps/server/test/api/files-routes.test.ts`

This is a refactor with no behaviour change — validated by the existing files-routes tests.

- [ ] **Step 1: Create the shared helper**

```ts
// apps/server/src/api/file-serving.ts
import { createReadStream, statSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { SessionMediaArchive } from "../storage/session-media-archive.js";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".srt": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
};

function mimeOf(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

interface ParsedRange {
  start: number;
  end: number; // inclusive
}

function parseRange(header: string, size: number): ParsedRange | "unsatisfiable" | null {
  const m = /^bytes=(\d+)?-(\d+)?$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] !== undefined ? Number(m[1]) : NaN;
  let end = m[2] !== undefined ? Number(m[2]) : NaN;
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    const suffix = end;
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start > end || start >= size) return "unsatisfiable";
  if (end >= size) end = size - 1;
  return { start, end };
}

/**
 * Stream a workspace-relative file (with Range support) or 302-redirect to a
 * signed URL when the local copy has been archived to GCS. Runs a path-escape
 * check against `root`. The caller is responsible for authorization.
 */
export async function serveWorkspaceFile(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { root: string; relative: string; sid: string; media?: SessionMediaArchive },
): Promise<unknown> {
  const target = resolve(opts.root, opts.relative);
  if (!target.startsWith(resolve(opts.root) + "/") && target !== resolve(opts.root)) {
    return reply.code(400).send({ error: "path escapes workspace" });
  }
  if (!existsSync(target)) {
    const url = opts.media ? await opts.media.signedUrlFor(opts.sid, opts.relative) : null;
    if (url) {
      reply.header("Cache-Control", "private, no-store");
      return reply.redirect(url, 302);
    }
    return reply.code(404).send({ error: "file not found" });
  }
  const stat = statSync(target);
  if (!stat.isFile()) {
    return reply.code(404).send({ error: "not a file" });
  }

  const rangeHeader = req.headers.range;
  reply.header("Accept-Ranges", "bytes");
  reply.header("Content-Type", mimeOf(target));

  if (rangeHeader) {
    const range = parseRange(rangeHeader, stat.size);
    if (range === "unsatisfiable") {
      reply.code(416).header("Content-Range", `bytes */${stat.size}`).send();
      return reply;
    }
    if (range !== null) {
      const length = range.end - range.start + 1;
      reply.code(206);
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
      reply.header("Content-Length", String(length));
      return reply.send(createReadStream(target, { start: range.start, end: range.end }));
    }
  }

  reply.header("Content-Length", String(stat.size));
  return reply.send(createReadStream(target));
}
```

- [ ] **Step 2: Rewrite `files-routes.ts` to use it**

Replace the entire body of `apps/server/src/api/files-routes.ts` with:

```ts
// apps/server/src/api/files-routes.ts
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";
import { serveWorkspaceFile } from "./file-serving.js";

export async function registerFilesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get<{ Params: { sid: string; "*": string } }>(
    "/api/sessions/:sid/files/*",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const relative = req.params["*"];
      const root = deps.workspaces.paths(sid).root;
      return serveWorkspaceFile(req, reply, { root, relative, sid, media: deps.media });
    },
  );
}
```

- [ ] **Step 3: Run the existing files-routes tests**

Run: `pnpm test files-routes`
Expected: PASS (all existing cases — local stream, range 206, 416, GCS 302 fallback, path-escape 400, 404 — unchanged).

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/server/src/api/file-serving.ts apps/server/src/api/files-routes.ts
git commit -m "refactor(server): extract serveWorkspaceFile from files-routes"
```

---

## Task 9: `PublicVideoRepository` (interface + fake + PG)

**Files:**
- Create: `apps/server/src/public/public-video-repository.ts`
- Create: `apps/server/src/public/pg-public-video-repository.ts`
- Create: `apps/server/test/helpers/in-memory-public-video-repository.ts`
- Test: `apps/server/test/public/in-memory-public-video-repository.test.ts`
- Test (PG): `apps/server/test/public/public-video-repository.pg.test.ts`

- [ ] **Step 1: Define the interface**

```ts
// apps/server/src/public/public-video-repository.ts
import type { PublicVideoSort, PublicVideoSummary } from "@ultracreator/shared";

export interface ListPublicVideosOpts {
  sort: PublicVideoSort;
  limit: number;
  /** Viewer whose likes populate likedByMe; null/undefined when logged out. */
  viewerId?: string | null;
}

/** Result of a like/unlike toggle; null when the target isn't a public video. */
export interface LikeResult {
  likeCount: number;
  liked: boolean;
}

/**
 * Read/like surface for public videos. A public video is a creator_sessions row
 * with is_public=true AND status='done'. The PG impl and the in-memory fake
 * MUST behave identically (same contract as SessionRepository's pair).
 */
export interface PublicVideoRepository {
  list(opts: ListPublicVideosOpts): Promise<PublicVideoSummary[]>;
  get(sessionId: string, viewerId?: string | null): Promise<PublicVideoSummary | null>;
  like(sessionId: string, userId: string): Promise<LikeResult | null>;
  unlike(sessionId: string, userId: string): Promise<LikeResult | null>;
}
```

- [ ] **Step 2: Write the failing fake test**

```ts
// apps/server/test/public/in-memory-public-video-repository.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryPublicVideoRepository } from "../helpers/in-memory-public-video-repository.js";

function seed(repo: InMemoryPublicVideoRepository) {
  repo.seed({ sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 1, createdAt: "2026-01-01T00:00:00.000Z" });
  repo.seed({ sid: "b", title: "Beta", author: { name: "Bob", image: null }, productUrl: null, likeCount: 5, createdAt: "2026-02-01T00:00:00.000Z" });
}

describe("InMemoryPublicVideoRepository", () => {
  it("sorts by recent (createdAt desc)", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    const list = await repo.list({ sort: "recent", limit: 10 });
    expect(list.map((v) => v.sid)).toEqual(["b", "a"]);
  });

  it("sorts by likes (likeCount desc)", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    const list = await repo.list({ sort: "likes", limit: 10 });
    expect(list.map((v) => v.sid)).toEqual(["b", "a"]);
  });

  it("respects limit", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    expect(await repo.list({ sort: "recent", limit: 1 })).toHaveLength(1);
  });

  it("computes likedByMe for the viewer", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    await repo.like("a", "u1");
    const asU1 = await repo.list({ sort: "recent", limit: 10, viewerId: "u1" });
    expect(asU1.find((v) => v.sid === "a")?.likedByMe).toBe(true);
    const anon = await repo.list({ sort: "recent", limit: 10 });
    expect(anon.every((v) => v.likedByMe === false)).toBe(true);
  });

  it("like is idempotent per user and toggles back with unlike", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    expect(await repo.like("b", "u1")).toEqual({ likeCount: 6, liked: true });
    expect(await repo.like("b", "u1")).toEqual({ likeCount: 6, liked: true }); // no double count
    expect(await repo.unlike("b", "u1")).toEqual({ likeCount: 5, liked: false });
    expect(await repo.unlike("b", "u1")).toEqual({ likeCount: 5, liked: false }); // floor
  });

  it("returns null for a non-public video", async () => {
    const repo = new InMemoryPublicVideoRepository();
    expect(await repo.get("missing")).toBeNull();
    expect(await repo.like("missing", "u1")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test in-memory-public-video-repository`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the in-memory fake**

```ts
// apps/server/test/helpers/in-memory-public-video-repository.ts
import type { PublicVideoSummary } from "@ultracreator/shared";
import type {
  LikeResult,
  ListPublicVideosOpts,
  PublicVideoRepository,
} from "../../src/public/public-video-repository.js";

type SeedRow = Omit<PublicVideoSummary, "likedByMe">;

/** Seed-driven fake. Each seeded row is a public+done video. */
export class InMemoryPublicVideoRepository implements PublicVideoRepository {
  private rows = new Map<string, SeedRow>();
  private likes = new Set<string>(); // `${sid}:${userId}`

  seed(row: SeedRow): void {
    this.rows.set(row.sid, { ...row });
  }

  private toSummary(row: SeedRow, viewerId?: string | null): PublicVideoSummary {
    return { ...row, likedByMe: viewerId ? this.likes.has(`${row.sid}:${viewerId}`) : false };
  }

  async list(opts: ListPublicVideosOpts): Promise<PublicVideoSummary[]> {
    const all = [...this.rows.values()];
    all.sort((a, b) =>
      opts.sort === "likes"
        ? b.likeCount - a.likeCount || (a.createdAt < b.createdAt ? 1 : -1)
        : a.createdAt < b.createdAt
          ? 1
          : a.createdAt > b.createdAt
            ? -1
            : 0,
    );
    return all.slice(0, opts.limit).map((r) => this.toSummary(r, opts.viewerId));
  }

  async get(sessionId: string, viewerId?: string | null): Promise<PublicVideoSummary | null> {
    const row = this.rows.get(sessionId);
    return row ? this.toSummary(row, viewerId) : null;
  }

  async like(sessionId: string, userId: string): Promise<LikeResult | null> {
    const row = this.rows.get(sessionId);
    if (!row) return null;
    const key = `${sessionId}:${userId}`;
    if (!this.likes.has(key)) {
      this.likes.add(key);
      row.likeCount += 1;
    }
    return { likeCount: row.likeCount, liked: true };
  }

  async unlike(sessionId: string, userId: string): Promise<LikeResult | null> {
    const row = this.rows.get(sessionId);
    if (!row) return null;
    const key = `${sessionId}:${userId}`;
    if (this.likes.has(key)) {
      this.likes.delete(key);
      row.likeCount = Math.max(0, row.likeCount - 1);
    }
    return { likeCount: row.likeCount, liked: false };
  }
}
```

- [ ] **Step 5: Run fake test to verify it passes**

Run: `pnpm test in-memory-public-video-repository`
Expected: PASS.

- [ ] **Step 6: Implement the PG repo**

```ts
// apps/server/src/public/pg-public-video-repository.ts
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PublicVideoSummary } from "@ultracreator/shared";
import { creatorSession, videoLike } from "../db/schema/creator.js";
import { user } from "../db/schema/auth.js";
import type { Db } from "../db/client.js";
import type {
  LikeResult,
  ListPublicVideosOpts,
  PublicVideoRepository,
} from "./public-video-repository.js";

interface BaseRow {
  sid: string;
  title: string | null;
  productUrl: string | null;
  likeCount: number;
  createdAt: Date;
  authorName: string;
  authorImage: string | null;
}

const PUBLIC = and(eq(creatorSession.isPublic, true), eq(creatorSession.status, "done"));

export class PgPublicVideoRepository implements PublicVideoRepository {
  constructor(private db: Db) {}

  private select() {
    return this.db
      .select({
        sid: creatorSession.id,
        title: creatorSession.title,
        productUrl: creatorSession.productUrl,
        likeCount: creatorSession.likeCount,
        createdAt: creatorSession.createdAt,
        authorName: user.name,
        authorImage: user.image,
      })
      .from(creatorSession)
      .innerJoin(user, eq(user.id, creatorSession.userId));
  }

  private async withLiked(rows: BaseRow[], viewerId?: string | null): Promise<PublicVideoSummary[]> {
    let likedSet = new Set<string>();
    if (viewerId && rows.length > 0) {
      const liked = await this.db
        .select({ sessionId: videoLike.sessionId })
        .from(videoLike)
        .where(
          and(
            eq(videoLike.userId, viewerId),
            inArray(videoLike.sessionId, rows.map((r) => r.sid)),
          ),
        );
      likedSet = new Set(liked.map((l) => l.sessionId));
    }
    return rows.map((r) => ({
      sid: r.sid,
      title: r.title,
      author: { name: r.authorName, image: r.authorImage },
      productUrl: r.productUrl,
      likeCount: r.likeCount,
      createdAt: r.createdAt.toISOString(),
      likedByMe: likedSet.has(r.sid),
    }));
  }

  async list(opts: ListPublicVideosOpts): Promise<PublicVideoSummary[]> {
    const order =
      opts.sort === "likes"
        ? [desc(creatorSession.likeCount), desc(creatorSession.id)]
        : [desc(creatorSession.createdAt), desc(creatorSession.id)];
    const rows = (await this.select().where(PUBLIC).orderBy(...order).limit(opts.limit)) as BaseRow[];
    return this.withLiked(rows, opts.viewerId);
  }

  async get(sessionId: string, viewerId?: string | null): Promise<PublicVideoSummary | null> {
    const rows = (await this.select()
      .where(and(PUBLIC, eq(creatorSession.id, sessionId)))
      .limit(1)) as BaseRow[];
    if (!rows[0]) return null;
    return (await this.withLiked([rows[0]], viewerId))[0]!;
  }

  async like(sessionId: string, userId: string): Promise<LikeResult | null> {
    return this.db.transaction(async (tx) => {
      const target = await tx
        .select({ id: creatorSession.id })
        .from(creatorSession)
        .where(and(PUBLIC, eq(creatorSession.id, sessionId)))
        .limit(1);
      if (!target[0]) return null;
      const inserted = await tx
        .insert(videoLike)
        .values({ sessionId, userId })
        .onConflictDoNothing()
        .returning({ id: videoLike.id });
      if (inserted.length > 0) {
        await tx
          .update(creatorSession)
          .set({ likeCount: sql`${creatorSession.likeCount} + 1` })
          .where(eq(creatorSession.id, sessionId));
      }
      const [row] = await tx
        .select({ likeCount: creatorSession.likeCount })
        .from(creatorSession)
        .where(eq(creatorSession.id, sessionId))
        .limit(1);
      return { likeCount: row!.likeCount, liked: true };
    });
  }

  async unlike(sessionId: string, userId: string): Promise<LikeResult | null> {
    return this.db.transaction(async (tx) => {
      const target = await tx
        .select({ id: creatorSession.id })
        .from(creatorSession)
        .where(and(PUBLIC, eq(creatorSession.id, sessionId)))
        .limit(1);
      if (!target[0]) return null;
      const deleted = await tx
        .delete(videoLike)
        .where(and(eq(videoLike.sessionId, sessionId), eq(videoLike.userId, userId)))
        .returning({ id: videoLike.id });
      if (deleted.length > 0) {
        await tx
          .update(creatorSession)
          .set({ likeCount: sql`GREATEST(${creatorSession.likeCount} - 1, 0)` })
          .where(eq(creatorSession.id, sessionId));
      }
      const [row] = await tx
        .select({ likeCount: creatorSession.likeCount })
        .from(creatorSession)
        .where(eq(creatorSession.id, sessionId))
        .limit(1);
      return { likeCount: row!.likeCount, liked: false };
    });
  }
}
```

- [ ] **Step 7: Write the PG integration test**

Same inline bootstrap as Task 4's PG test (from `test/public/`, migrations folder is `../../drizzle`).

```ts
// apps/server/test/public/public-video-repository.pg.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgSessionRepository } from "../../src/sessions/pg-session-repository.js";
import { PgPublicVideoRepository } from "../../src/public/pg-public-video-repository.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const testDbName = new URL(TEST_URL).pathname.slice(1);

let pool: pg.Pool;
let sessions: PgSessionRepository;
let pv: PgPublicVideoRepository;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${testDbName}`).catch((e: { code?: string }) => {
    if (e.code !== "42P04") throw e;
  });
  await admin.end();
  pool = new pg.Pool({ connectionString: TEST_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE;");
  await migrate(drizzle(pool), { migrationsFolder });
  sessions = new PgSessionRepository(drizzle(pool));
  pv = new PgPublicVideoRepository(drizzle(pool));
});

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE video_likes, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','Ann','a@x.com',false,now(),now())`,
  );
});

describe("PgPublicVideoRepository", () => {
  it("lists only public+done videos and toggles likes", async () => {
    await sessions.create({ id: "pub", userId: "u1", isPublic: true, productUrl: "https://a.com" });
    await sessions.updateStatus("pub", { status: "done", currentPhase: "render", error: null });
    await sessions.create({ id: "priv", userId: "u1", isPublic: false });
    await sessions.updateStatus("priv", { status: "done", currentPhase: "render", error: null });
    await sessions.create({ id: "running", userId: "u1", isPublic: true }); // not done → excluded

    const list = await pv.list({ sort: "recent", limit: 10 });
    expect(list.map((v) => v.sid)).toEqual(["pub"]);
    expect(list[0]!.author.name).toBe("Ann");

    expect(await pv.like("pub", "u1")).toEqual({ likeCount: 1, liked: true });
    expect(await pv.like("pub", "u1")).toEqual({ likeCount: 1, liked: true }); // idempotent
    const asViewer = await pv.get("pub", "u1");
    expect(asViewer?.likedByMe).toBe(true);
    expect(await pv.unlike("pub", "u1")).toEqual({ likeCount: 0, liked: false });
  });
});
```

- [ ] **Step 8: Run tests + typecheck**

Run: `pnpm test in-memory-public-video-repository` → PASS.
Run: `pnpm test public-video-repository.pg` → PASS (local Postgres).
Run: `pnpm typecheck` → PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/public/ apps/server/test/helpers/in-memory-public-video-repository.ts apps/server/test/public/
git commit -m "feat(server): PublicVideoRepository (list/get/like/unlike)"
```

---

## Task 10: `/api/public/*` routes

**Files:**
- Create: `apps/server/src/api/public-routes.ts`
- Modify: `apps/server/src/api/app.ts` (AppDeps + register)
- Modify: `apps/server/src/api/server.ts` (wire the PG repo)
- Test: `apps/server/test/api/public-routes.test.ts`

- [ ] **Step 1: Add the dep to AppDeps + register the routes**

In `apps/server/src/api/app.ts`:

Add an import:

```ts
import type { PublicVideoRepository } from "../public/public-video-repository.js";
import { registerPublicRoutes } from "./public-routes.js";
```

Add to `AppDeps` (after `credits?`):

```ts
  /** Optional: public-video read/like store (Product Plaza routes). */
  publicVideos?: PublicVideoRepository;
```

Register after `registerFilesRoutes(app, deps)`:

```ts
  await registerPublicRoutes(app, deps);
```

- [ ] **Step 2: Write the failing route test**

```ts
// apps/server/test/api/public-routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/events/event-bus.js";
import { WorkspaceManager } from "../../src/workspace/workspace-manager.js";
import { ArtifactStore } from "../../src/artifacts/artifact-store.js";
import { PhaseRegistry } from "../../src/phases/registry.js";
import { RuleBasedIntentRouter } from "../../src/intent/intent-router.js";
import { SessionOrchestrator } from "../../src/orchestrator/session-orchestrator.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";
import { createApp, type AppDeps } from "../../src/api/app.js";
import { fakeAuthService } from "../helpers/fake-auth.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";
import { InMemoryPublicVideoRepository } from "../helpers/in-memory-public-video-repository.js";

let root: string;
let deps: AppDeps;
let app: Awaited<ReturnType<typeof createApp>>;
let publicVideos: InMemoryPublicVideoRepository;

function baseDeps(): AppDeps {
  const events = new EventBus();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const sessions = new InMemorySessionRepository();
  const orchestrator = new SessionOrchestrator({
    workspaces, events, artifacts, phases,
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map(), sessions, messages: new InMemoryMessageStore(),
  });
  const eventLog = new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 });
  publicVideos = new InMemoryPublicVideoRepository();
  return { workspaces, events, artifacts, phases, orchestrator, eventLog, auth: fakeAuthService(), sessions, publicVideos };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "uc-public-route-"));
  deps = baseDeps();
  app = await createApp(deps);
  publicVideos.seed({ sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 2, createdAt: "2026-01-01T00:00:00.000Z" });
});

afterEach(async () => {
  await app.close();
  await deps.eventLog.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("public routes", () => {
  it("GET /api/public/videos lists videos WITHOUT auth", async () => {
    const unauth = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauth.inject({ method: "GET", url: "/api/public/videos" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { sid: string }[]).map((v) => v.sid)).toEqual(["a"]);
    await unauth.close();
  });

  it("GET /api/public/videos?sort=likes passes the sort through", async () => {
    publicVideos.seed({ sid: "b", title: "Beta", author: { name: "Bo", image: null }, productUrl: null, likeCount: 9, createdAt: "2026-02-01T00:00:00.000Z" });
    const res = await app.inject({ method: "GET", url: "/api/public/videos?sort=likes" });
    expect((res.json() as { sid: string }[]).map((v) => v.sid)).toEqual(["b", "a"]);
  });

  it("GET /api/public/videos/:sid returns one, 404 for unknown", async () => {
    expect((await app.inject({ method: "GET", url: "/api/public/videos/a" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/public/videos/nope" })).statusCode).toBe(404);
  });

  it("POST like requires auth; 401 when logged out", async () => {
    const unauth = await createApp({ ...deps, auth: fakeAuthService(null) });
    expect((await unauth.inject({ method: "POST", url: "/api/public/videos/a/like" })).statusCode).toBe(401);
    await unauth.close();
  });

  it("POST then DELETE like toggles the count", async () => {
    const liked = await app.inject({ method: "POST", url: "/api/public/videos/a/like" });
    expect(liked.json()).toEqual({ likeCount: 3, liked: true });
    const unliked = await app.inject({ method: "DELETE", url: "/api/public/videos/a/like" });
    expect(unliked.json()).toEqual({ likeCount: 2, liked: false });
  });

  it("GET /:sid/video 404s for a non-public session", async () => {
    // 'a' is only in the public-video fake, not a real session with an mp4.
    const res = await app.inject({ method: "GET", url: "/api/public/videos/a/video" });
    expect([404]).toContain(res.statusCode);
  });

  it("GET /:sid/video streams the mp4 of a public+done session", async () => {
    // Real public session + on-disk mp4 + mp4 artifact.
    const sid = "vid1";
    await deps.sessions.create({ id: sid, userId: "u-test", isPublic: true });
    await deps.sessions.updateStatus(sid, { status: "done", currentPhase: "render", error: null });
    await deps.workspaces.init(sid);
    const out = join(deps.workspaces.paths(sid).root, "output");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "final.mp4"), Buffer.from([0, 1, 2, 3]));
    await deps.artifacts.put(sid, "mp4", { path: "output/final.mp4" });

    const res = await app.inject({ method: "GET", url: `/api/public/videos/${sid}/video` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test public-routes`
Expected: FAIL — routes not registered (404s).

- [ ] **Step 4: Implement the routes**

```ts
// apps/server/src/api/public-routes.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isPublicVideoSort } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { toWebHeaders } from "../auth/fastify-auth.js";
import { isValidSessionId } from "./session-id.js";
import { serveWorkspaceFile } from "./file-serving.js";

const LIST_LIMIT = 60;

/** Resolve the viewer id from the session cookie, or null when logged out. */
async function viewerId(deps: AppDeps, req: FastifyRequest): Promise<string | null> {
  const session = await deps.auth.getSession(toWebHeaders(req.headers));
  return session?.user.id ?? null;
}

interface Mp4Data {
  path: string;
}

export async function registerPublicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const pv = deps.publicVideos;

  app.get<{ Querystring: { sort?: string } }>("/api/public/videos", async (req, reply) => {
    if (!pv) return reply.send([]);
    const sort = isPublicVideoSort(req.query.sort) ? req.query.sort : "recent";
    const list = await pv.list({ sort, limit: LIST_LIMIT, viewerId: await viewerId(deps, req) });
    return reply.send(list);
  });

  app.get<{ Params: { sid: string } }>("/api/public/videos/:sid", async (req, reply) => {
    if (!pv) return reply.code(404).send({ error: "not found" });
    const video = await pv.get(req.params.sid, await viewerId(deps, req));
    if (!video) return reply.code(404).send({ error: "video not found" });
    return reply.send(video);
  });

  app.get<{ Params: { sid: string } }>("/api/public/videos/:sid/video", async (req, reply) => {
    const sid = req.params.sid;
    if (!isValidSessionId(sid)) return reply.code(400).send({ error: "invalid session id" });
    const row = await deps.sessions.get(sid);
    if (!row || !row.isPublic || row.status !== "done") {
      return reply.code(404).send({ error: "video not found" });
    }
    const mp4 = await deps.artifacts.get<Mp4Data>(sid, "mp4");
    if (!mp4) return reply.code(404).send({ error: "video not found" });
    const root = deps.workspaces.paths(sid).root;
    return serveWorkspaceFile(req, reply, { root, relative: mp4.data.path, sid, media: deps.media });
  });

  const like = (fn: "like" | "unlike") => async (req: FastifyRequest<{ Params: { sid: string } }>, reply: FastifyReply) => {
    if (!pv) return reply.code(503).send({ error: "public_videos_disabled" });
    const uid = await viewerId(deps, req);
    if (!uid) return reply.code(401).send({ error: "unauthorized" });
    const sid = req.params.sid;
    if (!isValidSessionId(sid)) return reply.code(400).send({ error: "invalid session id" });
    const result = await pv[fn](sid, uid);
    if (!result) return reply.code(404).send({ error: "video not found" });
    return reply.send(result);
  };

  app.post<{ Params: { sid: string } }>("/api/public/videos/:sid/like", like("like"));
  app.delete<{ Params: { sid: string } }>("/api/public/videos/:sid/like", like("unlike"));
}
```

Note on `artifacts.get`: confirm the signature is `get<T>(sessionId, kind, version?)` returning an envelope with `.data` (it is — `ArtifactStore.get`). If the returned type needs a version, omit it to get the latest.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test public-routes`
Expected: PASS. If the `/video` streaming case fails on the artifact `put` schema, check `ARTIFACT_DATA_SCHEMAS.mp4` shape (`Mp4Data`) and pass the exact fields it requires.

- [ ] **Step 6: Wire the PG repo in production**

In `apps/server/src/api/server.ts`, near where `sessions`/`credits` are built (around line 190):

```ts
import { PgPublicVideoRepository } from "../public/pg-public-video-repository.js";
```

and add to the composed deps object (alongside `credits`):

```ts
  publicVideos: new PgPublicVideoRepository(db),
```

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/server/src/api/public-routes.ts apps/server/src/api/app.ts apps/server/src/api/server.ts apps/server/test/api/public-routes.test.ts
git commit -m "feat(server): /api/public/* list, detail, playback, like routes"
```

---

## Task 11: Web api-client + types

**Files:**
- Modify: `apps/web/src/lib/api-types.ts`
- Modify: `apps/web/src/lib/api-client.ts`
- Test: `apps/web/test/lib/public-videos-client.test.ts`

- [ ] **Step 1: Extend the types**

In `apps/web/src/lib/api-types.ts`:

Add `freePublicAvailable` to `CreditsResponse`:

```ts
export interface CreditsResponse {
  balance: number;
  breakdown: { subscription: number; bonus: number; purchased: number };
  subscription: {
    tier: PlanTier;
    status: "active" | "canceled" | "past_due";
    interval: "monthly" | "yearly";
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  /** Whether the account's one free public generation is still unused. */
  freePublicAvailable: boolean;
}
```

Add the shared re-exports (extend the existing import from `@ultracreator/shared` and the re-export line at the bottom):

```ts
import type {
  // ...existing imports...
  PublicVideoSummary,
  PublicVideoSort,
} from "@ultracreator/shared";
```

```ts
export type { ArtifactDescriptor, ArtifactKind, PhaseId, ServerEvent, SessionSummary, PublicVideoSummary, PublicVideoSort };
```

- [ ] **Step 2: Write the failing client test**

```ts
// apps/web/test/lib/public-videos-client.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listPublicVideos, likeVideo, publicVideoUrl } from "@/lib/api-client";
import { mockFetch } from "../helpers/api-mocks";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});
afterEach(() => vi.restoreAllMocks());

describe("public videos client", () => {
  it("listPublicVideos hits the sort endpoint", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await listPublicVideos("likes");
    expect(calls[0]).toContain("/api/public/videos?sort=likes");
  });

  it("likeVideo POSTs and returns the toggle result", async () => {
    mockFetch(async () => new Response(JSON.stringify({ likeCount: 3, liked: true }), { status: 200 }));
    expect(await likeVideo("a")).toEqual({ likeCount: 3, liked: true });
  });

  it("publicVideoUrl builds the playback URL", () => {
    expect(publicVideoUrl("a")).toBe("http://127.0.0.1:3001/api/public/videos/a/video");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test public-videos-client`
Expected: FAIL — functions not exported.

- [ ] **Step 4: Extend `createSession` + add public-video client fns**

In `apps/web/src/lib/api-client.ts`:

Import the new types:

```ts
import type {
  // ...existing...
  PublicVideoSummary,
  PublicVideoSort,
} from "./api-types.js";
```

Replace `createSession`:

```ts
export async function createSession(
  opts: { autoApprove: boolean; isPublic?: boolean; productUrl?: string } = { autoApprove: true },
): Promise<CreateSessionResponse> {
  const out = await jsonFetch<CreateSessionResponse>(`${apiBase()}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      autoApprove: opts.autoApprove,
      ...(opts.isPublic ? { isPublic: true } : {}),
      ...(opts.productUrl ? { productUrl: opts.productUrl } : {}),
    }),
  });
  if (!out) throw new ApiError(0, "createSession: empty response");
  return out;
}
```

Update the `getCredits` fallback object to include the new field:

```ts
export async function getCredits(): Promise<CreditsResponse> {
  return (
    (await jsonFetch<CreditsResponse>(`${apiBase()}/api/credits`)) ?? {
      balance: 0,
      breakdown: { subscription: 0, bonus: 0, purchased: 0 },
      subscription: null,
      freePublicAvailable: false,
    }
  );
}
```

Append the public-video functions (near the bottom, before the final `export type`):

```ts
// ---- Product Plaza / public videos ---------------------------------------

export async function listPublicVideos(sort: PublicVideoSort = "recent"): Promise<PublicVideoSummary[]> {
  return (await jsonFetch<PublicVideoSummary[]>(`${apiBase()}/api/public/videos?sort=${sort}`)) ?? [];
}

export async function getPublicVideo(sid: string): Promise<PublicVideoSummary | null> {
  return jsonFetch<PublicVideoSummary>(`${apiBase()}/api/public/videos/${sid}`, undefined, { allow404: true });
}

export async function likeVideo(sid: string): Promise<{ likeCount: number; liked: boolean }> {
  const out = await jsonFetch<{ likeCount: number; liked: boolean }>(
    `${apiBase()}/api/public/videos/${sid}/like`,
    { method: "POST" },
  );
  if (!out) throw new ApiError(0, "likeVideo: empty response");
  return out;
}

export async function unlikeVideo(sid: string): Promise<{ likeCount: number; liked: boolean }> {
  const out = await jsonFetch<{ likeCount: number; liked: boolean }>(
    `${apiBase()}/api/public/videos/${sid}/like`,
    { method: "DELETE" },
  );
  if (!out) throw new ApiError(0, "unlikeVideo: empty response");
  return out;
}

/** Playback URL for a public video (unguarded streaming endpoint). */
export function publicVideoUrl(sid: string): string {
  return `${apiBase()}/api/public/videos/${sid}/video`;
}
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test public-videos-client` → PASS.
Run: `pnpm typecheck` → PASS.

(If typecheck flags other `getCredits`/`CreditsResponse` construction sites lacking `freePublicAvailable`, add `freePublicAvailable: false` there — e.g. test fixtures/mocks.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api-types.ts apps/web/src/lib/api-client.ts apps/web/test/lib/public-videos-client.test.ts
git commit -m "feat(web): public-video api client + freePublicAvailable"
```

---

## Task 12: Web hooks — `usePublicVideos`, `usePublicVideo`, `useLikeVideo`

**Files:**
- Create: `apps/web/src/state/use-public-videos.ts`
- Test: `apps/web/test/state/use-public-videos.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { usePublicVideos, useLikeVideo } from "@/state/use-public-videos";

vi.mock("@/lib/api-client", () => ({
  listPublicVideos: vi.fn(async () => [
    { sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: null, likeCount: 1, createdAt: "t", likedByMe: false },
  ]),
  likeVideo: vi.fn(async () => ({ likeCount: 2, liked: true })),
  unlikeVideo: vi.fn(async () => ({ likeCount: 1, liked: false })),
}));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("use-public-videos", () => {
  it("fetches the list for a sort", async () => {
    const { result } = renderHook(() => usePublicVideos("recent"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]?.sid).toBe("a");
  });

  it("useLikeVideo calls likeVideo when not yet liked", async () => {
    const { likeVideo } = await import("@/lib/api-client");
    const { result } = renderHook(() => useLikeVideo(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync({ sid: "a", liked: false });
    });
    expect(likeVideo).toHaveBeenCalledWith("a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test use-public-videos`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hooks**

```tsx
// apps/web/src/state/use-public-videos.ts
"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicVideoSort, PublicVideoSummary } from "@/lib/api-types";
import { getPublicVideo, likeVideo, listPublicVideos, unlikeVideo } from "@/lib/api-client";

export function usePublicVideos(sort: PublicVideoSort) {
  return useQuery({
    queryKey: ["public-videos", sort],
    queryFn: () => listPublicVideos(sort),
  });
}

export function usePublicVideo(sid: string) {
  return useQuery({
    queryKey: ["public-video", sid],
    queryFn: () => getPublicVideo(sid),
  });
}

/**
 * Toggle a like. Pass the CURRENT liked state; the mutation flips it. Optimistic
 * across every cached public-videos list and the single-video cache.
 */
export function useLikeVideo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sid, liked }: { sid: string; liked: boolean }) =>
      liked ? unlikeVideo(sid) : likeVideo(sid),
    onMutate: async ({ sid, liked }) => {
      await qc.cancelQueries({ queryKey: ["public-videos"] });
      const delta = liked ? -1 : 1;
      // PublicVideoSummary tracks the viewer's like via `likedByMe` (no `liked` field).
      const patch = (v: PublicVideoSummary): PublicVideoSummary =>
        v.sid === sid ? { ...v, likedByMe: !liked, likeCount: Math.max(0, v.likeCount + delta) } : v;
      qc.setQueriesData<PublicVideoSummary[]>({ queryKey: ["public-videos"] }, (old) =>
        old ? old.map(patch) : old,
      );
      qc.setQueryData<PublicVideoSummary | null>(["public-video", sid], (old) => (old ? patch(old) : old));
    },
    onSettled: (_data, _err, { sid }) => {
      void qc.invalidateQueries({ queryKey: ["public-videos"] });
      void qc.invalidateQueries({ queryKey: ["public-video", sid] });
    },
  });
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test use-public-videos` → PASS.
Run: `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/use-public-videos.ts apps/web/test/state/use-public-videos.test.tsx
git commit -m "feat(web): public-video query + optimistic like hooks"
```

---

## Task 13: Composer — public toggle + free badge + wiring

**Files:**
- Modify: `apps/web/src/components/home-composer.tsx`
- Test: `apps/web/test/components/home-composer-public.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { createSession } from "@/lib/api-client";
import type { CreditsResponse } from "@/lib/api-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  uploadFiles: vi.fn(async () => ({ files: [] })),
  postMessage: vi.fn(async () => {}),
}));

function Harness() {
  const [text, setText] = useState("Promo for Acme");
  return (
    <HomeComposer
      text={text} onTextChange={setText}
      duration={30} onDurationChange={() => {}}
      aspect="16:9" onAspectChange={() => {}}
      placeholder="describe…"
    />
  );
}

const credits = (over: Partial<CreditsResponse> = {}): CreditsResponse => ({
  balance: 500, breakdown: { subscription: 0, bonus: 500, purchased: 0 }, subscription: null, freePublicAvailable: true, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("<HomeComposer> public toggle", () => {
  it("defaults the toggle OFF", () => {
    renderWithQuery(<Harness />);
    expect(screen.getByRole("switch", { name: /public/i })).not.toBeChecked();
  });

  it("shows the free badge only when public + freePublicAvailable", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits());
    await user.click(screen.getByRole("switch", { name: /public/i }));
    expect(await screen.findByText(/free/i)).toBeInTheDocument();
  });

  it("passes isPublic + productUrl to createSession", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits());
    // Open URL field + type a product URL.
    await user.click(screen.getByRole("button", { name: /url/i }));
    await user.type(screen.getByLabelText("product url"), "https://acme.com");
    await user.click(screen.getByRole("switch", { name: /public/i }));
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: true, productUrl: "https://acme.com" }),
      ),
    );
  });

  it("bypasses the out-of-credits block when public + free", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits({ balance: 0, freePublicAvailable: true }));
    await user.click(screen.getByRole("switch", { name: /public/i }));
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test home-composer-public`
Expected: FAIL — no `public` switch.

- [ ] **Step 3: Add imports + state**

In `apps/web/src/components/home-composer.tsx`:

Add to imports:

```ts
import { Switch } from "@/components/ui/switch";
```

Add state next to the other persistent prefs (after the `autoApprove` line ~133):

```ts
  const [isPublic, setIsPublic] = usePersistentState("uc.isPublic", false);
  const freePublicAvailable =
    qc.getQueryData<CreditsResponse>(["credits"])?.freePublicAvailable ?? false;
```

- [ ] **Step 4: Bypass the out-of-credits pre-check + pass fields to createSession**

In `handleGenerate`, change the balance guard (line ~258) to skip when the run is free:

```ts
    const balance = qc.getQueryData<CreditsResponse>(["credits"])?.balance;
    const freeRun = isPublic && freePublicAvailable;
    if (!freeRun && balance !== undefined && balance <= 0) {
      setUpgradeOpen(true);
      return;
    }
```

Change the `createSession` call (line ~276):

```ts
      const { sessionId } = await createSession({
        autoApprove,
        ...(isPublic ? { isPublic: true } : {}),
        ...(url ? { productUrl: normalizeUrl(url) } : {}),
      });
```

- [ ] **Step 5: Render the switch**

In the bottom controls row (the `<div className="flex flex-wrap items-center gap-2">` at line ~469), insert AFTER `<ComposerSettingsDialog … />` and BEFORE the `<div className="ml-auto …">` group:

```tsx
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <Switch
            checked={isPublic}
            onCheckedChange={setIsPublic}
            aria-label="public to plaza"
            className="scale-90"
          />
          <span>公开到广场</span>
          {isPublic && freePublicAvailable && (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              本次免费
            </span>
          )}
        </label>
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm test home-composer-public` → PASS.
Run: `pnpm test home-composer` → PASS (existing composer tests still green).
Run: `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/home-composer.tsx apps/web/test/components/home-composer-public.test.tsx
git commit -m "feat(web): composer public-to-plaza toggle + free badge"
```

---

## Task 14: Sidebar — "Product Plaza" nav item

**Files:**
- Modify: `apps/web/src/components/app-sidebar.tsx`
- Test: `apps/web/test/components/app-sidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `apps/web/test/components/app-sidebar.test.tsx` (inside `describe("<AppSidebar>", …)`):

```ts
  it("shows a Product Plaza link to /plaza", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    const link = await screen.findByRole("link", { name: /product plaza/i });
    expect(link).toHaveAttribute("href", "/plaza");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app-sidebar`
Expected: FAIL — no such link.

- [ ] **Step 3: Add the nav item**

In `apps/web/src/components/app-sidebar.tsx`:

Add `LayoutGrid` to the lucide import:

```ts
import { Plus, Trash2, Film, Clapperboard, Video, Megaphone, Sparkles, Wand2, Play, Tv, Loader2, LayoutGrid } from "lucide-react";
```

Insert this block right after the "New task" `<div className="px-3">…</div>` (closes ~line 85) and before the Tasks `<div className="mt-5 …">`:

```tsx
      {/* Product Plaza — public gallery of everyone's public videos */}
      <nav className="mt-2 px-2">
        <Link
          href="/plaza"
          onClick={closeIfMobile}
          aria-current={pathname === "/plaza" ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
            pathname === "/plaza"
              ? "bg-card text-foreground shadow-xs"
              : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
            !open && "justify-center px-0",
          )}
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          {open && <span className="flex-1 truncate">Product Plaza</span>}
        </Link>
      </nav>
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test app-sidebar` → PASS.
Run: `pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app-sidebar.tsx apps/web/test/components/app-sidebar.test.tsx
git commit -m "feat(web): Product Plaza sidebar nav item"
```

---

## Task 15: Plaza page + gallery components

**Files:**
- Create: `apps/web/src/app/plaza/page.tsx`
- Create: `apps/web/src/components/plaza/product-plaza.tsx`
- Create: `apps/web/src/components/plaza/video-card.tsx`
- Create: `apps/web/src/components/plaza/like-button.tsx`
- Test: `apps/web/test/components/product-plaza.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductPlaza } from "@/components/plaza/product-plaza";
import { renderWithQuery } from "../helpers/render-with-query";
import { listPublicVideos, likeVideo } from "@/lib/api-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "u1" } } }) }));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  listPublicVideos: vi.fn(async () => [
    { sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 1, createdAt: "2026-01-01T00:00:00.000Z", likedByMe: false },
  ]),
  likeVideo: vi.fn(async () => ({ likeCount: 2, liked: true })),
  unlikeVideo: vi.fn(async () => ({ likeCount: 1, liked: false })),
  publicVideoUrl: (sid: string) => `http://x/${sid}.mp4`,
}));

beforeEach(() => vi.clearAllMocks());

describe("<ProductPlaza>", () => {
  it("renders cards from the API", async () => {
    renderWithQuery(<ProductPlaza loggedIn />);
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /visit product/i })).toHaveAttribute("href", "https://a.com");
  });

  it("refetches with a new sort when switched", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ProductPlaza loggedIn />);
    await screen.findByText("Alpha");
    await user.selectOptions(screen.getByRole("combobox", { name: /sort/i }), "likes");
    await waitFor(() => expect(listPublicVideos).toHaveBeenCalledWith("likes"));
  });

  it("likes a video on click", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ProductPlaza loggedIn />);
    await screen.findByText("Alpha");
    await user.click(screen.getByRole("button", { name: /like/i }));
    await waitFor(() => expect(likeVideo).toHaveBeenCalledWith("a"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test product-plaza`
Expected: FAIL — components don't exist.

- [ ] **Step 3: Implement the like button**

```tsx
// apps/web/src/components/plaza/like-button.tsx
"use client";
import { useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useLikeVideo } from "@/state/use-public-videos";
import { cn } from "@/lib/utils";

export function LikeButton({
  sid,
  likeCount,
  liked,
}: {
  sid: string;
  likeCount: number;
  liked: boolean;
}): React.ReactElement {
  const router = useRouter();
  const { data: session } = useSession();
  const like = useLikeVideo();
  return (
    <button
      type="button"
      aria-label={liked ? "unlike" : "like"}
      aria-pressed={liked}
      onClick={() => {
        if (!session) {
          router.push("/login");
          return;
        }
        like.mutate({ sid, liked });
      }}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors",
        liked ? "text-red-500" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Heart className={cn("h-4 w-4", liked && "fill-current")} />
      <span>{likeCount}</span>
    </button>
  );
}
```

- [ ] **Step 4: Implement the video card**

```tsx
// apps/web/src/components/plaza/video-card.tsx
"use client";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { PublicVideoSummary } from "@/lib/api-types";
import { publicVideoUrl } from "@/lib/api-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LikeButton } from "./like-button";

export function VideoCard({ video }: { video: PublicVideoSummary }): React.ReactElement {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl bg-card shadow-xs ring-1 ring-border/50">
      <Link href={`/v/${video.sid}`} className="relative block aspect-video bg-black">
        {/* Muted first-frame preview; #t=0.1 nudges past a black frame 0. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={`${publicVideoUrl(video.sid)}#t=0.1`}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
        />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <Link href={`/v/${video.sid}`} className="line-clamp-1 text-sm font-medium hover:underline">
          {video.title ?? "Untitled"}
        </Link>
        <div className="flex items-center gap-2">
          <Avatar className="h-5 w-5">
            {video.author.image && <AvatarImage src={video.author.image} alt={video.author.name} />}
            <AvatarFallback className="text-[10px]">{video.author.name.slice(0, 1)}</AvatarFallback>
          </Avatar>
          <span className="truncate text-xs text-muted-foreground">{video.author.name}</span>
        </div>
        <div className="mt-auto flex items-center justify-between">
          <LikeButton sid={video.sid} likeCount={video.likeCount} liked={video.likedByMe} />
          {video.productUrl && (
            <a
              href={video.productUrl}
              target="_blank"
              rel="noopener nofollow"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              aria-label="visit product"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Visit product
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
```

Note: `@/components/ui/avatar` exports `Avatar`, `AvatarImage`, `AvatarFallback` (verified — also used by `sidebar-user.tsx`).

- [ ] **Step 5: Implement the plaza container**

```tsx
// apps/web/src/components/plaza/product-plaza.tsx
"use client";
import { useState } from "react";
import type { PublicVideoSort } from "@/lib/api-types";
import { usePublicVideos } from "@/state/use-public-videos";
import { VideoCard } from "./video-card";

export function ProductPlaza({ loggedIn }: { loggedIn: boolean }): React.ReactElement {
  const [sort, setSort] = useState<PublicVideoSort>("recent");
  const { data: videos = [], isLoading } = usePublicVideos(sort);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">产品广场 · Product Plaza</h1>
          <p className="text-sm text-muted-foreground">
            Public promo videos from the community. {loggedIn ? "Like your favorites." : "Log in to like."}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Sort</span>
          <select
            aria-label="sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as PublicVideoSort)}
            className="rounded-lg border bg-card px-2 py-1 text-sm"
          >
            <option value="recent">Recent</option>
            <option value="likes">Most liked</option>
          </select>
        </label>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : videos.length === 0 ? (
        <p className="text-sm text-muted-foreground">No public videos yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {videos.map((v) => (
            <VideoCard key={v.sid} video={v} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Implement the page (in-app + logged-out)**

```tsx
// apps/web/src/app/plaza/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ProductPlaza } from "@/components/plaza/product-plaza";
import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { getServerSession } from "@/lib/server-session";

export const metadata: Metadata = {
  title: "Product Plaza — UltraVora",
  description: "Public promo videos from the UltraVora community.",
};

export default async function PlazaPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (session) {
    return (
      <AppShell>
        <div className="h-full overflow-y-auto">
          <ProductPlaza loggedIn />
        </div>
      </AppShell>
    );
  }
  // Logged-out: standalone public page with a login CTA.
  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="flex h-14 items-center gap-2 px-4">
        <Link href="/" aria-label="UltraVora home" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <LogoMark className="h-5 w-5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">UltraVora</span>
        </Link>
        <div className="ml-auto">
          <Button asChild size="sm">
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      </header>
      <ProductPlaza loggedIn={false} />
    </div>
  );
}
```

- [ ] **Step 7: Run test + typecheck**

Run: `pnpm test product-plaza` → PASS.
Run: `pnpm typecheck` → PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/app/plaza/ apps/web/src/components/plaza/ apps/web/test/components/product-plaza.test.tsx
git commit -m "feat(web): Product Plaza gallery page (in-app + public)"
```

---

## Task 16: Public single-video share page `/v/[sid]`

**Files:**
- Create: `apps/web/src/app/v/[sid]/page.tsx`
- Create: `apps/web/src/components/plaza/public-video-view.tsx`
- Test: `apps/web/test/components/public-video-view.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { PublicVideoView } from "@/components/plaza/public-video-view";
import { renderWithQuery } from "../helpers/render-with-query";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  getPublicVideo: vi.fn(async () => ({
    sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 3, createdAt: "2026-01-01T00:00:00.000Z", likedByMe: false,
  })),
  publicVideoUrl: (sid: string) => `http://x/${sid}.mp4`,
}));

beforeEach(() => vi.clearAllMocks());

describe("<PublicVideoView>", () => {
  it("renders the video title + product link", async () => {
    renderWithQuery(<PublicVideoView sid="a" />);
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /visit product/i })).toHaveAttribute("href", "https://a.com");
  });

  it("shows a not-found message for a missing video", async () => {
    const { getPublicVideo } = await import("@/lib/api-client");
    (getPublicVideo as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(null);
    renderWithQuery(<PublicVideoView sid="missing" />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test public-video-view`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement the view**

```tsx
// apps/web/src/components/plaza/public-video-view.tsx
"use client";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { usePublicVideo } from "@/state/use-public-videos";
import { publicVideoUrl } from "@/lib/api-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { LikeButton } from "./like-button";

export function PublicVideoView({ sid }: { sid: string }): React.ReactElement {
  const { data: video, isLoading } = usePublicVideo(sid);

  if (isLoading) return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  if (!video) return <p className="p-8 text-sm text-muted-foreground">Video not found.</p>;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="overflow-hidden rounded-2xl bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={publicVideoUrl(video.sid)} className="aspect-video w-full" controls playsInline />
      </div>
      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight">{video.title ?? "Untitled"}</h1>
          <div className="mt-1 flex items-center gap-2">
            <Avatar className="h-6 w-6">
              {video.author.image && <AvatarImage src={video.author.image} alt={video.author.name} />}
              <AvatarFallback className="text-[10px]">{video.author.name.slice(0, 1)}</AvatarFallback>
            </Avatar>
            <span className="text-sm text-muted-foreground">{video.author.name}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <LikeButton sid={video.sid} likeCount={video.likeCount} liked={video.likedByMe} />
          {video.productUrl && (
            <a
              href={video.productUrl}
              target="_blank"
              rel="noopener nofollow"
              className="inline-flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
              aria-label="visit product"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Visit product
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Implement the page**

```tsx
// apps/web/src/app/v/[sid]/page.tsx
import Link from "next/link";
import { LogoMark } from "@/components/logo";
import { PublicVideoView } from "@/components/plaza/public-video-view";

export default async function PublicVideoPage({
  params,
}: {
  params: Promise<{ sid: string }>;
}): Promise<React.ReactElement> {
  const { sid } = await params;
  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="flex h-14 items-center gap-2 px-4">
        <Link href="/plaza" aria-label="Product Plaza" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <LogoMark className="h-5 w-5" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">UltraVora</span>
        </Link>
      </header>
      <PublicVideoView sid={sid} />
    </div>
  );
}
```

Note: `params` is a Promise here — verified against `apps/web/src/app/s/[sid]/page.tsx`, which uses `params: Promise<{ sid: string }>` and `const { sid } = await params;`.

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test public-video-view` → PASS.
Run: `pnpm typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/v/ apps/web/src/components/plaza/public-video-view.tsx apps/web/test/components/public-video-view.test.tsx
git commit -m "feat(web): public /v/[sid] video share page"
```

---

## Task 17: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire unit suite**

Run: `pnpm test`
Expected: all green. Fix any regression before proceeding.

- [ ] **Step 2: Run the PG suite (if local Postgres is available)**

Run: `pnpm test -- --project pg` (or `pnpm test *.pg`)
Expected: `free-grant.pg` + `public-video-repository.pg` + existing pg tests green. If Postgres is unavailable here, note it — CI runs them.

- [ ] **Step 3: Typecheck the whole repo**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Build the web app**

Run: `pnpm -F @ultracreator/web build`
Expected: build succeeds (new `/plaza` and `/v/[sid]` routes compile).

- [ ] **Step 5: Apply the migration locally (optional smoke)**

Run: `pnpm -F @ultracreator/server db:migrate`
Expected: migration applies cleanly against local Postgres.

- [ ] **Step 6: Final commit (if anything was touched during verification)**

```bash
git add -A
git commit -m "chore: verify product plaza feature end-to-end"
```

---

## Spec coverage checklist

- Composer public/private toggle (default off), free once per account → Tasks 3–7, 13.
- "产品广场 / Product Plaza" sidebar tab → Task 14.
- Gallery of all public videos (in-app + public) → Tasks 9, 10, 15.
- Jump to the creator's product URL → Tasks 2, 5 (persist), 15/16 (outbound link, `rel="noopener nofollow"`).
- Likes, one per user per video, toggle, login-gated → Tasks 2 (unique index), 9, 10, 12, 15/16.
- Sort by likes or creation time → Tasks 9 (repo), 10 (route), 15 (UI).
- Public playback without ownership → Tasks 8, 10.
- Free grant is permanent / public is permanent → no un-publish route exists (by omission); Task 4 grant is one-way.
