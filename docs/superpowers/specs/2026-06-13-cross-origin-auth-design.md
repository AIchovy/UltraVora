# Cross-Origin Authenticated API (web ↔ api on subdomains)

Date: 2026-06-13
Status: Approved (design)

## Problem

Today the browser reaches the Fastify API **same-origin only**: `apiBase()`
returns `""`, so the data client hits `/api/sessions` on the web origin and Next
rewrites `/api/*` to the API (`next.config.mjs`), carrying the first-party
session cookie. The better-auth client likewise hits same-origin `/api/auth/*`
through that proxy.

In production the frontend deploys to **Cloud Run** (`app.example.com`) and the
API to a **GCP VM** (`api.example.com`) — different origins. Pointing the data
client at the API (`NEXT_PUBLIC_API_URL=https://api.example.com`) makes requests
cross-origin, and the browser then sends **no cookie**: `fetch` defaults to
`credentials: 'same-origin'`, and the server CORS is `origin: true` with no
`credentials`. Result: `POST /api/sessions → 401` (the "click generate" error).

## Topology (locked)

- `app.example.com` (web, Cloud Run) and `api.example.com` (API, GCP VM) share
  the registrable domain `example.com` → **same-site, cross-origin**.
- Same-site ⇒ a cookie scoped to the parent domain `.example.com` is sent on
  cross-subdomain requests with **`SameSite=Lax`** — no need for `SameSite=None`.

## Decisions (locked)

- **Auth wiring: all-direct, env-switchable.** In prod the browser calls
  `api.example.com` for BOTH `/api/auth/*` and `/api/sessions/*`; the auth-client
  and better-auth `baseURL` point at the API origin. The frontend needs no proxy,
  so it works on Cloud Run (Next server) or any static host. When the new env
  vars are unset it falls back to today's same-origin proxy → **dev unchanged**.
- **Cookie `Domain=.example.com`, `SameSite=Lax`, `Secure`** via better-auth
  `crossSubDomainCookies`. Lax (not None) because same-site: more secure, and it
  still rides the Google top-level callback redirect. The domain is **derived**
  from the shared parent of `WEB_ORIGIN` + `BETTER_AUTH_URL` (`deriveCookieDomain`),
  so it isn't a separate setting; `COOKIE_DOMAIN` overrides the derivation.
- **CORS: explicit allowlist + credentials.** Replace `origin: true` with
  `origin: <WEB_ORIGIN allowlist>` + `credentials: true`. Never reflect-all
  *with credentials* — that lets any site issue authenticated requests for a
  logged-in user. Prod MUST set `WEB_ORIGIN`.
- **Everything env-gated.** Dev sets none of the new vars ⇒ exact current
  same-origin behavior; no local-dev code path changes.

## Request / cookie flow (prod)

```
Browser @ app.example.com   (all fetch + EventSource: credentials:'include')
   │   /api/auth/*   (login, session)        ─┐
   │   /api/sessions/* , .../stream (SSE)      ├──►  api.example.com  (Fastify @ GCP VM)
   │                                          ─┘        │ better-auth Set-Cookie
   ▼                                                    ▼
 Cookie  Domain=.example.com; SameSite=Lax; Secure  ◀── shared across *.example.com
```

Google OAuth: callback `https://api.example.com/api/auth/callback/google` →
better-auth sets the `.example.com` cookie → redirect back to `app.example.com`.
The OAuth state cookie is read same-origin on the callback; Lax permits it on the
top-level redirect from Google.

## Changes

### Server (`apps/server`)
1. **CORS** (`api/app.ts`): `{ origin: true }` → `{ origin: <allowlist|true>,
   credentials: true }`. Origin = `WEB_ORIGIN` (comma-split) when set, else `true`
   (dev/localhost). @fastify/cors then echoes the matched origin, emits
   `Access-Control-Allow-Credentials: true`, and answers OPTIONS preflight.
2. **better-auth** (`auth/better-auth.ts`): when a `cookieDomain` is provided,
   add `advanced.crossSubDomainCookies: { enabled: true, domain }`; merge
   `WEB_ORIGIN` into `trustedOrigins`. `baseURL`/`authPublicOrigin` come from
   `BETTER_AUTH_URL` (prod = `https://api.example.com`).
3. **Wiring** (`api/server.ts`): read `WEB_ORIGIN`; derive the cookie domain with
   `deriveCookieDomain(WEB_ORIGIN, BETTER_AUTH_URL)` (overridable by `COOKIE_DOMAIN`);
   thread both into `createApp` (CORS) and `createAuth` (cookie domain + trustedOrigins).

### Web (`apps/web`)
4. **Credentials** (`lib/api-client.ts`): `jsonFetch` sends
   `credentials: 'include'` (harmless same-origin, required cross-origin) — covers
   list/create/get/messages/uploads/delete, all of which route through it.
5. **SSE** (`state/use-session-stream.ts`): `new EventSource(url, {
   withCredentials: true })`.
6. **Auth-client baseURL** (`lib/auth-client.ts`): reuse `apiBase()`
   (`NEXT_PUBLIC_API_URL`) — auth shares the API origin, so there's a single
   browser-facing URL to configure. Unset → same-origin (dev/proxy).

## Env contract

| var | dev | prod |
|---|---|---|
| `NEXT_PUBLIC_API_URL` (web) | unset → same-origin | `https://api.example.com` (covers data **and** auth) |
| `BETTER_AUTH_URL` (server) | `http://localhost:3000` | `https://api.example.com` |
| `WEB_ORIGIN` (server) | unset → reflect/localhost | `https://app.example.com` |
| `COOKIE_DOMAIN` (server) | derived from `WEB_ORIGIN`+`BETTER_AUTH_URL` | optional override only |

Net config: **one** browser var (the API origin) + the server's own two URLs.
The API origin is the same string in `NEXT_PUBLIC_API_URL` and `BETTER_AUTH_URL`,
but they're read by two separate processes (browser bundle vs server).

Deployment steps (outside code): register the Google OAuth redirect
`https://api.example.com/api/auth/callback/google`; set the table above.
(`example.com` is a placeholder for the real domain.)

## Testing (TDD)

- **CORS** (`app.ts`, via `createApp` with fakes — existing pattern): with
  `WEB_ORIGIN` set, an allowed `Origin` gets `Access-Control-Allow-Origin: <that>`
  + `Access-Control-Allow-Credentials: true`; a disallowed origin does not.
- **better-auth** (`createAuth`): with `cookieDomain`, the config carries
  `crossSubDomainCookies` and `WEB_ORIGIN` ∈ `trustedOrigins`; without it,
  unchanged from today.
- **auth-client**: baseURL resolves from `NEXT_PUBLIC_AUTH_URL` (set vs unset).
- **jsonFetch**: passes `credentials: 'include'` (spy on `fetch`).
- During implementation, verify the exact better-auth **v1.6.16** option names
  (`crossSubDomainCookies`, domain leading-dot) against the installed package —
  do not assume.

## Non-goals

- No `SameSite=None` / truly cross-site (different registrable domains). If ever
  needed, only the cookie attributes + a note change.
- No shipped reverse-proxy/auth-proxied prod variant (the env fallback keeps it
  possible; prod = all-direct).
- No extra CSRF layer beyond better-auth's Origin/`trustedOrigins` checks.
