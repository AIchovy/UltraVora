import "client-only";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { apiBase } from "./api-base";

// Auth shares the API origin (one URL to configure). NEXT_PUBLIC_API_URL unset →
// same-origin /api/auth/* through the Next rewrite to Fastify (dev). Set it to
// the API origin → /api/auth goes there directly (prod subdomains).
const base = apiBase();

// Explicit type arg avoids TS2742 ("inferred type cannot be named" due to internal
// .mjs paths in better-auth / zod), while keeping plugin methods like emailOtp typed.
type EmailOTPClientOptions = { plugins: [ReturnType<typeof emailOTPClient>] };
export const authClient: ReturnType<typeof createAuthClient<EmailOTPClientOptions>> =
  createAuthClient({
    ...(base ? { baseURL: base } : {}),
    plugins: [emailOTPClient()],
  });

type AuthClient = typeof authClient;
export const useSession: AuthClient["useSession"] = authClient.useSession;
export const signIn: AuthClient["signIn"] = authClient.signIn;
export const signOut: AuthClient["signOut"] = authClient.signOut;
