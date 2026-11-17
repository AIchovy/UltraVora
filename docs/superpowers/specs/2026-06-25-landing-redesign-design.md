# Landing page redesign — animated showcases + testimonials

Date: 2026-06-25
Status: approved (design), implementation pending

## Goal

Redesign the marketing landing page (`apps/web/src/components/marketing/*`) so the
product's *generation process* is shown through on-brand, code-driven animations —
inspired by mulerun.com's animated feature sections — and add a horizontally
scrolling "What people say" testimonials section. Drop the placeholder
`picsum.photos` imagery entirely. Lightly unify the login page's visuals.

Product context: **UltraVora** — "promo videos from a single prompt." The pipeline is
Prompt → Research → Design (brief) → Script → Voiceover → Compose & render.

## Design language (unchanged constraints)

Stay strictly within the existing system in `globals.css`:
warm off-white canvas, monochrome charcoal `--color-primary`, depth via layered
shadows (`shadow-card/raised/panel`) not strokes, one `--radius` family, light-only.
No new color ramps, no photos, no new heavy dependencies. `motion` v11 is already
installed; CSS `@keyframes` handle looping micro-animation.

## Page structure: before → after

| Before | After |
|---|---|
| Header | unchanged |
| Hero (JSX `ProductGlimpse`) | Hero — light enhancement (progress + stage checks animate) |
| 6 static pipeline cards | "How it works": a compact 6-stage overview ribbon + **4 animated showcases** |
| Start from a style (4 picsum cards) | **removed** |
| — | **"What people say" marquee** (new) |
| FAQ | unchanged |
| Footer | unchanged |

The "six-stage studio" identity is preserved as a thin 6-node overview ribbon
(Prompt · Research · Design · Script · Voiceover · Render) atop the showcases; the
showcases expand the core stages.

## The four animated showcases

Alternating left/right rows. One side is copy; the other is a self-"generating",
code-only animation. Each plays when scrolled into view (`motion` whileInView /
IntersectionObserver), loops, and degrades to a static end-state under
`prefers-reduced-motion`. Hero already covers stage 01 (Prompt), so the showcases
cover stages 02–06 (05+06 combined).

1. **It studies your product first** (Research) — a prompt line types in, then
   research-finding chips cascade (audience / tone / key benefit / competitor gap)
   under a passing scan line.
2. **A creative brief you approve** (Design) — a brief panel self-assembles: palette
   swatches fill in, pacing bars grow, a mood word lands, then an "Approve" check
   lights up.
3. **Scene-by-scene, on a timeline** (Script) — a timeline of scene blocks with a
   playhead sweeping across and a caption typing under the active scene.
4. **Voiceover and the final cut, rendered** (Voiceover + Render) — a waveform
   animates, track lanes (footage / voice / music / captions) stack, a render
   progress bar fills to 100%, then a Play button appears on the final frame.

## "What people say" marquee

- Two rows of cards auto-scrolling in opposite directions; pause on hover; edges
  feathered with a mask. `prefers-reduced-motion` → static wrapped grid.
- Card: quote + monogram avatar (initials, no photo) + name + role/company.
- ~10–12 generated testimonials spanning founders, growth, brand, indie makers,
  PMMs, agencies. Content is authored in this repo (fictional, plausible).

## Login page

Visual unification only — keep the centered card. Add a `fade-up` entrance and
ensure shadow/radius/type match the refreshed landing. No image, no split layout.

## Component / file plan

- `marketing/landing-features.tsx` → rework into the "How it works" section: the
  6-stage overview ribbon + the four showcases. Remove the "Start from a style" grid.
- `marketing/showcase/` (new) → one small component per animation
  (`research-anim.tsx`, `brief-anim.tsx`, `script-anim.tsx`, `render-anim.tsx`) plus a
  `feature-showcase.tsx` layout wrapper (copy + animation slot, handles alternation +
  in-view trigger).
- `marketing/landing-testimonials.tsx` (new) → the marquee; testimonial data inline or
  in `lib/testimonials.ts`.
- `marketing/landing-page.tsx` → insert `<LandingTestimonials/>` between features and FAQ.
- `app/globals.css` → add keyframes (marquee scroll, playhead sweep, type, waveform,
  chip cascade, bar grow) + `prefers-reduced-motion` fallbacks.
- `lib/seed-styles.ts` → remove the now-unused `img` field and picsum URLs (only the
  marketing grid consumed `img`; the logged-in home uses `icon/accent/prompts`).
- `components/login-card.tsx` / `app/login/page.tsx` → minor entrance/visual polish.

## Implementation sequence

1. Add animation keyframes + reduced-motion fallbacks to `globals.css`.
2. Build `feature-showcase.tsx` layout wrapper (alternation + in-view trigger).
3. Build the four `showcase/*-anim.tsx` animations.
4. Rework `landing-features.tsx` (ribbon + showcases; delete style grid).
5. Build `landing-testimonials.tsx` + testimonial content; wire into `landing-page.tsx`.
6. Remove `img` from `seed-styles.ts`.
7. Login-card visual polish.
8. Verify in the browser preview (light + reduced-motion); screenshot proof.

## Verification

- Lint/typecheck clean.
- Browser preview: each showcase animates on scroll; marquee scrolls and pauses on
  hover; reduced-motion shows static end-states; no console/network errors.
- No remaining `picsum.photos` references.

## Out of scope

Header, footer, FAQ copy/structure; pricing; any logged-in app surface; the
`seed-styles` data used by the logged-in home (only its `img` field is dropped).
