# Plaza UI polish: animated like, card/detail/filter refresh

**Date:** 2026-07-02
**Status:** Approved (user confirmed direction + two adjustments: like reveals on hover; no "more videos" section on the detail page)

## Goal

Elevate the Product Plaza UI: move the card like control onto the video
cover, animate like/unlike, and give the detail page and the list's sort
filter a more premium treatment. Pure client-side; no API changes. (The
separate playback bug was fixed in `a59b2ed`.)

## Design

### A. LikeButton redesign (`apps/web/src/components/plaza/like-button.tsx`)

One component, two variants; same wiring (`useLikeVideo`, login redirect).

- `variant="overlay"` (video cover): frosted pill — `bg-black/45
  backdrop-blur text-white`, heart + count. Rendered by the card at the
  cover's top-right as a SIBLING of the cover `<Link>` (no click-through
  into navigation).
  - **Hover reveal:** hidden (`opacity-0`) until the card (`group`) is
    hovered or the button is focused. When `liked`, it stays visible —
    your own like should read at a glance (and touch devices keep at
    least the liked state visible).
- `variant="page"` (detail page): larger bordered pill on card background.
- **Animation** (motion/react, respects `useReducedMotion`):
  - Like: heart springs `1 → 1.35 → 1`, fills red; a one-shot ring pings
    outward and fades.
  - Unlike: fill fades back; no bounce.
  - Count: slides vertically on change (`AnimatePresence`, keyed by count).

### B. Video card (`apps/web/src/components/plaza/video-card.tsx`)

- Card root becomes a `group` with hover polish: slight lift + deeper
  shadow; cover video scales ~1.03 inside the clipped cover.
- Bottom block: title, then one row with author (left) and Visit product
  (right). Like moves out entirely (now on the cover).

### C. Detail page (`apps/web/src/components/plaza/public-video-view.tsx`)

- Stage widens to `max-w-4xl`; player gets `rounded-3xl` + ring + panel
  shadow.
- Meta row: larger title, author avatar + name + publish date; actions on
  the right: `variant="page"` like + `Visit product` as a rounded-full
  primary button.
- Loading state: skeleton (player block + text lines) instead of
  "Loading…" text. No "more videos" section (explicitly out of scope).

### D. Sort filter (`apps/web/src/components/plaza/product-plaza.tsx`)

- Native `<select>` → segmented control: `rounded-full bg-muted p-1` with
  two `aria-pressed` pill buttons (Recent / Most liked); active pill gets
  `bg-card shadow-raised` with a motion `layoutId` thumb sliding between
  them.
- Loading state: grid of pulsing skeleton cards instead of "Loading…".

## Testing

- like-button: new test file — count renders, `aria-pressed` reflects
  state, click calls like/unlike API, logged-out click routes to /login.
- product-plaza: sort control is two buttons; clicking "Most liked"
  refetches with `sort=likes`; skeletons render while loading.
- video-card (via product-plaza or its own file): overlay like button
  present on the cover with the same aria contract; bottom row no longer
  renders it.
- public-video-view: updated for the new layout (title, date, actions).
- Animations are presentational — not unit-tested beyond state/aria.
