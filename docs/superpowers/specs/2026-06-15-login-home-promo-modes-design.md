# Login + home modes — B2B promo framing

**Date:** 2026-06-15
**Status:** Approved (design), pending spec review

## Goal

Re-frame the product's four creation modes and the login copy around the B2B
"Promo videos for your product" positioning the home hero already states. The
old generic-creative modes (*Cinematic short / Social feed / Commercial ad /
Freeform*) don't match that hero. Replace them with a product-marketing lineup,
and update the login subtitle to evoke those use cases.

Each mode must have a **distinct duration and aspect ratio** so the mode picker
meaningfully changes the composer defaults (not all identical).

## The four modes (`apps/web/src/components/home-page.tsx`)

Keep the existing `Mode` shape (`id`, `label`, `icon`, `placeholder`,
`duration`, `aspect`) and sentence-case label style. New `MODES` array:

| Label | id | icon | duration | aspect | placeholder |
|---|---|---|---|---|---|
| Product demo | `product-demo` | `MonitorPlay` | 30 | 16:9 | "Walk through our dashboard's three core features in 30 seconds…" |
| Brand story | `brand-story` | `BookOpen` | 60 | 16:9 | "Why we started — the problem we kept hitting, and the team that set out to fix it…" |
| Social feed | `social` | `Smartphone` | 15 | 9:16 | "Hook them in 15 seconds — fast cuts, punchy captions, product front and center…" |
| Freeform | `freeform` | `Sparkles` | 45 | 1:1 | "Describe anything you want to see on screen…" *(unchanged)* |

- Durations span 15/30/45/60; aspects span 16:9/9:16/1:1 — all four are distinct.
- **Import change:** `Clapperboard, Smartphone, Megaphone, Sparkles` →
  `MonitorPlay, BookOpen, Smartphone, Sparkles` (verify `MonitorPlay`/`BookOpen`
  exist in lucide-react 0.460 at build time — both are long-standing icons).
- `MODES[0]` stays the initial mode → page loads at Product demo (16:9/30s),
  same load-time defaults as today (was Cinematic short 16:9/30s).

## Login subtitle (`apps/web/src/components/login-card.tsx:45`)

Title `Sign in to UltraCreator` unchanged. `CardDescription`:

- ~~"Your everyday video studio."~~
- → **"Promo videos for your product — demo, brand story, social clip, or anything."**

Maps to all four modes: demo → Product demo, brand story → Brand story,
social clip → Social feed, anything → Freeform.

## Marketing pipeline copy (`apps/web/src/components/marketing/landing-features.tsx:26`)

The "Prompt" stage body lists the old mode names; align it:

- ~~"…Pick cinematic, social, commercial, or freeform."~~
- → "…Pick product demo, brand story, social, or freeform."

## Files touched

1. `apps/web/src/components/home-page.tsx` — `MODES` array + icon imports.
2. `apps/web/src/components/login-card.tsx` — line 45 `CardDescription`.
3. `apps/web/src/components/marketing/landing-features.tsx` — line 26 stage body.

## Safety / behavior notes

- Mode `id`s are **local state only** — `modeId` lives in `HomePage` and seeds
  `duration`/`aspect`/`placeholder`; it is never persisted or sent to the
  backend (the composer posts `durationSec`/`aspectRatio`, not the mode id).
  Renaming `cinematic`→`product-demo` and `commercial`→`brand-story` is therefore
  safe; `social` and `freeform` ids are unchanged.
- `Freeform` default shifts from 16:9/30s → **1:1/45s** (intentional, for
  format variety). `HomeComposer` renders every allowed duration/aspect, so 60s
  and 1:1 select and highlight correctly.
- No backend, render-pipeline, or seed-style ("Promo styles") changes.

## Testing / verification

- Grep tests for the old labels/copy (`Cinematic short`, `Commercial ad`,
  `cinematic, social, commercial`) and update any assertions/snapshots.
- Worktree has no `node_modules` yet → `pnpm install --frozen-lockfile` before
  build/preview.
- Preview check: home page shows the 4 new pills; clicking each sets the right
  duration/aspect in the composer; login page shows the new subtitle.

## Out of scope

Backend, the render pipeline, the "Promo styles" seed grid, and any auth logic.
