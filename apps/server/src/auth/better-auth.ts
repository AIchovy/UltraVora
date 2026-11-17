import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { checkNickname, checkPassword, nicknamePolicyMessage, passwordPolicyMessage } from "@ultracreator/shared";
import type { Db } from "../db/client.js";
import * as schema from "../db/schema/index.js";
import type { AuthService } from "./auth-service.js";
import type { EmailService } from "../email/email-service.js";

export interface CreateAuthOptions {
  db: Db;
  /** Public origin the browser talks to, e.g. http://localhost:3000 (or the API
   *  origin when the browser calls /api/auth cross-origin in prod). */
  baseURL: string;
  secret: string;
  google: { clientId: string; clientSecret: string };
  /** Web app origin(s) to trust when it differs from baseURL (cross-subdomain prod). */
  webOrigin?: string | string[];
  /** Parent cookie domain so the session rides across subdomains, e.g.
   *  ".example.com". Unset → host-only cookie (current same-origin behavior). */
  cookieDomain?: string;
  /** Sends the 6-digit verification code email (Resend in prod, fake in tests). */
  email: EmailService;
  /** Verification-code lifetime in minutes. Default 15. */
  otpExpiresMinutes?: number;
}

// better-auth (with emailAndPassword enabled) exposes several credential-setting
// endpoints; each natively checks only password LENGTH. Map every such path to
// the body field carrying the new password so the full complexity policy
// (letter+digit+symbol, via @ultracreator/shared) is enforced on all of them.
const PASSWORD_FIELD_BY_PATH: Record<string, "password" | "newPassword"> = {
  "/sign-up/email": "password",
  "/change-password": "newPassword",
  "/set-password": "newPassword",
  // Reset paths are inert today (no sendResetPassword configured; the emailOTP
  // reset is blocked by assertVerificationOtpType). Gated anyway so the policy
  // can't be silently bypassed if forgot-password is enabled later.
  "/reset-password": "newPassword",
  "/email-otp/reset-password": "password",
};

/** The new password from an auth request body, or null when `path` isn't a
 *  password-setting endpoint. Returns "" (a guaranteed policy failure) when the
 *  field is missing or not a string, so the gate fails closed. */
export function passwordFromAuthBody(path: string, body: unknown): string | null {
  const field = PASSWORD_FIELD_BY_PATH[path];
  if (!field) return null;
  const value = (body as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value : "";
}

/** The submitted nickname (better-auth `name`) on the email sign-up path, or
 *  null elsewhere. Returns "" (a guaranteed policy failure) when the field is
 *  missing or not a string, so the gate fails closed. */
export function nicknameFromAuthBody(path: string, body: unknown): string | null {
  if (path !== "/sign-up/email") return null;
  const value = (body as Record<string, unknown> | undefined)?.name;
  return typeof value === "string" ? value : "";
}

/** Only email-verification OTPs belong to this product's flow. emailOTP also
 *  wires up passwordless sign-in and forgot-password OTPs that share the send
 *  callback; reject those types so no code is ever issued for them. */
export function assertVerificationOtpType(type: string): void {
  if (type !== "email-verification") {
    throw new APIError("BAD_REQUEST", { message: "Unsupported verification type" });
  }
}

/**
 * better-auth options minus the database adapter — a pure function so the
 * trustedOrigins / cross-subdomain cookie wiring is unit-testable without a DB.
 */
export function buildAuthConfig(opts: Omit<CreateAuthOptions, "db">): BetterAuthOptions {
  const webOrigins = opts.webOrigin
    ? Array.isArray(opts.webOrigin)
      ? opts.webOrigin
      : [opts.webOrigin]
    : [];
  return {
    appName: "UltraVora",
    baseURL: opts.baseURL,
    basePath: "/api/auth",
    secret: opts.secret,
    socialProviders: {
      google: {
        clientId: opts.google.clientId,
        clientSecret: opts.google.clientSecret,
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    emailVerification: {
      // Sign-up leaves the user verified-but-not-logged-in; once they enter the
      // emailed OTP, /email-otp/verify-email issues the session in that same
      // response so they land on the app authenticated — no separate sign-in.
      autoSignInAfterVerification: true,
    },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: (opts.otpExpiresMinutes ?? 15) * 60,
        sendVerificationOnSignUp: true,
        overrideDefaultEmailVerification: true,
        disableSignUp: true,
        sendVerificationOTP: async ({ email, otp, type }) => {
          assertVerificationOtpType(type);
          await opts.email.sendVerificationCode({
            to: email,
            code: otp,
            expiresInMinutes: opts.otpExpiresMinutes ?? 15,
          });
        },
      }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const password = passwordFromAuthBody(ctx.path, ctx.body);
        if (password !== null && !checkPassword(password).ok) {
          throw new APIError("BAD_REQUEST", { message: passwordPolicyMessage() });
        }
        const nickname = nicknameFromAuthBody(ctx.path, ctx.body);
        if (nickname !== null && !checkNickname(nickname)) {
          throw new APIError("BAD_REQUEST", { message: nicknamePolicyMessage() });
        }
      }),
    },
    account: {
      // 预留:未来加邮箱登录时,同邮箱自动并入既有 Google 用户(spec §3)。
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    trustedOrigins: [
      opts.baseURL,
      // Dev convenience: same app reached via the loopback IP literal.
      opts.baseURL.replace("://localhost", "://127.0.0.1"),
      ...webOrigins,
    ],
    // crossSubDomainCookies sets Domain=<cookieDomain> on the session cookie so
    // it's shared with the API subdomain; SameSite stays Lax (same-site) and
    // Secure auto-enables under an https baseURL.
    ...(opts.cookieDomain
      ? { advanced: { crossSubDomainCookies: { enabled: true, domain: opts.cookieDomain } } }
      : {}),
  };
}

/**
 * The cookie Domain that lets a session set on `apiOrigin` ride to `webOrigin`:
 * the shared parent of the two hosts (app.example.com + api.example.com →
 * ".example.com"), so COOKIE_DOMAIN need not be configured by hand. Returns
 * undefined when the hosts are identical or share no 2+-label parent (cross-site
 * — SameSite=Lax can't span it — or dev), leaving the cookie host-only.
 */
export function deriveCookieDomain(webOrigin: string, apiOrigin: string): string | undefined {
  let a: string;
  let b: string;
  try {
    a = new URL(webOrigin).hostname;
    b = new URL(apiOrigin).hostname;
  } catch {
    return undefined;
  }
  if (a === b) return undefined;
  const al = a.split(".");
  const bl = b.split(".");
  const shared: string[] = [];
  for (let i = 1; i <= Math.min(al.length, bl.length); i++) {
    const label = al[al.length - i];
    if (label !== bl[bl.length - i]) break;
    shared.unshift(label!);
  }
  return shared.length >= 2 ? "." + shared.join(".") : undefined;
}

export function createAuth(opts: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(opts.db, { provider: "pg", schema }),
    ...buildAuthConfig(opts),
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
