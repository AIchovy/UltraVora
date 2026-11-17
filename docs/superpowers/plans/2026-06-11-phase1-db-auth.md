# 阶段① 数据层 + 认证 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入 PostgreSQL(Drizzle)与 Better Auth(仅 Google 登录),前后端同源化,所有会话 API 要求登录,登录页 + 侧边栏用户区上线。

**Architecture:** Better Auth 挂在 Fastify 上(`/api/auth/*`),登录态为 httpOnly cookie + PG `session` 表;Next.js 通过 rewrites 把 `/api/*` 代理到 Fastify 实现同源;服务端以窄接口 `AuthService` 隔离 better-auth,测试注入 fake。本阶段不做业务会话落库(阶段②)。

**Tech Stack:** drizzle-orm + pg(node-postgres)+ drizzle-kit、better-auth(server + react client)、Fastify 5、Next.js 15。

**Spec:** `docs/superpowers/specs/2026-06-11-productization-design.md`(阶段①范围)

**前置条件(已就绪/需人工):**
- 本地 PG 14 运行中,`postgres://admin@localhost:5432/ultracreator` 可连(已验证)。
- `apps/server/.env` 已创建(gitignored),含 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。**计划文档中不出现密钥明文。**
- ⚠️ **需要用户人工操作**:在 Google Cloud Console 该 OAuth Client 的 Authorized redirect URIs 中加入 `http://localhost:3000/api/auth/callback/google`,Authorized JavaScript origins 加入 `http://localhost:3000`。没有这一步 Google 登录会报 redirect_uri_mismatch。

**版本说明:** better-auth 装 latest(v1.x API);若 `@better-auth/cli generate` 生成的 schema 与 Task 2 手写 schema 有出入,以 CLI 输出为准修正后再生成 migration。

---

### Task 1: 安装依赖 + 服务端 .env 加载

**Files:**
- Modify: `apps/server/package.json`(依赖)
- Modify: `apps/web/package.json`(依赖)
- Create: `apps/server/.env.example`
- Modify: `apps/server/src/api/server.ts:1-22`(顶部加 env 加载)

- [ ] **Step 1: 安装依赖**

```bash
pnpm -F @ultracreator/server add drizzle-orm pg better-auth
pnpm -F @ultracreator/server add -D drizzle-kit @types/pg
pnpm -F @ultracreator/web add better-auth
```

- [ ] **Step 2: 创建 `apps/server/.env.example`(占位符,可提交)**

```bash
# Copy to .env and fill in real values. .env is gitignored.
DATABASE_URL=postgres://admin@localhost:5432/ultracreator
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=<google oauth client id>
GOOGLE_CLIENT_SECRET=<google oauth client secret>
```

- [ ] **Step 3: server.ts 顶部加载 .env**

在 `apps/server/src/api/server.ts` 的 import 块之后、`const PORT = ...` 之前插入:

```ts
// Load apps/server/.env when present (dev convenience). Shell-provided env
// vars win — loadEnvFile never overrides existing process.env entries.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on shell env */
}
```

- [ ] **Step 4: 验证**

```bash
pnpm typecheck
```
Expected: 无错误(仅加了依赖与 env 加载,未引用新库)。

- [ ] **Step 5: Commit**

```bash
git add apps/server/package.json apps/web/package.json apps/server/.env.example apps/server/src/api/server.ts pnpm-lock.yaml
git commit -m "chore(server,web): add drizzle/pg/better-auth deps and .env loading"
```

---

### Task 2: Drizzle 数据层 + Better Auth 表 + migration

**Files:**
- Create: `apps/server/drizzle.config.ts`
- Create: `apps/server/src/db/schema/auth.ts`
- Create: `apps/server/src/db/schema/index.ts`
- Create: `apps/server/src/db/client.ts`
- Create: `apps/server/src/db/migrate.ts`
- Create: `apps/server/drizzle/`(drizzle-kit 生成)
- Modify: `apps/server/package.json`(scripts)
- Test: `apps/server/test/db/migrations.pg.test.ts`(真 PG 集成测试)

- [ ] **Step 1: 写失败的集成测试**

`apps/server/test/db/migrations.pg.test.ts`:

```ts
// Integration test against the real local PG (spec: 集成测试连本地真 PG 的独立库).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query("CREATE DATABASE ultracreator_test").catch((err: { code?: string }) => {
    if (err.code !== "42P04") throw err; // 42P04 = duplicate_database
  });
  await admin.end();
  pool = new pg.Pool({ connectionString: TEST_URL });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(drizzle(pool), { migrationsFolder });
});

afterAll(async () => {
  await pool?.end();
});

describe("auth schema migrations", () => {
  it("creates the better-auth tables", async () => {
    const res = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    const names = res.rows.map((r: { table_name: string }) => r.table_name);
    for (const t of ["account", "session", "user", "verification"]) {
      expect(names).toContain(t);
    }
  });

  it("enforces unique user email", async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('u1', 'A', 'a@x.com', false, now(), now())`,
    );
    await expect(
      pool.query(
        `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
         VALUES ('u2', 'B', 'a@x.com', false, now(), now())`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm exec vitest run apps/server/test/db/migrations.pg.test.ts
```
Expected: FAIL(migrations 目录不存在 / 表不存在)。

- [ ] **Step 3: 写 schema 与 db 模块**

`apps/server/src/db/schema/auth.ts`(better-auth v1 标准 drizzle schema;如与 `@better-auth/cli generate` 输出不一致,以 CLI 为准):

```ts
// Better Auth core tables. Column names follow better-auth's drizzle adapter
// defaults — do not rename without regenerating via @better-auth/cli.
import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});
```

`apps/server/src/db/schema/index.ts`:

```ts
export * from "./auth.js";
```

`apps/server/src/db/client.ts`:

```ts
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
```

`apps/server/src/db/migrate.ts`:

```ts
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "./client.js";

// src/db/migrate.ts → apps/server/drizzle
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
```

`apps/server/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator",
  },
});
```

`apps/server/package.json` 的 `scripts` 增加:

```json
"db:generate": "drizzle-kit generate",
"db:migrate": "drizzle-kit migrate"
```

- [ ] **Step 4: 生成 migration 并跑测试**

```bash
pnpm -F @ultracreator/server db:generate
pnpm exec vitest run apps/server/test/db/migrations.pg.test.ts
```
Expected: drizzle/ 下生成 `0000_*.sql`;测试 PASS。

- [ ] **Step 5: 对开发库执行 migration**

```bash
pnpm -F @ultracreator/server db:migrate
psql -h localhost -U admin -d ultracreator -c '\dt'
```
Expected: 列出 `user`、`session`、`account`、`verification` 表。

- [ ] **Step 6: Commit**

```bash
git add apps/server/drizzle.config.ts apps/server/src/db apps/server/drizzle apps/server/package.json apps/server/test/db
git commit -m "feat(server): drizzle + pg client and better-auth schema/migrations"
```

---

### Task 3: AuthService 接口 + Better Auth 实例 + Fastify 挂载

**Files:**
- Create: `apps/server/src/auth/auth-service.ts`
- Create: `apps/server/src/auth/better-auth.ts`
- Create: `apps/server/src/auth/fastify-auth.ts`
- Test: `apps/server/test/auth/fastify-auth.test.ts`

- [ ] **Step 1: 写失败的测试**

`apps/server/test/auth/fastify-auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { AuthService } from "../../src/auth/auth-service.js";
import { registerAuthRoutes } from "../../src/auth/fastify-auth.js";

function captureService(): { service: AuthService; calls: Request[] } {
  const calls: Request[] = [];
  const service: AuthService = {
    getSession: async () => null,
    handler: async (req) => {
      calls.push(req);
      const res = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      res.headers.append("set-cookie", "a=1; Path=/");
      res.headers.append("set-cookie", "b=2; Path=/");
      return res;
    },
  };
  return { service, calls };
}

describe("registerAuthRoutes", () => {
  it("maps the fastify request to a web Request against the public origin", async () => {
    const app = Fastify();
    const { service, calls } = captureService();
    await registerAuthRoutes(app, service, { publicOrigin: "http://localhost:3000" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/ok",
      headers: { cookie: "x=y" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("http://localhost:3000/api/auth/ok");
    expect(calls[0]!.headers.get("cookie")).toBe("x=y");
    await app.close();
  });

  it("passes through multiple set-cookie headers", async () => {
    const app = Fastify();
    const { service } = captureService();
    await registerAuthRoutes(app, service, { publicOrigin: "http://localhost:3000" });
    const res = await app.inject({ method: "GET", url: "/api/auth/ok" });
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    await app.close();
  });

  it("re-serializes parsed JSON bodies for POST", async () => {
    const app = Fastify();
    const { service, calls } = captureService();
    await registerAuthRoutes(app, service, { publicOrigin: "http://localhost:3000" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      payload: { callbackURL: "/login" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.method).toBe("POST");
    expect(await calls[0]!.text()).toBe(JSON.stringify({ callbackURL: "/login" }));
    expect(calls[0]!.headers.get("content-length")).toBeNull();
    await app.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm exec vitest run apps/server/test/auth/fastify-auth.test.ts
```
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`apps/server/src/auth/auth-service.ts`:

```ts
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  image?: string | null;
}

export interface AuthSession {
  user: AuthUser;
}

/**
 * Narrow seam over better-auth so routes and tests never import the library
 * directly. Tests inject a fake; production wraps the real instance.
 */
export interface AuthService {
  /** Serves /api/auth/* HTTP traffic (web-standard Request/Response). */
  handler(request: Request): Promise<Response>;
  /** Resolves the logged-in session from request headers (cookie), or null. */
  getSession(headers: Headers): Promise<AuthSession | null>;
}
```

`apps/server/src/auth/better-auth.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema/index.js";
import type { AuthService } from "./auth-service.js";

export interface CreateAuthOptions {
  db: Db;
  /** Public origin the browser talks to, e.g. http://localhost:3000 */
  baseURL: string;
  secret: string;
  google: { clientId: string; clientSecret: string };
}

export function createAuth(opts: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: "pg", schema }),
    baseURL: opts.baseURL,
    basePath: "/api/auth",
    secret: opts.secret,
    socialProviders: {
      google: {
        clientId: opts.google.clientId,
        clientSecret: opts.google.clientSecret,
      },
    },
    account: {
      // 预留:未来加邮箱登录时,同邮箱自动并入既有 Google 用户(spec §3)。
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    trustedOrigins: [opts.baseURL],
  });
}

export function betterAuthService(auth: ReturnType<typeof createAuth>): AuthService {
  return {
    handler: (request) => auth.handler(request),
    getSession: async (headers) => {
      const s = await auth.api.getSession({ headers });
      if (!s) return null;
      return {
        user: {
          id: s.user.id,
          email: s.user.email,
          name: s.user.name,
          image: s.user.image ?? null,
        },
      };
    },
  };
}
```

`apps/server/src/auth/fastify-auth.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import type { AuthService, AuthUser } from "./auth-service.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the session guard for /api/sessions* routes. */
    authUser?: AuthUser;
  }
}

export function toWebHeaders(nodeHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.append(key, value);
  }
  return headers;
}

export interface AuthRoutesOptions {
  /** Public origin the browser uses (through the Next proxy). */
  publicOrigin: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  opts: AuthRoutesOptions,
): Promise<void> {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: async (req, reply) => {
      const url = new URL(req.url, opts.publicOrigin);
      const headers = toWebHeaders(req.headers);
      // Fastify already parsed the body; we re-serialize it below, so the
      // original content-length no longer applies.
      headers.delete("content-length");
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        ...(req.body !== undefined && req.body !== null
          ? { body: JSON.stringify(req.body) }
          : {}),
      });
      const response = await auth.handler(request);
      reply.status(response.status);
      const setCookies = response.headers.getSetCookie();
      if (setCookies.length > 0) reply.header("set-cookie", setCookies);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie") reply.header(key, value);
      });
      reply.send(response.body ? await response.text() : null);
    },
  });
}

/** preHandler guarding /api/sessions* — 401 without a login session. */
export function createSessionGuard(auth: AuthService) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    if (!req.url.startsWith("/api/sessions")) return;
    const session = await auth.getSession(toWebHeaders(req.headers));
    if (!session) {
      reply.code(401).send({ error: "unauthorized" });
      return reply;
    }
    req.authUser = session.user;
    return;
  };
}
```

- [ ] **Step 4: 运行测试**

```bash
pnpm exec vitest run apps/server/test/auth/fastify-auth.test.ts
pnpm typecheck
```
Expected: PASS;无类型错误。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auth apps/server/test/auth
git commit -m "feat(server): AuthService seam, better-auth factory, fastify mount + session guard"
```

---

### Task 4: createApp 接入 auth(挂载 + 守卫)并更新现有测试

**Files:**
- Modify: `apps/server/src/api/app.ts`
- Create: `apps/server/test/helpers/fake-auth.ts`
- Modify: `apps/server/test/api/*.test.ts` 中所有构造 `AppDeps` 的文件(用 `grep -rln "createApp(" apps/server/test` 找全,已知:`sessions-routes`、`uploads-routes`、`messages-routes`、`artifacts-routes`、`files-routes`、`stream-routes`、`end-to-end`,以及可能的 `session-event-log`、根目录 `pipeline-e2e`)
- Test: `apps/server/test/api/sessions-routes.test.ts`(新增 401 用例)

- [ ] **Step 1: 写 fake + 失败的守卫测试**

`apps/server/test/helpers/fake-auth.ts`:

```ts
import type { AuthService, AuthUser } from "../../src/auth/auth-service.js";

export const TEST_USER: AuthUser = {
  id: "u-test",
  email: "test@example.com",
  name: "Test User",
  image: null,
};

/** AuthService fake: pass a user (default TEST_USER) or null for logged-out. */
export function fakeAuthService(user: AuthUser | null = TEST_USER): AuthService {
  return {
    handler: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    getSession: async () => (user ? { user } : null),
  };
}
```

在 `apps/server/test/api/sessions-routes.test.ts` 的 describe 末尾新增用例(并在该文件 `deps = {...}` 处加 `auth: fakeAuthService()`,import 自 `../helpers/fake-auth.js`):

```ts
it("returns 401 for /api/sessions* when there is no login session", async () => {
  const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
  const res = await unauthApp.inject({ method: "POST", url: "/api/sessions" });
  expect(res.statusCode).toBe(401);
  expect(res.json()).toEqual({ error: "unauthorized" });
  await unauthApp.close();
});

it("leaves /api/auth/* unguarded", async () => {
  const unauthApp = await createApp({ ...deps, auth: fakeAuthService(null) });
  const res = await unauthApp.inject({ method: "GET", url: "/api/auth/ok" });
  expect(res.statusCode).toBe(200);
  await unauthApp.close();
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm exec vitest run apps/server/test/api/sessions-routes.test.ts
```
Expected: FAIL(`AppDeps` 还没有 `auth` 字段 → 类型错误/守卫不存在)。

- [ ] **Step 3: 修改 `apps/server/src/api/app.ts`**

在 import 区加:

```ts
import type { AuthService } from "../auth/auth-service.js";
import { registerAuthRoutes, createSessionGuard } from "../auth/fastify-auth.js";
```

`AppDeps` 增加字段:

```ts
export interface AppDeps {
  workspaces: WorkspaceManager;
  events: EventBus;
  artifacts: ArtifactStore;
  phases: PhaseRegistry;
  orchestrator: SessionOrchestrator;
  eventLog: SessionEventLog;
  auth: AuthService;
}
```

`CreateAppOptions` 增加:

```ts
export interface CreateAppOptions {
  logger?: boolean;
  /** Bytes; passed through to @fastify/multipart's `fileSize`. */
  maxUploadBytes?: number;
  /** Public origin for /api/auth/* request reconstruction. */
  authPublicOrigin?: string;
}
```

`createApp` 中,在 `app.setErrorHandler(...)` 之后、`registerSessionsRoutes` 之前插入(守卫 hook 必须先于业务路由注册):

```ts
  app.addHook("preHandler", createSessionGuard(deps.auth));
  await registerAuthRoutes(app, deps.auth, {
    publicOrigin: opts.authPublicOrigin ?? "http://localhost:3000",
  });
```

- [ ] **Step 4: 更新所有构造 AppDeps 的测试**

```bash
grep -rln "createApp(" apps/server/test
```

对每个命中的文件:import `fakeAuthService`(注意相对路径,`test/api/` 下是 `../helpers/fake-auth.js`),在 `deps = { workspaces, events, ... }` 对象里加 `auth: fakeAuthService()`。

- [ ] **Step 5: 全量服务端测试**

```bash
pnpm exec vitest run apps/server/test
pnpm typecheck
```
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api/app.ts apps/server/test
git commit -m "feat(server): require login on /api/sessions* via auth guard"
```

---

### Task 5: server.ts 装配真实 auth + DB

**Files:**
- Modify: `apps/server/src/api/server.ts`

- [ ] **Step 1: 修改 server.ts**

import 区加:

```ts
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createAuth, betterAuthService } from "../auth/better-auth.js";
```

Environment 段(`required` 函数之后)加:

```ts
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator";
const BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const BETTER_AUTH_SECRET = required("BETTER_AUTH_SECRET");
const GOOGLE_CLIENT_ID = required("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = required("GOOGLE_CLIENT_SECRET");
```

在 `const eventLog = new SessionEventLog({...})` 之后加:

```ts
// ---------------------------------------------------------------------------
// Database + auth
// ---------------------------------------------------------------------------

const { db, pool } = createDb(DATABASE_URL);
// Fail fast when PG is unreachable (spec §8) — migrate connects immediately.
await runMigrations(db);

const auth = createAuth({
  db,
  baseURL: BETTER_AUTH_URL,
  secret: BETTER_AUTH_SECRET,
  google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET },
});
```

`createApp` 调用改为:

```ts
const app = await createApp(
  { ...composed, eventLog, auth: betterAuthService(auth) },
  { logger: true, authPublicOrigin: BETTER_AUTH_URL },
);
```

shutdown 函数中 `await eventLog.closeAll();` 之后加:

```ts
  await pool.end();
```

- [ ] **Step 2: 手工验证启动**

```bash
pnpm dev:server
# 另一个终端:
curl -s http://127.0.0.1:3001/api/auth/ok
curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3001/api/sessions
```
Expected: `/api/auth/ok` 返回 `{"ok":true}`;`/api/sessions` 返回 `401`。
(server 仍需要 GEMINI_API_KEY 等原有 env,沿用现有 shell 配置或写入 `apps/server/.env`。)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/api/server.ts
git commit -m "feat(server): wire real PG + better-auth into server bootstrap"
```

---

### Task 6: Next rewrites 同源化 + apiBase 改造 + SSE 代理验证

**Files:**
- Modify: `apps/web/next.config.mjs`(或现有 next.config 文件,以仓库实际为准)
- Modify: `apps/web/src/lib/api-base.ts`
- Test: `apps/web/test/lib/api-base.test.ts`(新建)

- [ ] **Step 1: 写失败的测试**

`apps/web/test/lib/api-base.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { apiBase } from "@/lib/api-base";

const ORIGINAL = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = ORIGINAL;
});

describe("apiBase", () => {
  it("returns '' when NEXT_PUBLIC_API_URL is unset (same-origin via Next rewrites)", () => {
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(apiBase()).toBe("");
  });

  it("strips the trailing slash from an explicit override", () => {
    process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001/";
    expect(apiBase()).toBe("http://127.0.0.1:3001");
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm exec vitest run apps/web/test/lib/api-base.test.ts
```
Expected: FAIL(unset 时现实现会 throw)。

- [ ] **Step 3: 实现**

`apps/web/src/lib/api-base.ts` 全量替换为:

```ts
// apps/web/src/lib/api-base.ts
export function apiBase(): string {
  // Read each call so tests can mutate process.env between calls.
  const raw = process.env.NEXT_PUBLIC_API_URL;
  // Default: same-origin — /api/* is proxied to the Fastify server by Next
  // rewrites, so cookies flow first-party. Set NEXT_PUBLIC_API_URL only to
  // bypass the proxy (e.g. tests hitting a real server directly).
  if (!raw || raw.length === 0) return "";
  return raw.replace(/\/$/, "");
}
```

`apps/web/next.config.mjs` 的 nextConfig 对象中加(与现有 `webpack` 字段平级):

```js
  async rewrites() {
    const target = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  },
```

- [ ] **Step 4: 运行测试**

```bash
pnpm exec vitest run apps/web/test
```
Expected: 全部 PASS(现有测试显式设置了 NEXT_PUBLIC_API_URL,不受影响)。

- [ ] **Step 5: 手工验证 SSE 经代理不缓冲(spec §3 风险点)**

```bash
# 终端 A:pnpm dev:server;终端 B:pnpm dev:web;终端 C:
curl -s http://localhost:3000/api/auth/ok        # 经 Next 代理 → {"ok":true}
curl -N --max-time 40 http://localhost:3000/api/sessions/00000000-0000-4000-8000-000000000000/stream
```
Expected:第一条命令返回 `{"ok":true}` 证明代理生效。第二条此时会返回 401(守卫已生效)——**SSE 流式验证放到 Task 10 登录后用真 cookie 做**;本步先确认代理通路与 401 即可。若 Task 10 发现 SSE 经代理被缓冲(`: connected` 不立即出现),回退方案:恢复 `NEXT_PUBLIC_API_URL=http://127.0.0.1:3001` 直连 + 全部 fetch 加 `credentials: "include"` + EventSource 加 `withCredentials: true` + Fastify CORS 配 `origin: ["http://localhost:3000"], credentials: true`。

- [ ] **Step 6: Commit**

```bash
git add apps/web/next.config.mjs apps/web/src/lib/api-base.ts apps/web/test/lib/api-base.test.ts
git commit -m "feat(web): proxy /api/* to fastify via rewrites; apiBase defaults to same-origin"
```

---

### Task 7: web auth client + 登录页

**Files:**
- Create: `apps/web/src/lib/auth-client.ts`
- Create: `apps/web/src/components/login-card.tsx`
- Create: `apps/web/src/app/login/page.tsx`
- Create: `apps/web/src/lib/server-session.ts`
- Test: `apps/web/test/components/login-card.test.tsx`
- Test: `apps/web/test/lib/server-session.test.ts`

- [ ] **Step 1: 写失败的 LoginCard 测试**

`apps/web/test/components/login-card.test.tsx`(文件头部的环境 pragma/import 写法照抄 `apps/web/test/components/app-sidebar.test.tsx` 的现有约定):

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginCard } from "@/components/login-card";

const socialMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: (args: unknown) => socialMock(args) } },
}));

describe("LoginCard", () => {
  it("starts Google sign-in with callback to /", async () => {
    render(<LoginCard />);
    await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(socialMock).toHaveBeenCalledWith({ provider: "google", callbackURL: "/" });
  });

  it("shows a disabled email placeholder (email auth comes later)", () => {
    render(<LoginCard />);
    expect(screen.getByPlaceholderText("you@example.com")).toBeDisabled();
    expect(screen.getByRole("button", { name: /email sign-in coming soon/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm exec vitest run apps/web/test/components/login-card.test.tsx
```
Expected: FAIL(组件不存在)。

- [ ] **Step 3: 实现 auth client 与组件**

`apps/web/src/lib/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";

// Same-origin: /api/auth/* goes through the Next rewrite to Fastify.
export const authClient = createAuthClient();
export const { useSession, signIn, signOut } = authClient;
```

`apps/web/src/components/login-card.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Clapperboard, Mail } from "lucide-react";
import { FcGoogle } from "react-icons/fc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function LoginCard(): React.ReactElement {
  const [busy, setBusy] = useState(false);

  async function handleGoogle(): Promise<void> {
    setBusy(true);
    try {
      await authClient.signIn.social({ provider: "google", callbackURL: "/" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
          <Clapperboard className="h-5 w-5" />
        </span>
        <CardTitle>Sign in to UltraCreator</CardTitle>
        <CardDescription>Your everyday video studio.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button
          variant="outline"
          className="w-full justify-center gap-2"
          disabled={busy}
          onClick={() => void handleGoogle()}
        >
          <FcGoogle className="h-4 w-4" />
          Continue with Google
        </Button>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          or
          <span className="h-px flex-1 bg-border" />
        </div>
        {/* Email sign-in ships in a later phase — placeholder per spec §3. */}
        <div className="flex flex-col gap-2">
          <Input type="email" placeholder="you@example.com" disabled />
          <Button variant="secondary" className="w-full justify-center gap-2" disabled>
            <Mail className="h-4 w-4" />
            Email sign-in coming soon
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

(若 `Button` 没有 `outline`/`secondary` variant,改用该文件里实际存在的 variant,保持视觉一致即可。)

`apps/web/src/lib/server-session.ts`:

```ts
import { headers } from "next/headers";

// Server components talk to Fastify directly (no Next proxy on the server side).
const API_ORIGIN = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";

export interface ServerSession {
  user: { id: string; email: string; name: string; image?: string | null };
}

/** Resolve the login session inside a server component, or null. */
export async function getServerSession(): Promise<ServerSession | null> {
  const cookie = (await headers()).get("cookie");
  if (!cookie) return null;
  try {
    const res = await fetch(`${API_ORIGIN}/api/auth/get-session`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as ServerSession | null;
    return body?.user ? body : null;
  } catch {
    return null;
  }
}
```

`apps/web/src/app/login/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { LoginCard } from "@/components/login-card";
import { getServerSession } from "@/lib/server-session";

export default async function LoginPage(): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (session) redirect("/");
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <LoginCard />
    </main>
  );
}
```

- [ ] **Step 4: 写 server-session 测试**

`apps/web/test/lib/server-session.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

let cookieValue: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieValue ? { cookie: cookieValue } : {}),
}));

import { getServerSession } from "@/lib/server-session";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  cookieValue = null;
});

describe("getServerSession", () => {
  it("returns null without a cookie and does not call the API", async () => {
    expect(await getServerSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the session when the API recognizes the cookie", async () => {
    cookieValue = "better-auth.session_token=abc";
    const session = { user: { id: "u1", email: "a@x.com", name: "A", image: null } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(session), { status: 200 }));
    expect(await getServerSession()).toEqual(session);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/auth/get-session");
    expect((init as RequestInit).headers).toEqual({ cookie: cookieValue });
  });

  it("returns null when the API replies with JSON null (no session)", async () => {
    cookieValue = "better-auth.session_token=expired";
    fetchMock.mockResolvedValue(new Response("null", { status: 200 }));
    expect(await getServerSession()).toBeNull();
  });

  it("returns null when the API is unreachable", async () => {
    cookieValue = "better-auth.session_token=abc";
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await getServerSession()).toBeNull();
  });
});
```

- [ ] **Step 5: 运行测试**

```bash
pnpm exec vitest run apps/web/test/components/login-card.test.tsx apps/web/test/lib/server-session.test.ts
pnpm typecheck
```
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/auth-client.ts apps/web/src/lib/server-session.ts apps/web/src/components/login-card.tsx apps/web/src/app/login apps/web/test
git commit -m "feat(web): auth client, /login page, server-side session helper"
```

---

### Task 8: 页面守卫(/ 与 /s/[sid])

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/s/[sid]/page.tsx`
- Create: `apps/web/src/components/session-page-client.tsx`(把原 `/s/[sid]` 的 client 壳抽出)

- [ ] **Step 1: 改 `apps/web/src/app/page.tsx`(server component + 守卫)**

```tsx
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { HomePage } from "@/components/home-page";
import { getServerSession } from "@/lib/server-session";

export default async function Page(): Promise<React.ReactElement> {
  const session = await getServerSession();
  // 阶段⑤会把这里改成:未登录 → 渲染营销主页。
  if (!session) redirect("/login");
  return (
    <AppShell>
      <HomePage />
    </AppShell>
  );
}
```

- [ ] **Step 2: 改 `/s/[sid]`**

新建 `apps/web/src/components/session-page-client.tsx`(原 page 的 client 部分):

```tsx
"use client";
import { AppShell } from "@/components/app-shell";
import { SessionPage } from "@/components/session-page";

export function SessionPageClient({ sid }: { sid: string }): React.ReactElement {
  return (
    <AppShell>
      <SessionPage sid={sid} />
    </AppShell>
  );
}
```

`apps/web/src/app/s/[sid]/page.tsx` 全量替换为:

```tsx
import { redirect } from "next/navigation";
import { SessionPageClient } from "@/components/session-page-client";
import { getServerSession } from "@/lib/server-session";

export default async function Page({
  params,
}: {
  params: Promise<{ sid: string }>;
}): Promise<React.ReactElement> {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { sid } = await params;
  return <SessionPageClient sid={sid} />;
}
```

- [ ] **Step 3: 验证**

```bash
pnpm exec vitest run apps/web/test
pnpm typecheck
pnpm -F @ultracreator/web build
```
Expected: 测试与 typecheck 通过;`next build` 成功(验证 server/client 组件边界没拆错)。

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/page.tsx "apps/web/src/app/s/[sid]/page.tsx" apps/web/src/components/session-page-client.tsx
git commit -m "feat(web): require login for app home and session pages"
```

---

### Task 9: 侧边栏用户区 + 退出登录

**Files:**
- Create: `apps/web/src/components/sidebar-user.tsx`
- Modify: `apps/web/src/components/app-sidebar.tsx:119`(替换底部 tagline)
- Test: `apps/web/test/components/sidebar-user.test.tsx`
- Modify: `apps/web/test/components/app-sidebar.test.tsx`(mock auth-client)

- [ ] **Step 1: 写失败的测试**

`apps/web/test/components/sidebar-user.test.tsx`(文件头部约定照抄 `app-sidebar.test.tsx`;Radix 菜单交互依赖 vitest.setup 已有的 pointer stub):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarProvider } from "@/components/ui/sidebar";
import { SidebarUser } from "@/components/sidebar-user";

const signOutMock = vi.fn().mockResolvedValue(undefined);
let sessionData: { user: { id: string; email: string; name: string; image: string | null } } | null = null;

vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: () => signOutMock() },
  useSession: () => ({ data: sessionData, isPending: false }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

beforeEach(() => {
  signOutMock.mockClear();
  pushMock.mockClear();
  sessionData = { user: { id: "u1", email: "a@x.com", name: "Alice", image: null } };
});

function renderUser() {
  return render(
    <SidebarProvider>
      <SidebarUser />
    </SidebarProvider>,
  );
}

describe("SidebarUser", () => {
  it("renders nothing while logged out", () => {
    sessionData = null;
    const { container } = renderUser();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows name and email", () => {
    renderUser();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("a@x.com")).toBeInTheDocument();
  });

  it("signs out and navigates to /login", async () => {
    renderUser();
    await userEvent.click(screen.getByRole("button", { name: /account menu/i }));
    await userEvent.click(await screen.findByText(/sign out/i));
    expect(signOutMock).toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledWith("/login");
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
pnpm exec vitest run apps/web/test/components/sidebar-user.test.tsx
```
Expected: FAIL(组件不存在)。

- [ ] **Step 3: 实现 `apps/web/src/components/sidebar-user.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSidebar } from "@/components/ui/sidebar";
import { authClient, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

export function SidebarUser(): React.ReactElement | null {
  const { open } = useSidebar();
  const router = useRouter();
  const { data: session } = useSession();
  if (!session) return null;
  const { name, email, image } = session.user;
  const initials = (name || email || "?").slice(0, 2).toUpperCase();

  async function handleSignOut(): Promise<void> {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="border-t border-border/60 px-2 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-card/60",
              !open && "justify-center px-0",
            )}
          >
            <Avatar className="h-7 w-7">
              {image ? <AvatarImage src={image} alt={name} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            {open && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-xs text-muted-foreground">{email}</span>
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
            {email}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void handleSignOut()}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

`apps/web/src/components/app-sidebar.tsx`:顶部加 `import { SidebarUser } from "@/components/sidebar-user";`,并把

```tsx
      {open && <div className="px-4 py-3 text-xs text-muted-foreground/70">Your everyday video studio.</div>}
```

替换为:

```tsx
      <SidebarUser />
```

- [ ] **Step 4: 更新 `apps/web/test/components/app-sidebar.test.tsx`**

文件顶部(其他 vi.mock 旁)加,防止真实 auth-client 在 jsdom 里发请求:

```tsx
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: vi.fn() },
  useSession: () => ({ data: null, isPending: false }),
}));
```

- [ ] **Step 5: 运行测试**

```bash
pnpm exec vitest run apps/web/test
pnpm typecheck
```
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/sidebar-user.tsx apps/web/src/components/app-sidebar.tsx apps/web/test/components
git commit -m "feat(web): sidebar account section with sign-out"
```

---

### Task 10: 全量回归 + 手工端到端验收

**Files:** 无新增(验收 + 可能的小修)

- [ ] **Step 1: 全量自动化验证**

```bash
pnpm test
pnpm typecheck
pnpm -F @ultracreator/web build
```
Expected: 全部通过。

- [ ] **Step 2: 手工端到端验收清单**

前置:确认 Google Console 已加 redirect URI(见计划头部);`pnpm dev:server` + `pnpm dev:web` 都在跑。

1. 访问 `http://localhost:3000/` → 重定向到 `/login`。
2. 点 "Continue with Google" → Google 授权 → 回跳 `/` → 看到应用首页(模式选择 + 侧边栏)。
3. 侧边栏左下角显示头像/名字/邮箱;`psql -h localhost -U admin -d ultracreator -c 'select id, email from "user";'` 能看到该用户。
4. 创建一个会话发一条消息 → SSE 输出正常流式出现(**这是 SSE 过 Next 代理的最终验证**;若输出整段卡住后一次性出现 = 代理缓冲,执行 Task 6 Step 5 的回退方案)。
5. 打开浏览器无痕窗口访问 `/s/<刚才的sid>` → 重定向 `/login`;`curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/api/sessions` → 401。
6. 侧边栏下拉点 "Sign out" → 回到 `/login`,再访问 `/` 仍被重定向。

- [ ] **Step 3: 验收中发现的问题就地修复并补测试,然后最终提交**

```bash
git status   # 确认无遗漏
git add -A && git commit -m "chore: phase1 acceptance fixes" # 仅当有修复时
```

---

## 自查记录(写计划时已核对)

- 阶段①spec 范围逐条对应:PG 接入(Task 2)、Better Auth+Google(Task 3/5)、同源改造与 SSE 风险验证(Task 6/10)、`/api/sessions*` 守卫(Task 4)、登录页(Task 7)、页面守卫(Task 8)、侧边栏用户区+退出(Task 9)、PG 失败 fail-fast(Task 5 migrate 即连接)、邮箱登录预留(Task 3 accountLinking + Task 7 placeholder)。
- 类型一致性:`AuthService`/`AuthUser`(Task 3 定义,Task 4/7 引用)、`fakeAuthService(user|null)`(Task 4 定义并使用)、`getServerSession→ServerSession`(Task 7 定义,Task 8 引用)、`createSessionGuard`/`registerAuthRoutes`(Task 3 定义,Task 4 使用)签名一致。
- UI 组件引用均已核实存在:`ui/avatar`(Avatar/AvatarImage/AvatarFallback)、`ui/dropdown-menu`(全套)、`ui/card`、`ui/input`、`ui/button`、`useSidebar`、`react-icons`(FcGoogle)。
- 已知现有测试影响面:`apps/server/test` 中构造 AppDeps 的文件(Task 4 Step 4 用 grep 找全);web 侧 `app-sidebar.test.tsx` 需 mock auth-client(Task 9 Step 4);其余 web 测试显式设置 NEXT_PUBLIC_API_URL,不受 apiBase 改动影响。
