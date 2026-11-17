# Email Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email registration (12-char letter+digit+symbol password), 6-digit email-code verification via Resend, email+password login, and email→Google account linking — on top of the existing better-auth foundation.

**Architecture:** Enable better-auth's `emailAndPassword` provider + `emailOTP` plugin (code on signup), inject a Resend-backed `EmailService` that renders the existing `email-templates/verification-code.html`, enforce password complexity in a `/sign-up/email` before-hook using a validator shared from `packages/shared`, and refactor the login card into mode-switching auth components. Account linking is already configured (`trustedProviders: ["google"]`) — no code change, verified manually.

**Tech Stack:** TypeScript, better-auth 1.6.16, Drizzle + PostgreSQL, Fastify, Resend, Next.js 15 / React 19, vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-06-24-email-auth-design.md`

**Conventions used below**
- Run one test file: `pnpm exec vitest run <path>` (PG files: same command — single file doesn't hit the multi-file race).
- Full suite: `pnpm test`. Types: `pnpm typecheck`.
- Web test files start with `// @vitest-environment jsdom` and mock `@/lib/auth-client` via `vi.mock`.
- Commit after each task on the current `claude/*` branch.

---

## Task 0: Install deps + add Resend + baseline

**Files:**
- Modify: `apps/server/package.json` (adds `resend` dependency)
- Create: `apps/server/.env` (gitignored — NOT committed)

- [ ] **Step 1: Install workspace deps and add Resend**

Run: `pnpm install --frozen-lockfile` then `pnpm --filter @ultracreator/server add resend`
Expected: install completes; `resend` appears under `apps/server/package.json` dependencies; lockfile updates.

- [ ] **Step 2: Create the local server `.env` (gitignored, never committed)**

The repo has no `.env` in a fresh worktree. Create `apps/server/.env` with the dev values. Use the **Resend API key the user provided in the original request** (do NOT paste it into any committed file). Minimum contents:

```
DATABASE_URL=postgres://admin@localhost:5432/ultracreator
BETTER_AUTH_SECRET=dev-secret-change-me-0000000000000000000000=
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=dev-google-client-id
GOOGLE_CLIENT_SECRET=dev-google-client-secret
GEMINI_API_KEY=dev-gemini-key
RESEND_API_KEY=<the key from the user's request>
EMAIL_FROM=UltraVora <noreply@support.ultra-vora.com>
OTP_EXPIRES_MINUTES=15
```

Verify it is ignored: `git check-ignore apps/server/.env` → prints the path (ignored).

- [ ] **Step 3: Baseline the test suite**

Run: `pnpm test`
Expected: existing suites pass (this confirms the toolchain works before changes).

- [ ] **Step 4: Commit the dependency change**

```bash
git add apps/server/package.json pnpm-lock.yaml
git commit -m "chore(server): add resend dependency for transactional email"
```

---

## Task 1: Shared password policy validator

**Files:**
- Create: `packages/shared/src/password.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/password.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/test/password.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { checkPassword, passwordPolicyMessage, PASSWORD_MIN_LENGTH } from "../src/password.js";

describe("checkPassword", () => {
  it("accepts a 12+ char password with a letter, digit, and symbol", () => {
    const { ok, rules } = checkPassword("Abcdef12345!");
    expect(ok).toBe(true);
    expect(rules).toEqual({ minLength: true, hasLetter: true, hasDigit: true, hasSymbol: true });
  });
  it("rejects when shorter than 12", () => {
    const { ok, rules } = checkPassword("Ab1!xyz");
    expect(ok).toBe(false);
    expect(rules.minLength).toBe(false);
  });
  it("rejects when missing a letter", () => {
    expect(checkPassword("123456789012!").rules.hasLetter).toBe(false);
  });
  it("rejects when missing a digit", () => {
    expect(checkPassword("abcdefghij!!").rules.hasDigit).toBe(false);
  });
  it("rejects when missing a symbol", () => {
    expect(checkPassword("abcdef123456").rules.hasSymbol).toBe(false);
  });
  it("exposes the min length and a human message mentioning 12", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordPolicyMessage()).toMatch(/12/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run packages/shared/test/password.test.ts`
Expected: FAIL — cannot resolve `../src/password.js`.

- [ ] **Step 3: Implement the validator**

`packages/shared/src/password.ts`:

```ts
// Single source of truth for the email-signup password policy, shared by the
// server (better-auth /sign-up/email hook) and the web sign-up form so the
// rules can never drift. Policy: >= 12 chars AND a letter AND a digit AND a symbol.

export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordRuleStatus {
  minLength: boolean;
  hasLetter: boolean;
  hasDigit: boolean;
  hasSymbol: boolean;
}

export function checkPassword(password: string): { ok: boolean; rules: PasswordRuleStatus } {
  const rules: PasswordRuleStatus = {
    minLength: password.length >= PASSWORD_MIN_LENGTH,
    hasLetter: /[A-Za-z]/.test(password),
    hasDigit: /[0-9]/.test(password),
    hasSymbol: /[^A-Za-z0-9]/.test(password),
  };
  return { ok: Object.values(rules).every(Boolean), rules };
}

export function passwordPolicyMessage(): string {
  return `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include a letter, a number, and a symbol.`;
}
```

- [ ] **Step 4: Export from the package index**

Append to `packages/shared/src/index.ts`:

```ts
export * from "./password.js";
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run packages/shared/test/password.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/password.ts packages/shared/src/index.ts packages/shared/test/password.test.ts
git commit -m "feat(shared): add password policy validator (>=12, letter+digit+symbol)"
```

---

## Task 2: Verification email template renderer

**Files:**
- Create: `apps/server/src/email/template.ts`
- Test: `apps/server/test/email/template.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/test/email/template.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderVerificationEmail, loadVerificationTemplate } from "../../src/email/template.js";

const template = `<p>Code: {{VERIFICATION_CODE}}</p><p>Expires in {{EXPIRES_IN}}.</p>`;

describe("renderVerificationEmail", () => {
  it("replaces both placeholders", () => {
    const html = renderVerificationEmail({ code: "123456", expiresInMinutes: 15, template });
    expect(html).toContain("123456");
    expect(html).toContain("15 minutes");
    expect(html).not.toContain("{{");
  });
  it("singularizes a 1-minute expiry", () => {
    expect(renderVerificationEmail({ code: "000000", expiresInMinutes: 1, template })).toContain("1 minute.");
  });
  it("throws if any mustache placeholder is left unreplaced", () => {
    expect(() =>
      renderVerificationEmail({ code: "1", expiresInMinutes: 5, template: "{{VERIFICATION_CODE}} {{UNKNOWN}}" }),
    ).toThrow(/UNKNOWN/);
  });
});

describe("loadVerificationTemplate", () => {
  it("reads the real UltraVora template from the repo", () => {
    const html = loadVerificationTemplate();
    expect(html).toContain("{{VERIFICATION_CODE}}");
    expect(html).toContain("UltraVora");
  });
  it("throws when the directory has no template", () => {
    expect(() => loadVerificationTemplate("/no/such/dir")).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/server/test/email/template.test.ts`
Expected: FAIL — cannot resolve `../../src/email/template.js`.

- [ ] **Step 3: Implement the renderer**

`apps/server/src/email/template.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve relative to THIS module (not cwd) so it works from any worktree and
// in dev (tsx runs from src/). Override with EMAIL_TEMPLATES_DIR for deploys
// that don't ship the repo-root email-templates/ directory.
function defaultTemplatesDir(): string {
  // apps/server/src/email/template.ts -> repo root is four levels up.
  return join(dirname(fileURLToPath(import.meta.url)), "../../../../email-templates");
}

export function templatesDir(): string {
  return process.env.EMAIL_TEMPLATES_DIR || defaultTemplatesDir();
}

export function loadVerificationTemplate(dir = templatesDir()): string {
  // Throws ENOENT (with the offending path) if the template is missing.
  return readFileSync(join(dir, "verification-code.html"), "utf8");
}

function humanizeMinutes(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function renderVerificationEmail(args: {
  code: string;
  expiresInMinutes: number;
  /** Pre-loaded template; defaults to reading the repo template. */
  template?: string;
}): string {
  const tpl = args.template ?? loadVerificationTemplate();
  const html = tpl
    .replaceAll("{{VERIFICATION_CODE}}", args.code)
    .replaceAll("{{EXPIRES_IN}}", humanizeMinutes(args.expiresInMinutes));
  const leftover = html.match(/\{\{[^}]+\}\}/);
  if (leftover) {
    throw new Error(`Verification email has an unreplaced placeholder: ${leftover[0]}`);
  }
  return html;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/server/test/email/template.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/email/template.ts apps/server/test/email/template.test.ts
git commit -m "feat(server): render verification-code email template"
```

---

## Task 3: EmailService interface + Resend implementation

**Files:**
- Create: `apps/server/src/email/email-service.ts`
- Create: `apps/server/src/email/resend-email-service.ts`
- Test: `apps/server/test/email/resend-email-service.test.ts`

- [ ] **Step 1: Define the interface (no test — pure type seam)**

`apps/server/src/email/email-service.ts`:

```ts
export interface VerificationEmail {
  to: string;
  code: string;
  expiresInMinutes: number;
}

/**
 * Narrow seam over the email provider so auth wiring and tests never import
 * Resend directly (mirrors the AuthService pattern). Tests inject a fake.
 */
export interface EmailService {
  sendVerificationCode(email: VerificationEmail): Promise<void>;
}
```

- [ ] **Step 2: Write the failing test**

`apps/server/test/email/resend-email-service.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ResendEmailService, type SendEmail } from "../../src/email/resend-email-service.js";

const template = `<p>{{VERIFICATION_CODE}} / {{EXPIRES_IN}}</p>`;

describe("ResendEmailService", () => {
  it("sends the rendered template with the configured from + subject", async () => {
    const send = vi.fn<Parameters<SendEmail>, ReturnType<SendEmail>>().mockResolvedValue({ error: null });
    const svc = new ResendEmailService({
      apiKey: "x",
      from: "UltraVora <noreply@support.ultra-vora.com>",
      send,
      template,
    });
    await svc.sendVerificationCode({ to: "a@b.com", code: "654321", expiresInMinutes: 15 });
    expect(send).toHaveBeenCalledOnce();
    const arg = send.mock.calls[0][0];
    expect(arg.from).toBe("UltraVora <noreply@support.ultra-vora.com>");
    expect(arg.to).toBe("a@b.com");
    expect(arg.subject).toBe("Your UltraVora verification code");
    expect(arg.html).toContain("654321");
    expect(arg.html).toContain("15 minutes");
  });

  it("throws when Resend returns an error", async () => {
    const send: SendEmail = async () => ({ error: { message: "domain not verified" } });
    const svc = new ResendEmailService({ apiKey: "x", from: "f@x.com", send, template });
    await expect(
      svc.sendVerificationCode({ to: "a@b.com", code: "111111", expiresInMinutes: 5 }),
    ).rejects.toThrow(/domain not verified/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm exec vitest run apps/server/test/email/resend-email-service.test.ts`
Expected: FAIL — cannot resolve `../../src/email/resend-email-service.js`.

- [ ] **Step 4: Implement the service**

`apps/server/src/email/resend-email-service.ts`:

```ts
import { Resend } from "resend";
import type { EmailService, VerificationEmail } from "./email-service.js";
import { loadVerificationTemplate, renderVerificationEmail, templatesDir } from "./template.js";

/** The single Resend send shape we depend on (injectable for tests). */
export type SendEmail = (args: {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
}) => Promise<{ error: { message: string } | null }>;

export interface ResendEmailServiceOptions {
  apiKey: string;
  from: string;
  /** Injected in tests; defaults to a real Resend client's emails.send. */
  send?: SendEmail;
  /** Pre-loaded template (tests); defaults to reading the repo template once. */
  template?: string;
}

const SUBJECT = "Your UltraVora verification code";

export class ResendEmailService implements EmailService {
  private readonly from: string;
  private readonly send: SendEmail;
  private readonly template: string;

  constructor(opts: ResendEmailServiceOptions) {
    this.from = opts.from;
    this.template = opts.template ?? loadVerificationTemplate(templatesDir());
    this.send =
      opts.send ??
      (((args) => new Resend(opts.apiKey).emails.send(args)) as unknown as SendEmail);
  }

  async sendVerificationCode({ to, code, expiresInMinutes }: VerificationEmail): Promise<void> {
    const html = renderVerificationEmail({ code, expiresInMinutes, template: this.template });
    const { error } = await this.send({ from: this.from, to, subject: SUBJECT, html });
    if (error) throw new Error(`Resend failed to send verification code: ${error.message}`);
  }
}
```

Note: the real `resend` `emails.send` returns `{ data, error }`; the cast narrows it to our `SendEmail` shape. Confirm the field names against the installed `resend` package during implementation and adjust the cast if needed.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm exec vitest run apps/server/test/email/resend-email-service.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/email/email-service.ts apps/server/src/email/resend-email-service.ts apps/server/test/email/resend-email-service.test.ts
git commit -m "feat(server): Resend-backed EmailService for verification codes"
```

---

## Task 4: Wire emailAndPassword + emailOTP + complexity hook into better-auth

**Files:**
- Modify: `apps/server/src/auth/better-auth.ts`
- Test: `apps/server/test/auth/better-auth.test.ts` (extend + fix existing `base`)

- [ ] **Step 1: Write the failing test additions**

In `apps/server/test/auth/better-auth.test.ts`, add a fake email to the shared `base` object and a new describe block. First update `base`:

```ts
const base = {
  baseURL: "http://localhost:3000",
  secret: "test-secret",
  google: { clientId: "id", clientSecret: "secret" },
  email: { sendVerificationCode: async () => {} },
};
```

Then append:

```ts
describe("buildAuthConfig email/password", () => {
  it("enables email+password with the 12-char minimum and required verification", () => {
    const cfg = buildAuthConfig(base);
    expect(cfg.emailAndPassword).toMatchObject({
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
    });
  });
  it("registers the emailOTP plugin", () => {
    const cfg = buildAuthConfig(base);
    expect(Array.isArray(cfg.plugins)).toBe(true);
    expect((cfg.plugins ?? []).length).toBeGreaterThan(0);
  });
  it("keeps google as a trusted linking provider", () => {
    const cfg = buildAuthConfig(base);
    expect(cfg.account?.accountLinking?.trustedProviders).toContain("google");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/server/test/auth/better-auth.test.ts`
Expected: FAIL — `cfg.emailAndPassword` is undefined / type error on `email` in `base`.

- [ ] **Step 3: Implement the config changes**

In `apps/server/src/auth/better-auth.ts`:

Add imports at the top:

```ts
import { emailOTP } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { checkPassword, passwordPolicyMessage } from "@ultracreator/shared";
import type { EmailService } from "../email/email-service.js";
```

Extend `CreateAuthOptions` (add two fields):

```ts
  /** Sends the 6-digit verification code email (Resend in prod, fake in tests). */
  email: EmailService;
  /** Verification-code lifetime in minutes. Default 15. */
  otpExpiresMinutes?: number;
```

Inside `buildAuthConfig`'s returned object, add these keys (alongside the existing `socialProviders` / `account` / `trustedOrigins`):

```ts
    emailAndPassword: {
      enabled: true,
      // Block password login until the email code is verified — also keeps the
      // later email->Google account link safe from takeover.
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: (opts.otpExpiresMinutes ?? 15) * 60,
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        sendVerificationOTP: async ({ email, otp }) => {
          await opts.email.sendVerificationCode({
            to: email,
            code: otp,
            expiresInMinutes: opts.otpExpiresMinutes ?? 15,
          });
        },
      }),
    ],
    hooks: {
      // better-auth only enforces length natively — enforce letter/digit/symbol
      // complexity on the signup path using the shared policy.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email") return;
        const password = (ctx.body as { password?: string } | undefined)?.password ?? "";
        if (!checkPassword(password).ok) {
          throw new APIError("BAD_REQUEST", { message: passwordPolicyMessage() });
        }
      }),
    },
```

Note: pin `emailOTP` option names (`sendVerificationOnSignUp`, `overrideDefaultEmailVerification`, `sendVerificationOTP`) and the `better-auth/plugins` / `better-auth/api` import paths against the installed v1.6.16 (introspect `node_modules/better-auth` after Task 0). The flow is robust to minor renames.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/server/test/auth/better-auth.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Confirm no DB migration is needed**

Run: `pnpm --filter @ultracreator/server db:generate`
Expected: "No schema changes, nothing to migrate." (The `account.password`, `user.emailVerified`, and `verification` table already exist.) If a diff IS produced, commit the generated SQL and run `pnpm --filter @ultracreator/server db:migrate` against the dev DB before continuing.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth/better-auth.ts apps/server/test/auth/better-auth.test.ts
git commit -m "feat(server): enable email+password + emailOTP with password complexity hook"
```

---

## Task 5: Bootstrap wiring + env documentation

**Files:**
- Modify: `apps/server/src/api/server.ts`
- Modify: `apps/server/.env.example`

- [ ] **Step 1: Add env reads + build the EmailService in server.ts**

In `apps/server/src/api/server.ts`, add the import near the other auth imports:

```ts
import { ResendEmailService } from "../email/resend-email-service.js";
```

After the `GOOGLE_CLIENT_SECRET` line in the Environment section, add:

```ts
const RESEND_API_KEY = required("RESEND_API_KEY");
const EMAIL_FROM = process.env.EMAIL_FROM ?? "UltraVora <noreply@support.ultra-vora.com>";
const OTP_EXPIRES_MINUTES = Number(process.env.OTP_EXPIRES_MINUTES ?? 15);
```

In the "Database + auth" section, build the email service just before `createAuth`:

```ts
const email = new ResendEmailService({ apiKey: RESEND_API_KEY, from: EMAIL_FROM });
```

Pass it into the `createAuth({ ... })` call (add two properties):

```ts
  email,
  otpExpiresMinutes: OTP_EXPIRES_MINUTES,
```

- [ ] **Step 2: Document the new env vars**

Append to `apps/server/.env.example`:

```
# Resend transactional email (verification codes). Get a key at resend.dev.
RESEND_API_KEY=<resend api key>
# From address for verification emails. The domain must be verified in Resend.
EMAIL_FROM=UltraVora <noreply@support.ultra-vora.com>
# Optional: verification-code lifetime in minutes (default 15).
OTP_EXPIRES_MINUTES=15
# Optional: directory holding verification-code.html. Defaults to the repo-root
# email-templates/. Set this if apps/server is deployed without that directory.
EMAIL_TEMPLATES_DIR=
```

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS (server compiles with the new wiring).

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/api/server.ts apps/server/.env.example
git commit -m "feat(server): wire Resend EmailService into auth bootstrap + document env"
```

---

## Task 6: Integration test — signup → code → verify → login (real PG)

**Files:**
- Test: `apps/server/test/auth/email-signup.pg.test.ts`

This drives the full flow through `auth.handler` (the same HTTP path production uses) against a real local Postgres, with a fake `EmailService` capturing the code. Requires local PG (same as the existing `migrations.pg.test.ts`).

- [ ] **Step 1: Write the integration test**

`apps/server/test/auth/email-signup.pg.test.ts`:

```ts
// Integration test against real local PG: email signup sends a 6-digit code,
// verification flips emailVerified + issues a session, and login is gated on it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as schema from "../../src/db/schema/index.js";
import { createAuth } from "../../src/auth/better-auth.js";
import type { EmailService } from "../../src/email/email-service.js";

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgres://admin@localhost:5432/postgres";
const TEST_URL = process.env.TEST_DATABASE_URL ?? "postgres://admin@localhost:5432/ultracreator_test";
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

const dbName = new URL(TEST_URL).pathname.slice(1);
if (!dbName.endsWith("_test") || !/^[a-z0-9_]+$/.test(dbName)) {
  throw new Error(`Refusing to run against unsafe test DB name "${dbName}"`);
}

let pool: pg.Pool;
let db: ReturnType<typeof drizzle>;
const sent: { to: string; code: string }[] = [];
const fakeEmail: EmailService = {
  async sendVerificationCode({ to, code }) {
    sent.push({ to, code });
  },
};

function buildAuth() {
  return createAuth({
    db,
    baseURL: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-0000",
    google: { clientId: "id", clientSecret: "secret" },
    email: fakeEmail,
    otpExpiresMinutes: 15,
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(`CREATE DATABASE ${dbName}`).catch((e: { code?: string }) => {
    if (e.code !== "42P04") throw e;
  });
  await admin.end();
  pool = new pg.Pool({ connectionString: TEST_URL });
  db = drizzle(pool, { schema });
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db, { migrationsFolder });
});

afterAll(async () => {
  await pool?.end();
});

describe("email signup + verification (PG)", () => {
  const email = "newuser@example.com";
  const password = "Abcdef12345!"; // valid per policy

  it("rejects a weak password with 400 and creates no user", async () => {
    const auth = buildAuth();
    const res = await auth.handler(post("/sign-up/email", { email: "weak@example.com", password: "short1!", name: "weak" }));
    expect(res.status).toBe(400);
    const rows = await db.select().from(schema.user).where(eq(schema.user.email, "weak@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("signs up, emails a 6-digit code, and leaves the email unverified", async () => {
    const auth = buildAuth();
    sent.length = 0;
    const res = await auth.handler(post("/sign-up/email", { email, password, name: "newuser" }));
    expect(res.status).toBeLessThan(400);
    const mine = sent.filter((s) => s.to === email);
    expect(mine).toHaveLength(1);
    expect(mine[0].code).toMatch(/^\d{6}$/);
    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    expect(u.emailVerified).toBe(false);
  });

  it("blocks password login before verification", async () => {
    const auth = buildAuth();
    const res = await auth.handler(post("/sign-in/email", { email, password }));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("verifies with the emailed code, flips emailVerified, and then allows login", async () => {
    const auth = buildAuth();
    const code = sent.filter((s) => s.to === email).at(-1)!.code;
    const verifyRes = await auth.handler(post("/email-otp/verify-email", { email, otp: code }));
    expect(verifyRes.status).toBeLessThan(400);
    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    expect(u.emailVerified).toBe(true);

    const loginRes = await auth.handler(post("/sign-in/email", { email, password }));
    expect(loginRes.status).toBeLessThan(400);
    expect(loginRes.headers.getSetCookie().join(";")).toContain("better-auth");
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `pnpm exec vitest run apps/server/test/auth/email-signup.pg.test.ts`
Expected: PASS (4 tests). If the emailOTP verify path differs from `/email-otp/verify-email`, introspect the installed plugin's registered endpoints (`node_modules/better-auth/dist/plugins/email-otp`) and adjust the path; the rest of the flow is unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/server/test/auth/email-signup.pg.test.ts
git commit -m "test(server): integration — email signup, code verify, login gating (PG)"
```

---

## Task 7: Add emailOTP client plugin to the web auth client

**Files:**
- Modify: `apps/web/src/lib/auth-client.ts`

- [ ] **Step 1: Add the plugin**

Replace the body of `apps/web/src/lib/auth-client.ts` with:

```ts
import "client-only";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { apiBase } from "./api-base";

// Auth shares the API origin (one URL to configure). NEXT_PUBLIC_API_URL unset →
// same-origin /api/auth/* through the Next rewrite to Fastify (dev). Set it to
// the API origin → /api/auth goes there directly (prod subdomains).
const base = apiBase();
export const authClient = createAuthClient({
  ...(base ? { baseURL: base } : {}),
  plugins: [emailOTPClient()],
});

type AuthClient = typeof authClient;
export const useSession: AuthClient["useSession"] = authClient.useSession;
export const signIn: AuthClient["signIn"] = authClient.signIn;
export const signOut: AuthClient["signOut"] = authClient.signOut;
```

Note: the previous `ReturnType<typeof createAuthClient>` annotation existed to dodge TS2742; with a plugin we need the inferred type (so `authClient.emailOtp` is typed). If `pnpm typecheck` reports TS2742 ("cannot be named") on `authClient`, the remedy is to keep the inferred `const` and re-export the sub-namespaces via `typeof authClient` (as above) rather than re-annotating the whole client.

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS — `authClient.emailOtp`, `authClient.signUp.email`, `authClient.signIn.email` are all typed.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/auth-client.ts
git commit -m "feat(web): add emailOTP client plugin to auth client"
```

---

## Task 8: GoogleButton component (extracted)

**Files:**
- Create: `apps/web/src/components/auth/google-button.tsx`
- Test: `apps/web/test/components/auth/google-button.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/test/components/auth/google-button.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoogleButton } from "@/components/auth/google-button";

const socialMock = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { social: (args: unknown) => socialMock(args) } },
}));

const originalLocation = window.location;
beforeEach(() => {
  socialMock.mockReset();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...originalLocation, href: "http://localhost:3000/login" },
  });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("GoogleButton", () => {
  it("starts Google sign-in with the callback and redirects to the provider URL", async () => {
    socialMock.mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }, error: null });
    render(<GoogleButton callbackURL="/dashboard" />);
    await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(socialMock).toHaveBeenCalledWith({ provider: "google", callbackURL: "/dashboard" });
    expect(window.location.href).toBe("https://accounts.google.com/o/oauth2/v2/auth?x=1");
  });

  it("shows an inline error when sign-in returns no URL", async () => {
    socialMock.mockResolvedValue({ data: null, error: null });
    render(<GoogleButton />);
    await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/google sign-in failed/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/web/test/components/auth/google-button.test.tsx`
Expected: FAIL — cannot resolve `@/components/auth/google-button`.

- [ ] **Step 3: Implement the component**

`apps/web/src/components/auth/google-button.tsx`:

```tsx
"use client";
import { useState } from "react";
import { FcGoogle } from "react-icons/fc";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function GoogleButton({ callbackURL = "/" }: { callbackURL?: string }): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGoogle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { data, error: signInError } = await authClient.signIn.social({ provider: "google", callbackURL });
      if (signInError || !data?.url) {
        setError("Google sign-in failed. Please try again.");
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Could not reach the sign-in service. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" className="w-full justify-center gap-2" disabled={busy} onClick={() => void handleGoogle()}>
        <FcGoogle className="h-4 w-4" />
        Continue with Google
      </Button>
      {error && <p role="alert" className="text-center text-xs text-destructive">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/web/test/components/auth/google-button.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/auth/google-button.tsx apps/web/test/components/auth/google-button.test.tsx
git commit -m "feat(web): extract GoogleButton auth component"
```

---

## Task 9: PasswordPolicyHint component

**Files:**
- Create: `apps/web/src/components/auth/password-policy-hint.tsx`
- Test: `apps/web/test/components/auth/password-policy-hint.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/test/components/auth/password-policy-hint.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PasswordPolicyHint } from "@/components/auth/password-policy-hint";

describe("PasswordPolicyHint", () => {
  it("marks all four rules met for a valid password", () => {
    const { container } = render(<PasswordPolicyHint password="Abcdef12345!" />);
    expect(container.querySelectorAll('[data-met="true"]')).toHaveLength(4);
  });
  it("marks only satisfied rules for a partial password", () => {
    // 'abc' -> letter only: minLength=false, hasLetter=true, hasDigit=false, hasSymbol=false
    const { container } = render(<PasswordPolicyHint password="abc" />);
    expect(container.querySelectorAll('[data-met="true"]')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/web/test/components/auth/password-policy-hint.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement the component**

`apps/web/src/components/auth/password-policy-hint.tsx`:

```tsx
import { Check, X } from "lucide-react";
import { checkPassword, PASSWORD_MIN_LENGTH, type PasswordRuleStatus } from "@ultracreator/shared";

const RULES: { key: keyof PasswordRuleStatus; label: string }[] = [
  { key: "minLength", label: `At least ${PASSWORD_MIN_LENGTH} characters` },
  { key: "hasLetter", label: "A letter" },
  { key: "hasDigit", label: "A number" },
  { key: "hasSymbol", label: "A symbol" },
];

export function PasswordPolicyHint({ password }: { password: string }): React.ReactElement {
  const { rules } = checkPassword(password);
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {RULES.map((r) => {
        const met = rules[r.key];
        return (
          <li
            key={r.key}
            data-met={met}
            className={met ? "flex items-center gap-1.5 text-emerald-600" : "flex items-center gap-1.5 text-muted-foreground"}
          >
            {met ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
            {r.label}
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/web/test/components/auth/password-policy-hint.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/auth/password-policy-hint.tsx apps/web/test/components/auth/password-policy-hint.test.tsx
git commit -m "feat(web): live password policy hint component"
```

---

## Task 10: SignUpForm component

**Files:**
- Create: `apps/web/src/components/auth/sign-up-form.tsx`
- Test: `apps/web/test/components/auth/sign-up-form.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/test/components/auth/sign-up-form.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignUpForm } from "@/components/auth/sign-up-form";

const signUpEmail = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { signUp: { email: (args: unknown) => signUpEmail(args) } },
}));

beforeEach(() => signUpEmail.mockReset());

describe("SignUpForm", () => {
  it("keeps submit disabled until email + valid password are entered", async () => {
    render(<SignUpForm onSent={vi.fn()} />);
    const submit = screen.getByRole("button", { name: /create account/i });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "a@b.com");
    await userEvent.type(screen.getByPlaceholderText(/create a password/i), "Abcdef12345!");
    expect(submit).toBeEnabled();
  });

  it("signs up with a name derived from the email and calls onSent", async () => {
    signUpEmail.mockResolvedValue({ data: {}, error: null });
    const onSent = vi.fn();
    render(<SignUpForm onSent={onSent} />);
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "alice@b.com");
    await userEvent.type(screen.getByPlaceholderText(/create a password/i), "Abcdef12345!");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(signUpEmail).toHaveBeenCalledWith({ email: "alice@b.com", password: "Abcdef12345!", name: "alice" });
    expect(onSent).toHaveBeenCalledWith("alice@b.com");
  });

  it("shows an already-registered message and does not advance", async () => {
    signUpEmail.mockResolvedValue({ data: null, error: { code: "USER_ALREADY_EXISTS", message: "exists" } });
    const onSent = vi.fn();
    render(<SignUpForm onSent={onSent} />);
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "alice@b.com");
    await userEvent.type(screen.getByPlaceholderText(/create a password/i), "Abcdef12345!");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already registered/i);
    expect(onSent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/web/test/components/auth/sign-up-form.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement the component**

`apps/web/src/components/auth/sign-up-form.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { checkPassword } from "@ultracreator/shared";
import { PasswordPolicyHint } from "./password-policy-hint";

export function SignUpForm({ onSent }: { onSent: (email: string) => void }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = email.includes("@") && checkPassword(password).ok;

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    const name = email.split("@")[0] || email;
    const { error: signUpError } = await authClient.signUp.email({ email, password, name });
    if (signUpError) {
      setBusy(false);
      const exists = signUpError.code === "USER_ALREADY_EXISTS" || /exist/i.test(signUpError.message ?? "");
      setError(exists ? "This email is already registered — try signing in." : (signUpError.message ?? "Sign-up failed. Please try again."));
      return;
    }
    onSent(email);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
      <Input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <Input type="password" placeholder="Create a password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      <PasswordPolicyHint password={password} />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={!valid || busy}>Create account</Button>
    </form>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/web/test/components/auth/sign-up-form.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/auth/sign-up-form.tsx apps/web/test/components/auth/sign-up-form.test.tsx
git commit -m "feat(web): email sign-up form with live password policy"
```

---

## Task 11: OtpVerifyForm component

**Files:**
- Create: `apps/web/src/components/auth/otp-verify-form.tsx`
- Test: `apps/web/test/components/auth/otp-verify-form.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/test/components/auth/otp-verify-form.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OtpVerifyForm } from "@/components/auth/otp-verify-form";

const verifyEmail = vi.fn();
const sendOtp = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { emailOtp: { verifyEmail: (a: unknown) => verifyEmail(a), sendVerificationOtp: (a: unknown) => sendOtp(a) } },
}));

const originalLocation = window.location;
beforeEach(() => {
  verifyEmail.mockReset();
  sendOtp.mockReset();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalLocation, href: "http://localhost:3000/login" } });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("OtpVerifyForm", () => {
  it("verifies the code and redirects to the callback on success", async () => {
    verifyEmail.mockResolvedValue({ data: {}, error: null });
    render(<OtpVerifyForm email="a@b.com" callbackURL="/dashboard" />);
    await userEvent.type(screen.getByPlaceholderText("123456"), "654321");
    await userEvent.click(screen.getByRole("button", { name: /verify & continue/i }));
    expect(verifyEmail).toHaveBeenCalledWith({ email: "a@b.com", otp: "654321" });
    expect(window.location.href).toBe("/dashboard");
  });

  it("shows an error for an invalid code", async () => {
    verifyEmail.mockResolvedValue({ data: null, error: { message: "bad" } });
    render(<OtpVerifyForm email="a@b.com" />);
    await userEvent.type(screen.getByPlaceholderText("123456"), "000000");
    await userEvent.click(screen.getByRole("button", { name: /verify & continue/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or expired/i);
  });

  it("resends a code via the email-verification type", async () => {
    sendOtp.mockResolvedValue({ data: {}, error: null });
    render(<OtpVerifyForm email="a@b.com" />);
    await userEvent.click(screen.getByRole("button", { name: /resend code/i }));
    expect(sendOtp).toHaveBeenCalledWith({ email: "a@b.com", type: "email-verification" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/web/test/components/auth/otp-verify-form.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement the component**

`apps/web/src/components/auth/otp-verify-form.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function OtpVerifyForm({ email, callbackURL = "/" }: { email: string; callbackURL?: string }): React.ReactElement {
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function handleVerify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: verifyError } = await authClient.emailOtp.verifyEmail({ email, otp });
    if (verifyError) {
      setBusy(false);
      setError("That code is invalid or expired.");
      return;
    }
    window.location.href = callbackURL;
  }

  async function handleResend(): Promise<void> {
    setError(null);
    setResent(false);
    await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
    setResent(true);
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void handleVerify(e)}>
      <p className="text-xs text-muted-foreground">We sent a 6-digit code to {email}.</p>
      <Input
        inputMode="numeric"
        maxLength={6}
        placeholder="123456"
        value={otp}
        onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
        required
      />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {resent && <p className="text-xs text-emerald-600">A new code is on its way.</p>}
      <Button type="submit" className="w-full" disabled={otp.length !== 6 || busy}>Verify &amp; continue</Button>
      <Button type="button" variant="ghost" className="w-full" onClick={() => void handleResend()}>Resend code</Button>
    </form>
  );
}
```

Note: if `@/components/ui/button` has no `ghost` variant, use `outline`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/web/test/components/auth/otp-verify-form.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/auth/otp-verify-form.tsx apps/web/test/components/auth/otp-verify-form.test.tsx
git commit -m "feat(web): OTP verification form with resend"
```

---

## Task 12: SignInForm component

**Files:**
- Create: `apps/web/src/components/auth/sign-in-form.tsx`
- Test: `apps/web/test/components/auth/sign-in-form.test.tsx`

- [ ] **Step 1: Write the failing test**

`apps/web/test/components/auth/sign-in-form.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignInForm } from "@/components/auth/sign-in-form";

const signInEmail = vi.fn();
vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: (a: unknown) => signInEmail(a) } },
}));

const originalLocation = window.location;
beforeEach(() => {
  signInEmail.mockReset();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...originalLocation, href: "http://localhost:3000/login" } });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("SignInForm", () => {
  it("signs in and redirects to the callback on success", async () => {
    signInEmail.mockResolvedValue({ data: {}, error: null });
    render(<SignInForm callbackURL="/dashboard" />);
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "a@b.com");
    await userEvent.type(screen.getByPlaceholderText(/password/i), "Abcdef12345!");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(signInEmail).toHaveBeenCalledWith({ email: "a@b.com", password: "Abcdef12345!" });
    expect(window.location.href).toBe("/dashboard");
  });

  it("shows a single generic error on failure", async () => {
    signInEmail.mockResolvedValue({ data: null, error: { message: "whatever" } });
    render(<SignInForm />);
    await userEvent.type(screen.getByPlaceholderText(/you@example.com/i), "a@b.com");
    await userEvent.type(screen.getByPlaceholderText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/email or password is incorrect/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/web/test/components/auth/sign-in-form.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Implement the component**

`apps/web/src/components/auth/sign-in-form.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

export function SignInForm({ callbackURL = "/" }: { callbackURL?: string }): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // One generic message for every failure (wrong password, unverified,
    // Google-only, unknown email) — no provider/account enumeration.
    const { error: signInError } = await authClient.signIn.email({ email, password });
    if (signInError) {
      setBusy(false);
      setError("Email or password is incorrect.");
      return;
    }
    window.location.href = callbackURL;
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void handleSubmit(e)}>
      <Input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>Sign in</Button>
    </form>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/web/test/components/auth/sign-in-form.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/auth/sign-in-form.tsx apps/web/test/components/auth/sign-in-form.test.tsx
git commit -m "feat(web): email+password sign-in form with generic error"
```

---

## Task 13: Refactor LoginCard into the mode-switching shell

**Files:**
- Modify: `apps/web/src/components/login-card.tsx`
- Modify: `apps/web/test/components/login-card.test.tsx` (rewrite for the shell)

- [ ] **Step 1: Rewrite the LoginCard test for the new shell**

Replace the contents of `apps/web/test/components/login-card.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginCard } from "@/components/login-card";

// The card composes the auth sub-components; mock the client so they're inert.
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { social: vi.fn(), email: vi.fn() },
    signUp: { email: vi.fn() },
    emailOtp: { verifyEmail: vi.fn(), sendVerificationOtp: vi.fn() },
  },
}));

describe("LoginCard", () => {
  it("defaults to sign-in mode with Google + email-password fields", () => {
    render(<LoginCard />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument();
  });

  it("toggles to sign-up mode and shows the create-account form", async () => {
    render(<LoginCard />);
    await userEvent.click(screen.getByRole("button", { name: /need an account\? create one/i }));
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
    // Google stays available in sign-up mode.
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run apps/web/test/components/login-card.test.tsx`
Expected: FAIL — old card has no "Sign in" submit / "Create one" toggle.

- [ ] **Step 3: Implement the shell**

Replace `apps/web/src/components/login-card.tsx` with:

```tsx
"use client";
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoMark } from "@/components/logo";
import { GoogleButton } from "@/components/auth/google-button";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { OtpVerifyForm } from "@/components/auth/otp-verify-form";

type Mode = "signin" | "signup" | "verify";

const TITLES: Record<Mode, string> = {
  signin: "Sign in to UltraVora",
  signup: "Create your UltraVora account",
  verify: "Verify your email",
};

export function LoginCard({ callbackURL = "/" }: { callbackURL?: string } = {}): React.ReactElement {
  const [mode, setMode] = useState<Mode>("signin");
  const [pendingEmail, setPendingEmail] = useState("");

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-xs">
          <LogoMark className="h-7 w-7" />
        </span>
        <CardTitle>{TITLES[mode]}</CardTitle>
        <CardDescription>Promo videos for your product — demo, brand story, social clip, or anything.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {mode === "verify" ? (
          <OtpVerifyForm email={pendingEmail} callbackURL={callbackURL} />
        ) : (
          <>
            <GoogleButton callbackURL={callbackURL} />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or
              <span className="h-px flex-1 bg-border" />
            </div>
            {mode === "signin" ? (
              <SignInForm callbackURL={callbackURL} />
            ) : (
              <SignUpForm onSent={(email) => { setPendingEmail(email); setMode("verify"); }} />
            )}
            <button
              type="button"
              className="text-center text-xs text-muted-foreground underline"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
            >
              {mode === "signin" ? "Need an account? Create one" : "Already have an account? Sign in"}
            </button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run apps/web/test/components/login-card.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/login-card.tsx apps/web/test/components/login-card.test.tsx
git commit -m "feat(web): login card with sign-in / sign-up / verify modes"
```

---

## Task 14: Full verification

**Files:** none (gates + manual)

- [ ] **Step 1: Full type check**

Run: `pnpm typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: PASS — unit + pg projects, including the new password, email, auth-config, integration, and web component tests.

- [ ] **Step 3: Manual smoke (optional, needs running stack + real Resend domain)**

Confirm against the spec's "manual verification" item — the live Google→email account link cannot be unit-tested:
1. Start `pnpm dev:server` and `pnpm dev:web`.
2. Register with an email + a 12-char letter/digit/symbol password; confirm a code arrives (only deliverable once `support.ultra-vora.com` is verified in Resend; otherwise check Resend's dashboard logs).
3. Enter the code → land logged in.
4. Sign out, sign in with the same email + password.
5. Sign out, "Continue with Google" using the **same** email → confirm it lands on the same account (one `user.id`, a new `account` row with `provider_id='google'`): `psql` → `SELECT provider_id FROM account a JOIN "user" u ON u.id=a.user_id WHERE u.email='<that email>';` should show both `credential` and `google`.

- [ ] **Step 4: No commit** (verification only). Implementation complete — hand off to `superpowers:finishing-a-development-branch`.

---

## Self-review notes (author)

- **Spec coverage:** register+password policy (Tasks 1,4,10), 6-digit code via Resend + template (Tasks 2,3,4), email+password login (Tasks 4,12), Google unchanged (Task 8 extract), account linking (config already present — asserted in Task 4 Step 1, exercised manually in Task 14). Env/secrets (Tasks 0,5). All spec sections map to a task.
- **No migration** is asserted, not assumed (Task 4 Step 5).
- **Type consistency:** `EmailService.sendVerificationCode({ to, code, expiresInMinutes })`, `checkPassword`/`PasswordRuleStatus`/`PASSWORD_MIN_LENGTH`, `ResendEmailService`/`SendEmail`, and `authClient.emailOtp.verifyEmail`/`sendVerificationOtp` are used identically across tasks.
- **Library-call caveats** (better-auth `emailOTP` option names + import paths, the emailOTP verify endpoint path, the `resend` send return shape) are explicitly flagged to pin against the installed packages at implementation time — they are third-party surfaces this plan can't introspect from a fresh worktree.
