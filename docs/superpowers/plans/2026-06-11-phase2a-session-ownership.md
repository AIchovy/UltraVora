# 阶段②a 会话归属 + 列表落库 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给每个业务会话加上归属(`user_id`)并把会话列表从浏览器 localStorage 迁到 PG 后端,所有会话 API 校验归属(越权返回 404),会话状态/标题落库。验收:换浏览器登录同一账号能看到自己的全部会话。

**Architecture:** 新增 `creator_sessions` 表(归属 + 状态 + 标题,FK→`user`,级联删除)。新增窄接口 `SessionRepository`(PG 实现 + 内存 fake),作为会话存在性与归属的唯一真相来源。orchestrator 在每次状态迁移时把 `status/current_phase/error` 写入 `creator_sessions`,重启恢复从该表读取(不再依赖 `events.jsonl`)。会话首条消息在服务端截断为标题落库。前端会话列表改为 `GET /api/sessions`(React Query),删除 localStorage 列表逻辑。

**本阶段范围边界(② 拆为 2a/2b,本计划只做 2a):**
- ✅ `creator_sessions` 表 + 归属 + 列表 + 状态/标题落库 + 越权 404。
- ❌ `session_events` 取代 `events.jsonl`、`artifacts` 表取代 `artifacts/*.json`——留给 **阶段②b**。本阶段 `SessionEventLog`、`ArtifactStore` 不动,事件日志与 artifact 仍写磁盘。
- ❌ `session_messages` 消息队列、自动恢复——阶段③。
- ❌ `initial-message.json` 仍留在磁盘(阶段③ 随消息队列迁库)。

**Tech Stack:** drizzle-orm + pg(node-postgres)+ drizzle-kit、Fastify 5、Next.js 15 + @tanstack/react-query。

**Spec:** `docs/superpowers/specs/2026-06-11-productization-design.md`(阶段② 范围,§2 数据模型 `creator_sessions`、§3 归属守卫、§6 前端列表、§9 测试策略)

**前置条件(已就绪):**
- 阶段① 已合并:`creator_sessions` 之外的 better-auth 表(`user`/`session`/`account`/`verification`)已在 `drizzle/0000_*.sql`。
- 本地 PG 可连;测试库 `ultracreator_test` 由 `*.pg.test.ts` 的 `beforeAll` 建表(沿用阶段① 模式)。
- 路由守卫 `createSessionGuard` 已为 `/api/sessions*` 设置 `req.authUser`(阶段①)。

**两处实现决策(本计划已替你拍板,实现时照此办,无需再问):**
1. **状态真相来源切换**:阶段① 重启恢复靠重放 `events.jsonl`;本阶段改为 `creator_sessions.status/current_phase/error`。`events.jsonl` 仍写(给 SSE 重放),但不再是状态恢复来源。这使 orchestrator 不再耦合事件日志文件,为阶段②b 铺路。
2. **`status` 用 `text` 列而非 PG enum**:避免 enum migration 复杂度,由 `SessionRepository` 在边界处映射/校验。spec §2 写的是 enum,这里取实用主义,语义不变。

**关键不变量(实现/审查都要守):**
- `creator_sessions` 行是会话存在性与归属的唯一真相。`requireOwnedSession` 查不到行或 `user_id` 不匹配 → **404**(不是 403,避免泄漏会话是否存在;spec §8)。
- `updateStatus` 是纯 `UPDATE`,行不存在时静默 no-op(行由 `POST /api/sessions` 用 `req.authUser.id` 创建)。
- `SessionRepository` 接口对 PG 实现与内存 fake **行为一致**:除 `updateStatus`(纯 UPDATE)外不做隐式 upsert。

---

### Task 1: `creator_sessions` schema + migration

**Files:**
- Create: `apps/server/src/db/schema/creator.ts`
- Modify: `apps/server/src/db/schema/index.ts`
- Create(生成物): `apps/server/drizzle/0001_*.sql`
- Test: `apps/server/test/db/migrations.pg.test.ts:53-76`(在已有 describe 后追加断言)

- [ ] **Step 1: 写 schema**

`apps/server/src/db/schema/creator.ts`:

```ts
// 业务会话表。命名 creator_sessions 以避免与 better-auth 的登录态 session 表混淆。
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const creatorSession = pgTable(
  "creator_sessions",
  {
    id: text("id").primaryKey(), // = sid(POST /api/sessions 生成的 UUID 字符串)
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title"), // 首条用户消息截断;创建时为 null
    // idle | running | awaiting-gate | error | done —— 映射 SessionState.kind。
    // 用 text 而非 enum(见计划顶部决策 2)。
    status: text("status").notNull().default("idle"),
    currentPhase: text("current_phase"), // PhaseId | null
    error: text("error"), // 错误态的错误串 | null
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // 列表查询:WHERE user_id=? ORDER BY updated_at DESC
    userUpdatedIdx: index("creator_sessions_user_id_updated_at_idx").on(t.userId, t.updatedAt),
  }),
);
```

- [ ] **Step 2: 从 schema barrel 导出**

`apps/server/src/db/schema/index.ts` 改为:

```ts
export * from "./auth.js";
export * from "./creator.js";
```

- [ ] **Step 3: 生成 migration**

```bash
pnpm -F @ultracreator/server db:generate
```
Expected: 新增 `apps/server/drizzle/0001_*.sql`,含 `CREATE TABLE "creator_sessions"`、FK 到 `"user"(id)` `ON DELETE cascade`、`creator_sessions_user_id_updated_at_idx` 索引。`meta/` 下 journal 更新。**人工核对生成的 SQL**:确认没有意外 drop 既有表。

- [ ] **Step 4: 写失败测试(PG 集成)**

在 `apps/server/test/db/migrations.pg.test.ts` 现有 `describe("auth schema migrations", ...)` 内部末尾追加:

```ts
  it("creates creator_sessions with a cascading user FK", async () => {
    const res = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = res.rows.map((r: { table_name: string }) => r.table_name);
    expect(names).toContain("creator_sessions");

    // 插入归属于一个 user 的会话,删除 user 应级联删掉会话。
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('owner1', 'O', 'owner1@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('sess1', 'owner1', 'idle', now(), now())`,
    );
    await pool.query(`DELETE FROM "user" WHERE id='owner1'`);
    const after = await pool.query(`SELECT id FROM creator_sessions WHERE id='sess1'`);
    expect(after.rowCount).toBe(0);
  });
```

- [ ] **Step 5: 跑测试**

```bash
pnpm test -- migrations.pg
```
Expected: 全绿(`beforeAll` 重建库 + 跑 0000、0001 两个 migration;新断言通过)。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/db/schema/creator.ts apps/server/src/db/schema/index.ts apps/server/drizzle apps/server/test/db/migrations.pg.test.ts
git commit -m "feat(server): creator_sessions table + migration"
```

---

### Task 2: `SessionRepository` 接口 + 内存 fake + PG 实现

**Files:**
- Create: `apps/server/src/sessions/session-repository.ts`(接口 + 类型)
- Create: `apps/server/src/sessions/pg-session-repository.ts`(PG 实现)
- Create: `apps/server/test/helpers/in-memory-session-repository.ts`(单测 fake)
- Test: `apps/server/test/sessions/in-memory-session-repository.test.ts`
- Test: `apps/server/test/sessions/pg-session-repository.pg.test.ts`

- [ ] **Step 1: 写接口 + 类型**

`apps/server/src/sessions/session-repository.ts`:

```ts
import type { PhaseId } from "@ultracreator/shared";

export type SessionStatus = "idle" | "running" | "awaiting-gate" | "error" | "done";

export interface SessionRecord {
  id: string;
  userId: string;
  title: string | null;
  status: SessionStatus;
  currentPhase: PhaseId | null;
  error: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
}

export interface SessionStatusUpdate {
  status: SessionStatus;
  currentPhase: PhaseId | null;
  error: string | null;
}

/**
 * 会话归属与状态的持久化。`creator_sessions` 行是会话存在性的唯一真相。
 * 实现约定:`updateStatus` 是纯 UPDATE(行不存在则 no-op);行只能由
 * `create`(携带 userId)产生。PG 实现与内存 fake 行为必须一致。
 */
export interface SessionRepository {
  create(input: { id: string; userId: string }): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  /** 该用户的会话,按 updatedAt 倒序。 */
  listByUser(userId: string): Promise<SessionRecord[]>;
  /** 纯 UPDATE,行不存在静默 no-op。同时把 updatedAt 刷新为当前时刻。 */
  updateStatus(id: string, update: SessionStatusUpdate): Promise<void>;
  /** 仅当 title 当前为 null 时写入(首条消息定标题,后续消息不覆盖)。 */
  setTitleIfEmpty(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
}
```

- [ ] **Step 2: 写内存 fake**

`apps/server/test/helpers/in-memory-session-repository.ts`:

```ts
import type {
  SessionRecord,
  SessionRepository,
  SessionStatusUpdate,
} from "../../src/sessions/session-repository.js";

/** 单元测试用的 SessionRepository 内存实现。行为与 PG 实现保持一致。 */
export class InMemorySessionRepository implements SessionRepository {
  private rows = new Map<string, SessionRecord>();

  async create(input: { id: string; userId: string }): Promise<void> {
    if (this.rows.has(input.id)) return;
    const now = new Date().toISOString();
    this.rows.set(input.id, {
      id: input.id,
      userId: input.userId,
      title: null,
      status: "idle",
      currentPhase: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((r) => ({ ...r }));
  }

  async updateStatus(id: string, update: SessionStatusUpdate): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return; // 纯 UPDATE 语义
    row.status = update.status;
    row.currentPhase = update.currentPhase;
    row.error = update.error;
    row.updatedAt = new Date().toISOString();
  }

  async setTitleIfEmpty(id: string, title: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.title !== null) return;
    row.title = title;
    row.updatedAt = new Date().toISOString();
  }

  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
}
```

- [ ] **Step 3: 内存 fake 的失败测试**

`apps/server/test/sessions/in-memory-session-repository.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";

describe("InMemorySessionRepository", () => {
  it("create + get returns an idle, untitled record owned by the user", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    const row = await repo.get("s1");
    expect(row).toMatchObject({ id: "s1", userId: "u1", title: null, status: "idle", currentPhase: null });
  });

  it("get returns null for an unknown id", async () => {
    expect(await new InMemorySessionRepository().get("nope")).toBeNull();
  });

  it("listByUser is scoped to the user and ordered by updatedAt desc", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "a", userId: "u1" });
    await repo.create({ id: "b", userId: "u1" });
    await repo.create({ id: "c", userId: "u2" });
    // bump a so it becomes most-recently-updated
    await repo.updateStatus("a", { status: "running", currentPhase: "research", error: null });
    const list = await repo.listByUser("u1");
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
    expect((await repo.listByUser("u2")).map((r) => r.id)).toEqual(["c"]);
  });

  it("updateStatus is a no-op when the row is absent", async () => {
    const repo = new InMemorySessionRepository();
    await repo.updateStatus("ghost", { status: "running", currentPhase: "research", error: null });
    expect(await repo.get("ghost")).toBeNull();
  });

  it("setTitleIfEmpty only sets the first time", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    await repo.setTitleIfEmpty("s1", "First");
    await repo.setTitleIfEmpty("s1", "Second");
    expect((await repo.get("s1"))?.title).toBe("First");
  });

  it("delete removes the row", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    await repo.delete("s1");
    expect(await repo.get("s1")).toBeNull();
  });
});
```

- [ ] **Step 4: 跑 → 应通过(fake 已实现);再写 PG 实现**

```bash
pnpm test -- in-memory-session-repository
```
Expected: 全绿。

`apps/server/src/sessions/pg-session-repository.ts`:

```ts
import { eq, desc } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { creatorSession } from "../db/schema/creator.js";
import type { PhaseId } from "@ultracreator/shared";
import type {
  SessionRecord,
  SessionRepository,
  SessionStatus,
  SessionStatusUpdate,
} from "./session-repository.js";

type Row = typeof creatorSession.$inferSelect;

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    title: row.title,
    status: row.status as SessionStatus,
    currentPhase: (row.currentPhase as PhaseId | null) ?? null,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PgSessionRepository implements SessionRepository {
  constructor(private db: NodePgDatabase<Record<string, unknown>>) {}

  async create(input: { id: string; userId: string }): Promise<void> {
    // 幂等:重复 POST/恢复不报错。
    await this.db
      .insert(creatorSession)
      .values({ id: input.id, userId: input.userId })
      .onConflictDoNothing({ target: creatorSession.id });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const rows = await this.db.select().from(creatorSession).where(eq(creatorSession.id, id)).limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByUser(userId: string): Promise<SessionRecord[]> {
    const rows = await this.db
      .select()
      .from(creatorSession)
      .where(eq(creatorSession.userId, userId))
      .orderBy(desc(creatorSession.updatedAt));
    return rows.map(toRecord);
  }

  async updateStatus(id: string, update: SessionStatusUpdate): Promise<void> {
    await this.db
      .update(creatorSession)
      .set({
        status: update.status,
        currentPhase: update.currentPhase,
        error: update.error,
        updatedAt: new Date(),
      })
      .where(eq(creatorSession.id, id));
  }

  async setTitleIfEmpty(id: string, title: string): Promise<void> {
    const rows = await this.db
      .select({ title: creatorSession.title })
      .from(creatorSession)
      .where(eq(creatorSession.id, id))
      .limit(1);
    if (!rows[0] || rows[0].title !== null) return;
    await this.db
      .update(creatorSession)
      .set({ title, updatedAt: new Date() })
      .where(eq(creatorSession.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(creatorSession).where(eq(creatorSession.id, id));
  }
}
```

- [ ] **Step 5: PG 实现的集成测试**

`apps/server/test/sessions/pg-session-repository.pg.test.ts`(沿用 `migrations.pg.test.ts` 的建库模式):

```ts
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
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let repo: PgSessionRepository;

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
  repo = new PgSessionRepository(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query("TRUNCATE creator_sessions, \"user\" CASCADE");
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now()), ('u2','U2','u2@x.com',false,now(),now())`,
  );
});

describe("PgSessionRepository", () => {
  it("create + get yields an idle untitled owned record", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    expect(await repo.get("s1")).toMatchObject({ id: "s1", userId: "u1", title: null, status: "idle" });
  });

  it("create is idempotent", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.create({ id: "s1", userId: "u1" });
    expect(await repo.get("s1")).not.toBeNull();
  });

  it("listByUser scopes by user, newest first", async () => {
    await repo.create({ id: "a", userId: "u1" });
    await repo.create({ id: "b", userId: "u1" });
    await repo.create({ id: "c", userId: "u2" });
    await repo.updateStatus("a", { status: "running", currentPhase: "research", error: null });
    expect((await repo.listByUser("u1")).map((r) => r.id)).toEqual(["a", "b"]);
    expect((await repo.listByUser("u2")).map((r) => r.id)).toEqual(["c"]);
  });

  it("updateStatus persists kind/phase/error and is a no-op when absent", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.updateStatus("s1", { status: "error", currentPhase: "design", error: "boom" });
    expect(await repo.get("s1")).toMatchObject({ status: "error", currentPhase: "design", error: "boom" });
    await repo.updateStatus("ghost", { status: "running", currentPhase: "research", error: null });
    expect(await repo.get("ghost")).toBeNull();
  });

  it("setTitleIfEmpty only sets once", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.setTitleIfEmpty("s1", "First");
    await repo.setTitleIfEmpty("s1", "Second");
    expect((await repo.get("s1"))?.title).toBe("First");
  });

  it("delete removes the row", async () => {
    await repo.create({ id: "s1", userId: "u1" });
    await repo.delete("s1");
    expect(await repo.get("s1")).toBeNull();
  });
});
```

- [ ] **Step 6: 跑 → 全绿**

```bash
pnpm test -- in-memory-session-repository pg-session-repository
```
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sessions apps/server/test/helpers/in-memory-session-repository.ts apps/server/test/sessions
git commit -m "feat(server): SessionRepository (PG impl + in-memory fake)"
```

---

### Task 3: 把 `sessions` 依赖接入 AppDeps / OrchestratorDeps / 装配

**Files:**
- Modify: `apps/server/src/api/app.ts:21-29`(AppDeps 加 `sessions`)
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts:28-44`(OrchestratorDeps 加 `sessions`)
- Modify: `apps/server/src/compose-orchestrator.ts`(构造并透传 `sessions`)
- Modify: `apps/server/src/api/server.ts`(用 `db` 构造 `PgSessionRepository`)
- Modify(测试同步):`apps/server/test/api/sessions-routes.test.ts`、`messages-routes.test.ts`、`uploads-routes.test.ts`、`artifacts-routes.test.ts`、`files-routes.test.ts`、`stream-routes.test.ts`、`orchestrator.test.ts`、`compose-orchestrator-integration.test.ts`(凡 `new SessionOrchestrator(...)` / 构造 `AppDeps` 处加 `sessions`)

> 本任务只做"接线",不改行为(orchestrator 暂不写库——下一任务)。目的是让 `sessions` 在两个 deps 里就位且全套测试仍绿。

- [ ] **Step 1: AppDeps 加字段**

`apps/server/src/api/app.ts` 在 import 区加:

```ts
import type { SessionRepository } from "../sessions/session-repository.js";
```
`AppDeps` 接口加一行:

```ts
  sessions: SessionRepository;
```

- [ ] **Step 2: OrchestratorDeps 加字段**

`apps/server/src/orchestrator/session-orchestrator.ts`,import 区加:

```ts
import type { SessionRepository } from "../sessions/session-repository.js";
```
`OrchestratorDeps` 接口加一行:

```ts
  sessions: SessionRepository;
```

- [ ] **Step 3: composeOrchestrator 透传**

`apps/server/src/compose-orchestrator.ts`:`ComposeOrchestratorOptions`(约 27 行)加必填 `sessions: SessionRepository`(import 同上),在 `new SessionOrchestrator({...})`(约 192 行)的对象里加 `sessions: opts.sessions`。**`ComposedOrchestrator` 返回类型(约 90 行)无需加 `sessions`**——server.ts 自己持有该实例并直接传给 createApp(见 Step 4)。

- [ ] **Step 4: server.ts 装配真实仓库**

`apps/server/src/api/server.ts`:在 `const { db, pool } = createDb(...)`、`await runMigrations(db)` 之后构造仓库:

```ts
import { PgSessionRepository } from "../sessions/pg-session-repository.js";
// ...
const sessions = new PgSessionRepository(db);
```
把 `sessions` 传入 `composeOrchestrator({ ... , sessions })`,并在 `createApp({ ...composed, eventLog, auth: betterAuthService(auth), sessions }, ...)` 显式带上 `sessions`(`composed` 不含 `sessions`,这里直接用本地变量)。

- [ ] **Step 5: 同步所有测试构造点(加 `sessions`)**

- `orchestrator.test.ts`:`buildOrchestrator()` 内 `new InMemorySessionRepository()` 并加进 deps;返回对象带上 `sessions`,供 Task 4 复用。import:
  ```ts
  import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
  ```
  改 `buildOrchestrator`:
  ```ts
  function buildOrchestrator() {
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const phases = new PhaseRegistry();
    const intentRouter = new RuleBasedIntentRouter();
    const sessions = new InMemorySessionRepository();
    const handlers = buildHandlers() as Map<import("@ultracreator/shared").PhaseId, PhaseHandler>;
    const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions });
    return { orch, workspaces, events, artifacts, phases, sessions };
  }
  ```
  其余 3 处内联 `new SessionOrchestrator({...})`(约 543、580、623 行)各加 `sessions: new InMemorySessionRepository()`(注意:543 与 580 是模拟"重启"的两个进程,需共享**同一个** `sessions` 实例——见 Task 4 详述;本任务先各自给独立实例让其编译通过,Task 4 再改为共享)。
- 各 route 测试(`sessions-routes`/`messages-routes`/`uploads-routes`/`artifacts-routes`/`files-routes`/`stream-routes`):`beforeEach` 里建 `const sessions = new InMemorySessionRepository();`,加入 `deps = { ..., sessions }`;import fake。
- `compose-orchestrator-integration.test.ts`:`composeOrchestrator({...})` 调用加 `sessions: new InMemorySessionRepository()`。

- [ ] **Step 6: typecheck + 全量测试**

```bash
pnpm typecheck && pnpm test
```
Expected: 全绿(纯接线,无行为变化)。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(server): thread SessionRepository through app + orchestrator deps"
```

---

### Task 4: orchestrator 状态落库 + 从 `creator_sessions` 恢复

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Test: `apps/server/test/orchestrator.test.ts`(改写 `state recovery after restart` describe)

- [ ] **Step 1: 写失败测试——改写"重启恢复"用例为基于仓库**

把 `apps/server/test/orchestrator.test.ts` 的 `describe("SessionOrchestrator: state recovery after restart", ...)`(约 481–592 行)整体替换为下面版本(不再写 `events.jsonl`,改为 seed/共享 `SessionRepository`)。删除该文件顶部已不再需要的 `writeFileSync` import(若其它用例仍用则保留)。

```ts
describe("SessionOrchestrator: state recovery after restart", () => {
  it("rehydrates awaiting-gate from the repository so /approve resumes", async () => {
    const { orch, workspaces, artifacts, events, sessions } = buildOrchestrator();
    await workspaces.init("s1");
    await sessions.create({ id: "s1", userId: "u1" });

    // 上游 artifact 仍在磁盘(本阶段 ArtifactStore 不变),下一阶段才入库。
    const brief = briefFor({
      text: "x",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    await artifacts.put("s1", "brief", brief);
    await artifacts.put("s1", "design", designData);

    // 模拟上一个进程已跑到 design 审批门:状态落在仓库里。
    await sessions.updateStatus("s1", { status: "awaiting-gate", currentPhase: "design", error: null });

    // 本进程 in-memory 状态为空(刚构造),getState 触发从仓库恢复前仍是 idle。
    const seen: ServerEvent[] = [];
    events.subscribe("s1", (e) => seen.push(e));

    await orch.handleMessage("s1", { text: "/approve" });

    expect(
      seen.some((e) => e.type === "phase.started" && (e as { phase: string }).phase === "script"),
    ).toBe(true);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "script" });
  });

  it("stays idle when the repository has no record (fresh session)", async () => {
    const { orch, workspaces } = buildOrchestrator();
    await workspaces.init("s2");
    await orch.handleMessage("s2", { text: "/approve" });
    expect(orch.getState("s2")).toEqual({ kind: "idle" });
  });

  it("restores the initial message across a restart so research re-runs with it", async () => {
    const initial: UserMessage = {
      text: "Make a promo for Acme",
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    };
    // 跨"重启"共享同一个仓库(模拟 PG 持久化)。
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "s1", userId: "u1" });

    // Process 1: research 抛错,落到 error 状态(orchestrator 写库)。
    {
      const workspaces = new WorkspaceManager(root);
      const events = new EventBus();
      const artifacts = new ArtifactStore(workspaces, events);
      const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
        ["research", new FakePhaseHandler({
          phase: "research",
          produce: async () => { throw new Error("scrape failed"); },
        })],
      ]);
      const orch = new SessionOrchestrator({
        workspaces, events, artifacts,
        phases: new PhaseRegistry(),
        intentRouter: new RuleBasedIntentRouter(),
        handlers, sessions,
      });
      await orch.handleMessage("s1", initial);
      expect(orch.getState("s1")).toMatchObject({ kind: "error", phase: "research" });
    }

    // Process 2: 全新 orchestrator(空 in-memory),共享仓库 + 同一磁盘 root。
    // refine 消息必须带着原始 initialMessage 重跑 research(initialMessage 仍来自磁盘文件)。
    const received: (UserMessage | undefined)[] = [];
    const workspaces = new WorkspaceManager(root);
    const events = new EventBus();
    const artifacts = new ArtifactStore(workspaces, events);
    const handlers = new Map<import("@ultracreator/shared").PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({
        phase: "research",
        produce: async (ctx) => {
          received.push(ctx.initialMessage);
          return [{ kind: "brief", data: briefFor(ctx.initialMessage!) }];
        },
      })],
      ["design", new FakePhaseHandler({
        phase: "design",
        produce: async () => [{ kind: "design", data: designData }],
      })],
    ]);
    const orch = new SessionOrchestrator({
      workspaces, events, artifacts,
      phases: new PhaseRegistry(),
      intentRouter: new RuleBasedIntentRouter(),
      handlers, sessions,
    });

    await orch.handleMessage("s1", { text: "retry that please" });

    expect(received).toEqual([initial]);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });
});
```

确保该测试文件顶部有 `import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";`(Task 3 已加)。

- [ ] **Step 2: 跑测试看它失败**

```bash
pnpm test -- orchestrator
```
Expected: 新的 recovery 用例 FAIL(orchestrator 还没写库,也没从库恢复:`/approve` 在 idle 上是 no-op,getState 仍 idle)。

- [ ] **Step 3: 实现——状态写库 + 从库恢复**

在 `apps/server/src/orchestrator/session-orchestrator.ts`:

(a) 加一个集中式的状态写入器,并把所有 `this.states.set(sessionId, X)` 替换为 `await this.setState(sessionId, X)`。新增私有方法:

```ts
  /**
   * Set in-memory state AND mirror it to the durable creator_sessions row.
   * The row is the source of truth for recovery after a restart; updateStatus
   * is a no-op if the row was never created (e.g. orchestrator-only tests).
   */
  private async setState(sessionId: string, state: SessionState): Promise<void> {
    this.states.set(sessionId, state);
    await this.deps.sessions.updateStatus(sessionId, serializeStatus(state));
  }
```

在文件内(类外)加映射函数:

```ts
import type { SessionStatus, SessionStatusUpdate } from "../sessions/session-repository.js";

function serializeStatus(state: SessionState): SessionStatusUpdate {
  switch (state.kind) {
    case "idle":
      return { status: "idle", currentPhase: null, error: null };
    case "running":
      return { status: "running", currentPhase: state.phase, error: null };
    case "awaiting-gate":
      return { status: "awaiting-gate", currentPhase: state.phase, error: null };
    case "error":
      return { status: "error", currentPhase: state.phase, error: state.error };
    case "done":
      return { status: "done", currentPhase: state.lastPhase, error: null };
  }
}

function deserializeStatus(row: {
  status: SessionStatus;
  currentPhase: import("@ultracreator/shared").PhaseId | null;
  error: string | null;
}): SessionState | null {
  switch (row.status) {
    case "idle":
      return null; // getState 默认即 idle,无需占用 map
    case "running":
      return row.currentPhase ? { kind: "running", phase: row.currentPhase } : null;
    case "awaiting-gate":
      return row.currentPhase ? { kind: "awaiting-gate", phase: row.currentPhase } : null;
    case "error":
      return row.currentPhase ? { kind: "error", phase: row.currentPhase, error: row.error ?? "" } : null;
    case "done":
      return { kind: "done", lastPhase: row.currentPhase ?? "render" };
  }
}
```

把这些 `this.states.set(...)` 调用点改为 `await this.setState(...)`(均在 async 方法内,可直接 await):`runFromPhase` 里 2 处(abort error、done)、`approve` 里 1 处(done)、`runPhase` 里 3 处(running、error、awaiting-gate)。注意 `runFromPhase` 中读取 `this.getState(sessionId)` 的逻辑不变。

(b) 重写 `rehydrateState` 从仓库恢复(替换原来读 `events.jsonl` 的整段),`initial-message.json` 读取保留:

```ts
  private async rehydrateState(sessionId: string): Promise<void> {
    if (this.states.has(sessionId) || this.rehydrated.has(sessionId)) return;
    this.rehydrated.add(sessionId);
    const row = await this.deps.sessions.get(sessionId);
    if (row) {
      const recovered = deserializeStatus(row);
      if (recovered) this.states.set(sessionId, recovered);
    }
    // initialMessage 仍来自磁盘文件(本阶段不迁库)。
    if (!this.initialMessages.has(sessionId)) {
      const msgPath = join(this.deps.workspaces.paths(sessionId).root, INITIAL_MESSAGE_FILE);
      try {
        const message = UserMessageSchema.parse(JSON.parse(await readFile(msgPath, "utf8")));
        this.initialMessages.set(sessionId, message);
      } catch {
        // Missing or corrupt — research re-run degrades as before.
      }
    }
  }
```

删除原 `rehydrateState` 里对 `logPath`/`existsSync`/逐行解析 `events.jsonl` 的代码;若 `existsSync`/`ServerEvent` import 在文件内已无其它用处则一并清掉(typecheck 会提示未用)。

- [ ] **Step 4: 跑测试**

```bash
pnpm test -- orchestrator
```
Expected: 全绿(recovery 用例通过;其余 getState 断言不受影响——in-memory 仍是主缓存)。

- [ ] **Step 5: 全量回归(确认没踩到别处)**

```bash
pnpm test
```
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/orchestrator/session-orchestrator.ts apps/server/test/orchestrator.test.ts
git commit -m "feat(server): persist session status to creator_sessions; recover from it on restart"
```

---

### Task 5: 首条消息在服务端定标题

**Files:**
- Create: `apps/server/src/sessions/derive-title.ts`
- Modify: `apps/server/src/api/messages-routes.ts`
- Test: `apps/server/test/sessions/derive-title.test.ts`
- Test: `apps/server/test/api/messages-routes.test.ts`(加标题落库断言)

- [ ] **Step 1: 标题派生 helper + 失败测试**

`apps/server/test/sessions/derive-title.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveTitle } from "../../src/sessions/derive-title.js";

describe("deriveTitle", () => {
  it("takes the first non-empty line, trimmed", () => {
    expect(deriveTitle("  Make a promo for Acme  ")).toBe("Make a promo for Acme");
  });
  it("uses only the first line", () => {
    expect(deriveTitle("Launch teaser\n\nProduct page: https://acme.dev")).toBe("Launch teaser");
  });
  it("truncates to 80 chars", () => {
    expect(deriveTitle("x".repeat(200))).toHaveLength(80);
  });
  it("falls back to Untitled for blank input", () => {
    expect(deriveTitle("   \n  ")).toBe("Untitled");
  });
});
```

`apps/server/src/sessions/derive-title.ts`:

```ts
const MAX_TITLE = 80;

/** Session title from the first user message: first non-empty line, trimmed & capped. */
export function deriveTitle(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const title = firstLine.slice(0, MAX_TITLE);
  return title.length > 0 ? title : "Untitled";
}
```

- [ ] **Step 2: 跑 → 通过**

```bash
pnpm test -- derive-title
```

- [ ] **Step 3: 在 messages 路由落标题(失败测试先行)**

在 `apps/server/test/api/messages-routes.test.ts` 加用例(沿用该文件已有 deps/`app` 构造方式;`POST /api/sessions` 会创建归属于 TEST_USER 的行):

```ts
  it("sets the session title from the first message text", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { text: "Launch teaser\n\nmore detail" },
      headers: { "content-type": "application/json" },
    });
    expect((await deps.sessions.get(sessionId))?.title).toBe("Launch teaser");
  });

  it("does not overwrite the title on later messages", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const send = (text: string) => app.inject({
      method: "POST", url: `/api/sessions/${sessionId}/messages`,
      payload: { text }, headers: { "content-type": "application/json" },
    });
    await send("First title");
    await send("second message");
    expect((await deps.sessions.get(sessionId))?.title).toBe("First title");
  });
```

> 注:`messages-routes.test.ts` 在 Task 3 已把 `sessions` 放进 `deps`,且 `POST /api/sessions` 会在 Task 6 起创建归属行。**本任务依赖 Task 6 的 POST 建行**——故 Task 6 排在前更顺;若按编号顺序执行,在本任务的 `beforeEach` 里改用 `await deps.sessions.create({ id, userId: TEST_USER.id })` + `await deps.workspaces.init(id)` 显式建会话,再 POST 消息(避免顺序耦合)。实现 subagent 按"当前 POST 是否已建行"二选一,保证测试自洽。

`apps/server/src/api/messages-routes.ts` 改为(在校验消息后、派发前落标题):

```ts
import type { FastifyInstance } from "fastify";
import { UserMessageSchema } from "@ultracreator/shared";
import type { AppDeps } from "./app.js";
import { requireOwnedSession } from "./route-helpers.js";
import { deriveTitle } from "../sessions/derive-title.js";

export async function registerMessagesRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post<{ Params: { sid: string } }>(
    "/api/sessions/:sid/messages",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const message = UserMessageSchema.parse(req.body);
      await deps.sessions.setTitleIfEmpty(sid, deriveTitle(message.text));
      void deps.orchestrator.handleMessage(sid, message).catch((err) => {
        app.log.error({ err, sid }, "orchestrator.handleMessage rejected");
      });
      reply.code(202).send({ accepted: true });
    },
  );
}
```

> `requireOwnedSession` 在 Task 6 定义。若本任务先于 Task 6 执行,临时保留旧 `requireSession(req, reply, deps.workspaces)` 调用,Task 6/7 再统一切换。**推荐先做 Task 6 再做本任务**(见下方"任务顺序建议")。

- [ ] **Step 4: 跑测试**

```bash
pnpm test -- messages-routes derive-title
```
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sessions/derive-title.ts apps/server/src/api/messages-routes.ts apps/server/test/sessions/derive-title.test.ts apps/server/test/api/messages-routes.test.ts
git commit -m "feat(server): derive session title from first message, persist server-side"
```

> **任务顺序建议:** Task 6(归属 helper + POST 建行)实际上是 Task 5、Task 7 的前置(都依赖 `requireOwnedSession` 和 POST 创建的归属行)。**执行顺序建议:Task 1 → 2 → 3 → 4 → 6 → 5 → 7 → 8 → 9 → 10。** 计划编号保留逻辑分组,执行时按此依赖顺序。

---

### Task 6: 归属校验 helper + `sessions-routes`(POST 建行 / DELETE 守卫 / GET 归属)

**Files:**
- Modify: `apps/server/src/api/route-helpers.ts`(新增 `requireOwnedSession`,保留旧 `requireSession` 至 Task 7 迁完)
- Modify: `apps/server/src/api/sessions-routes.ts`
- Test: `apps/server/test/api/route-helpers.test.ts`(新建)
- Test: `apps/server/test/api/sessions-routes.test.ts`(归属用例)

- [ ] **Step 1: 写 `requireOwnedSession` + 单测**

`apps/server/test/api/route-helpers.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireOwnedSession } from "../../src/api/route-helpers.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";

function fakeReply() {
  const reply = { statusCode: 0, body: undefined as unknown };
  return {
    code(c: number) { reply.statusCode = c; return this; },
    send(b: unknown) { reply.body = b; return this; },
    _state: reply,
  } as unknown as FastifyReply & { _state: { statusCode: number; body: unknown } };
}

function reqFor(sid: string, userId: string | undefined) {
  return { params: { sid }, authUser: userId ? { id: userId, email: "e", name: "n", image: null } : undefined } as unknown as FastifyRequest<{ Params: { sid: string } }>;
}

describe("requireOwnedSession", () => {
  it("returns the sid when the caller owns the session", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "11111111-1111-4111-8111-111111111111", userId: "u1" });
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor("11111111-1111-4111-8111-111111111111", "u1"), reply, sessions);
    expect(sid).toBe("11111111-1111-4111-8111-111111111111");
    expect(reply._state.statusCode).toBe(0);
  });

  it("400 on a malformed id", async () => {
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor("has..slash", "u1"), reply, new InMemorySessionRepository());
    expect(sid).toBeNull();
    expect(reply._state.statusCode).toBe(400);
  });

  it("404 when the session does not exist", async () => {
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor("22222222-2222-4222-8222-222222222222", "u1"), reply, new InMemorySessionRepository());
    expect(sid).toBeNull();
    expect(reply._state.statusCode).toBe(404);
  });

  it("404 (not 403) when another user owns the session", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: "33333333-3333-4333-8333-333333333333", userId: "owner" });
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor("33333333-3333-4333-8333-333333333333", "intruder"), reply, sessions);
    expect(sid).toBeNull();
    expect(reply._state.statusCode).toBe(404);
  });
});
```

`apps/server/src/api/route-helpers.ts` 追加(保留现有 `requireSession`):

```ts
import type { SessionRepository } from "../sessions/session-repository.js";

/**
 * Validate `:sid`, then assert the authenticated caller owns the session.
 * 400 on malformed id; 404 when the row is absent OR owned by someone else
 * (404 not 403 — don't leak whether a session exists). Returns the sid, or
 * null after replying (caller must `return`). `req.authUser` is set by the
 * session guard for all /api/sessions* routes.
 */
export async function requireOwnedSession(
  req: FastifyRequest<{ Params: { sid: string } }>,
  reply: FastifyReply,
  sessions: SessionRepository,
): Promise<string | null> {
  const sid = req.params.sid;
  if (!isValidSessionId(sid)) {
    reply.code(400).send({ error: "invalid session id" });
    return null;
  }
  const row = await sessions.get(sid);
  if (!row || row.userId !== req.authUser?.id) {
    reply.code(404).send({ error: "session not found" });
    return null;
  }
  return sid;
}
```

- [ ] **Step 2: 跑 → 通过**

```bash
pnpm test -- route-helpers
```

- [ ] **Step 3: 改 sessions-routes(失败测试先行)**

在 `apps/server/test/api/sessions-routes.test.ts` 调整/追加:

```ts
  it("POST /api/sessions persists an owned creator_sessions row", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const row = await deps.sessions.get(sessionId);
    expect(row).toMatchObject({ id: sessionId, userId: "u-test", status: "idle", title: null });
  });

  it("GET /api/sessions/:sid is 404 for a session owned by another user", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
  });

  it("DELETE /api/sessions/:sid is 404 for a non-owner and leaves the session intact", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "intruder", email: "i@x.com", name: "I", image: null }) });
    const res = await otherApp.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(404);
    await otherApp.close();
    expect(await deps.sessions.get(sessionId)).not.toBeNull();
  });

  it("DELETE /api/sessions/:sid removes the row, workspace, and event log for the owner", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    const res = await app.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(res.statusCode).toBe(204);
    expect(existsSync(join(root, sessionId))).toBe(false);
    expect(await deps.sessions.get(sessionId)).toBeNull();
  });
```

注意:原有 `GET /api/sessions/:sid returns 404 for an unknown session`、`returns 400 for an invalid id`、`returns state=idle and empty artifacts` 用例保留;后者现在 POST 会建行,GET 归属校验通过(TEST_USER 即 owner),返回体新增 `title`(见 Task 8)——本任务 GET 仍只返回 `{state, artifacts}`,`title` 在 Task 8 加。原 `DELETE ... is 404 if the session does not exist` 保留(查不到行 → 404)。原"does not tear down other sessions' event logs"用例:其使用的 `a`、`b` 均由 POST 创建(归属 TEST_USER),保持可用。

`apps/server/src/api/sessions-routes.ts` 改为:

```ts
import { rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "./app.js";
import { newSessionId } from "./session-id.js";
import { requireOwnedSession } from "./route-helpers.js";

export async function registerSessionsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post("/api/sessions", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) { reply.code(401).send({ error: "unauthorized" }); return; } // 守卫已保证,双保险
    const sessionId = newSessionId();
    await deps.sessions.create({ id: sessionId, userId });
    await deps.workspaces.init(sessionId);
    await deps.eventLog.attach(sessionId);
    reply.code(201).send({ sessionId });
  });

  app.get<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const state = deps.orchestrator.getState(sid);
      const artifacts = await deps.artifacts.list(sid);
      reply.send({ state, artifacts });
    },
  );

  app.delete<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      // 先关日志写者释放 fd,再删 workspace,最后删归属行。
      await deps.eventLog.close(sid);
      await rm(deps.workspaces.paths(sid).root, { recursive: true, force: true });
      await deps.sessions.delete(sid);
      reply.code(204).send();
    },
  );
}
```

> 移除了对 `existsSync`/`isValidSessionId` 的直接使用(归属 helper 内已校验 id);若 import 变为未用,typecheck 会提示,删掉即可。

- [ ] **Step 4: 跑测试**

```bash
pnpm test -- sessions-routes route-helpers
```
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api/route-helpers.ts apps/server/src/api/sessions-routes.ts apps/server/test/api/route-helpers.test.ts apps/server/test/api/sessions-routes.test.ts
git commit -m "feat(server): per-user session ownership (POST creates owned row, GET/DELETE 404 on non-owner)"
```

---

### Task 7: 把归属校验铺到其余会话子路由

**Files:**
- Modify: `apps/server/src/api/messages-routes.ts`(若 Task 5 已切换则确认)、`uploads-routes.ts`、`artifacts-routes.ts`、`files-routes.ts`、`stream-routes.ts`
- Modify: `apps/server/src/api/route-helpers.ts`(删除已无引用的旧 `requireSession`)
- Test: 对应各 route 测试

- [ ] **Step 1: 逐路由把 `requireSession(req, reply, deps.workspaces)` 换成 `await requireOwnedSession(req, reply, deps.sessions)`**

每个文件的 handler 改成 `const sid = await requireOwnedSession(req, reply, deps.sessions); if (!sid) return;`(注意加 `await`,handler 已是 async)。涉及:
- `uploads-routes.ts`
- `artifacts-routes.ts`(两个 handler:list 与 `:kind`)
- `files-routes.ts`
- `stream-routes.ts`(`requireSession` 在 hijack 之前调用,改 await 即可)
- `messages-routes.ts`(Task 5 已切;此处确认)

- [ ] **Step 2: 各 route 测试 seed 归属行**

这些测试此前用 `POST /api/sessions` 或直接 `workspaces.init(sid)` 准备会话。统一改为:**用 `POST /api/sessions` 拿 sid**(它现在会建归属行),或在 `beforeEach`/用例里 `await deps.sessions.create({ id, userId: TEST_USER.id })` + `await deps.workspaces.init(id)`。逐文件检查:
- `uploads-routes.test.ts`:上传前确保会话由 POST 创建或显式 `sessions.create`+`workspaces.init`。
- `artifacts-routes.test.ts`:同理;artifact 仍由 `deps.artifacts.put` 写磁盘(本阶段不变),会话行需存在。
- `files-routes.test.ts`:文件落在 `workspaces.paths(sid)` 下,需 `workspaces.init` + `sessions.create`。
- `stream-routes.test.ts`:SSE 测试需要会话行存在;`sessions.create`+`workspaces.init`+`eventLog.attach`。
- 每个文件加 1 条越权用例:用 `fakeAuthService({ id: "intruder", ... })` 新建 app,访问他人 sid → 期望 404。

- [ ] **Step 3: 删除旧 `requireSession`**

确认 `apps/server/src` 内不再有 `requireSession(` 引用(`grep -rn "requireSession" apps/server/src`),删除 `route-helpers.ts` 里的旧函数及其不再需要的 `existsSync`/`WorkspaceManager` import。

- [ ] **Step 4: 全量回归**

```bash
pnpm typecheck && pnpm test
```
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api apps/server/test/api
git commit -m "feat(server): enforce session ownership on all session sub-routes"
```

---

### Task 8: `GET /api/sessions` 列表端点 + `GET /:sid` 返回 title + 共享 schema

**Files:**
- Create: `packages/shared/src/session.ts`(`SessionSummary` schema/type)
- Modify: `packages/shared/src/index.ts`(导出)
- Modify: `apps/server/src/api/sessions-routes.ts`(新增 GET 列表;GET `/:sid` 返回体加 `title`)
- Test: `apps/server/test/api/sessions-routes.test.ts`

- [ ] **Step 1: 共享 `SessionSummary` schema**

`packages/shared/src/session.ts`:

```ts
import { z } from "zod";
import { PhaseIdSchema } from "./events.js";

export const SESSION_STATUSES = ["idle", "running", "awaiting-gate", "error", "done"] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Sidebar/list row for one of the current user's sessions. */
export const SessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  status: SessionStatusSchema,
  currentPhase: PhaseIdSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
```

> **已确认:`packages/shared/src/events.ts` 第 4 行的 `PhaseIdSchema` 是 `const`,未导出。** 本步骤必须先把它改成 `export const PhaseIdSchema = ...`,否则 `session.ts` 的 import 会失败。`PhaseId` 类型已导出,无需改。

`packages/shared/src/index.ts` 加:

```ts
export * from "./session.js";
```

- [ ] **Step 2: 失败测试(列表 + 归属隔离 + title 字段)**

在 `apps/server/test/api/sessions-routes.test.ts` 追加:

```ts
  it("GET /api/sessions lists only the caller's sessions, newest first", async () => {
    const a = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
    const b = ((await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string }).sessionId;
    // 另一个用户的会话不应出现在 TEST_USER 的列表里。
    const otherApp = await createApp({ ...deps, auth: fakeAuthService({ id: "other", email: "o@x.com", name: "O", image: null }) });
    await otherApp.inject({ method: "POST", url: "/api/sessions" });
    await otherApp.close();

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string }[];
    expect(list.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(list.every((s) => "title" in s && "status" in s && "updatedAt" in s)).toBe(true);
  });

  it("GET /api/sessions/:sid includes the session title", async () => {
    const { sessionId } = (await app.inject({ method: "POST", url: "/api/sessions" })).json() as { sessionId: string };
    await deps.sessions.setTitleIfEmpty(sessionId, "My Title");
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect((res.json() as { title: string | null }).title).toBe("My Title");
  });

  it("GET /api/sessions is 401 when logged out", async () => {
    const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
    const res = await unauthApp.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(401);
    await unauthApp.close();
  });
```

- [ ] **Step 3: 实现**

`apps/server/src/api/sessions-routes.ts`:加列表路由,并给 `GET /:sid` 返回体加 `title`。

列表 handler(放在 POST 之后、`GET /:sid` 之前;注意 Fastify 中 `/api/sessions` 与 `/api/sessions/:sid` 不冲突):

```ts
  app.get("/api/sessions", async (req, reply) => {
    const userId = req.authUser?.id;
    if (!userId) { reply.code(401).send({ error: "unauthorized" }); return; }
    const rows = await deps.sessions.listByUser(userId);
    const summaries = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      currentPhase: r.currentPhase,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
    reply.send(summaries);
  });
```

`GET /:sid` 返回体补 `title`(从仓库行取,`requireOwnedSession` 已确认行存在,这里再查一次拿 title;或让 `requireOwnedSession` 返回 record——为最小改动,这里直接 `await deps.sessions.get(sid)`):

```ts
  app.get<{ Params: { sid: string } }>(
    "/api/sessions/:sid",
    async (req, reply) => {
      const sid = await requireOwnedSession(req, reply, deps.sessions);
      if (!sid) return;
      const state = deps.orchestrator.getState(sid);
      const artifacts = await deps.artifacts.list(sid);
      const row = await deps.sessions.get(sid);
      reply.send({ state, artifacts, title: row?.title ?? null });
    },
  );
```

> 守卫 `createSessionGuard` 已覆盖精确匹配 `/api/sessions` 与前缀 `/api/sessions/`,故 `GET /api/sessions` 登出时返回 401(测试已覆盖)。

- [ ] **Step 4: 跑测试**

```bash
pnpm test -- sessions-routes
pnpm test -- import-shared   # 确认 shared 新增导出可被 import(若该测试存在)
```
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/session.ts packages/shared/src/index.ts apps/server/src/api/sessions-routes.ts apps/server/test/api/sessions-routes.test.ts
git commit -m "feat(server+shared): GET /api/sessions list + title in GET /:sid"
```

---

### Task 9: 前端会话列表改走 API + 移除 localStorage 列表

**Files:**
- Modify: `apps/web/src/lib/api-types.ts`(加 `SessionSummary` re-export + `GetSessionResponse.title`)
- Modify: `apps/web/src/lib/api-client.ts`(加 `listSessions`)
- Create: `apps/web/src/state/use-sessions.ts`(React Query hook)
- Modify: `apps/web/src/components/app-sidebar.tsx`(列表改 `useSessions`,删除本删除后 invalidate)
- Modify: `apps/web/src/components/session-page.tsx`(`ChatHeader` 标题改从 `GET /:sid` 的 `title`)
- Modify: `apps/web/src/components/home-composer.tsx`(创建会话后 invalidate `["sessions"]`,删除 `addLocalSession`)
- Modify: `apps/web/src/lib/session-store.ts`(删除会话列表函数;保留无关项——见下)
- Test: `apps/web/test/components/app-sidebar.test.tsx`、`home-composer.test.tsx`、`session-page.test.tsx`、`lib/session-store.test.ts`

- [ ] **Step 1: 前端类型**

`apps/web/src/lib/api-types.ts`:
- 从 shared re-export `SessionSummary`:在底部 `export type { ... }` 里加 `SessionSummary`,并在顶部 import 里加 `SessionSummary`(来自 `@ultracreator/shared`)。
- `GetSessionResponse` 加 `title`:

```ts
export interface GetSessionResponse {
  state: SessionState;
  artifacts: ArtifactDescriptor[];
  title: string | null;
}
```

- [ ] **Step 2: api-client 加 `listSessions`(失败测试先行)**

`apps/web/test/lib/api-client.test.ts` 加(沿用该文件 mockFetch 模式):

```ts
  it("listSessions GETs /api/sessions and returns the array", async () => {
    mockFetch(async (url, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(url).toBe("http://127.0.0.1:3001/api/sessions");
      return new Response(JSON.stringify([{ id: "a", title: "A", status: "idle", currentPhase: null, createdAt: "t", updatedAt: "t" }]), { status: 200 });
    });
    const out = await listSessions();
    expect(out.map((s) => s.id)).toEqual(["a"]);
  });
```
(在该测试文件顶部 import 里加 `listSessions`。)

`apps/web/src/lib/api-client.ts` 加:

```ts
import type { SessionSummary } from "./api-types.js";
// ...
export async function listSessions(): Promise<SessionSummary[]> {
  return (await jsonFetch<SessionSummary[]>(`${apiBase()}/api/sessions`)) ?? [];
}
```
并把 `SessionSummary` 加进顶部已有的 `api-types` import 列表(与 `CreateSessionResponse` 等同源)。底部 `export type { SequencedEvent };` 旁可加 `export type { SessionSummary };`(可选)。

- [ ] **Step 3: `useSessions` hook**

`apps/web/src/state/use-sessions.ts`:

```ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { listSessions } from "@/lib/api-client";

export function useSessions() {
  return useQuery({ queryKey: ["sessions"], queryFn: listSessions });
}
```

- [ ] **Step 4: 改 `app-sidebar.tsx`(失败测试先行)**

重写 `apps/web/test/components/app-sidebar.test.tsx` 为基于 API mock(不再用 `addLocalSession`/`listLocalSessions`):

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: vi.fn() },
  useSession: () => ({ data: null, isPending: false }),
}));
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: pushMock, refresh: () => {} }),
  usePathname: () => "/",
}));

function render() {
  return renderWithQuery(
    <SidebarProvider><AppSidebar /></SidebarProvider>,
  );
}
const summary = (id: string, title: string) => ({ id, title, status: "idle", currentPhase: null, createdAt: "t", updatedAt: "t" });

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  pushMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("<AppSidebar>", () => {
  it("shows an empty hint when the API returns no sessions", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    render();
    expect(await screen.findByText(/no tasks yet/i)).toBeInTheDocument();
  });

  it("lists sessions from the API", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions")) return new Response(JSON.stringify([summary("a", "Alpha"), summary("b", "Beta")]), { status: 200 });
      return new Response("", { status: 404 });
    });
    render();
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("'New project' routes to Home", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    const user = userEvent.setup();
    render();
    await user.click(screen.getByRole("button", { name: /new project/i }));
    expect(pushMock).toHaveBeenCalledWith("/");
  });

  it("deleting a task DELETEs and refetches the list", async () => {
    let deleted = false;
    const spy = mockFetch(async (url, init) => {
      if (url.endsWith("/api/sessions/a") && init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      if (url.endsWith("/api/sessions")) return new Response(JSON.stringify(deleted ? [] : [summary("a", "Alpha")]), { status: 200 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole("button", { name: /delete alpha/i }));
    await waitFor(() => expect(spy.mock.calls.some(([u, i]) => String(u).endsWith("/api/sessions/a") && (i as RequestInit)?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Alpha")).not.toBeInTheDocument());
  });
});
```

`apps/web/src/components/app-sidebar.tsx` 改动:
- 删除 `useState/useEffect` + `listLocalSessions/removeLocalSession` + `SidebarSession` import。
- 用 hook:
  ```ts
  import { useQueryClient } from "@tanstack/react-query";
  import { useSessions } from "@/state/use-sessions";
  import { deleteSession } from "@/lib/api-client";
  import type { SessionSummary } from "@/lib/api-types";
  // ...
  const qc = useQueryClient();
  const { data: sessions = [] } = useSessions();
  ```
- `handleDelete` 改为:
  ```ts
  async function handleDelete(s: SessionSummary) {
    try { await deleteSession(s.id); } catch { /* may already be gone */ }
    await qc.invalidateQueries({ queryKey: ["sessions"] });
    if (s.id === activeSid) router.push("/");
  }
  ```
- 列表渲染:`sessions.map((s) => ...)`,显示 `s.title ?? "Untitled"`(标题可空);`title={s.title ?? "Untitled"}`,`aria-label={`delete ${s.title ?? "Untitled"}`}`。其余 JSX 不变。

- [ ] **Step 5: 改 `session-page.tsx` 的 `ChatHeader` 标题来源**

`apps/web/test/components/session-page.test.tsx`:把依赖 `listLocalSessions` 的标题断言改为依赖 `GET /:sid` 返回的 `title`(该测试已 mock session 请求;给 mock 的 `GetSessionResponse` 加 `title` 字段并断言渲染)。具体改动随该测试现有 mock 结构而定。

`apps/web/src/components/session-page.tsx`:`ChatHeader` 删除 `useEffect + listLocalSessions().find`,改用 session 查询的 `title`。最小改法:让 `ChatHeader` 接收 `title` prop(由父组件从 `useSession().session.data?.title` 传入),fallback `"Untitled"`:
```tsx
function ChatHeader({ title, state }: { title: string | null; state: { kind: string; phase?: string } }) {
  return (
    <header className="flex items-center gap-2 px-4 py-3">
      <span className="truncate text-sm font-medium" title={title ?? "Untitled"}>{title ?? "Untitled"}</span>
      <StatusPill state={state} />
    </header>
  );
}
```
父组件传 `title={session.data?.title ?? null}`(`session` 来自 `useSession(sid)` 的 query;其 `getSession` 返回的 `GetSessionResponse` 现含 `title`)。删除 `session-page.tsx` 里对 `@/lib/session-store` 的 import。

- [ ] **Step 6: 改 `home-composer.tsx`(创建后 invalidate,移除 localStorage)**

`apps/web/test/components/home-composer.test.tsx`:把 `listLocalSessions().some(...)` 断言删掉,改为断言创建会话后触发了 `["sessions"]` 失效——简单做法:断言 `pushMock` 跳转 + 不再断言 localStorage(invalidate 难以直接观测,可省该断言或用 spy 包 `qc.invalidateQueries`)。保留"创建+发消息+跳转"主用例。删除 `import { listLocalSessions }`。

`apps/web/src/components/home-composer.tsx`:
- 删除 `import { addLocalSession }` 与第 96 行 `addLocalSession(...)`。
- 加 `const qc = useQueryClient();`(import `useQueryClient`),在 `router.push(`/s/${sessionId}`)` 之前 `void qc.invalidateQueries({ queryKey: ["sessions"] });`,让侧栏列表在返回首页/打开侧栏时拿到新会话。`setPendingMessage` 保留(它是 sessionStorage 的首条消息回显,与会话列表无关)。

- [ ] **Step 7: 收缩 `session-store.ts`**

`apps/web/src/lib/session-store.ts`:删除会话**列表**相关函数(`listLocalSessions`/`addLocalSession`/`renameLocalSession`/`removeLocalSession`/`read`/`write`/`SidebarSession`/`LOCAL_KEY`)。若全文件已无其它用途,**删除该文件**并相应删除 `apps/web/test/lib/session-store.test.ts`;否则保留剩余项。`grep -rn "session-store\|SidebarSession\|listLocalSessions\|addLocalSession\|removeLocalSession" apps/web/src apps/web/test` 确认无残留引用。

- [ ] **Step 8: 全量回归**

```bash
pnpm typecheck && pnpm test
```
Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(web): session list from GET /api/sessions; remove localStorage session list"
```

---

### Task 10: 全量回归 + 手工验收

**Files:** 无(验证 + 文档)

- [ ] **Step 1: 全量自动化测试 + 类型检查**

```bash
pnpm typecheck && pnpm test
```
Expected: 全绿(含 `*.pg.test.ts` 连本地 PG)。

- [ ] **Step 2: 手工验收清单(开发者本机)**

前置:`apps/server/.env` 含 `DATABASE_URL` 与 `GEMINI_API_KEY`;两端启动(`pnpm dev:server`、`pnpm dev:web`)。

1. Google 登录用户 A,首页发起一个项目 → 侧栏出现该会话,标题=首条消息首行截断。
2. `psql ultracreator -c "select id,user_id,title,status from creator_sessions;"` → 看到该行,`user_id` 为 A,`status` 随阶段推进变化(running/awaiting-gate/...)。
3. 关闭浏览器、换一个浏览器(或隐身窗)再登录 A → 侧栏仍能看到该会话(列表来自 PG,非 localStorage)。
4. 退出 A、登录用户 B → 侧栏看不到 A 的会话;直接访问 `/s/<A 的 sid>` → 被守卫处理(API 返回 404,页面回退/空态)。
5. 删除一个会话 → 侧栏移除;`creator_sessions` 对应行消失;workspace 目录删除。
6. 任务运行中刷新页面 → SSE 重连,输出继续(事件日志仍走磁盘,本阶段未改 SSE)。
7. DevTools → Application → Local Storage:确认不再有 `uc.sessions.v1` 写入。

- [ ] **Step 3: 标记完成 + 阶段②b 预告**

向用户汇报:阶段②a 完成并通过验收;阶段②b(events/artifacts 迁 PG)待用户确认后开始。

- [ ] **Step 4: Commit(若有文档/清理变更)**

```bash
git add -A && git commit -m "chore: phase 2a regression + acceptance notes"
```

---

## 自检(写完计划后对照 spec)

- **Spec 覆盖(阶段② 中归属/列表部分):** `creator_sessions`(Task 1)、归属隔离 404(Task 6/7)、会话列表按用户(Task 8)、移除 localStorage(Task 9)、状态落库 + 重启恢复(Task 4)、标题落库(Task 5)。`session_events`/`artifacts` 入 PG 明确划入阶段②b(计划顶部已声明)。
- **占位符扫描:** 无 TBD;每个代码步骤都给了完整代码或精确改法。少数"随现有 mock 结构而定"的测试改写(Task 9 Step 5/6)给了目标与最小改法,因这两测试的现状未逐行展开——实现 subagent 先 `Read` 该测试再改。
- **类型一致性:** `SessionRepository`/`SessionRecord`/`SessionStatusUpdate`(Task 2)在 orchestrator(Task 4 `serializeStatus`/`deserializeStatus`)、路由(Task 6/8)、shared `SessionSummary`(Task 8)、web 类型(Task 9)间字段名一致(`id/userId/title/status/currentPhase/error/createdAt/updatedAt`)。`requireOwnedSession` 签名 `(req, reply, sessions) => Promise<string|null>` 全程一致。
- **执行顺序:** 因 `requireOwnedSession` 与 POST 建行是 Task 5/7 的前置,建议执行序 1→2→3→4→6→5→7→8→9→10(计划内已注明)。
