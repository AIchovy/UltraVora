# Email registration + password login + Google account linking

Date: 2026-06-24
Status: Approved (design) — pending spec review

## Original request (verbatim)

> 实现邮箱注册(需要设置密码12位,包含字母,数字,符号)和登录(密码登录,如果谷歌),还有如果邮箱注册后又用谷歌登录邮箱的这个事情需要可以关联信息,邮箱注册使用邮箱验证码,已经有模版文件了,然后使用 resend 的 api 去发送邮件。

Confirmed decisions during brainstorming:

- **Flow A** — user enters email + password together, then a 6-digit code (better-auth `emailAndPassword` + `emailOTP` plugin).
- **From address** — `EMAIL_FROM` defaults to `UltraVora <noreply@support.ultra-vora.com>`, env-configurable.
- **Scope** — core only: email register + password login + Google + account linking. **No** forgot-password, **no** invite-code flow.
- **Google-only email at the password form** — no provider detection / no lookup endpoint. A failed password login returns a single generic "email or password is incorrect" message. Google users use the always-present "Continue with Google" button.

## Goals

1. Register with email + password. Password policy: **≥ 12 chars, contains at least one letter, one digit, and one symbol.**
2. Email verification via a **6-digit code** sent through **Resend**, rendering the existing [`email-templates/verification-code.html`](../../../email-templates/verification-code.html).
3. Log in with email + password.
4. Continue with Google (already works — unchanged).
5. **Account linking:** a user who registered with email (verified) and later signs in with Google using the **same** email is merged into the **same** `user.id`.

## Non-goals

- Forgot/reset password.
- Invite-code onboarding (`invite-code.html` stays unused).
- Detecting which provider an email uses / routing a Google email away from the password form.
- A separate "name" input — see Open question below; default is to derive `name` from the email local-part.
- Reverse linking (Google-first, then email signup with the same email) — see Edge cases.

## Existing foundation (no change needed)

- **better-auth 1.6.16** in both `apps/server` and `apps/web`; Google OAuth fully working.
- Account linking already configured: `account.accountLinking = { enabled: true, trustedProviders: ["google"] }` in [`apps/server/src/auth/better-auth.ts`](../../../apps/server/src/auth/better-auth.ts) — the comment there explicitly reserves it for "same-email auto-merge into existing Google user."
- DB tables already complete for this feature ([`apps/server/src/db/schema/auth.ts`](../../../apps/server/src/db/schema/auth.ts)): `user.emailVerified`, `account.password`, and the `verification` table (used by emailOTP for codes). **Expect no new migration** — to be confirmed by running `pnpm --filter @ultracreator/server db:generate` and observing an empty diff.
- The Fastify ↔ better-auth bridge ([`fastify-auth.ts`](../../../apps/server/src/auth/fastify-auth.ts)) already forwards all `GET/POST /api/auth/*` with JSON bodies, so **no new server routes** are needed — signup, sign-in, and verify all ride existing `/api/auth/*` endpoints.

## Architecture

### A. Shared password policy — `packages/shared`

New `packages/shared/src/password.ts`, exported from `index.ts`:

```ts
export const PASSWORD_MIN_LENGTH = 12;
export interface PasswordRuleStatus {
  minLength: boolean;  // ≥ 12
  hasLetter: boolean;  // /[A-Za-z]/
  hasDigit: boolean;   // /[0-9]/
  hasSymbol: boolean;  // /[^A-Za-z0-9]/
}
export function checkPassword(pw: string): { ok: boolean; rules: PasswordRuleStatus };
export function passwordPolicyMessage(): string; // human-readable rule summary
```

Single source of truth consumed by **both** the server (better-auth before-hook) and the web (live form checklist) so the rules can never drift.

### B. Email sending — `apps/server/src/email/` (new)

Following the codebase's seam pattern (`AuthService`), define a narrow interface so routes/auth never import Resend directly and tests inject a fake:

```ts
// email-service.ts
export interface EmailService {
  sendVerificationCode(args: { to: string; code: string; expiresInMinutes: number }): Promise<void>;
}
```

- `template.ts` — reads the HTML template **once at startup** and caches it; renders by replacing `{{VERIFICATION_CODE}}` and `{{EXPIRES_IN}}` (e.g. `"15 minutes"`). Throws a clear error at startup if the file is missing or a placeholder is left unreplaced. Template path = `EMAIL_TEMPLATES_DIR` env, else resolved relative to the module via `fileURLToPath(import.meta.url)` → repo-root `email-templates/`.
- `resend-email-service.ts` — `ResendEmailService implements EmailService`. Wraps `new Resend(apiKey)`; `emails.send({ from: EMAIL_FROM, to, subject: "Your UltraVora verification code", html })`. The Resend `emails.send` function is injectable (constructor dependency) so unit tests run without network. Send failures are logged and rethrown as a generic error.

### C. better-auth wiring — `apps/server/src/auth/better-auth.ts`

Extend `CreateAuthOptions` with `email: EmailService` and `otpExpiresMinutes?: number` (default 15). In `buildAuthConfig`, add:

```ts
emailAndPassword: {
  enabled: true,
  requireEmailVerification: true,   // block sign-in until the code is verified
  minPasswordLength: 12,
  maxPasswordLength: 128,
},
emailVerification: {
  autoSignInAfterVerification: true,   // /email-otp/verify-email issues the session in its own response (step 4) — without this the route returns token:null and the user lands logged-out
},
plugins: [
  emailOTP({
    otpLength: 6,
    expiresIn: otpExpiresMinutes * 60,
    sendVerificationOnSignUp: true,           // auto-send the code on signup
    overrideDefaultEmailVerification: true,   // verification uses the code, not a link
    async sendVerificationOTP({ email, otp }) {
      await email.sendVerificationCode({ to: email, code: otp, expiresInMinutes: otpExpiresMinutes });
    },
  }),
],
hooks: {
  // Complexity is not built into better-auth (only length). Enforce on /sign-up/email.
  before: createAuthMiddleware(async (ctx) => {
    if (ctx.path !== "/sign-up/email") return;
    const pw = ctx.body?.password ?? "";
    if (!checkPassword(pw).ok) throw new APIError("BAD_REQUEST", { message: passwordPolicyMessage() });
  }),
},
```

`buildAuthConfig` stays DB-free and unit-testable (it now also asserts the plugin list + emailAndPassword settings). Exact `emailOTP` option names (`sendVerificationOnSignUp`, `overrideDefaultEmailVerification`) will be pinned against the installed v1.6.16 during implementation; the design is robust to minor renames.

### D. Server bootstrap — `apps/server/src/api/server.ts`

Read `RESEND_API_KEY` (required), `EMAIL_FROM` (default `UltraVora <noreply@support.ultra-vora.com>`), `OTP_EXPIRES_MINUTES` (default 15), `EMAIL_TEMPLATES_DIR` (optional). Build `ResendEmailService` and pass it + `otpExpiresMinutes` into `createAuth({ ..., email, otpExpiresMinutes })`.

### E. Web UI — `apps/web`

- `lib/auth-client.ts` — add the `emailOTPClient()` plugin so `authClient.emailOtp.verifyEmail` / `sendVerificationOtp` exist. `signUp.email` / `signIn.email` are core (available once the server enables emailAndPassword).
- New focused components under `src/components/auth/`:
  - `google-button.tsx` — extracted from the current login card (unchanged behavior).
  - `password-policy-hint.tsx` — live 4-item checklist driven by `checkPassword`.
  - `sign-up-form.tsx` — email + password (+ hint). Submit → `authClient.signUp.email({ email, password, name })` where `name` defaults to the email local-part. On success → switch parent to `verify`.
  - `otp-verify-form.tsx` — 6-digit input → `authClient.emailOtp.verifyEmail({ email, otp })`. On success → redirect to `callbackURL`. "Resend code" → `authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" })`.
  - `sign-in-form.tsx` — email + password → `authClient.signIn.email({ email, password, callbackURL })`. Any failure → generic "Email or password is incorrect."
- Refactor [`login-card.tsx`](../../../apps/web/src/components/login-card.tsx) into the card shell holding mode state `"signin" | "signup" | "verify"`, rendering the Google button (in signin/signup) + the active form + a toggle link. Single `/login` route; the existing disabled "coming soon" stub is removed.

## Data flow

**Register**
1. `signUp.email({ email, password, name })` → before-hook validates policy (400 on weak password).
2. User row created with `emailVerified=false`; emailOTP auto-sends a 6-digit code via Resend.
3. UI shows the `verify` step (with resend).
4. `emailOtp.verifyEmail({ email, otp })` → `emailVerified=true`, session cookie issued (logged in). `requireEmailVerification` blocks login until this happens.

**Password login**
- `signIn.email({ email, password })`. Success → session. Any failure (wrong password, unverified, Google-only, unknown email) → one generic message.

**Google + linking**
- Unchanged Google flow. If a verified email user already exists with the same email, better-auth links the Google `account` row to that existing `user.id` (Google is a trusted provider → emails are verified → safe). One identity, two `account` rows.

## Error handling (friendly, non-technical copy — matches repo tone)

| Situation | User sees |
|---|---|
| Weak password (server + live client hint) | inline rule checklist; "Password must be at least 12 characters and include a letter, a number, and a symbol." |
| Email already registered (signup) | "This email is already registered — try signing in." |
| Wrong password / unverified / unknown email (login) | "Email or password is incorrect." |
| Expired / invalid code | "That code is invalid or expired." + Resend |
| Resend send failure | "We couldn't send the code. Please try again." (server logs the real error) |

## Security

- **Resend key:** lives only in gitignored `apps/server/.env`; `.env.example` gets a placeholder. The key was shared in plaintext in chat — **recommend rotating it** after wiring.
- Generic login error avoids account/method enumeration (per the chosen approach).
- Email verification is required before login, which keeps Google→email account linking safe from takeover.

### Implementation hardening (added during build — beyond the original draft)
Enabling `emailAndPassword` and the `emailOTP` plugin exposes more endpoints than the happy path, so the implementation locks them down:
- **Password complexity on every credential-setting path, not just signup.** better-auth natively checks only password *length* on `/sign-up/email`, `/change-password`, `/set-password` (and the inert `/reset-password`, `/email-otp/reset-password`). A `passwordFromAuthBody(path, body)` helper maps each path to its password field and the `hooks.before` gate runs the shared `checkPassword` on all of them (fails closed on missing/non-string input).
- **emailOTP restricted to email-verification only.** The plugin also wires up passwordless `/sign-in/email-otp` (which can auto-create accounts) and forgot-password OTPs. Two guards neutralize them: `disableSignUp: true` (no OTP-based account creation) and `assertVerificationOtpType(type)` in the send callback, which throws for any `type !== "email-verification"` — so no sign-in/forgot-password code is ever issued or mis-rendered with the verification template.

## Edge cases

- **Reverse direction (out of scope):** signing up with an email that already belongs to a Google account returns "This email is already registered — try signing in." (better-auth rejects duplicate email signup). The user then uses the Google button. No auto-password-set on an existing Google account.
- **Unverified signups** linger as `emailVerified=false` users; they can re-request a code and verify later. (Cleanup of stale unverified users is out of scope.)

## Testing (TDD — tests written first)

**`packages/shared`**
- `test/password.test.ts` — `checkPassword`: rejects < 12 / missing letter / digit / symbol; accepts valid; per-rule flags correct.

**`apps/server`**
- `test/email/template.test.ts` — placeholders replaced; no leftover `{{`; throws on missing file.
- `test/email/resend-email-service.test.ts` — injected fake `emails.send` receives `from=EMAIL_FROM`, `to`, subject, and html containing the code.
- `test/auth/better-auth.test.ts` (extend) — config includes `emailAndPassword` (enabled, requireEmailVerification, minPasswordLength 12) and an `emailOTP` plugin; complexity before-hook present; `trustedProviders` still includes `google`.
- `test/auth/email-signup.pg.test.ts` (integration, real PG + fake `EmailService`) — weak password rejected (no user); valid signup creates `emailVerified=false` user and the fake captures an OTP; `verifyEmail` flips to `true` and issues a session; `signIn.email` blocked before verify, succeeds after.

**`apps/web`** (vitest + testing-library, `authClient` mocked)
- `sign-up-form.test.tsx` — invalid password blocks submit + shows hints; valid calls `signUp.email` with derived name and transitions to verify.
- `otp-verify-form.test.tsx` — calls `verifyEmail`; success redirects; resend calls `sendVerificationOtp`.
- `sign-in-form.test.tsx` — calls `signIn.email`; failure shows the generic message.
- `auth-card.test.tsx` — mode toggling; Google button present in signin/signup.

**Manual (consistent with the existing manual-only Google test note):** the live Google→email account-linking round-trip.

## Env vars (added)

```
RESEND_API_KEY=<resend api key>           # required; gitignored .env only
EMAIL_FROM=UltraVora <noreply@support.ultra-vora.com>
OTP_EXPIRES_MINUTES=15                     # optional
EMAIL_TEMPLATES_DIR=                       # optional; defaults to repo-root email-templates/
```

**Deployment note:** if `apps/server` is deployed without the repo-root `email-templates/` directory, set `EMAIL_TEMPLATES_DIR` (or include the directory in the image).

## Open question (non-blocking)

- **`name` for email signups:** default is to derive it from the email local-part (no extra input), keeping the form to email + password + code as requested. If you'd rather collect a display name, we add one optional field. Proceeding with the derive-default unless told otherwise.
