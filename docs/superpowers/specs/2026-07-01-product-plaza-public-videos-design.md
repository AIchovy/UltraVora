# Product Plaza & Public Promo Videos — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorm), pending implementation plan

## Summary

Let a logged-in user opt to publish a generated promo video to a public
"Product Plaza". Publishing is incentivised: **the first public generation per
account is free** (all pipeline phases waived). The Plaza is a browsable gallery
of everyone's public videos — in-app (sidebar tab) **and** on a public,
logged-out page — where each work links out to the creator's product URL and can
be liked (one like per user per video). The gallery can be sorted by like count
or creation time.

## Decisions (locked during brainstorm)

1. **Free scope — one free public generation per account.** Turning the composer
   toggle on makes *this* generation public. If the account has never claimed the
   free grant, this generation is free (every phase waived). Once claimed, later
   public generations are still allowed but charged normally.
2. **Plaza visibility — dual.** An in-app page (reachable from the sidebar) *and*
   a public page that renders for logged-out visitors, plus a public per-video
   share page.
3. **Composer toggle default — OFF** (private + paid). Users opt in deliberately.
4. **Public is permanent.** Once a session is published (especially the free
   one), it cannot be reverted to private. There is no un-publish in v1.
5. **Likes.** One active like per user per video, toggle-able (like / unlike),
   requires login. Logged-out like attempts route to `/login`.

## Non-goals (v1)

- No un-publish / privacy reversal.
- No moderation queue, reporting, or takedown UI (owner delete already removes
  the session and cascades likes).
- No comments, follows, or creator profiles.
- No daily/volume free caps beyond the single lifetime free grant.
- No separate poster/thumbnail asset — cards use a `<video>` element.

## Architecture approach

**Chosen: extend `creator_sessions`.** A "public video" is exactly a session
with `is_public = true` and `status = 'done'`. No separate snapshot table, no
publish hook — the existing artifact/media/file-serving machinery is reused
as-is. A new `video_likes` table holds likes.

Rejected alternatives: a separate `public_videos` snapshot table (duplicates
data, needs a sync hook — overkill for v1); modelling publicity as an artifact
kind (artifacts are pipeline outputs, not user metadata).

---

## 1. Database (Drizzle)

`apps/server/src/db/schema/creator.ts` — add to `creator_sessions`:

| Column | Type | Notes |
|--------|------|-------|
| `is_public` | `boolean not null default false` | set at session creation |
| `product_url` | `text` (nullable) | structured copy of the composer URL |
| `free_grant` | `boolean not null default false` | true when this session holds the account's one free grant |
| `like_count` | `integer not null default 0` | denormalised counter |

New indexes on `creator_sessions`:
- `(is_public, created_at)` — Plaza "recent" sort.
- `(is_public, like_count)` — Plaza "most liked" sort.

New table `video_likes`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | `bigserial` pk | |
| `session_id` | `text` FK → `creator_sessions.id` `onDelete cascade` | |
| `user_id` | `text` FK → `user.id` `onDelete cascade` | |
| `created_at` | `timestamp not null defaultNow` | |
| unique | `(session_id, user_id)` | **enforces one-like-per-user** |

Generate the migration via the repo's existing `drizzle-kit` flow (matching
`apps/server/drizzle/`).

## 2. Server — session creation & "free once" charge logic

**`SessionRepository` / `SessionRecord`** (`apps/server/src/sessions/*`):
- `SessionRecord` gains `isPublic`, `productUrl`, `freeGrant`, `likeCount`.
- `create()` input gains optional `isPublic` and `productUrl`.
- New method `claimFreePublicGrant(sessionId, userId): Promise<boolean>` —
  atomic: `UPDATE creator_sessions SET free_grant = true WHERE id = :sid AND
  NOT EXISTS (SELECT 1 FROM creator_sessions WHERE user_id = :uid AND free_grant
  = true)`; returns true when this session now holds the grant (either it already
  did, or the UPDATE claimed it). Implemented identically in the PG repo and the
  in-memory fake.
- New method `hasFreePublicGrant(userId): Promise<boolean>` — for the credits
  response (`freePublicAvailable = !hasFreePublicGrant`).
- Like helpers (may live in the session repo or a small `likes` repo — pick one
  and keep PG + fake in lock-step): `addLike(sid, uid)`, `removeLike(sid, uid)`,
  `hasLiked(sid, uid)` / `likedSet(sids, uid)`. Add/remove adjust `like_count`
  in the same transaction and are idempotent (`ON CONFLICT DO NOTHING` /
  delete-then-conditionally-decrement).

**`POST /api/sessions`** (`sessions-routes.ts`): accept an extended body
`{ autoApprove?, isPublic?, productUrl? }` (still tolerant of a missing body).
Validate `productUrl` is a well-formed http(s) URL when present; store both on
the row.

**`chargeForPhase`** (`session-orchestrator.ts`): before the existing debit,
branch on `session.isPublic`:
```
if (session.isPublic) {
  const free = await sessions.claimFreePublicGrant(sessionId, session.userId);
  if (free) return { ok: true, ... };   // waive: no ledger entry
}
// otherwise existing per-phase debit (idempotent per session:phase)
```
Because the grant is claimed at the **first** phase and `free_grant` sticks on
the row, every subsequent phase of that session also reads `is_public` and
re-claims (no-op, still true) → all phases free. Non-free public sessions and
private sessions charge exactly as today, including the awaiting-credits park.

**Known trade-off (documented):** the free grant is consumed at first-phase
charge, so a free public run that later errors still burns the one free chance.
This is the intended anti-abuse posture (the expensive research/LLM work already
ran). Not revisited in v1.

**`GET /api/credits`** (`billing-routes.ts`): add `freePublicAvailable: boolean`
to the response and to the shared `CreditsResponse` type.

## 3. Server — public list, playback, and likes

New `apps/server/src/api/public-routes.ts`. These paths are **not** covered by
the session auth guard (which guards `/api/sessions*` and `/api/billing/*`), so
they are reachable logged-out. The like endpoints resolve auth *inside* the
handler.

- `GET /api/public/videos?sort=recent|likes&limit=&cursor=`
  → `PublicVideoSummary[]`. Query: `is_public = true AND status = 'done'`,
  ordered by the chosen sort (default `recent`). Joins `user` for author name /
  image. Optional auth: if a valid session cookie is present, resolve the viewer
  and set `likedByMe` per row via `likedSet`; else `likedByMe = false`.
  Cursor/limit pagination (keyset on the sort column + `id` tiebreak).
- `GET /api/public/videos/:sid` → one `PublicVideoSummary` (404 if the session
  is not public/done). Same optional-auth `likedByMe`.
- `GET /api/public/videos/:sid/video` → streams the session's `mp4` artifact,
  gated on `is_public && status='done'` instead of ownership. Factor the Range /
  local-stream / GCS-302 logic out of `files-routes.ts` into a shared helper and
  call it from both routes.
- `POST /api/public/videos/:sid/like` and `DELETE …/like` → resolve the user via
  `auth.getSession(headers)`; 401 if absent. Verify the target session is
  public. Insert/delete in `video_likes` and adjust `like_count` atomically.
  Return `{ likeCount, liked }`.

Wire `registerPublicRoutes(app, deps)` in `apps/server/src/api/app.ts`.

### `PublicVideoSummary` shape (shared)
```
{
  sid: string;
  title: string | null;
  author: { name: string; image: string | null };
  productUrl: string | null;
  likeCount: number;
  aspectRatio?: string;   // from brief constraints / mp4, for card layout
  createdAt: string;      // ISO
  likedByMe: boolean;
}
```

## 4. Web

**Shared/client types** (`apps/web/src/lib/api-types.ts`, `api-client.ts`):
- Extend `CreditsResponse` with `freePublicAvailable`.
- `createSession` gains optional `isPublic` / `productUrl`.
- Add `PublicVideoSummary`, `PublicVideoSort = 'recent' | 'likes'`, and client
  fns `listPublicVideos(sort)`, `getPublicVideo(sid)`, `likeVideo(sid)`,
  `unlikeVideo(sid)`. Public video playback URL = `${apiBase()}/api/public/videos/${sid}/video`.

**Composer** (`home-composer.tsx`):
- New persisted state `isPublic` (default `false`, key `uc.isPublic`).
- A `Switch` in the bottom controls row labelled "公开到广场 / Public to plaza".
  When `isPublic && credits.freePublicAvailable`, render a small "本次免费 / Free"
  badge next to it.
- `handleGenerate`: when `isPublic && freePublicAvailable`, **skip** the
  out-of-credits pre-check (`balance <= 0`) since the run is free. Pass
  `isPublic` and the structured `productUrl` to `createSession`. (Keep the
  existing "Product page: <url>" text embed so the research phase still sees it.)

**Sidebar** (`app-sidebar.tsx`):
- Add a nav item "产品广场 / Product Plaza" (grid/store lucide icon) above the
  Tasks section, linking to `/plaza`; active-highlight when `pathname === '/plaza'`.

**`/plaza`** (`apps/web/src/app/plaza/page.tsx` + a `ProductPlaza` client
component):
- Logged in → render inside `AppShell` (sidebar highlighted). Logged out →
  standalone layout with a lightweight header and a "Log in" CTA.
- A sort control (**Recent** / **Most liked**) driving `usePublicVideos(sort)`
  (React Query, `queryKey: ['public-videos', sort]`).
- Responsive card grid. Card: `<video muted playsinline preload="metadata">`
  preview (poster = first frame via `#t=0.1`), title, author (avatar + name),
  an outbound "Visit product" button (`href=productUrl`, `target="_blank"`,
  `rel="noopener nofollow"`, hidden when null), a like button + count, and the
  date. Card body (not the buttons) links to `/v/[sid]`.

**`/v/[sid]`** (`apps/web/src/app/v/[sid]/page.tsx`): public per-video share
page — larger player, title, author, product link, like button, share/copy-link.
Server component fetches `getPublicVideo` for SSR/metadata; 404 when not
public/done. Works logged-out.

**Likes UX**: optimistic toggle via a `useLikeVideo()` mutation that updates the
cached summary and invalidates on settle. A logged-out click routes to `/login`.

## 5. Testing (TDD)

**Server**
- `claimFreePublicGrant`: first public session for a user claims (free); a second
  distinct session does not; re-calling for the same holding session stays true;
  two sessions racing the claim → exactly one wins (transaction/`NOT EXISTS`).
- Charge integration: a public session with the grant available writes **no**
  consumption ledger entries across all phases; a public session after the grant
  is used charges normally; a private session is unchanged.
- Likes: unique `(session_id, user_id)` blocks a second like; toggle
  add→remove→add leaves `like_count` correct; likes cascade-delete with the
  session.
- Public list: only `is_public && done` rows appear; `recent` vs `likes` sort;
  `likedByMe` reflects the optional-auth viewer; pagination cursor.
- Public playback: served for a public/done session; 404 for private or
  not-done; ownership is **not** required.
- PG repo and in-memory fake behave identically (existing repo-parity pattern).

**Shared**
- Schema/type tests for `PublicVideoSummary`, extended `CreditsResponse`, and the
  extended create-session body.

**Web**
- Composer: toggle persists; free badge shows only when public + available;
  out-of-credits pre-check bypassed when public + free; `createSession` receives
  `isPublic`/`productUrl`.
- Plaza: renders cards, switches sort, optimistic like toggle, logged-out like
  routes to login, product link has `rel="noopener nofollow"` + `target=_blank`.

## Naming

Bilingual UI labels "产品广场 / Product Plaza" to match the app's mixed English
chrome; route `/plaza`, public share route `/v/[sid]`.

## Rollout / ops notes

- Requires a DB migration (new columns + table + indexes).
- No new env vars. Public playback reuses the existing GCS signed-URL path (works
  whether or not `GCS_BUCKET` is set — falls back to local streaming in dev).
- Owner session delete already cascades to `video_likes` and removes the video
  from the Plaza (row gone → predicate no longer matches).
