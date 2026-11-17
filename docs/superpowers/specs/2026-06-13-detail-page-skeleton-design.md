# Detail Page Loading Skeletons — Design

**Date:** 2026-06-13
**Status:** Approved (pending spec review)

## Problem

The session detail page (`/s/[sid]`) fetches everything client-side: session
metadata via React Query (`getSession`) and the conversation via an SSE stream
(`useSessionStream`). Locally this is instant, but in production each request
has network latency. During that window the page renders its loaded shell with
empty/placeholder content, so three zones visibly flash a wrong or empty state
before the real content pops in:

| Zone | Source | Flash during load |
|---|---|---|
| Title bar (`ChatHeader`) | `session.data.title` | "Untitled" |
| Conversation (`ChatStream`) | SSE `stream.uiState.chat` | "Waiting for the agent. Nothing yet." |
| Preview (`PreviewPanel`) | `session.data.artifacts` | "Nothing to preview yet" |

This lands the same way whether the user **clicks a task** in the sidebar or
**creates a new task** (the Home "Generate" button already shows a spinner, then
`router.push`es to `/s/[sid]` — the same destination). The genuine empty states
are correct *after* load completes; the bug is showing them *during* load.

## Goal

Show pulsing skeleton placeholders in the three detail-page zones while their
data is in flight, behind one shared `<Skeleton>` primitive. Each zone keys off
its own loading signal so the shell stays stable and content fades in per-zone
as it arrives. The real empty states are preserved — shown only once loading has
completed.

Scope is the **detail page only**. The sidebar task list, a route-level
`loading.tsx`, and the create-button spinner are explicitly out of scope (see
below).

## Approach

Per-zone, in-component skeletons keyed to each zone's own loading state
(rejected alternatives: a single page-level skeleton — too coarse, hides a
conversation that may already be ready; and a Next.js `loading.tsx` route
skeleton — `AppShell`/the sidebar lives *inside* each page's tree, not a shared
layout, so a route skeleton would blink the sidebar out and back).

## Design

### 1. Shared `<Skeleton>` primitive

`apps/web/src/components/ui/skeleton.tsx`:

```tsx
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };
```

- Matches the shadcn `ui/` convention and the existing inline idiom in
  [preview-panel.tsx](../../../apps/web/src/components/preview-panel.tsx)
  (`PaneSkeleton`: `animate-pulse rounded-md bg-muted`).
- `animate-pulse` is pure CSS, so the global `prefers-reduced-motion` block in
  [globals.css](../../../apps/web/src/app/globals.css) already collapses the
  pulse for reduced-motion users — no extra a11y work.
- Refactor the existing `PaneSkeleton` to compose `<Skeleton>` blocks, removing
  the duplicated utility strings.

### 2. Loading signals and per-zone behavior

Computed once in `SessionPage`
([session-page.tsx](../../../apps/web/src/components/session-page.tsx)) and
passed down:

```ts
const chatEmpty = stream.uiState.chat.length === 0;
// "connecting" = stream not yet open and not errored out
const connecting = !stream.isStreaming && stream.lastError === null;

const titleLoading   = session.isLoading;
const previewLoading = session.isLoading;            // artifacts come from session.data
const chatLoading    = chatEmpty && (session.isLoading || connecting);
```

| Zone | Loading signal | Loading view | Genuine empty (after load) |
|---|---|---|---|
| Title bar | `titleLoading` | skeleton bar; StatusPill hidden | real title / "Untitled" + StatusPill |
| Conversation | `chatLoading` | ghost chat bubbles | "Waiting for the agent. Nothing yet." |
| Preview | `previewLoading` (when `tabs.length === 0`) | tab-strip + body skeleton | "Nothing to preview yet" |

Key points:

- **Conversation** content replays over SSE and the server emits no
  "replay-complete" sentinel
  ([stream-routes.ts](../../../apps/server/src/api/stream-routes.ts) flips from
  replay to live mode silently). So the skeleton is gated on *list empty AND
  (metadata still loading OR stream not yet connected)*. The moment any message
  exists — including the locally-replayed first bubble on a freshly created
  session (`takePendingMessage`) — the real conversation renders. If the stream
  errors before opening (`lastError` set), `connecting` becomes false and the
  zone falls through to the genuine empty state rather than getting stuck on the
  skeleton.
- All three genuine empty states render **only after loading completes**,
  eliminating the false-empty flash.
- Zones are independent: a ready conversation shows even while the title/preview
  are still skeletons, and vice-versa.

### 3. Wiring

- `SessionPage` computes the three flags above and passes them down.
- `ChatHeader` gains `loading`: renders a `<Skeleton className="h-4 w-40" />`
  title bar and omits the StatusPill while loading (the SSE status is not yet
  meaningful).
- `ChatStream` gains `loading`: when `loading` is true it renders
  `<ChatStreamSkeleton />` instead of evaluating `blocks.length === 0`;
  otherwise behavior is unchanged.
- `PreviewPanel` gains `loading`: in the `tabs.length === 0` branch, render
  `<PreviewSkeleton />` when `loading`, else the existing empty state. The
  per-artifact `PaneSkeleton` (shown while an individual artifact query is
  fetching) is unchanged apart from the `<Skeleton>` refactor.

### 4. Skeleton shapes (colocated with their zone)

- **Title** — inline in `ChatHeader`: one `h-4 w-40` bar.
- **`ChatStreamSkeleton`** (in
  [chat-stream.tsx](../../../apps/web/src/components/chat-stream.tsx)): a
  right-aligned user bubble block, then three agent rows (a `size-7` rounded
  avatar block + two text-line bars at ~90%/65% width), filling the tall
  conversation panel and matching the real bubble geometry (`rounded-2xl`,
  left/right alignment).
- **`PreviewSkeleton`** (in
  [preview-panel.tsx](../../../apps/web/src/components/preview-panel.tsx)): a
  rounded-full tab-strip block, then the `PaneSkeleton` body (heading bar + line
  + a 3-up grid of `aspect-video` blocks).

Skeleton color is surface-relative. The preview-side blocks keep the primitive's
default `bg-muted` (they sit on the white `bg-background` canvas). The chat-side
blocks — the `ChatHeader` title bar and everything in `ChatStreamSkeleton` —
override to `bg-foreground/10`, because the conversation section is itself
`bg-muted`, so `bg-muted` blocks would be invisible there.

## Testing

vitest + React Testing Library, TDD. Mock `useSession` / `useSessionStream`
(or the underlying `getSession` query) to drive `SessionPage` through three
states and assert per zone:

- **loading** (`session.isLoading`, chat empty, stream not open): all three
  skeletons present; neither "Waiting for the agent…" nor "Nothing to preview
  yet" is in the document, and the title bar shows a skeleton rather than the
  title text.
- **loaded with data**: skeletons gone; real title, conversation, and preview
  tabs render.
- **loaded but genuinely empty** (metadata loaded, stream open, no messages / no
  artifacts): skeletons gone; the genuine empty states render.

Plus a focused test for the conversation gate: stream `lastError` set with an
empty chat → no skeleton (falls through to empty state, not stuck).

## Error handling / edge cases

| Case | Behavior |
|---|---|
| Metadata 404 / fetch error | React Query leaves `isLoading` → settled; zones fall through to their loaded views (existing error behavior unchanged) |
| SSE errors before opening | `connecting` false → conversation shows genuine empty state, not a stuck skeleton |
| Fresh session, first bubble replayed locally | `chat` non-empty immediately → conversation renders, no skeleton |
| Reduced motion | global `prefers-reduced-motion` rule collapses `animate-pulse` |

## Out of scope

- **Sidebar task list** skeleton (the `useSessions` "No tasks yet." cold-load
  flash) — same root cause, deferred by the scope decision.
- **`loading.tsx`** route-level skeleton — blinks the in-page sidebar (see
  Approach).
- **Create flow** — the Home "Generate" button already shows a spinner; its
  destination is the detail page, which this work covers.

## Risk

Low. Pure additive UI; no API, schema, or data-flow changes. The only nuance is
the conversation gate's dependence on stream connection state — covered by the
`lastError` fall-through and the focused test above.
