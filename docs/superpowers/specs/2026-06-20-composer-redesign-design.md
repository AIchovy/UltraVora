# Composer Redesign — Design

- **Date:** 2026-06-20
- **Status:** Approved (design); spec under review
- **Area:** `apps/web` (home composer, sidebar, promo styles), `packages/shared` (constraints, message), `apps/server` (research prompt)

## Motivation

The logged-in home composer toolbar has grown cluttered: it crams Attach, two
segmented controls (duration + aspect), an Audio popover, the Auto-pilot switch,
and a Generate button into one wrapping row. We want a cleaner, two-tier composer
plus four related improvements the user requested:

1. Toolbar refactor — Attach → `+` icon; a Settings gear opening a **modal** for
   duration / aspect / audio / subtitles / bgm; Generate → up-arrow icon (Enter
   submits); a Chat / Auto-pilot **mode dropdown** left of Generate.
2. Sidebar — "New project" → "New task"; per-task icons varied (not all `Film`).
3. Uploads — images only, previewed in the URL/Logo row, `@`-referenceable in the
   textarea so the backend prompt tells the agent which image is the logo and
   which `@token` points to which image. Up to 5 images total.
4. Promo styles — replace the 4 image cards with expandable category pills that
   reveal preset prompts (motion expand-down, hover/dwell effects, per-category
   accent colors).

## Locked Decisions

- **Mode dropdown semantics:** `Chat` = manual mode (relabel of `autoApprove=false`);
  `Auto-pilot` = `autoApprove=true`. No new backend flow. Default `Auto-pilot`,
  persisted to `localStorage["uc.autoApprove"]` (reuses the existing key; the
  dropdown **replaces** the home-composer Switch). The session-page pause control
  is unchanged.
- **`@` reference labels:** auto-numbered — `@logo`, `@image1`, `@image2`, … A picker
  pops on `@`; selecting inserts the short label. Backend receives a `label → path`
  map plus which asset is the logo.
- **Promo styles content:** keep the existing 4 styles as categories; author 4–5
  preset prompts per style; drop the cover image from the home gallery; each
  category gets a distinct accent color for its expanded items.
- **Durations:** add `120` (2m) and `180` (3m) alongside `15/30/45/60`. Stored as
  seconds; displayed as `2m` / `3m`.

## Design by Area

### 1. Composer toolbar — `apps/web/src/components/home-composer.tsx`

Split the single crowded row into an **asset row** and a **control row**.

**Asset row** (top, keeps the existing URL/Logo tile look):
- `[URL]` and `[Logo]` tiles unchanged. After them, render thumbnails for each
  attached image (with an `×` remove control).
- All uploads are images only (`accept="image/*"`).
- **Total cap: 5 images** (the logo counts as one — so up to 4 additional
  attachments when a logo is set). When the cap is reached, `+` is disabled.

**Control row** (bottom, left → right):
- `+` icon button (`Plus`, replacing the `Paperclip` "Attach"): opens an
  image-only file picker; adds to the asset set.
- ⚙ Settings icon button (`Settings2`): opens the settings **modal** (§2). Shows a
  small accent dot when any audio option is on (`voiceover || bgm`).
- `ml-auto` spacer.
- **Mode dropdown** (`DropdownMenu`, just left of Generate): two items with icons —
  `Chat` (`MessageSquare`) and `Auto-pilot` (`Rocket`). The trigger shows the
  current mode's icon + label. Selecting persists `autoApprove` to
  `localStorage["uc.autoApprove"]`. Default `Auto-pilot` (true), read after mount
  like the current switch.
- **Generate** → circular up-arrow icon button (`ArrowUp`, primary). `busy` →
  spinner; disabled when `!canSubmit`.

The duration and aspect segmented controls **move out of the toolbar into the
modal** — this is the primary fix for the cluttered layout.

**Keyboard:** in the textarea, `Enter` submits (calls `handleGenerate`),
`Shift+Enter` inserts a newline. This replaces the current `Cmd/Ctrl+Enter`.
When the `@` picker is open, `Enter` selects the highlighted mention instead of
submitting (the picker owns the key).

### 2. Settings modal — uses existing `apps/web/src/components/ui/dialog.tsx`

Title *Video settings*. Three sections, laid out cleanly:
- **Duration** — six chips: `15s 30s 45s 60s 2m 3m` (single-select; reuses the
  `Segmented`/`SegButton` idiom or a chip grid).
- **Aspect ratio** — `16:9 / 9:16 / 1:1`, each with a small proportional shape icon.
- **Audio** — three rows with `Switch`: Voiceover, Subtitles (disabled unless
  voiceover, preserving the existing `voiceover && subtitles` linkage), Background
  music.

The modal binds to state owned by `HomePage` (duration/aspect via existing props)
and `HomeComposer` (voiceover/subtitles/bgm local state, unchanged).

### 3. Image uploads + `@` referencing — `home-composer.tsx`

Local asset model:

```ts
interface ComposerAsset {
  id: string;                  // stable local id (monotonic counter)
  file: File;
  label: string;               // "logo" | "image1" | "image2" | ...
  role: "logo" | "image";
  previewUrl: string;          // URL.createObjectURL(file)
}
```

- **Labels are stable and monotonic** — assigned from an incrementing counter at
  add time and never reused or re-densified on removal. So after adding three
  images and removing the second you keep `@image1` and `@image3`. This keeps any
  `@token` already typed in the text valid. The logo's label is always `logo`.
- **Preview:** thumbnails render in the URL/Logo row; revoke object URLs on removal
  / unmount (extend the existing `logoPreview` cleanup pattern).
- **`@` picker:** when the user types `@` in the textarea (at string start or after
  whitespace) and at least one asset exists, open a small anchored panel listing
  matching assets (thumbnail + label), filtered by the text typed after `@`.
  - `↑/↓` move highlight, `Enter`/click selects, `Esc` closes.
  - Selecting replaces the `@query` fragment with `@label ` at the caret and closes.
- **Submit:** upload order is `[logo?, ...attachments]`; map each returned
  `out.files[i].path` back to its asset by index to build
  `assets: { label, path, role }[]`. Send the textarea text verbatim (keeping any
  `@token`s) plus `assets`. `uploadedFiles` continues to carry all paths for
  backward compatibility with the `read_upload` tool.

### 4. Shared schema + backend

**`packages/shared/src/constraints.ts`**
- `ALLOWED_DURATIONS = [15, 30, 45, 60, 120, 180]`.
- `DurationSchema` gains `z.literal(120)` and `z.literal(180)`.

**`packages/shared/src/message.ts`**
- New `AssetRefSchema = z.object({ label: z.string(), path: z.string(), role: z.enum(["logo", "image"]) })`.
- `UserMessageSchema` gains `assets: z.array(AssetRefSchema).optional()`.
- `uploadedFiles` remains.

**`apps/server/src/phases/pi-research-handler.ts`**
- When `initial.assets?.length`, emit a `Referenced assets:` block in the prompt:
  ```
  Referenced assets (the user may cite these as @label in their message):
  - @logo → assets/<...>.png (the brand LOGO)
  - @image1 → assets/<...>.png
  ```
- Add one line to `SYSTEM_PROMPT` explaining that the user's message may contain
  `@label` mentions that point to the listed referenced assets, and the agent
  should treat the `logo` asset as the brand logo. Keep the existing
  `Uploaded files:` line for runs without structured assets.

### 5. Promo styles → expandable categories — `apps/web/src/lib/seed-styles.ts` + `home-page.tsx`

**`SeedStyle`** keeps `title`, `inspiration`, `img` (the marketing landing page at
`apps/web/src/components/marketing/landing-features.tsx` still reads these — leave
it untouched) and **adds**:

```ts
interface SeedStyle {
  id: string;
  title: string;
  inspiration: string;
  img: string;                 // kept for marketing
  icon: LucideIcon;
  accent: AccentKey;           // "blue" | "emerald" | "amber" | "violet"
  prompts: string[];           // 4–5 preset prompts, authored per style
}
```

Accent assignment: Minimalist Tech → blue, Pro Walkthrough → emerald, Dynamic
Promo → amber, Brand Narrative → violet.

**Home gallery** (`home-page.tsx`): replace the image-card grid with a horizontal
row of 4 style pills (icon + title, tinted by accent). Clicking a pill toggles an
expand-down panel beneath the row showing that style's preset prompts:
- `motion` `AnimatePresence` + height/opacity for the expand; list items
  stagger in.
- Hover a pill: subtle lift/scale + accent tint.
- Hover/active a preset row: highlighted in the **category's accent color** (so
  each category's expanded items are visually distinct).
- Click a preset: `setText(prompt)` and mark it active.
- Respect `prefers-reduced-motion` (the page already uses `useReducedMotion`).

Only one category expands at a time.

### 6. Sidebar — `apps/web/src/components/app-sidebar.tsx`

- "New project" button label and `aria-label` → **"New task"**.
- Per-task icon chosen **deterministically by session id** from a small set
  (e.g. `Film, Clapperboard, Video, Megaphone, Sparkles, Wand2, Play, Tv`):
  `ICONS[hash(id) % ICONS.length]` with a simple stable char-sum hash. Stable
  across renders (no per-render randomness / flicker).

## Testing (Vitest + jsdom, existing `renderWithQuery` helper)

- **shared:** `DurationSchema` accepts `120` and `180`; rejects e.g. `90`; existing
  values still pass. `AssetRefSchema` / `UserMessage.assets` parse round-trip.
- **server:** research handler prompt includes the `Referenced assets` block with
  `@label → path` lines when `assets` present; constraints/message validation
  accepts the new durations and `assets`.
- **web — composer:** `+` adds an image and shows a thumbnail; settings modal opens,
  toggles audio, and the subtitles↔voiceover gating holds; mode dropdown switches
  and persists to localStorage; `Enter` submits while `Shift+Enter` does not;
  Generate renders the up-arrow.
- **web — @ mentions:** typing `@` opens the picker; selecting inserts `@label `;
  submit sends `assets` with correct `label`/`role` mapping; the 5-image cap
  disables `+`.
- **web — promo styles:** clicking a pill expands its prompt list; clicking a preset
  sets the textarea text; only one category open at a time; accent classes applied
  per category.
- **web — sidebar:** button reads "New task"; the same id yields the same icon and
  different ids spread across the icon set.

## Non-goals / Out of scope

- No change to the session-page pause control (still a Switch).
- No marketing landing-page redesign (it keeps using `img`).
- No caret-accurate `@` popover positioning — anchoring the picker to the textarea
  is sufficient for this iteration.
- No persistence of selected promo style or per-style "last used" state.
- `@`-tokens are plain text in the message; we do not parse/validate that every
  `@token` resolves to an asset (the prompt lists the real assets and the agent
  reasons). Stale tokens are harmless prose.
