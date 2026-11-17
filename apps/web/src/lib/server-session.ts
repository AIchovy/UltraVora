import { headers } from "next/headers";

// Server components talk to Fastify directly (no Next proxy on the server side).
const API_ORIGIN = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001";

export interface ServerSession {
  user: { id: string; email: string; name: string; image?: string | null };
}

/** Resolve the login session inside a server component, or null. */
export async function getServerSession(): Promise<ServerSession | null> {
  const cookie = (await headers()).get("cookie");
  // Only pay the auth-API roundtrip when a better-auth session cookie is
  // actually present (covers the __Secure- prefixed variant too). Stray
  // cookies (analytics etc.) must not slow the public marketing homepage.
  if (!cookie?.includes("better-auth.session_token")) return null;
  try {
    const res = await fetch(`${API_ORIGIN}/api/auth/get-session`, {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status >= 500) {
      console.warn("getServerSession: auth API returned", res.status);
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as ServerSession | null;
    return body?.user ? body : null;
  } catch (err) {
    console.warn("getServerSession: auth API unreachable", err);
    return null;
  }
}
