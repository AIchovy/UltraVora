# Phase 2b — Events & Artifacts to PostgreSQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move per-session event logs (`workspaces/<sid>/logs/events.jsonl`) and artifact descriptors (`workspaces/<sid>/artifacts/*.json` + `index.json`) out of the filesystem and into two new PostgreSQL tables, so a session's full event stream and artifact set live in PG alongside its `creator_sessions` row.

**Architecture:** Mirror Phase 2a's repository pattern. Introduce two thin persistence interfaces — `EventStore` and `ArtifactRepository` — each with a PG implementation (`PgEventStore`, `PgArtifactRepository`) and an in-memory fake for unit tests. All *behavior* (per-session monotonic `seq`, per-kind `version`, Zod validation, EventBus emission, live SSE broadcast) stays in the existing `SessionEventLog` and `ArtifactStore` components, which now delegate only raw persistence. `SessionEventLog` gains a ~100ms batch buffer that bulk-inserts events (the spec's write strategy for high-frequency `agent.text`); SSE replay reads from PG via `seq > Last-Event-Id`, with a flush-before-replay step in the stream route to close the batch window. Media files (mp4/audio/composition dir) stay on disk and are untouched here — Phase 4 (GCS) handles them; only the JSON descriptors move.

**Tech Stack:** Fastify 5, Drizzle ORM 0.45 + node-postgres, drizzle-kit migrations, Vitest (two-project workspace: `unit` parallel + `pg` single-fork), TS ESM with NodeNext `.js` import extensions.

---

## Context for the implementer

You are extending UltraCreator's `apps/server`. Phase 2a already added:

- `apps/server/src/db/schema/creator.ts` — the `creator_sessions` table (`id text PK`, `userId text FK→user.id cascade`, `title`, `status`, `currentPhase`, `error`, timestamps).
- `apps/server/src/db/client.ts` — `export type Db = NodePgDatabase<typeof schema>` and `createDb(url)`.
- `apps/server/src/sessions/session-repository.ts` + `pg-session-repository.ts` + `test/helpers/in-memory-session-repository.ts` — the interface/PG/fake pattern you will copy.
- Migrations auto-apply on server start via `runMigrations(db)`; `0001_*.sql` created `creator_sessions`.
- `vitest.suites.ts`: the `pg` project runs every `*.pg.test.ts` **single-fork, one file at a time** against the shared `ultracreator_test` DB. New `*.pg.test.ts` files automatically join that project — each one does `DROP SCHEMA public CASCADE` + `migrate` in `beforeAll`, so they never race.

**The two components being refactored today:**

1. `apps/server/src/events/session-event-log.ts` — sits between the orchestrator's `EventBus` and live SSE clients. Currently: on `attach(sid)` it opens `events.jsonl` for append and recovers `nextSeq` from the line count; on each bus event it stamps `{seq, at, event}`, writes a JSON line, and broadcasts to subscribers; `readSince(sid, seq)` streams persisted events from disk for SSE replay. Types: `SequencedEvent = {seq:number, at:string, event:ServerEvent}`, `SequencedListener = (e:SequencedEvent)=>void`.

2. `apps/server/src/artifacts/artifact-store.ts` — the only writer of artifact descriptors. Currently: `put` writes a `<kind>.v<n>.json` envelope file + updates `index.json` + emits `artifact.created`; `get` reads the envelope from disk; `list` reads `index.json`; `markStale` flips a flag in `index.json` + emits `artifact.stale`. Public methods used by handlers/orchestrator via `ctx.artifacts`: `put`, `get`, `list`, `markStale`. **These public signatures must not change.**

**Key facts already verified (do not re-litigate):**

- Nothing outside `artifact-store.ts` reads artifact envelope/`index.json` files directly. Media files (the actual mp4/audio/composition dir) are written by the *handlers* via `WorkspaceManager`, not by `ArtifactStore`; `ArtifactStore` only ever persisted JSON. So removing file I/O from `ArtifactStore` is safe.
- `ArtifactDescriptorSchema` is `.parse`d in exactly one place — `artifact-store.ts:46` (`readIndex`), which this plan deletes. No frontend code reads `descriptor.path`. Dropping `path` from the shared schema is safe.
- `eventLog.attach(sid)` is called in `sessions-routes.ts` (POST, right after `sessions.create`) and `stream-routes.ts` (GET, after `requireOwnedSession`). In both, the `creator_sessions` row already exists, so a `session_events` insert never violates the FK. The DELETE route calls `eventLog.close(sid)` (flush) **before** `sessions.delete(sid)` (cascade), so no orphan append.

**Conventions:**
- Timestamps in schema use bare `timestamp(...)` (matches `auth.ts`/`creator.ts`). Convert `Date → ISO` with `.toISOString()` on read; `ISO → Date` with `new Date(iso)` on write.
- Comments in English. Run `pnpm typecheck` and `pnpm test` from the repo root. Commit after each task.

**Locked decisions:**
1. `session_events.seq` is per-session monotonic, allocated **in memory** at broadcast time (single-instance assumption, spec §4), recovered on `attach` via `SELECT MAX(seq)`. Same model as today's line-count recovery.
2. `artifacts` keeps the read-then-insert version model (caller serializes per session — orchestrator holds one logical lock); `unique(session_id, kind, version)` is the backstop against races.
3. Drop `path` from `ArtifactDescriptorSchema` entirely (spec's `artifacts` table has no path column; relative media paths live inside `data`).
4. FK `ON DELETE CASCADE` is the deletion mechanism (spec §5: "删除会话:同时清理 PG 行(级联)"). No explicit child deletes in the DELETE route.

---

## File Structure

**New (production):**
- `apps/server/src/events/event-store.ts` — `EventStore` interface + `SequencedEvent` type (moved here, re-exported from `session-event-log.ts`).
- `apps/server/src/events/pg-event-store.ts` — `PgEventStore`.
- `apps/server/src/artifacts/artifact-repository.ts` — `ArtifactRepository` interface + `ArtifactRow` type.
- `apps/server/src/artifacts/pg-artifact-repository.ts` — `PgArtifactRepository`.

**New (test helpers / tests):**
- `apps/server/test/helpers/in-memory-event-store.ts`
- `apps/server/test/helpers/in-memory-artifact-repository.ts`
- `apps/server/test/events/in-memory-event-store.test.ts`
- `apps/server/test/events/pg-event-store.pg.test.ts`
- `apps/server/test/artifacts/in-memory-artifact-repository.test.ts`
- `apps/server/test/artifacts/pg-artifact-repository.pg.test.ts`

**Modified:**
- `apps/server/src/db/schema/creator.ts` — add `sessionEvent` + `artifact` tables.
- `apps/server/drizzle/0002_*.sql` — generated migration.
- `apps/server/src/events/session-event-log.ts` — delegate to `EventStore`, add batch buffer.
- `apps/server/src/artifacts/artifact-store.ts` — delegate to `ArtifactRepository`.
- `apps/server/src/api/stream-routes.ts` — flush-before-replay.
- `packages/shared/src/artifact.ts` — drop `path` from `ArtifactDescriptorSchema`.
- `apps/server/src/compose-orchestrator.ts` — accept `artifactRepo`, build `ArtifactStore(repo, events)`.
- `apps/server/src/api/server.ts` — construct `PgEventStore` + `PgArtifactRepository`, wire them.
- Test files constructing `SessionEventLog` / `ArtifactStore` — swap to the in-memory fakes (mechanical sweeps, in the same task that changes each signature).
- `apps/server/test/db/migrations.pg.test.ts` — add cascade + unique tests for the two new tables.

---

## Task 1: Schema + migration for `session_events` and `artifacts`

**Files:**
- Modify: `apps/server/src/db/schema/creator.ts`
- Create: `apps/server/drizzle/0002_*.sql` (generated)
- Test: `apps/server/test/db/migrations.pg.test.ts`

- [ ] **Step 1: Add the two tables to the schema**

Append to `apps/server/src/db/schema/creator.ts` (keep the existing `creatorSession` definition and its imports; extend the `drizzle-orm/pg-core` import line and add a shared type import):

```ts
import {
  pgTable,
  text,
  timestamp,
  index,
  uniqueIndex,
  bigserial,
  integer,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import type { ServerEvent, LineageRef } from "@ultracreator/shared";
import { user } from "./auth.js";

// ... existing creatorSession definition stays unchanged above ...

// Replaces workspaces/<sid>/logs/events.jsonl. One row per ServerEvent, stamped
// with a per-session monotonic seq (allocated in memory by SessionEventLog) and
// an ISO instant. SSE replay reads `seq > Last-Event-Id` ordered by seq.
export const sessionEvent = pgTable(
  "session_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: timestamp("at").notNull(),
    event: jsonb("event").$type<ServerEvent>().notNull(),
  },
  (t) => ({
    sessionSeqKey: uniqueIndex("session_events_session_id_seq_key").on(t.sessionId, t.seq),
  }),
);

// Replaces workspaces/<sid>/artifacts/*.json + index.json. Media files (mp4,
// audio, composition dir) stay on disk; `data` jsonb holds the descriptor with
// workspace-relative paths inside it.
export const artifact = pgTable(
  "artifacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // ArtifactKind
    version: integer("version").notNull(),
    data: jsonb("data").notNull(),
    derivedFrom: jsonb("derived_from").$type<LineageRef[] | null>(), // nullable
    stale: boolean("stale").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    kindVersionKey: uniqueIndex("artifacts_session_id_kind_version_key").on(
      t.sessionId,
      t.kind,
      t.version,
    ),
  }),
);
```

- [ ] **Step 2: Generate the migration**

Run: `cd apps/server && pnpm db:generate`
Expected: a new file `apps/server/drizzle/0002_<name>.sql` containing `CREATE TABLE "session_events"` and `CREATE TABLE "artifacts"` with the two FKs (`ON DELETE cascade`) and the two unique indexes. It must be **additive only** (no `DROP`/`ALTER` of `creator_sessions` or auth tables). Open the file and confirm. If drizzle-kit prompts interactively, it should not for pure additions; if it does, the schema diff is wrong — stop and recheck Step 1.

- [ ] **Step 3: Add migration tests (failing first)**

Add these two `it` blocks inside the `describe("auth schema migrations", ...)` in `apps/server/test/db/migrations.pg.test.ts` (after the existing `creator_sessions` cascade test). They reuse the file's `pool`:

```ts
  it("creates session_events + artifacts and cascades them when the session is deleted", async () => {
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    const names = tables.rows.map((r: { table_name: string }) => r.table_name);
    expect(names).toContain("session_events");
    expect(names).toContain("artifacts");

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('ev_owner', 'O', 'ev_owner@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('ev_sess', 'ev_owner', 'idle', now(), now())`,
    );
    await pool.query(
      `INSERT INTO session_events (session_id, seq, at, event)
       VALUES ('ev_sess', 1, now(), '{"type":"phase.progress","phase":"research","message":"x"}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO artifacts (session_id, kind, version, data, derived_from, stale, created_at)
       VALUES ('ev_sess', 'brief', 1, '{"x":1}'::jsonb, null, false, now())`,
    );

    await pool.query(`DELETE FROM creator_sessions WHERE id='ev_sess'`);
    const ev = await pool.query(`SELECT id FROM session_events WHERE session_id='ev_sess'`);
    const ar = await pool.query(`SELECT id FROM artifacts WHERE session_id='ev_sess'`);
    expect(ev.rowCount).toBe(0);
    expect(ar.rowCount).toBe(0);
  });

  it("enforces unique (session_id, seq) and (session_id, kind, version)", async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('uq_owner', 'O', 'uq_owner@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('uq_sess', 'uq_owner', 'idle', now(), now())`,
    );
    await pool.query(
      `INSERT INTO session_events (session_id, seq, at, event)
       VALUES ('uq_sess', 1, now(), '{}'::jsonb)`,
    );
    await expect(
      pool.query(
        `INSERT INTO session_events (session_id, seq, at, event)
         VALUES ('uq_sess', 1, now(), '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/duplicate key/);

    await pool.query(
      `INSERT INTO artifacts (session_id, kind, version, data, stale, created_at)
       VALUES ('uq_sess', 'brief', 1, '{}'::jsonb, false, now())`,
    );
    await expect(
      pool.query(
        `INSERT INTO artifacts (session_id, kind, version, data, stale, created_at)
         VALUES ('uq_sess', 'brief', 1, '{}'::jsonb, false, now())`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
```

- [ ] **Step 4: Run the migration test**

Run: `pnpm test -- migrations.pg`
Expected: PASS (the `pg` project drops+migrates a fresh schema in `beforeAll`, so `0002` is applied). If `relation "session_events" does not exist`, the migration wasn't generated/applied — recheck Step 2.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add apps/server/src/db/schema/creator.ts apps/server/drizzle apps/server/test/db/migrations.pg.test.ts
git commit -m "feat(server): session_events + artifacts tables + migration 0002"
```

---

## Task 2: `EventStore` interface + `InMemoryEventStore` fake

**Files:**
- Create: `apps/server/src/events/event-store.ts`
- Create: `apps/server/test/helpers/in-memory-event-store.ts`
- Test: `apps/server/test/events/in-memory-event-store.test.ts`

- [ ] **Step 1: Define the interface**

Create `apps/server/src/events/event-store.ts`:

```ts
import type { ServerEvent } from "@ultracreator/shared";

/** One persisted, sequenced event. `seq` is per-session monotonic; `at` is ISO. */
export interface SequencedEvent {
  seq: number;
  at: string;
  event: ServerEvent;
}

/**
 * Raw persistence for a session's event stream. All sequencing/broadcast logic
 * lives in SessionEventLog; this is dumb CRUD so the PG and in-memory impls
 * stay behaviorally identical.
 */
export interface EventStore {
  /** Highest seq persisted for the session, or 0 if none. */
  maxSeq(sessionId: string): Promise<number>;
  /** Bulk-insert. No-op on an empty batch. */
  append(sessionId: string, entries: SequencedEvent[]): Promise<void>;
  /** Persisted events with seq > sinceSeq, ascending by seq. */
  readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent>;
}
```

- [ ] **Step 2: Write the failing fake test**

Create `apps/server/test/events/in-memory-event-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ServerEvent } from "@ultracreator/shared";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";

const ev = (i: number): ServerEvent => ({ type: "phase.progress", phase: "research", message: `m${i}` });
const entry = (seq: number) => ({ seq, at: new Date(seq * 1000).toISOString(), event: ev(seq) });

async function collect(it: AsyncIterable<{ seq: number }>): Promise<number[]> {
  const out: number[] = [];
  for await (const e of it) out.push(e.seq);
  return out;
}

describe("InMemoryEventStore", () => {
  it("maxSeq is 0 for an unknown session", async () => {
    expect(await new InMemoryEventStore().maxSeq("s1")).toBe(0);
  });

  it("append + maxSeq + readSince round-trips, scoped per session", async () => {
    const store = new InMemoryEventStore();
    await store.append("s1", [entry(1), entry(2)]);
    await store.append("s2", [entry(1)]);
    expect(await store.maxSeq("s1")).toBe(2);
    expect(await store.maxSeq("s2")).toBe(1);
    expect(await collect(store.readSince("s1", 0))).toEqual([1, 2]);
    expect(await collect(store.readSince("s1", 1))).toEqual([2]);
    expect(await collect(store.readSince("s2", 0))).toEqual([1]);
  });

  it("append of an empty batch is a no-op", async () => {
    const store = new InMemoryEventStore();
    await store.append("s1", []);
    expect(await store.maxSeq("s1")).toBe(0);
  });

  it("readSince yields ascending by seq even if appended out of order", async () => {
    const store = new InMemoryEventStore();
    await store.append("s1", [entry(3), entry(1), entry(2)]);
    expect(await collect(store.readSince("s1", 0))).toEqual([1, 2, 3]);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm test -- in-memory-event-store`
Expected: FAIL (`InMemoryEventStore` not found).

- [ ] **Step 4: Implement the fake**

Create `apps/server/test/helpers/in-memory-event-store.ts`:

```ts
import type { EventStore, SequencedEvent } from "../../src/events/event-store.js";

/** In-memory EventStore for unit tests. Behaves identically to PgEventStore. */
export class InMemoryEventStore implements EventStore {
  private rows = new Map<string, SequencedEvent[]>();

  async maxSeq(sessionId: string): Promise<number> {
    const list = this.rows.get(sessionId);
    return list && list.length > 0 ? Math.max(...list.map((e) => e.seq)) : 0;
  }

  async append(sessionId: string, entries: SequencedEvent[]): Promise<void> {
    if (entries.length === 0) return;
    const list = this.rows.get(sessionId) ?? [];
    for (const e of entries) list.push({ ...e });
    this.rows.set(sessionId, list);
  }

  async *readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent> {
    const list = (this.rows.get(sessionId) ?? [])
      .filter((e) => e.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
    for (const e of list) yield { ...e };
  }
}
```

- [ ] **Step 5: Run + commit**

Run: `pnpm test -- in-memory-event-store` → PASS, then `pnpm typecheck` → clean.

```bash
git add apps/server/src/events/event-store.ts apps/server/test/helpers/in-memory-event-store.ts apps/server/test/events/in-memory-event-store.test.ts
git commit -m "feat(server): EventStore interface + in-memory fake"
```

---

## Task 3: `PgEventStore`

**Files:**
- Create: `apps/server/src/events/pg-event-store.ts`
- Test: `apps/server/test/events/pg-event-store.pg.test.ts`

- [ ] **Step 1: Write the failing PG test**

Create `apps/server/test/events/pg-event-store.pg.test.ts` (mirrors `pg-session-repository.pg.test.ts` — shares `ultracreator_test`, safe under the single-fork `pg` project):

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { PgEventStore } from "../../src/events/pg-event-store.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
// Shares the ultracreator_test DB with the other *.pg.test.ts files. Safe because
// the "pg" vitest project (vitest.suites.ts) runs every *.pg.test.ts single-fork,
// one file at a time — each beforeAll drops+migrates fresh, so they never race.
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let store: PgEventStore;

const ev = (i: number): ServerEvent => ({ type: "phase.progress", phase: "research", message: `m${i}` });
const entry = (seq: number) => ({ seq, at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), event: ev(seq) });

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
  store = new PgEventStore(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query('TRUNCATE session_events, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
  await pool.query(
    `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
     VALUES ('s1','u1','idle',now(),now()), ('s2','u1','idle',now(),now())`,
  );
});

async function collect(it: AsyncIterable<{ seq: number; at: string }>): Promise<{ seq: number; at: string }[]> {
  const out: { seq: number; at: string }[] = [];
  for await (const e of it) out.push({ seq: e.seq, at: e.at });
  return out;
}

describe("PgEventStore", () => {
  it("maxSeq is 0 before any append", async () => {
    expect(await store.maxSeq("s1")).toBe(0);
  });

  it("append + maxSeq + readSince round-trips and preserves event + ISO at", async () => {
    await store.append("s1", [entry(1), entry(2), entry(3)]);
    expect(await store.maxSeq("s1")).toBe(3);
    const rows = await collect(store.readSince("s1", 1));
    expect(rows.map((r) => r.seq)).toEqual([2, 3]);
    expect(rows[0]!.at).toBe(entry(2).at); // lossless ISO round-trip
  });

  it("readSince(0) yields all; readSince is scoped per session", async () => {
    await store.append("s1", [entry(1), entry(2)]);
    await store.append("s2", [entry(1)]);
    const s1 = await collect(store.readSince("s1", 0));
    const s2 = await collect(store.readSince("s2", 0));
    expect(s1.map((r) => r.seq)).toEqual([1, 2]);
    expect(s2.map((r) => r.seq)).toEqual([1]);
  });

  it("append of an empty batch is a no-op", async () => {
    await store.append("s1", []);
    expect(await store.maxSeq("s1")).toBe(0);
  });

  it("append for a deleted session is swallowed (FK violation ignored)", async () => {
    await pool.query(`DELETE FROM creator_sessions WHERE id='s2'`);
    await expect(store.append("s2", [entry(1)])).resolves.toBeUndefined();
    expect(await store.maxSeq("s2")).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- pg-event-store`
Expected: FAIL (`PgEventStore` not found).

- [ ] **Step 3: Implement `PgEventStore`**

Create `apps/server/src/events/pg-event-store.ts`:

```ts
import { and, asc, eq, gt, max } from "drizzle-orm";
import { sessionEvent } from "../db/schema/creator.js";
import type { Db } from "../db/client.js";
import type { EventStore, SequencedEvent } from "./event-store.js";

export class PgEventStore implements EventStore {
  constructor(private db: Db) {}

  async maxSeq(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ m: max(sessionEvent.seq) })
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, sessionId));
    return rows[0]?.m ?? 0;
  }

  async append(sessionId: string, entries: SequencedEvent[]): Promise<void> {
    if (entries.length === 0) return;
    try {
      await this.db.insert(sessionEvent).values(
        entries.map((e) => ({
          sessionId,
          seq: e.seq,
          at: new Date(e.at),
          event: e.event,
        })),
      );
    } catch (err) {
      // 23503 = foreign_key_violation: the session was deleted out from under a
      // pending batch. The events are gone with it — drop them silently.
      if ((err as { code?: string }).code === "23503") return;
      throw err;
    }
  }

  async *readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent> {
    const rows = await this.db
      .select()
      .from(sessionEvent)
      .where(and(eq(sessionEvent.sessionId, sessionId), gt(sessionEvent.seq, sinceSeq)))
      .orderBy(asc(sessionEvent.seq));
    for (const row of rows) {
      yield { seq: row.seq, at: row.at.toISOString(), event: row.event };
    }
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

Run: `pnpm test -- pg-event-store` → PASS, then `pnpm typecheck` → clean.

```bash
git add apps/server/src/events/pg-event-store.ts apps/server/test/events/pg-event-store.pg.test.ts
git commit -m "feat(server): PgEventStore (session_events persistence)"
```

---

## Task 4: Refactor `SessionEventLog` onto `EventStore` + batch buffer

**Files:**
- Modify: `apps/server/src/events/session-event-log.ts`
- Modify: `apps/server/test/api/session-event-log.test.ts` (rewrite)
- Modify (mechanical sweep — every `new SessionEventLog(...)` site): `apps/server/src/api/server.ts`, `apps/server/test/api/{artifacts-routes,end-to-end,files-routes,messages-routes,sessions-routes,uploads-routes,stream-routes}.test.ts`

This task changes the `SessionEventLog` constructor from `{events, workspaces}` to `{events, store, batchMs?}`. **Every construction site must be updated in this same task** so the suite stays green.

- [ ] **Step 1: Rewrite the unit test (failing first)**

Replace `apps/server/test/api/session-event-log.test.ts` entirely:

```ts
// apps/server/test/api/session-event-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ServerEvent } from "@ultracreator/shared";
import { EventBus } from "../../src/events/event-bus.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";

let events: EventBus;
let store: InMemoryEventStore;
let log: SessionEventLog;

beforeEach(() => {
  events = new EventBus();
  store = new InMemoryEventStore();
  // batchMs: 0 keeps tests fast; flush() still forces a synchronous drain.
  log = new SessionEventLog({ events, store, batchMs: 0 });
});

afterEach(async () => {
  await log.closeAll();
});

const ev = (i: number): ServerEvent => ({ type: "phase.progress", phase: "research", message: `msg-${i}` });

async function readAll(sid: string): Promise<{ seq: number; event: ServerEvent }[]> {
  const out: { seq: number; event: ServerEvent }[] = [];
  for await (const e of log.readSince(sid, 0)) out.push({ seq: e.seq, event: e.event });
  return out;
}

describe("SessionEventLog", () => {
  it("attach() subscribes to the EventBus and persists one entry per event", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    await log.flush("s1");
    const rows = await readAll("s1");
    expect(rows).toEqual([
      { seq: 1, event: ev(1) },
      { seq: 2, event: ev(2) },
    ]);
  });

  it("re-broadcasts sequenced envelopes to subscribers synchronously, in order", async () => {
    await log.attach("s1");
    const seen: Array<{ seq: number; event: ServerEvent }> = [];
    log.subscribe("s1", (entry) => seen.push({ seq: entry.seq, event: entry.event }));
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    expect(seen).toEqual([
      { seq: 1, event: ev(1) },
      { seq: 2, event: ev(2) },
    ]);
  });

  it("attach() resumes sequence numbering from the store", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    await log.closeAll();
    // New SessionEventLog over the SAME store — seq must continue at 3.
    log = new SessionEventLog({ events, store, batchMs: 0 });
    await log.attach("s1");
    events.emit("s1", ev(3));
    await log.flush("s1");
    const rows = await readAll("s1");
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("readSince(sid, sinceSeq) yields only events with seq > sinceSeq", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    events.emit("s1", ev(3));
    await log.flush("s1");
    const collected: number[] = [];
    for await (const entry of log.readSince("s1", 1)) collected.push(entry.seq);
    expect(collected).toEqual([2, 3]);
  });

  it("readSince returns an empty iterator for a session with no events", async () => {
    const seen: number[] = [];
    for await (const e of log.readSince("s2", 0)) seen.push(e.seq);
    expect(seen).toEqual([]);
  });

  it("closeAll() stops further appends and broadcasts", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    await log.closeAll();
    const seen: number[] = [];
    log.subscribe("s1", (e) => seen.push(e.seq));
    events.emit("s1", ev(2));
    expect(seen).toEqual([]);
    expect((await readAll("s1")).map((r) => r.seq)).toEqual([1]);
  });

  it("flush persists events buffered before flush even with a long batch window", async () => {
    log = new SessionEventLog({ events, store, batchMs: 10_000 });
    await log.attach("s1");
    events.emit("s1", ev(1));
    // Not yet persisted (timer hasn't fired); flush forces it.
    await log.flush("s1");
    expect((await readAll("s1")).map((r) => r.seq)).toEqual([1]);
  });

  it("subscribe() unsub stops only that listener", async () => {
    await log.attach("s1");
    const a: number[] = [];
    const b: number[] = [];
    const offA = log.subscribe("s1", (e) => a.push(e.seq));
    log.subscribe("s1", (e) => b.push(e.seq));
    events.emit("s1", ev(1));
    offA();
    events.emit("s1", ev(2));
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- session-event-log`
Expected: FAIL (constructor still wants `workspaces`; `store` unknown).

- [ ] **Step 3: Rewrite `SessionEventLog`**

Replace `apps/server/src/events/session-event-log.ts` entirely:

```ts
// apps/server/src/events/session-event-log.ts
import type { EventBus } from "./event-bus.js";
import type { EventStore, SequencedEvent } from "./event-store.js";

// Re-exported for back-compat: stream-routes imports SequencedEvent from here.
export type { SequencedEvent } from "./event-store.js";
export type SequencedListener = (entry: SequencedEvent) => void;

interface SessionState {
  nextSeq: number;
  subscribers: Set<SequencedListener>;
  unsubFromBus: () => void;
  buffer: SequencedEvent[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Tail of the serialized append chain; resolves when the buffer is persisted. */
  pendingFlush: Promise<void>;
}

export interface SessionEventLogDeps {
  events: EventBus;
  store: EventStore;
  /** Batch window (ms) before a bulk insert. Default 100. Tests pass 0. */
  batchMs?: number;
}

/**
 * Sits between the orchestrator's EventBus and live SSE clients.
 *
 * - On `attach(sid)`: recover the next sequence number from the store
 *   (`maxSeq + 1`) and subscribe to the bus.
 * - On each bus event: stamp it with a per-session monotonic `seq` + ISO `at`,
 *   broadcast `{seq, at, event}` to live subscribers *synchronously*, and push
 *   it onto a buffer that is bulk-inserted ~`batchMs` later (the spec's write
 *   strategy for high-frequency agent.text). `flush(sid)` forces an immediate
 *   drain — the SSE route calls it before replaying so no buffered event is
 *   missed.
 * - `readSince(sid, sinceSeq)` delegates to the store for SSE replay.
 *
 * Sequence numbers are the source of truth for replay ordering; the seq dedup
 * in the SSE route makes the subscribe→flush→readSince→drain handoff safe.
 */
export class SessionEventLog {
  private states = new Map<string, SessionState>();
  private batchMs: number;

  constructor(private deps: SessionEventLogDeps) {
    this.batchMs = deps.batchMs ?? 100;
  }

  async attach(sessionId: string): Promise<void> {
    if (this.states.has(sessionId)) return;
    const nextSeq = (await this.deps.store.maxSeq(sessionId)) + 1;
    const state: SessionState = {
      nextSeq,
      subscribers: new Set(),
      unsubFromBus: () => {},
      buffer: [],
      flushTimer: null,
      pendingFlush: Promise.resolve(),
    };
    state.unsubFromBus = this.deps.events.subscribe(sessionId, (event) => {
      const entry: SequencedEvent = {
        seq: state.nextSeq++,
        at: new Date().toISOString(),
        event,
      };
      state.buffer.push(entry);
      for (const sub of [...state.subscribers]) sub(entry);
      if (!state.flushTimer) {
        state.flushTimer = setTimeout(() => {
          void this.persist(sessionId);
        }, this.batchMs);
      }
    });
    this.states.set(sessionId, state);
  }

  subscribe(sessionId: string, listener: SequencedListener): () => void {
    const state = this.states.get(sessionId);
    if (!state) return () => {};
    state.subscribers.add(listener);
    return () => {
      state.subscribers.delete(listener);
    };
  }

  readSince(sessionId: string, sinceSeq: number): AsyncIterable<SequencedEvent> {
    return this.deps.store.readSince(sessionId, sinceSeq);
  }

  /** Drain the current buffer to the store now and await it. */
  async flush(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    await this.persist(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.unsubFromBus(); // stop capturing new events first
    await this.persist(sessionId); // flush remainder (row still exists)
    state.subscribers.clear();
    this.states.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    const ids = [...this.states.keys()];
    for (const id of ids) await this.close(id);
  }

  /**
   * Clear the timer, splice the buffer, and append it to the store, chained
   * after any in-flight append so inserts never overlap. Returns the chain tail.
   */
  private persist(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return Promise.resolve();
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    const batch = state.buffer.splice(0);
    if (batch.length === 0) return state.pendingFlush;
    state.pendingFlush = state.pendingFlush
      .then(() => this.deps.store.append(sessionId, batch))
      .catch((err) => {
        // Events were already broadcast to live clients; a persistence failure
        // only costs replay-after-reconnect. Log, don't crash the stream.
        console.error(`session-event-log: append failed for ${sessionId}`, err);
      });
    return state.pendingFlush;
  }
}
```

- [ ] **Step 4: Run the unit test**

Run: `pnpm test -- session-event-log`
Expected: PASS.

- [ ] **Step 5: Sweep every `new SessionEventLog(...)` construction site**

`pnpm typecheck` now fails at each site that passes `workspaces`. Fix them all:

- **`apps/server/src/api/server.ts`**: this needs the PG store. Add the import and construct it (Task 3 created `PgEventStore`). The file already has a `db` in scope (used for `new PgSessionRepository(db)`). Change:

```ts
// near the other src/events imports:
import { PgEventStore } from "../events/pg-event-store.js";

// replace the existing eventLog construction:
const eventLog = new SessionEventLog({
  events: composed.events,
  store: new PgEventStore(db),
});
```

  Remove the now-unused `workspaces: composed.workspaces` line from that object. (Default `batchMs` of 100 is correct for production.)

- **Each of these test files**: replace `new SessionEventLog({ events, workspaces })` with `new SessionEventLog({ events, store: new InMemoryEventStore(), batchMs: 0 })` and add `import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";`. Leave their `workspaces`/`WorkspaceManager` usage for other deps intact.
  - `apps/server/test/api/artifacts-routes.test.ts`
  - `apps/server/test/api/end-to-end.test.ts`
  - `apps/server/test/api/files-routes.test.ts`
  - `apps/server/test/api/messages-routes.test.ts`
  - `apps/server/test/api/sessions-routes.test.ts`
  - `apps/server/test/api/uploads-routes.test.ts`
  - `apps/server/test/api/stream-routes.test.ts`

  Note: `sessions-routes.test.ts:68` and `end-to-end.test.ts:156` assert on the `events.jsonl` file path. Those assertions are now obsolete — replace them with the PG-backed equivalent: read via the app's `deps.eventLog.readSince(sid, 0)` (after `await deps.eventLog.flush(sid)`) and assert the events are present, OR delete the disk assertion if the test's intent is already covered elsewhere. Use judgment per test; keep the *behavioral* intent (a session accrues events), drop the *disk-file* mechanism.

- [ ] **Step 6: Full suite green + commit**

Run: `pnpm typecheck` → clean. Run: `pnpm test` → all green.

```bash
git add -A
git commit -m "refactor(server): SessionEventLog persists via EventStore with batch buffer"
```

---

## Task 5: Flush-before-replay in the SSE stream route

**Files:**
- Modify: `apps/server/src/api/stream-routes.ts`
- Test: `apps/server/test/api/stream-routes.test.ts`

With batching, an event broadcast just before a client connects can be in neither PG nor the new subscriber's buffer. Subscribing first, then flushing, then replaying from PG closes the gap; the existing `entry.seq > lastSent` dedup absorbs any overlap.

- [ ] **Step 1: Add a failing test**

Add to `apps/server/test/api/stream-routes.test.ts`. Match the file's existing harness for opening an SSE request and reading frames (reuse its helpers — do not invent a new client). The test: with a non-zero `batchMs`, emit an event, then connect and assert it is replayed.

```ts
  it("replays an event that is still in the batch buffer when the client connects", async () => {
    // Rebuild the event log with a long batch window so the event is NOT yet in
    // the store when the SSE client connects; the route's flush must surface it.
    deps.eventLog = new SessionEventLog({
      events: deps.events,
      store: new InMemoryEventStore(),
      batchMs: 10_000,
    });
    await app.close();
    app = await createApp(deps);
    const sid = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;

    await deps.eventLog.attach(sid);
    deps.events.emit(sid, { type: "phase.progress", phase: "research", message: "buffered" });

    // <connect to GET /api/sessions/:sid/stream using the file's existing SSE
    // helper, with no Last-Event-Id, and collect the first data frame>
    // Assert the replayed frame's event.message === "buffered".
  });
```

Implement the `<connect...>` part with whatever SSE-reading utility the file already uses (e.g. an inject with a payload stream / a raw socket helper). If the file lacks one, model it on the existing "reconnect replays from disk" test in the same file.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- stream-routes`
Expected: FAIL (the buffered event is missing from the replay — no flush yet).

- [ ] **Step 3: Add the flush**

In `apps/server/src/api/stream-routes.ts`, after the `subscribe(...)` block and before the `try { for await (const entry of deps.eventLog.readSince(...)) }` replay loop, insert:

```ts
      // Persist anything still in the batch buffer so the PG replay below sees
      // it. Subscribe already happened, so events arriving during the flush are
      // captured in `buffered` and drained after cutover (seq dedup prevents
      // doubles).
      await deps.eventLog.flush(sid);
```

- [ ] **Step 4: Run + full suite + commit**

Run: `pnpm test -- stream-routes` → PASS. Run: `pnpm test` → all green. `pnpm typecheck` → clean.

```bash
git add apps/server/src/api/stream-routes.ts apps/server/test/api/stream-routes.test.ts
git commit -m "fix(server): flush event buffer before SSE replay so no buffered event is lost"
```

---

## Task 6: `ArtifactRepository` interface + `InMemoryArtifactRepository` + drop `path`

**Files:**
- Create: `apps/server/src/artifacts/artifact-repository.ts`
- Create: `apps/server/test/helpers/in-memory-artifact-repository.ts`
- Test: `apps/server/test/artifacts/in-memory-artifact-repository.test.ts`
- Modify: `packages/shared/src/artifact.ts` (drop `path`)

- [ ] **Step 1: Drop `path` from the shared descriptor schema**

In `packages/shared/src/artifact.ts`, remove the `path` line from `ArtifactDescriptorSchema`:

```ts
export const ArtifactDescriptorSchema = z.object({
  kind: ArtifactKindSchema,
  version: z.number().int().positive(),
  createdAt: z.string(),
  derivedFrom: z.array(LineageRefSchema).nullable(),
  stale: z.boolean(),
});
```

(Leave `ArtifactEnvelope`, `LineageRefSchema`, everything else unchanged. `ArtifactDescriptor` type re-infers without `path`.)

- [ ] **Step 2: Define the repository interface**

Create `apps/server/src/artifacts/artifact-repository.ts`:

```ts
import type { ArtifactKind, LineageRef } from "@ultracreator/shared";

/** A persisted artifact row. `data` is the validated artifact payload (jsonb). */
export interface ArtifactRow {
  kind: ArtifactKind;
  version: number;
  createdAt: string;
  derivedFrom: LineageRef[] | null;
  stale: boolean;
  data: unknown;
}

/**
 * Raw persistence for a session's artifacts. Versioning, Zod validation, and
 * EventBus emission live in ArtifactStore; this is dumb CRUD so the PG and
 * in-memory impls stay behaviorally identical. The caller serializes writes per
 * session (orchestrator holds one logical lock), and the PG unique constraint
 * (session_id, kind, version) is the backstop.
 */
export interface ArtifactRepository {
  /** Highest version for (session, kind), or 0 if none. */
  maxVersion(sessionId: string, kind: ArtifactKind): Promise<number>;
  insert(sessionId: string, row: ArtifactRow): Promise<void>;
  getLatest(sessionId: string, kind: ArtifactKind): Promise<ArtifactRow | null>;
  getVersion(sessionId: string, kind: ArtifactKind, version: number): Promise<ArtifactRow | null>;
  /** All artifact rows for the session (any kind/version), for list(). */
  list(sessionId: string): Promise<ArtifactRow[]>;
  /** Flip stale=true. Returns false if no matching row. */
  markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<boolean>;
}
```

- [ ] **Step 3: Write the failing fake test**

Create `apps/server/test/artifacts/in-memory-artifact-repository.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import type { ArtifactRow } from "../../src/artifacts/artifact-repository.js";

const row = (kind: ArtifactRow["kind"], version: number, extra: Partial<ArtifactRow> = {}): ArtifactRow => ({
  kind,
  version,
  createdAt: new Date(version * 1000).toISOString(),
  derivedFrom: null,
  stale: false,
  data: { v: version },
  ...extra,
});

describe("InMemoryArtifactRepository", () => {
  it("maxVersion is 0 when empty, then tracks the highest per kind", async () => {
    const repo = new InMemoryArtifactRepository();
    expect(await repo.maxVersion("s1", "brief")).toBe(0);
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("brief", 2));
    await repo.insert("s1", row("design", 1));
    expect(await repo.maxVersion("s1", "brief")).toBe(2);
    expect(await repo.maxVersion("s1", "design")).toBe(1);
  });

  it("getLatest returns the highest version; getVersion is exact", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("brief", 1, { data: { a: 1 } }));
    await repo.insert("s1", row("brief", 2, { data: { a: 2 } }));
    expect((await repo.getLatest("s1", "brief"))?.data).toEqual({ a: 2 });
    expect((await repo.getVersion("s1", "brief", 1))?.data).toEqual({ a: 1 });
    expect(await repo.getVersion("s1", "brief", 9)).toBeNull();
    expect(await repo.getLatest("s1", "design")).toBeNull();
  });

  it("list returns every row; scoped per session", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("design", 1));
    await repo.insert("s2", row("brief", 1));
    expect((await repo.list("s1")).map((r) => r.kind).sort()).toEqual(["brief", "design"]);
    expect((await repo.list("s2")).map((r) => r.kind)).toEqual(["brief"]);
  });

  it("markStale flips the flag and returns false for a missing row", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("brief", 1));
    expect(await repo.markStale("s1", "brief", 1)).toBe(true);
    expect((await repo.getVersion("s1", "brief", 1))?.stale).toBe(true);
    expect(await repo.markStale("s1", "brief", 2)).toBe(false);
  });

  it("preserves derivedFrom", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("design", 1, { derivedFrom: [{ kind: "brief", version: 1 }] }));
    expect((await repo.getLatest("s1", "design"))?.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });
});
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `pnpm test -- in-memory-artifact-repository`
Expected: FAIL (`InMemoryArtifactRepository` not found).

- [ ] **Step 5: Implement the fake**

Create `apps/server/test/helpers/in-memory-artifact-repository.ts`:

```ts
import type { ArtifactKind } from "@ultracreator/shared";
import type { ArtifactRepository, ArtifactRow } from "../../src/artifacts/artifact-repository.js";

/** In-memory ArtifactRepository for unit tests. Behaves identically to the PG impl. */
export class InMemoryArtifactRepository implements ArtifactRepository {
  private rows = new Map<string, ArtifactRow[]>();

  private list_(sessionId: string): ArtifactRow[] {
    return this.rows.get(sessionId) ?? [];
  }

  async maxVersion(sessionId: string, kind: ArtifactKind): Promise<number> {
    const versions = this.list_(sessionId).filter((r) => r.kind === kind).map((r) => r.version);
    return versions.length > 0 ? Math.max(...versions) : 0;
  }

  async insert(sessionId: string, row: ArtifactRow): Promise<void> {
    const list = this.list_(sessionId);
    list.push({ ...row });
    this.rows.set(sessionId, list);
  }

  async getLatest(sessionId: string, kind: ArtifactKind): Promise<ArtifactRow | null> {
    const candidates = this.list_(sessionId).filter((r) => r.kind === kind);
    if (candidates.length === 0) return null;
    const latest = candidates.reduce((a, b) => (b.version > a.version ? b : a));
    return { ...latest };
  }

  async getVersion(sessionId: string, kind: ArtifactKind, version: number): Promise<ArtifactRow | null> {
    const found = this.list_(sessionId).find((r) => r.kind === kind && r.version === version);
    return found ? { ...found } : null;
  }

  async list(sessionId: string): Promise<ArtifactRow[]> {
    return this.list_(sessionId).map((r) => ({ ...r }));
  }

  async markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<boolean> {
    const found = this.list_(sessionId).find((r) => r.kind === kind && r.version === version);
    if (!found) return false;
    found.stale = true;
    return true;
  }
}
```

- [ ] **Step 6: Run + typecheck + commit**

Run: `pnpm test -- in-memory-artifact-repository` → PASS. `pnpm typecheck` → clean (dropping `path` may surface a stale assertion in `artifact-store.test.ts` line ~137 — that test is rewritten in Task 8; if typecheck flags a *type* error there now, it won't, since `path` removal is a runtime/`toMatchObject` concern. If the broader suite is run it stays green until Task 8 rewrites that file's assertion).

```bash
git add apps/server/src/artifacts/artifact-repository.ts apps/server/test/helpers/in-memory-artifact-repository.ts apps/server/test/artifacts/in-memory-artifact-repository.test.ts packages/shared/src/artifact.ts
git commit -m "feat(server): ArtifactRepository interface + in-memory fake; drop artifact descriptor path"
```

---

## Task 7: `PgArtifactRepository`

**Files:**
- Create: `apps/server/src/artifacts/pg-artifact-repository.ts`
- Test: `apps/server/test/artifacts/pg-artifact-repository.pg.test.ts`

- [ ] **Step 1: Write the failing PG test**

Create `apps/server/test/artifacts/pg-artifact-repository.pg.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgArtifactRepository } from "../../src/artifacts/pg-artifact-repository.js";
import type { ArtifactRow } from "../../src/artifacts/artifact-repository.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
// Shares ultracreator_test; safe under the single-fork "pg" project (see vitest.suites.ts).
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let repo: PgArtifactRepository;

const row = (kind: ArtifactRow["kind"], version: number, extra: Partial<ArtifactRow> = {}): ArtifactRow => ({
  kind,
  version,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, version)).toISOString(),
  derivedFrom: null,
  stale: false,
  data: { v: version },
  ...extra,
});

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
  repo = new PgArtifactRepository(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query('TRUNCATE artifacts, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
  await pool.query(
    `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
     VALUES ('s1','u1','idle',now(),now()), ('s2','u1','idle',now(),now())`,
  );
});

describe("PgArtifactRepository", () => {
  it("maxVersion is 0 then tracks the highest per kind", async () => {
    expect(await repo.maxVersion("s1", "brief")).toBe(0);
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("brief", 2));
    await repo.insert("s1", row("design", 1));
    expect(await repo.maxVersion("s1", "brief")).toBe(2);
    expect(await repo.maxVersion("s1", "design")).toBe(1);
  });

  it("getLatest / getVersion round-trip data, createdAt (ISO) and derivedFrom", async () => {
    await repo.insert("s1", row("brief", 1, { data: { a: 1 } }));
    await repo.insert("s1", row("design", 1, { data: { d: 1 }, derivedFrom: [{ kind: "brief", version: 1 }] }));
    const latest = await repo.getLatest("s1", "design");
    expect(latest?.data).toEqual({ d: 1 });
    expect(latest?.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
    expect(latest?.createdAt).toBe(row("design", 1).createdAt);
    expect((await repo.getVersion("s1", "brief", 1))?.data).toEqual({ a: 1 });
    expect(await repo.getVersion("s1", "brief", 9)).toBeNull();
    expect(await repo.getLatest("s2", "brief")).toBeNull();
  });

  it("list returns every row, scoped per session", async () => {
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("design", 1));
    await repo.insert("s2", row("brief", 1));
    expect((await repo.list("s1")).map((r) => r.kind).sort()).toEqual(["brief", "design"]);
    expect((await repo.list("s2")).map((r) => r.kind)).toEqual(["brief"]);
  });

  it("markStale flips the flag and returns false for a missing row", async () => {
    await repo.insert("s1", row("brief", 1));
    expect(await repo.markStale("s1", "brief", 1)).toBe(true);
    expect((await repo.getVersion("s1", "brief", 1))?.stale).toBe(true);
    expect(await repo.markStale("s1", "brief", 2)).toBe(false);
  });

  it("rejects a duplicate (session, kind, version)", async () => {
    await repo.insert("s1", row("brief", 1));
    await expect(repo.insert("s1", row("brief", 1))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- pg-artifact-repository`
Expected: FAIL (`PgArtifactRepository` not found).

- [ ] **Step 3: Implement `PgArtifactRepository`**

Create `apps/server/src/artifacts/pg-artifact-repository.ts`:

```ts
import { and, desc, eq, max } from "drizzle-orm";
import type { ArtifactKind, LineageRef } from "@ultracreator/shared";
import { artifact } from "../db/schema/creator.js";
import type { Db } from "../db/client.js";
import type { ArtifactRepository, ArtifactRow } from "./artifact-repository.js";

type Row = typeof artifact.$inferSelect;

function toRow(r: Row): ArtifactRow {
  return {
    kind: r.kind as ArtifactKind,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    derivedFrom: (r.derivedFrom as LineageRef[] | null) ?? null,
    stale: r.stale,
    data: r.data,
  };
}

export class PgArtifactRepository implements ArtifactRepository {
  constructor(private db: Db) {}

  async maxVersion(sessionId: string, kind: ArtifactKind): Promise<number> {
    const rows = await this.db
      .select({ m: max(artifact.version) })
      .from(artifact)
      .where(and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind)));
    return rows[0]?.m ?? 0;
  }

  async insert(sessionId: string, row: ArtifactRow): Promise<void> {
    await this.db.insert(artifact).values({
      sessionId,
      kind: row.kind,
      version: row.version,
      data: row.data,
      derivedFrom: row.derivedFrom,
      stale: row.stale,
      createdAt: new Date(row.createdAt),
    });
  }

  async getLatest(sessionId: string, kind: ArtifactKind): Promise<ArtifactRow | null> {
    const rows = await this.db
      .select()
      .from(artifact)
      .where(and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind)))
      .orderBy(desc(artifact.version))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async getVersion(sessionId: string, kind: ArtifactKind, version: number): Promise<ArtifactRow | null> {
    const rows = await this.db
      .select()
      .from(artifact)
      .where(
        and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind), eq(artifact.version, version)),
      )
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async list(sessionId: string): Promise<ArtifactRow[]> {
    const rows = await this.db
      .select()
      .from(artifact)
      .where(eq(artifact.sessionId, sessionId))
      .orderBy(artifact.kind, artifact.version);
    return rows.map(toRow);
  }

  async markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<boolean> {
    const updated = await this.db
      .update(artifact)
      .set({ stale: true })
      .where(
        and(eq(artifact.sessionId, sessionId), eq(artifact.kind, kind), eq(artifact.version, version)),
      )
      .returning({ id: artifact.id });
    return updated.length > 0;
  }
}
```

- [ ] **Step 4: Run + typecheck + commit**

Run: `pnpm test -- pg-artifact-repository` → PASS. `pnpm typecheck` → clean.

```bash
git add apps/server/src/artifacts/pg-artifact-repository.ts apps/server/test/artifacts/pg-artifact-repository.pg.test.ts
git commit -m "feat(server): PgArtifactRepository (artifacts persistence)"
```

---

## Task 8: Refactor `ArtifactStore` onto `ArtifactRepository` + wire it everywhere

**Files:**
- Modify: `apps/server/src/artifacts/artifact-store.ts`
- Modify: `apps/server/test/artifact-store.test.ts` (rewrite)
- Modify: `apps/server/src/compose-orchestrator.ts` (accept `artifactRepo`)
- Modify: `apps/server/src/api/server.ts` (pass `PgArtifactRepository`)
- Modify (mechanical sweep — every `new ArtifactStore(...)` and every `composeOrchestrator(...)` call site): all test files listed below.

This task changes the `ArtifactStore` constructor from `(workspaces, events)` to `(repo, events)`. **Every construction site must be updated in this same task.**

- [ ] **Step 1: Rewrite the unit test (failing first)**

Replace `apps/server/test/artifact-store.test.ts` entirely:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import type { ServerEvent } from "@ultracreator/shared";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";

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

let bus: EventBus;
let store: ArtifactStore;

beforeEach(() => {
  bus = new EventBus();
  store = new ArtifactStore(new InMemoryArtifactRepository(), bus);
});

describe("ArtifactStore", () => {
  it("put validates data and returns a v1 envelope", async () => {
    const env = await store.put("s1", "brief", briefData);
    expect(env.version).toBe(1);
    expect(env.kind).toBe("brief");
    expect((env.data as typeof briefData).product.name).toBe("Acme");
    const got = await store.get("s1", "brief");
    expect((got!.data as typeof briefData).product.name).toBe("Acme");
  });

  it("put rejects data that fails the kind schema", async () => {
    await expect(store.put("s1", "brief", { product: {} })).rejects.toThrow();
  });

  it("put assigns incrementing versions per kind", async () => {
    expect((await store.put("s1", "brief", briefData)).version).toBe(1);
    expect((await store.put("s1", "brief", briefData)).version).toBe(2);
  });

  it("get returns the latest version by default", async () => {
    await store.put("s1", "brief", briefData);
    await store.put("s1", "brief", { ...briefData, audience: "marketers" });
    const latest = await store.get("s1", "brief");
    expect(latest!.version).toBe(2);
    expect((latest!.data as typeof briefData).audience).toBe("marketers");
  });

  it("get returns a specific version when asked", async () => {
    await store.put("s1", "brief", briefData);
    await store.put("s1", "brief", { ...briefData, audience: "marketers" });
    expect(((await store.get("s1", "brief", 1))!.data as typeof briefData).audience).toBe("devs");
  });

  it("records lineage via derivedFrom", async () => {
    await store.put("s1", "brief", briefData);
    const design = await store.put("s1", "design", designData, {
      derivedFrom: [{ kind: "brief", version: 1 }],
    });
    expect(design.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "design")!.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });

  it("emits artifact.created on put", async () => {
    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    await store.put("s1", "brief", briefData);
    expect(events).toContainEqual({ type: "artifact.created", kind: "brief", version: 1 });
  });

  it("markStale flips the flag and emits artifact.stale, leaving the stored data immutable", async () => {
    await store.put("s1", "brief", briefData);
    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    await store.markStale("s1", "brief", 1);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")!.stale).toBe(true);
    expect(events).toContainEqual({ type: "artifact.stale", kind: "brief", version: 1 });
    // The envelope data is unchanged — stale lives only on the descriptor.
    const env = await store.get("s1", "brief", 1);
    expect((env!.data as typeof briefData).product.name).toBe("Acme");
  });

  it("list returns descriptors (no path field) for all written artifacts", async () => {
    await store.put("s1", "brief", briefData);
    const list = await store.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "brief", version: 1, stale: false });
    expect(list[0]).not.toHaveProperty("path");
  });

  it("get returns null for a kind that was never written", async () => {
    expect(await store.get("s1", "brief")).toBeNull();
  });

  it("markStale throws when the kind/version does not exist", async () => {
    await store.put("s1", "brief", briefData);
    await expect(store.markStale("s1", "brief", 2)).rejects.toThrow(/to mark stale/i);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test -- artifact-store`
Expected: FAIL (constructor still wants `workspaces`).

- [ ] **Step 3: Rewrite `ArtifactStore`**

Replace `apps/server/src/artifacts/artifact-store.ts` entirely:

```ts
import {
  ARTIFACT_DATA_SCHEMAS,
  type ArtifactDescriptor,
  type ArtifactEnvelope,
  type ArtifactKind,
  type LineageRef,
} from "@ultracreator/shared";
import type { EventBus } from "../events/event-bus.js";
import type { ArtifactRepository } from "./artifact-repository.js";

export interface PutOptions {
  derivedFrom?: LineageRef[];
}

/**
 * The only writer of artifact descriptors for a session. Validates payloads,
 * assigns per-kind versions, persists via an ArtifactRepository, and emits
 * EventBus notifications. Media files (mp4/audio/composition dir) stay on disk
 * and are written by the phase handlers, not here; `data` only holds the
 * descriptor with workspace-relative paths inside it.
 *
 * Concurrency contract: `put`/`markStale` read-then-write version state, so
 * writes to a single session MUST be serialized by the caller (the orchestrator
 * holds one logical lock per session — see spec §8). The repository's
 * unique(session_id, kind, version) constraint is the backstop.
 */
export class ArtifactStore {
  constructor(
    private repo: ArtifactRepository,
    private events: EventBus,
  ) {}

  async put<T>(
    sessionId: string,
    kind: ArtifactKind,
    data: T,
    opts: PutOptions = {},
  ): Promise<ArtifactEnvelope<T>> {
    const schema = ARTIFACT_DATA_SCHEMAS[kind];
    const validated = schema.parse(data) as T;

    const version = (await this.repo.maxVersion(sessionId, kind)) + 1;
    const createdAt = new Date().toISOString();
    const derivedFrom = opts.derivedFrom ?? null;

    await this.repo.insert(sessionId, {
      kind,
      version,
      createdAt,
      derivedFrom,
      stale: false,
      data: validated,
    });

    this.events.emit(sessionId, { type: "artifact.created", kind, version });
    return { kind, version, createdAt, derivedFrom, data: validated };
  }

  async get<T = unknown>(
    sessionId: string,
    kind: ArtifactKind,
    version?: number,
  ): Promise<ArtifactEnvelope<T> | null> {
    const row =
      version !== undefined
        ? await this.repo.getVersion(sessionId, kind, version)
        : await this.repo.getLatest(sessionId, kind);
    if (!row) return null;
    return {
      kind: row.kind,
      version: row.version,
      createdAt: row.createdAt,
      derivedFrom: row.derivedFrom,
      data: row.data as T,
    };
  }

  async list(sessionId: string): Promise<ArtifactDescriptor[]> {
    const rows = await this.repo.list(sessionId);
    return rows.map((r) => ({
      kind: r.kind,
      version: r.version,
      createdAt: r.createdAt,
      derivedFrom: r.derivedFrom,
      stale: r.stale,
    }));
  }

  async markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<void> {
    const ok = await this.repo.markStale(sessionId, kind, version);
    if (!ok) throw new Error(`No ${kind} v${version} to mark stale`);
    this.events.emit(sessionId, { type: "artifact.stale", kind, version });
  }
}
```

- [ ] **Step 4: Run the unit test**

Run: `pnpm test -- artifact-store`
Expected: PASS.

- [ ] **Step 5: Thread `artifactRepo` through `composeOrchestrator`**

In `apps/server/src/compose-orchestrator.ts`:
- Add to `ComposeOrchestratorOptions`: `artifactRepo: ArtifactRepository;` (import the type: `import type { ArtifactRepository } from "./artifacts/artifact-repository.js";`).
- Replace `const artifacts = new ArtifactStore(workspaces, events);` with `const artifacts = new ArtifactStore(opts.artifactRepo, events);`.
- `workspaces` is still constructed and returned (handlers need it for media); only its use in the `ArtifactStore` constructor goes away.

- [ ] **Step 6: Wire `PgArtifactRepository` in `server.ts`**

In `apps/server/src/api/server.ts`:
- Import: `import { PgArtifactRepository } from "../artifacts/pg-artifact-repository.js";`.
- Pass `artifactRepo: new PgArtifactRepository(db)` into the `composeOrchestrator({ ... })` options object.

- [ ] **Step 7: Sweep every remaining `new ArtifactStore(...)` and `composeOrchestrator(...)` site**

`pnpm typecheck` now lists each broken site. Fix them mechanically:

- For direct `new ArtifactStore(wm, bus)` (or `(workspaces, events)`) in test files: replace the first arg with `new InMemoryArtifactRepository()` and add `import { InMemoryArtifactRepository } from "<correct relative path>/helpers/in-memory-artifact-repository.js";`. Keep the `WorkspaceManager` for the handler/other deps in that test. Files:
  - `apps/server/test/api/artifacts-routes.test.ts`
  - `apps/server/test/api/end-to-end.test.ts`
  - `apps/server/test/api/files-routes.test.ts`
  - `apps/server/test/api/messages-routes.test.ts`
  - `apps/server/test/api/sessions-routes.test.ts`
  - `apps/server/test/api/stream-routes.test.ts`
  - `apps/server/test/api/uploads-routes.test.ts`
  - `apps/server/test/artifact-write-tools.test.ts`
  - `apps/server/test/fake-handler.test.ts`
  - `apps/server/test/generate-music-tool.test.ts`
  - `apps/server/test/orchestrator.test.ts`
  - `apps/server/test/pi-compose-handler.test.ts`
  - `apps/server/test/pi-design-handler.test.ts`
  - `apps/server/test/pi-research-handler.test.ts`
  - `apps/server/test/pi-script-handler.test.ts`
  - `apps/server/test/render-handler.test.ts`
  - `apps/server/test/stale.test.ts`
  - `apps/server/test/voiceover-handler.test.ts`
- For any `composeOrchestrator({ ... })` call in tests (e.g. `end-to-end.test.ts`): add `artifactRepo: new InMemoryArtifactRepository()` to the options.

Tip: `grep -rln "new ArtifactStore\|composeOrchestrator(" apps/server/test` to enumerate; let `pnpm typecheck` confirm none are missed.

- [ ] **Step 8: Full suite green + commit**

Run: `pnpm typecheck` → clean. Run: `pnpm test` → all green (`unit` + `pg` projects).

```bash
git add -A
git commit -m "refactor(server): ArtifactStore persists via ArtifactRepository; wire PG impl"
```

---

## Task 9: Full regression, dead-code sweep, and acceptance

**Files:** none new — verification + cleanup.

- [ ] **Step 1: Confirm the disk paths are gone**

Run: `grep -rn "events.jsonl\|index.json\|\.v\${\|artifacts/.*\.json" apps/server/src`
Expected: no remaining references to `events.jsonl`, the artifact `index.json`, or `<kind>.v<n>.json` envelope files in `apps/server/src`. (The `logs/` and `artifacts/` workspace directories may still be created by `WorkspaceManager` — that's fine; they're just unused now. Do **not** remove `WorkspaceManager` dir creation in this task; media still uses the workspace.)

- [ ] **Step 2: Confirm no `WorkspaceManager` import lingers in the refactored files**

Open `apps/server/src/events/session-event-log.ts` and `apps/server/src/artifacts/artifact-store.ts`: neither should import `WorkspaceManager` or `node:fs` anymore.

- [ ] **Step 3: Full typecheck + test**

Run: `pnpm typecheck` → clean.
Run: `pnpm test` → all green. Confirm the `pg` project ran all `*.pg.test.ts` files single-fork (migrations, pg-session-repository, pg-event-store, pg-artifact-repository). If `worker-ipc-disconnect.test.ts` flakes, re-run once — it is a known timing-sensitive test, unrelated to this change.

- [ ] **Step 4: Manual acceptance smoke (requires local PG + a running server + Google login — the user runs this)**

Document for the user to run:
1. Start the server (`runMigrations` auto-applies `0002`). Create a session, send a message, let a phase or two run.
2. Inspect PG: `SELECT seq, event->>'type' FROM session_events WHERE session_id='<sid>' ORDER BY seq LIMIT 20;` and `SELECT kind, version, stale FROM artifacts WHERE session_id='<sid>' ORDER BY kind, version;` — events and artifacts are rows, not files.
3. Confirm `workspaces/<sid>/logs/events.jsonl` and `workspaces/<sid>/artifacts/*.json` are no longer written (the dirs may exist but stay empty of these files).
4. Reconnect the SSE stream (reload the session page) — the full event history replays from PG; a running task keeps streaming.
5. Delete the session → `session_events` and `artifacts` rows for that sid are gone (FK cascade).

- [ ] **Step 5: Final whole-phase review**

Dispatch a final code-review subagent over the whole Phase 2b diff (`git diff <phase-2b-base>..HEAD`) checking: (a) no event/artifact disk I/O remains in `src`; (b) seq/version monotonicity preserved across restart (recovered from PG); (c) SSE replay correctness with batching (subscribe→flush→readSince→drain, seq dedup); (d) FK cascade on delete; (e) no public API shape change except the intended `path` drop; (f) both in-memory fakes match their PG counterparts behaviorally. Address any Critical/Important findings, then this phase is ready to merge.

---

## Self-Review (planner)

**Spec coverage (§2 business tables, §2 write strategy):**
- `session_events` table (id bigserial, session_id FK, seq, at, event jsonb, unique(session_id,seq)) → Task 1. ✔
- `artifacts` table (id bigserial, session_id FK, kind, version, data jsonb, derived_from jsonb, stale, created_at, unique(session_id,kind,version)) → Task 1. ✔
- "事件日志组件做约 100ms 的批量缓冲后批插" → Task 4 (batch buffer, default `batchMs: 100`). ✔
- "SSE 重放改为按 seq > Last-Event-Id 查 PG" → `readSince` delegates to PG (Tasks 3/4); stream route unchanged except flush (Task 5). ✔
- "删除会话:同时清理 PG 行(级联)" → FK `ON DELETE CASCADE` (Task 1) + cascade test. ✔
- "媒体文件仍存磁盘…JSON 中保存相对路径" → media untouched; only JSON descriptors move (Tasks 6/8). ✔

**Placeholder scan:** The only deliberately-non-literal spot is Task 5 Step 1's `<connect to SSE…>` — because the stream test's SSE-reading helper is file-specific and must be reused, not reinvented. The step names exactly what to assert and points at the existing "reconnect replays from disk" test as the model. Everything else is complete code.

**Type consistency:** `SequencedEvent` defined once in `event-store.ts`, re-exported from `session-event-log.ts` (stream-routes' import path unchanged). `EventStore` methods (`maxSeq`/`append`/`readSince`) identical across interface, PG, and fake. `ArtifactRepository` methods (`maxVersion`/`insert`/`getLatest`/`getVersion`/`list`/`markStale`) identical across interface, PG, and fake. `ArtifactRow` shape consistent. `ArtifactStore` public methods (`put`/`get`/`list`/`markStale`) and `ArtifactEnvelope`/`ArtifactDescriptor` shapes preserved (minus `path`). `composeOrchestrator` gains one required option (`artifactRepo`), updated at both call sites (server.ts + end-to-end test).
