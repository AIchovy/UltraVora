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
