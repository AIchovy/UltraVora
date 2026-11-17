# Plaza toggle in video settings + homepage promo banner

**Date:** 2026-07-02
**Status:** Approved

## Goal

Two related UI changes around the Product Plaza publish flow:

1. Move the "Public to plaza" toggle out of the composer toolbar into the
   existing **video settings** dialog.
2. Add a **dismissible promo banner** on the logged-in homepage advertising
   limited-time free publishing to the Plaza.

Backend is untouched. The "limited-time free" framing is copy only — the
existing one-free-public-generation-per-account grant
(`freePublicAvailable` from `GET /api/credits`) keeps working as is.

## Non-goals

- No real time-windowed campaign on the server (no start/end dates).
- No global user-settings page; "settings" means the existing
  `ComposerSettingsDialog`.
- No i18n system; labels stay hardcoded English, consistent with commit
  `6a55c5d`.

## Design

### 1. Toggle moves into `ComposerSettingsDialog`

State stays where it is: `HomeComposer` keeps owning
`usePersistentState("uc.isPublic", false)` — it is the dialog's parent, so
no lifting is needed. (`usePersistentState` does not sync across separate
subscribers, so ownership must stay single.)

- `apps/web/src/components/home-composer.tsx`
  - Delete the inline toolbar toggle (the `<label>` wrapping the Switch +
    "Public to plaza" + "Free" badge) and the now-unused `Switch` import.
  - Pass three new props to `ComposerSettingsDialog`: `isPublic`,
    `onIsPublicChange`, `freePublic` (the existing `freePublicAvailable`
    value read from the credits query cache).
  - `freeRun` logic and `createSession({ isPublic: true })` wiring are
    unchanged.
- `apps/web/src/components/composer-settings-dialog.tsx`
  - New props: `isPublic: boolean`, `onIsPublicChange: (v: boolean) => void`,
    `freePublic: boolean`.
  - New `Section` (reusing the existing Section/Switch card pattern), e.g.
    icon `Globe2`, label "Public to plaza", caption "Show the finished video
    in the Product Plaza". Inside, a row with the Switch
    (`aria-label="public to plaza"`).
  - When `freePublic` is true, render the small "Free" pill next to the
    label (same styling as the old inline badge:
    `rounded-full bg-primary/15 … text-primary`). Keep it visible regardless
    of the switch position so users see the incentive before enabling.
  - The trigger button's active-dot indicator becomes
    `voiceover || bgm || isPublic` so an enabled plaza toggle stays
    discoverable while hidden inside the dialog.

### 2. Homepage promo banner

A plain announcement banner — **not** bound to `freePublicAvailable`,
`isPublic`, or any server state. Manual dismiss only.

- New component: `apps/web/src/components/plaza-promo-banner.tsx`.
  - Renders a `rounded-2xl` card in the app's design language (soft primary
    tint, `Sparkles` icon), containing:
    - Copy: **"Limited-time offer: publish your video to the Product Plaza
      for free — turn on 'Public to plaza' in video settings."**
    - A ✕ close button (`aria-label="dismiss plaza promo"`).
  - Dismissal is persisted via
    `usePersistentState("uc.plazaPromoDismissed", false)`; once dismissed it
    never reappears. Use the hook's default behavior (initial `false` =
    visible, hides after the mount effect reads storage). No extra
    anti-flash guard: the banner's entrance animation starts at opacity 0
    and the storage read lands within the animation delay, so a
    previously-dismissed user never sees it in practice.
- `apps/web/src/components/home-page.tsx`
  - Render `<PlazaPromoBanner />` between the hero description paragraph and
    the mode-pill row, with the same staggered `reveal()` motion treatment
    as its neighbors.

### 3. Error handling

None new — the banner and toggle are pure client UI over existing wiring.
`usePersistentState` already swallows storage failures.

## Testing (TDD, existing component-test style)

- **composer-settings-dialog**: renders the "Public to plaza" section; the
  switch reflects `isPublic` and fires `onIsPublicChange`; "Free" pill shows
  iff `freePublic`; trigger shows the active dot when `isPublic` is true.
- **home-composer**: toolbar no longer renders the inline plaza switch;
  with the toggle on, `createSession` is still called with
  `isPublic: true`.
- **plaza-promo-banner**: renders by default; clicking ✕ hides it and
  writes `uc.plazaPromoDismissed`; with the flag already stored it hides
  after hydration.
- **home-page**: banner appears on the homepage.
