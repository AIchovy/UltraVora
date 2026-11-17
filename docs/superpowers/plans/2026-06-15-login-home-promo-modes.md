# Login + Home B2B Promo Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-frame the four home-page creation modes as a B2B product-marketing lineup (Product demo / Brand story / Social feed / Freeform) with distinct duration+aspect each, and align the login subtitle and marketing pipeline copy to the "Promo videos for your product" positioning.

**Architecture:** Pure presentational copy/config edits across three React components in `apps/web`. The mode `id`s are local-only state in `HomePage` (never persisted or sent to the backend), so renaming them is safe. Each change is covered by a Testing-Library render test (jsdom).

**Tech Stack:** Next.js (App Router), React, TypeScript, lucide-react icons, Vitest + @testing-library/react (jsdom), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-06-15-login-home-promo-modes-design.md`

**Conventions:**
- Run from the **repo root** (the worktree root). Single file: `pnpm test <path>`. Full suite: `pnpm test`.
- Worktree starts without `node_modules` — Task 0 installs them.
- Commit on the current `claude/*` branch. Do not push (ff-merge to local main happens after verification; push only on request).

---

### Task 0: Install worktree dependencies

**Files:** none (environment prep)

- [ ] **Step 1: Install deps (fresh worktree has none)**

Run: `pnpm install --frozen-lockfile`
Expected: completes; `node_modules` present at repo root and in `apps/web`.

- [ ] **Step 2: Sanity-check the test runner works on an existing suite**

Run: `pnpm test apps/web/test/components/login-card.test.tsx`
Expected: PASS (6 tests) — confirms vitest/jsdom wiring before we add new tests.

---

### Task 1: Re-frame the four home-page modes

**Files:**
- Create: `apps/web/test/components/home-page.test.tsx`
- Modify: `apps/web/src/components/home-page.tsx` (imports line 4; `Mode` icon type line 13; `MODES` array lines 19-52)

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/home-page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomePage } from "@/components/home-page";
import { renderWithQuery } from "../helpers/render-with-query";

// HomePage embeds HomeComposer, which calls useRouter() + useQueryClient().
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/",
}));

beforeEach(() => {
  // HomeComposer's api-client reads this; set defensively (we never submit here).
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});

describe("<HomePage>", () => {
  it("offers the four B2B promo modes", () => {
    renderWithQuery(<HomePage />);
    for (const label of ["Product demo", "Brand story", "Social feed", "Freeform"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("drops the old generic-creative mode names", () => {
    renderWithQuery(<HomePage />);
    expect(screen.queryByRole("button", { name: "Cinematic short" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Commercial ad" })).toBeNull();
  });

  it("seeds the composer to 60s / 16:9 when Brand story is picked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Brand story" }));
    const duration = screen.getByRole("group", { name: "duration" });
    const aspect = screen.getByRole("group", { name: "aspect ratio" });
    expect(within(duration).getByRole("button", { name: "60s", pressed: true })).toBeInTheDocument();
    expect(within(aspect).getByRole("button", { name: "16:9", pressed: true })).toBeInTheDocument();
  });

  it("seeds the composer to 45s / 1:1 when Freeform is picked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Freeform" }));
    const duration = screen.getByRole("group", { name: "duration" });
    const aspect = screen.getByRole("group", { name: "aspect ratio" });
    expect(within(duration).getByRole("button", { name: "45s", pressed: true })).toBeInTheDocument();
    expect(within(aspect).getByRole("button", { name: "1:1", pressed: true })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test apps/web/test/components/home-page.test.tsx`
Expected: FAIL — "Product demo" button not found; "Cinematic short" still present.

- [ ] **Step 3: Implement — swap imports, icon type, and the MODES array**

In `apps/web/src/components/home-page.tsx`, replace the icon import (line 4):

```tsx
import { MonitorPlay, BookOpen, Smartphone, Sparkles } from "lucide-react";
```

Change the `Mode.icon` type (line 13) from `typeof Clapperboard` to:

```tsx
  icon: typeof MonitorPlay;
```

Replace the entire `MODES` array (lines 19-52) with:

```tsx
const MODES: Mode[] = [
  {
    id: "product-demo",
    label: "Product demo",
    icon: MonitorPlay,
    placeholder: "Walk through our dashboard's three core features in 30 seconds…",
    duration: 30,
    aspect: "16:9",
  },
  {
    id: "brand-story",
    label: "Brand story",
    icon: BookOpen,
    placeholder: "Why we started — the problem we kept hitting, and the team that set out to fix it…",
    duration: 60,
    aspect: "16:9",
  },
  {
    id: "social",
    label: "Social feed",
    icon: Smartphone,
    placeholder: "Hook them in 15 seconds — fast cuts, punchy captions, product front and center…",
    duration: 15,
    aspect: "9:16",
  },
  {
    id: "freeform",
    label: "Freeform",
    icon: Sparkles,
    placeholder: "Describe anything you want to see on screen…",
    duration: 45,
    aspect: "1:1",
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test apps/web/test/components/home-page.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/home-page.tsx apps/web/test/components/home-page.test.tsx
git commit -m "feat(web): re-frame home modes as B2B promo lineup"
```

---

### Task 2: Update the login subtitle

**Files:**
- Modify: `apps/web/src/components/login-card.tsx:45`
- Test: `apps/web/test/components/login-card.test.tsx` (add one `it` inside the existing `describe("LoginCard", ...)`)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("LoginCard", () => { ... })` block in `apps/web/test/components/login-card.test.tsx`:

```tsx
  it("pitches the promo formats in the subtitle", () => {
    render(<LoginCard />);
    expect(screen.getByText(/demo, brand story, social clip, or anything/i)).toBeInTheDocument();
    expect(screen.queryByText(/everyday video studio/i)).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test apps/web/test/components/login-card.test.tsx`
Expected: FAIL — new subtitle text not found; old "everyday video studio" still present.

- [ ] **Step 3: Implement — replace the CardDescription (line 45)**

In `apps/web/src/components/login-card.tsx`, change line 45 from
`<CardDescription>Your everyday video studio.</CardDescription>` to:

```tsx
        <CardDescription>Promo videos for your product — demo, brand story, social clip, or anything.</CardDescription>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test apps/web/test/components/login-card.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/login-card.tsx apps/web/test/components/login-card.test.tsx
git commit -m "feat(web): point login subtitle at the promo formats"
```

---

### Task 3: Align the marketing pipeline copy

**Files:**
- Modify: `apps/web/src/components/marketing/landing-features.tsx:26`
- Test: `apps/web/test/components/landing-page.test.tsx` (add one `it` inside the existing `describe("LandingPage", ...)`)

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe("LandingPage", () => { ... })` block in `apps/web/test/components/landing-page.test.tsx`:

```tsx
  it("prompt stage lists the current promo modes", () => {
    render(<LandingPage />);
    expect(screen.getByText(/pick product demo, brand story, social, or freeform/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test apps/web/test/components/landing-page.test.tsx`
Expected: FAIL — text not found (copy still says "cinematic, social, commercial, or freeform").

- [ ] **Step 3: Implement — update the Prompt stage body (line 26)**

In `apps/web/src/components/marketing/landing-features.tsx`, change the `body` on line 26 to:

```tsx
    body: "Describe the video you want: a product, a vibe, a length. Pick product demo, brand story, social, or freeform.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test apps/web/test/components/landing-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/marketing/landing-features.tsx apps/web/test/components/landing-page.test.tsx
git commit -m "feat(web): align landing pipeline copy with new promo modes"
```

---

### Task 4: Full verification

**Files:** none (gates)

- [ ] **Step 1: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS — confirms `MonitorPlay`/`BookOpen` resolve from lucide-react and the `Mode` type still holds.

- [ ] **Step 2: Run the full web test suite**

Run: `pnpm test apps/web`
Expected: PASS — no existing assertions regressed by the renames.

- [ ] **Step 3: Browser preview verification**

Start the dev server via the preview tooling (autoPort/portless per the worktree preview note) and confirm:
- `/` (home) shows exactly four pills: Product demo, Brand story, Social feed, Freeform; clicking Brand story selects 60s/16:9, Freeform selects 45s/1:1.
- `/login` shows the subtitle "Promo videos for your product — demo, brand story, social clip, or anything."
- Console has no new errors; capture a screenshot of each as proof.

- [ ] **Step 4: Integrate**

Fast-forward merge the `claude/*` branch into local `main` (do not push unless asked).

---

## Self-Review

**Spec coverage:**
- Four modes w/ distinct duration+aspect → Task 1 ✓
- Login subtitle → Task 2 ✓
- Marketing pipeline copy → Task 3 ✓
- lucide import swap + typecheck of icons → Task 1 (impl) + Task 4 Step 1 ✓
- "no existing test regresses" → Task 4 Step 2 ✓
- Preview check (home pills, mode→defaults, login subtitle) → Task 4 Step 3 ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output.

**Type consistency:** `Mode.icon` typed as `typeof MonitorPlay`; all four `icon` values (`MonitorPlay`, `BookOpen`, `Smartphone`, `Sparkles`) are imported on line 4. `duration` values (30/60/15/45) and `aspect` values (16:9/16:9/9:16/1:1) are all members of `ALLOWED_DURATIONS`/`ALLOWED_ASPECT_RATIOS`, so they satisfy the `Duration`/`AspectRatio` types. Test handles (`role="group"` named "duration"/"aspect ratio", `{d}s` button labels, `aria-pressed`) match `home-composer.tsx` exactly.
