# 阶段③ 任务持久化与自动恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户消息落库为 `session_messages` 持久化队列;服务重启时扫描未完成消息,从中断阶段自动续跑(总设计 §4,验收:任务跑一半 kill 服务再启动,自动续跑)。

**Architecture:** 沿用 2a/2b 的仓储模式 —— 新增 `MessageStore` 持久化接口(PG 实现 + 内存 fake),持久化语义(状态机推进、恢复决策)全部留在 `SessionOrchestrator`。`handleMessage` 在入队前先落一行 `pending`,队列任务体内推进 `processing → done|error`;新公开方法 `recover()` 在启动时扫描 `pending|processing` 行并重新入队 —— `processing` 行结合 `creator_sessions` 行(2a 已落库的 status/current_phase)决定从哪续跑。前端零改动(恢复的阶段照常发 `phase.started` 等事件)。

**Tech Stack:** Drizzle ORM 0.45 + node-postgres、Fastify 5、Vitest 双 project workspace(unit 并行 / pg singleFork)、TS ESM(NodeNext,相对 import 必须带 `.js` 后缀)。

---

## 背景:现状与目标差距

当前消息链路(`apps/server/src/api/messages-routes.ts` → `apps/server/src/orchestrator/session-orchestrator.ts`):

- `POST /api/sessions/:sid/messages` 校验归属后 fire-and-forget 调 `orchestrator.handleMessage(sid, message)`,回 202。
- `handleMessage`:`rehydrateState` → abort 关键字快速通道(绕过队列直接 `controller.abort()`)→ `SessionQueue.enqueue`(每会话串行 FIFO)→ intent 分类 → 分发(startNewProject / approve / refine / reviseBack / …)。
- `runFromPhase` 在**单个队列任务内**跑完整条阶段链(直到 done / awaiting-gate / error),每次状态迁移已通过 `setState` 镜像到 `creator_sessions.status/current_phase`(2a)。
- `rehydrateState` 重启后能从 `creator_sessions` 行恢复 SessionState、从 workspace 的 `initial-message.json` 恢复首条消息(2a)。
- **缺口**:消息本身不落库 —— 进程死了,正在跑/排队中的任务无影无踪。`deserializeStatus` 里有显式注释:running 行在 2a 不自动续跑,是本阶段(阶段③)范围。

## 关键设计决策(执行者必读)

1. **接口命名 `MessageStore`**(对齐 2b 的 `EventStore`;别叫 Queue —— 执行排序是内存里 `SessionQueue` 的职责,这个接口只是持久化)。状态机:`pending → processing → done | error`。表无 error 详情列(spec §2 如此;错误详情在 `creator_sessions.error`)。
2. **abort 关键字消息不落库**:它是针对在途运行的控制信号,不是工作项。若落库,重启恢复时会把一条陈旧 abort 重放到刚续跑的任务上,把它杀掉。在 `handleMessage` 的快速通道直接 return,不 insert。
3. **`processing` 行的恢复决策看 `creator_sessions` 行**,不重放 intent 分类(对已 running 的会话重放"做个视频"的分类结果不可预测):
   | 崩溃时会话状态 | 恢复动作 |
   |---|---|
   | `running` + current_phase=P | 直接 `runFromPhase(sid, P)` —— 已完成阶段的 artifact 在 PG,阶段幂等(重跑产出新版本),链条从 P 接着跑到 gate/done/error |
   | `awaiting-gate` / `done` | 这条消息的工作其实已经跑完停好了 → `markDone` |
   | `error` | 运行已失败 → `markError`(用户显式 refine/revise 重试,不自动重跑) |
   | `idle` | 死在 markProcessing 和第一次 setState 之间(如分类途中)→ 走完整分发路径重放 |
4. **`pending` 行直接重放完整分发路径**(它根本没开始跑,分类从当前状态出发是确定的)。
5. **顺序**:`listIncomplete()` 按 id 升序(=到达序),`SessionQueue` 每会话 FIFO ⇒ 恢复保持原始到达顺序;同会话先续跑中断任务、再处理排队中的 pending。
6. **消息终态由会话状态映射**:阶段失败不抛异常(`runFromPhase` 把会话停在 error 态并发 `phase.error`),所以分发结束后读 `getState`:`error` → `markError`,否则 `markDone`。已知简化:会话本就处于 error 态时,一条 ask 类 no-op 消息也会被标 error —— 无行为影响(done/error 都是终态,恢复只看 pending/processing),接受。
7. **route 不动**:202 语义保持 fire-and-forget(`handleMessage` 的返回 promise 仍代表完整管线,所有现有测试的 `await handleMessage` 语义不变)。落库发生在 enqueue 之前,正常情况下 202 即已持久化;极端的"回了 202 但 insert 还没跑完就崩"窗口接受(与现状一致,无回归)。
8. **`recover()` 在 `app.listen` 之前调用**:只是一次 SELECT + 入队(任务本体在后台跑),先恢复再开门,避免新请求与恢复入队竞争同一会话的队列顺序。
9. **PG insert 不吞 FK 错误**(不同于 PgEventStore 吞 23503):路由已先校验归属,session 行必然存在;真撞上(删除竞态)就让它抛,由路由日志兜底 —— 用户消息绝不能静默丢弃。

## File Map

| 动作 | 文件 | 职责 |
|---|---|---|
| Modify | `apps/server/src/db/schema/creator.ts` | + `sessionMessage` 表 |
| Create | `apps/server/drizzle/0003_*.sql`(生成) | migration |
| Modify | `apps/server/test/db/migrations.pg.test.ts` | + session_messages 存在/默认值/级联测试 |
| Create | `apps/server/src/messages/message-store.ts` | `MessageStore` 接口 + 记录类型 |
| Create | `apps/server/test/helpers/in-memory-message-store.ts` | 内存 fake(含测试用 `all()`/`seed()`) |
| Create | `apps/server/test/messages/in-memory-message-store.test.ts` | fake 行为测试 |
| Create | `apps/server/src/messages/pg-message-store.ts` | PG 实现 |
| Create | `apps/server/test/messages/pg-message-store.pg.test.ts` | PG 集成测试 |
| Modify | `apps/server/src/orchestrator/session-orchestrator.ts` | deps+生命周期+recover() |
| Modify | `apps/server/src/compose-orchestrator.ts` | + `messageStore` 必填项 |
| Modify | `apps/server/src/api/server.ts` | PgMessageStore 装配 + recover() 调用 |
| Modify | 8 个 `new SessionOrchestrator(` 测试文件 + 2 个 `composeOrchestrator(` 测试文件 | 注入 fake(清单见 T4) |
| Create | `apps/server/test/orchestrator-recovery.test.ts` | recover() 分支单测 |
| Create | `apps/server/test/restart-recovery.test.ts` | "重启"集成测试(双 orchestrator 实例共享持久层) |

常用命令(repo 根目录执行):

- 全量:`pnpm test`(= `vitest run --workspace ./vitest.suites.ts`;pg project 需要本地 PG,`postgres://admin@localhost:5432`)
- 单文件:`pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/<file>.test.ts`
- 类型:`pnpm typecheck`
- 生成 migration:`pnpm -C apps/server db:generate`

---

### Task 1: `session_messages` schema + migration 0003 + 迁移测试

**Files:**
- Modify: `apps/server/src/db/schema/creator.ts`
- Create: `apps/server/drizzle/0003_*.sql` + meta(由 drizzle-kit 生成)
- Modify: `apps/server/test/db/migrations.pg.test.ts`

- [ ] **Step 1: 写失败的迁移测试** —— 在 `migrations.pg.test.ts` 的 describe 末尾追加:

```ts
  it("creates session_messages with pending default and session cascade", async () => {
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
    );
    expect(tables.rows.map((r: { table_name: string }) => r.table_name)).toContain(
      "session_messages",
    );

    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('mq_owner', 'O', 'mq_owner@x.com', false, now(), now())`,
    );
    await pool.query(
      `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
       VALUES ('mq_sess', 'mq_owner', 'idle', now(), now())`,
    );
    await pool.query(
      `INSERT INTO session_messages (session_id, payload)
       VALUES ('mq_sess', '{"text":"make a video"}'::jsonb)`,
    );
    const row = await pool.query(
      `SELECT status, started_at, finished_at FROM session_messages WHERE session_id='mq_sess'`,
    );
    expect(row.rows[0]).toMatchObject({ status: "pending", started_at: null, finished_at: null });

    await pool.query(`DELETE FROM creator_sessions WHERE id='mq_sess'`);
    const after = await pool.query(
      `SELECT id FROM session_messages WHERE session_id='mq_sess'`,
    );
    expect(after.rowCount).toBe(0);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/db/migrations.pg.test.ts`
Expected: FAIL —— `session_messages` 不在表清单里。

- [ ] **Step 3: 加 schema** —— 在 `creator.ts` 末尾追加(`UserMessage` 并入文件头部既有的 `import type { ServerEvent, LineageRef } from "@ultracreator/shared"`):

```ts
// Durable message queue (spec §2/§4) — the recovery unit after a crash. One row
// per accepted user message; status advances pending → processing → done|error
// as SessionOrchestrator works through it. Startup recovery re-enqueues every
// pending|processing row. Abort keyword messages are intentionally NOT stored
// (control signal, not a work item). No error-detail column by design — the
// failure text lives on creator_sessions.error.
export const sessionMessage = pgTable(
  "session_messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => creatorSession.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<UserMessage>().notNull(),
    status: text("status").notNull().default("pending"), // pending | processing | done | error
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({
    // Startup recovery scans WHERE status IN ('pending','processing').
    statusIdx: index("session_messages_status_idx").on(t.status),
  }),
);
```

- [ ] **Step 4: 生成 migration 并人工检查**

Run: `pnpm -C apps/server db:generate`
Expected: 新增 `apps/server/drizzle/0003_<slug>.sql`。打开检查:**纯增量**(1 个 CREATE TABLE + 1 个 FK ON DELETE cascade + 1 个 index),不得出现对既有表的 ALTER/DROP。

- [ ] **Step 5: 跑迁移测试确认通过**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/db/migrations.pg.test.ts`
Expected: PASS(全部用例,含新用例)。

- [ ] **Step 6: typecheck + commit**

Run: `pnpm typecheck`
```bash
git add apps/server/src/db/schema/creator.ts apps/server/drizzle apps/server/test/db/migrations.pg.test.ts
git commit -m "feat(server): add session_messages table for durable message queue (migration 0003)"
```

### Task 2: `MessageStore` 接口 + `InMemoryMessageStore`

**Files:**
- Create: `apps/server/src/messages/message-store.ts`
- Create: `apps/server/test/helpers/in-memory-message-store.ts`
- Test: `apps/server/test/messages/in-memory-message-store.test.ts`

- [ ] **Step 1: 写接口文件**(无测试,纯类型):

```ts
// apps/server/src/messages/message-store.ts
import type { UserMessage } from "@ultracreator/shared";

export type SessionMessageStatus = "pending" | "processing" | "done" | "error";

export interface SessionMessageRecord {
  id: number;
  sessionId: string;
  payload: UserMessage;
  status: SessionMessageStatus;
  createdAt: string; // ISO
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Persistence for the durable message queue (session_messages). Raw row CRUD
 * only — the state machine (when to advance which status) lives in
 * SessionOrchestrator. The PG impl and the in-memory fake MUST behave
 * identically. mark* methods are plain UPDATEs: silent no-op on absent rows.
 */
export interface MessageStore {
  /** Insert as pending; returns the new row id. */
  insert(sessionId: string, payload: UserMessage): Promise<number>;
  /** → processing; stamps startedAt. */
  markProcessing(id: number): Promise<void>;
  /** → done; stamps finishedAt. */
  markDone(id: number): Promise<void>;
  /** → error; stamps finishedAt. */
  markError(id: number): Promise<void>;
  /** Every pending|processing row across all sessions, id ascending (= arrival order). */
  listIncomplete(): Promise<SessionMessageRecord[]>;
}
```

- [ ] **Step 2: 写 fake 的失败测试** `apps/server/test/messages/in-memory-message-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";

describe("InMemoryMessageStore", () => {
  it("insert returns increasing ids and rows start pending with null timestamps", async () => {
    const store = new InMemoryMessageStore();
    const a = await store.insert("s1", { text: "one" });
    const b = await store.insert("s1", { text: "two" });
    expect(b).toBeGreaterThan(a);
    const rows = store.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: a, sessionId: "s1", status: "pending", startedAt: null, finishedAt: null });
    expect(rows[0]!.payload).toEqual({ text: "one" });
    expect(typeof rows[0]!.createdAt).toBe("string");
  });

  it("markProcessing/markDone/markError advance status and stamp timestamps", async () => {
    const store = new InMemoryMessageStore();
    const id = await store.insert("s1", { text: "x" });
    await store.markProcessing(id);
    expect(store.all()[0]).toMatchObject({ status: "processing" });
    expect(store.all()[0]!.startedAt).not.toBeNull();
    await store.markDone(id);
    expect(store.all()[0]).toMatchObject({ status: "done" });
    expect(store.all()[0]!.finishedAt).not.toBeNull();

    const id2 = await store.insert("s1", { text: "y" });
    await store.markError(id2);
    expect(store.all()[1]).toMatchObject({ status: "error" });
    expect(store.all()[1]!.finishedAt).not.toBeNull();
  });

  it("mark* on an absent id is a silent no-op", async () => {
    const store = new InMemoryMessageStore();
    await expect(store.markProcessing(99)).resolves.toBeUndefined();
    await expect(store.markDone(99)).resolves.toBeUndefined();
    await expect(store.markError(99)).resolves.toBeUndefined();
  });

  it("listIncomplete returns pending+processing in id order and excludes done/error", async () => {
    const store = new InMemoryMessageStore();
    const a = await store.insert("s1", { text: "a" });
    const b = await store.insert("s2", { text: "b" });
    const c = await store.insert("s1", { text: "c" });
    const d = await store.insert("s1", { text: "d" });
    await store.markProcessing(b);
    await store.markDone(c);
    await store.markError(d);
    const rows = await store.listIncomplete();
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(rows.map((r) => r.status)).toEqual(["pending", "processing"]);
  });

  it("returned rows are copies — mutating them does not corrupt the store", async () => {
    const store = new InMemoryMessageStore();
    await store.insert("s1", { text: "a" });
    const rows = await store.listIncomplete();
    rows[0]!.payload.text = "EVIL";
    (rows[0] as { status: string }).status = "done";
    expect((await store.listIncomplete())[0]!.payload.text).toBe("a");
  });

  it("seed inserts a row with the given status for recovery scenarios", async () => {
    const store = new InMemoryMessageStore();
    const id = store.seed({
      sessionId: "s1",
      payload: { text: "interrupted" },
      status: "processing",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    expect((await store.listIncomplete())[0]).toMatchObject({ id, status: "processing" });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/messages/in-memory-message-store.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 4: 实现 fake** `apps/server/test/helpers/in-memory-message-store.ts`:

```ts
import type { UserMessage } from "@ultracreator/shared";
import type {
  MessageStore,
  SessionMessageRecord,
} from "../../src/messages/message-store.js";

/** In-memory MessageStore fake. Same observable behavior as PgMessageStore. */
export class InMemoryMessageStore implements MessageStore {
  private rows = new Map<number, SessionMessageRecord>();
  private nextId = 1;

  async insert(sessionId: string, payload: UserMessage): Promise<number> {
    const id = this.nextId++;
    this.rows.set(id, {
      id,
      sessionId,
      payload: structuredClone(payload),
      status: "pending",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    });
    return id;
  }

  async markProcessing(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "processing";
      row.startedAt = new Date().toISOString();
    }
  }

  async markDone(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "done";
      row.finishedAt = new Date().toISOString();
    }
  }

  async markError(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.status = "error";
      row.finishedAt = new Date().toISOString();
    }
  }

  async listIncomplete(): Promise<SessionMessageRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === "pending" || r.status === "processing")
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r, payload: structuredClone(r.payload) }));
  }

  /** Test-only accessor: every row regardless of status, id ascending. */
  all(): SessionMessageRecord[] {
    return [...this.rows.values()]
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r, payload: structuredClone(r.payload) }));
  }

  /** Test-only: seed a row in an arbitrary status (recovery scenarios). */
  seed(row: Omit<SessionMessageRecord, "id">): number {
    const id = this.nextId++;
    this.rows.set(id, { ...row, id, payload: structuredClone(row.payload) });
    return id;
  }
}
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/messages/in-memory-message-store.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/messages/message-store.ts apps/server/test/helpers/in-memory-message-store.ts apps/server/test/messages/in-memory-message-store.test.ts
git commit -m "feat(server): MessageStore interface + in-memory fake for durable message queue"
```

### Task 3: `PgMessageStore` + PG 集成测试

**Files:**
- Create: `apps/server/src/messages/pg-message-store.ts`
- Test: `apps/server/test/messages/pg-message-store.pg.test.ts`

- [ ] **Step 1: 写失败的 PG 测试**(harness 抄 `apps/server/test/sessions/pg-session-repository.pg.test.ts` 的 beforeAll/afterAll/安全检查模式):

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PgMessageStore } from "../../src/messages/pg-message-store.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
// Shares ultracreator_test with the other *.pg.test.ts files — safe because the
// "pg" vitest project runs them single-fork, one file at a time.
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const testDbName = new URL(TEST_URL).pathname.slice(1);
if (!testDbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(testDbName)) {
  throw new Error(`Refusing destructive test against "${testDbName}"`);
}

let pool: pg.Pool;
let store: PgMessageStore;

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
  store = new PgMessageStore(drizzle(pool));
});

afterAll(async () => { await pool?.end(); });

beforeEach(async () => {
  await pool.query('TRUNCATE session_messages, creator_sessions, "user" CASCADE');
  await pool.query(
    `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
     VALUES ('u1','U1','u1@x.com',false,now(),now())`,
  );
  await pool.query(
    `INSERT INTO creator_sessions (id, user_id, status, created_at, updated_at)
     VALUES ('s1','u1','idle',now(),now()), ('s2','u1','idle',now(),now())`,
  );
});

describe("PgMessageStore", () => {
  it("insert creates a pending row and returns its id; payload round-trips", async () => {
    const id = await store.insert("s1", {
      text: "make a video",
      uploadedFiles: ["a.png"],
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    const rows = await store.listIncomplete();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, sessionId: "s1", status: "pending", startedAt: null, finishedAt: null });
    expect(rows[0]!.payload).toEqual({
      text: "make a video",
      uploadedFiles: ["a.png"],
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(typeof rows[0]!.createdAt).toBe("string");
  });

  it("markProcessing/markDone/markError advance status and stamp timestamps", async () => {
    const id = await store.insert("s1", { text: "x" });
    await store.markProcessing(id);
    let row = (await store.listIncomplete())[0]!;
    expect(row.status).toBe("processing");
    expect(row.startedAt).not.toBeNull();

    await store.markDone(id);
    expect(await store.listIncomplete()).toHaveLength(0);
    const done = await pool.query("SELECT status, finished_at FROM session_messages WHERE id=$1", [id]);
    expect(done.rows[0]!.status).toBe("done");
    expect(done.rows[0]!.finished_at).not.toBeNull();

    const id2 = await store.insert("s1", { text: "y" });
    await store.markError(id2);
    const err = await pool.query("SELECT status, finished_at FROM session_messages WHERE id=$1", [id2]);
    expect(err.rows[0]!.status).toBe("error");
    expect(err.rows[0]!.finished_at).not.toBeNull();
  });

  it("mark* on an absent id is a silent no-op", async () => {
    await expect(store.markProcessing(424242)).resolves.toBeUndefined();
    await expect(store.markDone(424242)).resolves.toBeUndefined();
    await expect(store.markError(424242)).resolves.toBeUndefined();
  });

  it("listIncomplete spans sessions, id ascending, excluding done/error", async () => {
    const a = await store.insert("s1", { text: "a" });
    const b = await store.insert("s2", { text: "b" });
    const c = await store.insert("s1", { text: "c" });
    const d = await store.insert("s2", { text: "d" });
    await store.markProcessing(a);
    await store.markDone(c);
    await store.markError(d);
    const rows = await store.listIncomplete();
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(rows.map((r) => r.status)).toEqual(["processing", "pending"]);
  });

  it("insert for a missing session rejects (FK) — user messages must not be silently dropped", async () => {
    await expect(store.insert("ghost", { text: "x" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/messages/pg-message-store.pg.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现** `apps/server/src/messages/pg-message-store.ts`:

```ts
// PG-backed MessageStore over the session_messages table. Unlike PgEventStore,
// FK violations are NOT swallowed: routes validate session ownership before
// any insert, so a violation is a real bug/race that must surface — a user
// message silently dropped is worse than a logged 5xx.
import { asc, eq, inArray } from "drizzle-orm";
import type { UserMessage } from "@ultracreator/shared";
import type { Db } from "../db/client.js";
import { sessionMessage } from "../db/schema/creator.js";
import type {
  MessageStore,
  SessionMessageRecord,
  SessionMessageStatus,
} from "./message-store.js";

export class PgMessageStore implements MessageStore {
  constructor(private db: Db) {}

  async insert(sessionId: string, payload: UserMessage): Promise<number> {
    const rows = await this.db
      .insert(sessionMessage)
      .values({ sessionId, payload })
      .returning({ id: sessionMessage.id });
    return rows[0]!.id;
  }

  async markProcessing(id: number): Promise<void> {
    await this.db
      .update(sessionMessage)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(sessionMessage.id, id));
  }

  async markDone(id: number): Promise<void> {
    await this.db
      .update(sessionMessage)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(sessionMessage.id, id));
  }

  async markError(id: number): Promise<void> {
    await this.db
      .update(sessionMessage)
      .set({ status: "error", finishedAt: new Date() })
      .where(eq(sessionMessage.id, id));
  }

  async listIncomplete(): Promise<SessionMessageRecord[]> {
    const rows = await this.db
      .select()
      .from(sessionMessage)
      .where(inArray(sessionMessage.status, ["pending", "processing"]))
      .orderBy(asc(sessionMessage.id));
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      payload: r.payload,
      status: r.status as SessionMessageStatus,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/messages/pg-message-store.pg.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/messages/pg-message-store.ts apps/server/test/messages/pg-message-store.pg.test.ts
git commit -m "feat(server): PgMessageStore for the durable message queue"
```

### Task 4: orchestrator 消息生命周期 + 依赖扫尾 + 装配

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/src/compose-orchestrator.ts`
- Modify: `apps/server/src/api/server.ts`
- Modify(扫尾,均为加一个 `messages: new InMemoryMessageStore()` 依赖 + import):
  - `apps/server/test/orchestrator.test.ts`(`buildOrchestrator`,并把 store 加入返回对象)
  - `apps/server/test/api/messages-routes.test.ts`
  - `apps/server/test/api/artifacts-routes.test.ts`
  - `apps/server/test/api/stream-routes.test.ts`(注意:文件内第二处 inline 重建 app 的地方只换 eventLog,不新建 orchestrator,无需第二处改动)
  - `apps/server/test/api/files-routes.test.ts`
  - `apps/server/test/api/end-to-end.test.ts`
  - `apps/server/test/api/sessions-routes.test.ts`
  - `apps/server/test/api/uploads-routes.test.ts`
  - `apps/server/test/pipeline-e2e.test.ts`(composeOrchestrator 调用 +`messageStore:`)
  - `apps/server/test/compose-orchestrator-integration.test.ts`(3 处 composeOrchestrator 调用)

> ⚠️ **分类前提(所有新测试 payload 必须遵守)**:`RuleBasedIntentRouter` 只有在 `state=idle` **且消息带 `constraints`** 时才判 new-project(`intent-router.ts` 规则 5);裸 `{ text: "..." }` 在 idle 态会落到 `ask`,管线根本不跑。所以凡是要触发管线的测试消息一律写成
> `{ text: "Make a promo for Acme", constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false } }`。
> gate 态的 refine 文案用 `"make the palette warmer"`(不含 approve/brief 关键词 → 规则 7 判 refine)。

- [ ] **Step 1: 在 `orchestrator.test.ts` 写失败的生命周期测试** —— 先把 `buildOrchestrator` 改为注入并返回 store,并接受可选 handlers 覆盖(现有调用 `buildOrchestrator()` 全部不受影响):

```ts
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";
// ...
function buildOrchestrator(opts: { handlers?: Map<import("@ultracreator/shared").PhaseId, PhaseHandler> } = {}) {
  const workspaces = new WorkspaceManager(root);
  const events = new EventBus();
  const artifacts = new ArtifactStore(new InMemoryArtifactRepository(), events);
  const phases = new PhaseRegistry();
  const intentRouter = new RuleBasedIntentRouter();
  const handlers = opts.handlers ?? (buildHandlers() as Map<import("@ultracreator/shared").PhaseId, PhaseHandler>);
  const sessions = new InMemorySessionRepository();
  const messages = new InMemoryMessageStore();
  const orch = new SessionOrchestrator({ workspaces, events, artifacts, phases, intentRouter, handlers, sessions, messages });
  return { orch, workspaces, events, artifacts, phases, sessions, messages };
}
```

再追加 describe(文件末尾):

```ts
describe("SessionOrchestrator: durable message queue", () => {
  const newProject = {
    text: "Make a promo for Acme",
    constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
  };

  it("a handled message ends done with started/finished stamps", async () => {
    const { orch, messages } = buildOrchestrator();
    await orch.handleMessage("s1", newProject);
    const rows = messages.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: "s1", status: "done" });
    expect(rows[0]!.payload).toEqual(newProject);
    expect(rows[0]!.startedAt).not.toBeNull();
    expect(rows[0]!.finishedAt).not.toBeNull();
  });

  it("a phase failure marks the message error", async () => {
    const handlers = buildHandlers() as Map<import("@ultracreator/shared").PhaseId, PhaseHandler>;
    handlers.set("research", {
      async *run() { throw new Error("boom"); },
    });
    const { orch, messages } = buildOrchestrator({ handlers });
    await orch.handleMessage("s1", newProject);
    expect(messages.all()[0]).toMatchObject({ sessionId: "s1", status: "error" });
    expect(messages.all()[0]!.finishedAt).not.toBeNull();
  });

  it("an abort keyword message is NOT persisted", async () => {
    const { orch, messages } = buildOrchestrator();
    await orch.handleMessage("s1", { text: "abort" });
    expect(messages.all()).toHaveLength(0);
  });

  it("two messages persist as two rows in arrival order", async () => {
    const { orch, messages } = buildOrchestrator();
    await orch.handleMessage("s1", newProject); // → awaiting-gate design
    await orch.handleMessage("s1", { text: "make the palette warmer" }); // refine design
    const rows = messages.all();
    expect(rows.map((r) => r.status)).toEqual(["done", "done"]);
    expect(rows.map((r) => r.payload.text)).toEqual([
      "Make a promo for Acme",
      "make the palette warmer",
    ]);
  });
});
```

(若 `async *run() { throw ... }` 触发 lint/TS 抱怨,参考本文件既有 fetch 超时错误用例的 throwing handler 写法。)

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/orchestrator.test.ts`
Expected: FAIL —— `messages` 不是合法依赖(TS 报错)或运行时无落库行为。

- [ ] **Step 3: 改 `session-orchestrator.ts`**:

3a. deps 加字段:

```ts
import type { MessageStore } from "../messages/message-store.js";
// ...
export interface OrchestratorDeps {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  intentRouter: IntentRouter;
  handlers: ReadonlyMap<PhaseId, PhaseHandler>;
  sessions: SessionRepository;
  messages: MessageStore;
}
```

3b. 把现有 `handleMessage` 拆成三段(intent switch 的函数体**逐字搬**进 `dispatch`,不改逻辑):

```ts
  async handleMessage(sessionId: string, message: UserMessage): Promise<void> {
    await this.rehydrateState(sessionId);
    // Abort bypasses the queue AND the durable store: it must interrupt the
    // in-flight phase NOW (a queued task would wait behind it), and persisting
    // it would make startup recovery replay a stale abort against the very run
    // it just resumed. Pure keyword check — instant, no LLM round-trip.
    if (isAbortText(message.text)) {
      this.controllers.get(sessionId)?.abort();
      return;
    }
    // Durable BEFORE enqueue (spec §4): the row is the recovery unit if the
    // process dies mid-run.
    const messageId = await this.deps.messages.insert(sessionId, message);
    return this.processMessage(sessionId, messageId, message);
  }

  /** Queue the message and advance its durable status as it is worked through. */
  private processMessage(
    sessionId: string,
    messageId: number,
    message: UserMessage,
  ): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      await this.deps.messages.markProcessing(messageId);
      try {
        await this.dispatch(sessionId, message);
      } catch (err) {
        await this.deps.messages.markError(messageId);
        throw err;
      }
      await this.finalizeMessage(sessionId, messageId);
    });
  }

  /** Classify the message against the current state and run the matching action. */
  private async dispatch(sessionId: string, message: UserMessage): Promise<void> {
    const routerState = this.toRouterState(this.getState(sessionId));
    const { intent, targetPhase } = await this.deps.intentRouter.classify(message, routerState);
    switch (intent) {
      // ... 现有 switch 全文逐字搬入,无任何逻辑改动 ...
    }
  }

  /**
   * Phase failures do not throw (runFromPhase parks the session in error state
   * and emits phase.error), so the message outcome is read off the session
   * state once dispatch returns. Known simplification: a no-op message handled
   * while the session already sits in error state is also marked error —
   * harmless, since done/error are both terminal for recovery purposes.
   */
  private async finalizeMessage(sessionId: string, messageId: number): Promise<void> {
    if (this.getState(sessionId).kind === "error") {
      await this.deps.messages.markError(messageId);
    } else {
      await this.deps.messages.markDone(messageId);
    }
  }
```

- [ ] **Step 4: 扫尾全部构造点**(文件清单见上)。两种模式:
  - `new SessionOrchestrator({ ... })`:依赖对象加 `messages: new InMemoryMessageStore()`,import 路径:`test/api/` 下用 `../helpers/in-memory-message-store.js`,`test/` 顶层用 `./helpers/in-memory-message-store.js`。
  - `composeOrchestrator({ ... })`:加 `messageStore: new InMemoryMessageStore()`。

  `compose-orchestrator.ts` 改动:

```ts
import type { MessageStore } from "./messages/message-store.js";
// ComposeOrchestratorOptions 追加:
  /** Durable message queue repository. */
  messageStore: MessageStore;
// composeOrchestrator 内 SessionOrchestrator 构造:
  const orchestrator = new SessionOrchestrator({
    workspaces,
    events,
    artifacts,
    phases,
    intentRouter,
    handlers,
    sessions: opts.sessions,
    messages: opts.messageStore,
  });
```

  `server.ts` 改动(`PgSessionRepository` import 旁加):

```ts
import { PgMessageStore } from "../messages/pg-message-store.js";
// composeOrchestrator 调用处:
  sessions,
  artifactRepo: new PgArtifactRepository(db),
  messageStore: new PgMessageStore(db),
```

- [ ] **Step 5: 全量跑 unit project + typecheck**

Run: `pnpm vitest run --workspace ./vitest.suites.ts --project unit && pnpm typecheck`
Expected: 全绿(含新 describe)。

- [ ] **Step 6: Commit**

```bash
git add -u apps/server
git commit -m "feat(server): persist user messages through the durable queue (pending→processing→done|error)"
```

### Task 5: `recover()` + `resumeInterrupted` + 启动接线

**Files:**
- Modify: `apps/server/src/orchestrator/session-orchestrator.ts`
- Modify: `apps/server/src/api/server.ts`
- Test: `apps/server/test/orchestrator-recovery.test.ts`(新建)

- [ ] **Step 1: 写失败的恢复分支单测** `apps/server/test/orchestrator-recovery.test.ts`(完整文件):

```ts
// Unit tests for SessionOrchestrator.recover() branch logic. The full
// "crash mid-phase + rebuild orchestrator" simulation lives in
// restart-recovery.test.ts; here each durable-state branch is exercised
// directly by seeding the fakes.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId, UserMessage } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";
import type { PhaseHandler } from "../src/phases/types.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-recover-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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

function build() {
  const counters = { research: 0, design: 0 };
  const handlers = new Map<PhaseId, PhaseHandler>([
    ["research", new FakePhaseHandler({
      phase: "research",
      produce: async () => { counters.research++; return [{ kind: "brief", data: brief }]; },
    })],
    ["design", new FakePhaseHandler({
      phase: "design",
      produce: async () => { counters.design++; return [{ kind: "design", data: designData }]; },
    })],
  ]);
  const events = new EventBus();
  const sessions = new InMemorySessionRepository();
  const messages = new InMemoryMessageStore();
  const orch = new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events,
    artifacts: new ArtifactStore(new InMemoryArtifactRepository(), events),
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers,
    sessions,
    messages,
  });
  return { orch, sessions, messages, counters };
}

// Triggers new-project from idle (the rule router requires constraints — see T4 注意).
const newProject: UserMessage = {
  text: "Make a promo for Acme",
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

const seedRow = (
  messages: InMemoryMessageStore,
  sessionId: string,
  status: "pending" | "processing",
  payload: UserMessage,
) =>
  messages.seed({
    sessionId,
    payload,
    status,
    createdAt: new Date().toISOString(),
    startedAt: status === "processing" ? new Date().toISOString() : null,
    finishedAt: null,
  });

async function statusOf(messages: InMemoryMessageStore, id: number): Promise<string> {
  return messages.all().find((r) => r.id === id)!.status;
}

describe("SessionOrchestrator.recover", () => {
  it("replays a pending row through the normal dispatch path", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    const id = seedRow(messages, "s1", "pending", newProject);

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("done"));
    expect(counters.research).toBe(1);
    expect(counters.design).toBe(1);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("processing + awaiting-gate session → marked done without re-running anything", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    await sessions.updateStatus("s1", { status: "awaiting-gate", currentPhase: "design", error: null });
    const id = seedRow(messages, "s1", "processing", { text: "anything — never dispatched" });

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("done"));
    expect(counters.research).toBe(0);
    expect(counters.design).toBe(0);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("processing + error session → marked error without re-running anything", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    await sessions.updateStatus("s1", { status: "error", currentPhase: "design", error: "boom" });
    const id = seedRow(messages, "s1", "processing", { text: "anything — never dispatched" });

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("error"));
    expect(counters.research).toBe(0);
    expect(counters.design).toBe(0);
  });

  it("processing + idle session (crashed before any state write) → full replay", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    const id = seedRow(messages, "s1", "processing", newProject);

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, id)).toBe("done"));
    expect(counters.research).toBe(1);
    expect(orch.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  });

  it("a pending row queued behind the interrupted one runs after it, in order", async () => {
    const { orch, sessions, messages, counters } = build();
    await sessions.create({ id: "s1", userId: "u1" });
    // Interrupted new-project (idle branch → replay) followed by a queued refine.
    const first = seedRow(messages, "s1", "processing", newProject);
    const second = seedRow(messages, "s1", "pending", { text: "make the palette warmer" });

    await orch.recover();
    await vi.waitFor(async () => expect(await statusOf(messages, second)).toBe("done"));
    expect(await statusOf(messages, first)).toBe("done");
    // refine re-ran design after the replayed pipeline reached the design gate
    expect(counters.research).toBe(1);
    expect(counters.design).toBe(2);
  });

  it("recover with nothing incomplete is a no-op", async () => {
    const { orch, messages, counters } = build();
    await orch.recover();
    expect(messages.all()).toHaveLength(0);
    expect(counters.research).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/orchestrator-recovery.test.ts`
Expected: FAIL —— `recover` 不存在。

- [ ] **Step 3: 实现 `recover()` / `resumeInterrupted()`**(加在 `handleMessage` 附近):

```ts
  /**
   * Startup recovery (spec §4): re-enqueue every message that never finished.
   * Pending rows never started — replay them through the normal dispatch path.
   * Processing rows were interrupted by a crash mid-run; the durable
   * creator_sessions row records where the pipeline stopped — see
   * resumeInterrupted for the per-state decision. listIncomplete is
   * id-ascending and SessionQueue is per-session FIFO, so arrival order is
   * preserved. Resolves once everything is enqueued; the runs themselves
   * continue in the background (observable via events + session_messages).
   */
  async recover(): Promise<void> {
    const incomplete = await this.deps.messages.listIncomplete();
    for (const msg of incomplete) {
      await this.rehydrateState(msg.sessionId);
      // Outcomes are recorded durably inside the queued task (markDone /
      // markError); swallow the propagated rejection so one poisoned message
      // cannot crash startup.
      if (msg.status === "pending") {
        void this.processMessage(msg.sessionId, msg.id, msg.payload).catch(() => {});
      } else {
        void this.resumeInterrupted(msg.sessionId, msg.id, msg.payload).catch(() => {});
      }
    }
  }

  /**
   * A processing row means the crash interrupted this message mid-run. Decide
   * from the recovered SessionState:
   *  - running        → re-run from current_phase. Earlier phases' artifacts are
   *                     already in PG; phases are idempotent (a re-run writes a
   *                     new artifact version) and the chain continues to its
   *                     natural stop (gate / done / error).
   *  - idle           → died between markProcessing and the first state write
   *                     (e.g. mid-classification): replay from scratch.
   *  - error          → the run had already failed; mirror it on the message.
   *                     The user retries explicitly (refine/revise) — no auto-rerun.
   *  - awaiting-gate / done → the run had already parked; the work is complete.
   */
  private resumeInterrupted(
    sessionId: string,
    messageId: number,
    message: UserMessage,
  ): Promise<void> {
    return this.queue.enqueue(sessionId, async () => {
      const state = this.getState(sessionId);
      switch (state.kind) {
        case "running":
          await this.runFromPhase(sessionId, state.phase);
          await this.finalizeMessage(sessionId, messageId);
          return;
        case "idle":
          try {
            await this.dispatch(sessionId, message);
          } catch (err) {
            await this.deps.messages.markError(messageId);
            throw err;
          }
          await this.finalizeMessage(sessionId, messageId);
          return;
        case "error":
          await this.deps.messages.markError(messageId);
          return;
        case "awaiting-gate":
        case "done":
          await this.deps.messages.markDone(messageId);
          return;
      }
    });
  }
```

同时更新 `deserializeStatus` 里 2a 留下的 NOTE 注释为:

```ts
    // A "running" row after a restart is resumed by recover() at startup: the
    // interrupted message is still `processing` in session_messages and gets
    // re-enqueued from current_phase.
```

- [ ] **Step 4: server.ts 接线** —— `createApp(...)` 之后、`app.listen` 之前:

```ts
// Startup recovery (spec §4): re-enqueue messages interrupted by the previous
// process. One SELECT + enqueue — the resumed runs proceed in the background
// after listen.
await composed.orchestrator.recover();
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/orchestrator-recovery.test.ts apps/server/test/orchestrator.test.ts && pnpm typecheck`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add -u apps/server
git commit -m "feat(server): startup recovery — re-enqueue unfinished messages and resume from the interrupted phase"
```

### Task 6: 重启恢复集成测试(双 orchestrator 实例)

**Files:**
- Test: `apps/server/test/restart-recovery.test.ts`(新建)

- [ ] **Step 1: 写集成测试**(完整文件;这是 spec §9 点名的"处理中消息 + 进程重启"模拟 —— 内存 fake 扮演 PG 的角色,跨两个 orchestrator 实例存活;workspace 目录天然跨实例存活):

```ts
// Spec §4/§9 acceptance: kill the server mid-pipeline, restart, and the task
// resumes from the interrupted phase. Simulated in-process: orchestrator #1
// runs into a phase that never finishes (the "crash" leaves its queue task
// parked forever and we simply abandon the instance); orchestrator #2 is built
// over the SAME durable stores (the in-memory fakes play the role of PG, the
// tmp workspace dir plays itself) and recover() must finish the run.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, PhaseId, ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { InMemoryArtifactRepository } from "./helpers/in-memory-artifact-repository.js";
import { PhaseRegistry } from "../src/phases/registry.js";
import { FakePhaseHandler } from "../src/phases/fake-handler.js";
import type { PhaseHandler } from "../src/phases/types.js";
import { RuleBasedIntentRouter } from "../src/intent/intent-router.js";
import { SessionOrchestrator } from "../src/orchestrator/session-orchestrator.js";
import { InMemorySessionRepository } from "./helpers/in-memory-session-repository.js";
import { InMemoryMessageStore } from "./helpers/in-memory-message-store.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-restart-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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

it("a task killed mid-design resumes from design (not research) on the next process", async () => {
  // ---- durable layer, shared across both "processes" -----------------------
  const sessions = new InMemorySessionRepository();
  const messages = new InMemoryMessageStore();
  const artifactRepo = new InMemoryArtifactRepository();
  await sessions.create({ id: "s1", userId: "u1" });

  // ---- process #1: research completes, design hangs forever ----------------
  let signalDesignStarted!: () => void;
  const designStarted = new Promise<void>((r) => { signalDesignStarted = r; });
  const hangingDesign: PhaseHandler = {
    async *run() {
      signalDesignStarted();
      await new Promise<never>(() => {}); // parked forever — the "kill" abandons it
    },
  };
  const events1 = new EventBus();
  const orch1 = new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events: events1,
    artifacts: new ArtifactStore(artifactRepo, events1),
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map<PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({ phase: "research", produce: async () => [{ kind: "brief", data: brief }] })],
      ["design", hangingDesign],
    ]),
    sessions,
    messages,
  });

  // Fire and abandon — the returned promise never settles (design hangs).
  void orch1.handleMessage("s1", {
    text: "Make a promo for Acme",
    constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
  });
  await designStarted;

  // Durable snapshot at "kill" time: message processing, session running:design,
  // research's brief already persisted.
  expect(messages.all()[0]).toMatchObject({ status: "processing" });
  expect(await sessions.get("s1")).toMatchObject({ status: "running", currentPhase: "design" });
  expect(await artifactRepo.getLatest("s1", "brief")).not.toBeNull();

  // ---- process #2: fresh instance over the same durable layer --------------
  let researchRuns2 = 0;
  const events2 = new EventBus();
  const seen2: ServerEvent[] = [];
  events2.subscribe("s1", (e) => seen2.push(e));
  const orch2 = new SessionOrchestrator({
    workspaces: new WorkspaceManager(root),
    events: events2,
    artifacts: new ArtifactStore(artifactRepo, events2),
    phases: new PhaseRegistry(),
    intentRouter: new RuleBasedIntentRouter(),
    handlers: new Map<PhaseId, PhaseHandler>([
      ["research", new FakePhaseHandler({ phase: "research", produce: async () => { researchRuns2++; return [{ kind: "brief", data: brief }]; } })],
      ["design", new FakePhaseHandler({ phase: "design", produce: async () => [{ kind: "design", data: designData }] })],
    ]),
    sessions,
    messages,
  });

  await orch2.recover();
  await vi.waitFor(() => expect(messages.all()[0]!.status).toBe("done"));

  // Resumed from design: research did NOT re-run, design completed and gated.
  expect(researchRuns2).toBe(0);
  expect(seen2.filter((e) => e.type === "phase.started").map((e) => (e as { phase: string }).phase)).toEqual(["design"]);
  expect(orch2.getState("s1")).toEqual({ kind: "awaiting-gate", phase: "design" });
  expect(await sessions.get("s1")).toMatchObject({ status: "awaiting-gate", currentPhase: "design" });
  expect(await artifactRepo.getLatest("s1", "design")).toMatchObject({ version: 1 });
  // The recovered run emits ordinary events — the SSE/前端 path needs nothing special.
  expect(seen2.some((e) => e.type === "gate.awaiting")).toBe(true);
});
```

- [ ] **Step 2: 跑测试**

Run: `pnpm vitest run --workspace ./vitest.suites.ts apps/server/test/restart-recovery.test.ts`
Expected: PASS(T5 已实现 recover;若失败,修 src 而不是改断言)。

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/restart-recovery.test.ts
git commit -m "test(server): restart-recovery integration — killed mid-design resumes from design on a fresh instance"
```

### Task 7: 全量回归 + 注释扫尾 + 终审

- [ ] **Step 1: 全量回归**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿(unit + pg 两个 project;pg 需本地 PG 在跑)。

- [ ] **Step 2: 陈旧注释/死代码扫描**

Run: `grep -rn "phase 3\|阶段3\|阶段③" apps/server/src --include="*.ts"`
Expected: 不再有"留待阶段③"口吻的注释(T5 已改 `deserializeStatus` 的 NOTE;若扫出其他,改成现状描述)。确认 `messages-routes.ts` 的注释仍准确(fire-and-forget 语义未变,无需改动)。

- [ ] **Step 3: Commit(如有改动)**

```bash
git add -u apps/server
git commit -m "chore(server): retire phase-3 forward references in comments"
```

- [ ] **Step 4: 整阶段终审** —— 控制器对 `git diff <计划提交>..HEAD` 跑 opus 终审,重点:恢复语义表是否如实实现、消息状态机无泄漏路径(每条 insert 的行都有终态)、恢复顺序(同会话 FIFO)、abort 不落库、server.ts 接线时序(recover 在 listen 前)、扫尾无遗漏。

## 手工验收(用户执行,服务器+真 PG)

1. 起服务(0003 自动迁移),登录,发起一个会话跑管线。
2. 跑到中途(如 design/compose 阶段)`kill -9` 服务进程。
3. `SELECT id, status, started_at FROM session_messages` 应有一行 `processing`;`SELECT status, current_phase FROM creator_sessions` 应为 `running` + 中断阶段。
4. 重启服务:日志后任务自动续跑;浏览器重开会话页,SSE 重放出完整历史 + 新阶段事件;`session_messages` 那行最终 `done`。
5. 验收标准(spec §1):任务跑一半 kill 服务再启动,任务自动续跑。✔
