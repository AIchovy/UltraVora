# Plaza Toggle in Settings + Homepage Promo Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "Public to plaza" toggle from the composer toolbar into the existing video-settings dialog, and add a dismissible "limited-time free publish" banner to the logged-in homepage.

**Architecture:** Pure client-side UI change in `apps/web`; zero backend changes. `HomeComposer` keeps owning the `uc.isPublic` persistent state and passes it down to `ComposerSettingsDialog` as new props (`usePersistentState` does not sync across independent subscribers, so ownership stays single). The banner is a new self-contained component whose only state is a persisted dismissed flag.

**Tech Stack:** Next.js App Router client components, Tailwind, Radix dialog (`@/components/ui/dialog`), `motion/react`, lucide-react icons, TanStack Query cache reads, Vitest + Testing Library (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-02-plaza-toggle-settings-and-promo-banner-design.md`

**Environment notes:**
- Work in the worktree at `/path/to/UltraVora` (all paths below are relative to it). Dependencies are already installed (`pnpm install --frozen-lockfile` was run).
- Run tests from the repo root. Single file: `pnpm test apps/web/test/components/<file>.test.tsx`. Full suite: `pnpm test`.
- Vitest does NOT typecheck (esbuild strips types), so each task runs `tsc` explicitly.

---

### Task 1: Move the plaza toggle into the video-settings dialog

**Files:**
- Modify: `apps/web/src/components/composer-settings-dialog.tsx`
- Modify: `apps/web/src/components/home-composer.tsx`
- Test: `apps/web/test/components/home-composer-public.test.tsx` (rewrite)

The toggle currently lives inline in the composer toolbar (`home-composer.tsx:518-531`). After this task it lives in a new section of `ComposerSettingsDialog`, the toolbar switch is gone, and the dialog trigger advertises an enabled toggle via the existing active-dot (exposed as `data-active` for tests).

- [ ] **Step 1: Rewrite the test file to describe the new UX**

Replace the entire contents of `apps/web/test/components/home-composer-public.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { createSession } from "@/lib/api-client";
import type { CreditsResponse } from "@/lib/api-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  uploadFiles: vi.fn(async () => ({ files: [] })),
  postMessage: vi.fn(async () => {}),
}));

function Harness() {
  const [text, setText] = useState("Promo for Acme");
  return (
    <HomeComposer
      text={text} onTextChange={setText}
      duration={30} onDurationChange={() => {}}
      aspect="16:9" onAspectChange={() => {}}
      placeholder="describe…"
    />
  );
}

const credits = (over: Partial<CreditsResponse> = {}): CreditsResponse => ({
  balance: 500, breakdown: { subscription: 0, bonus: 500, purchased: 0 }, subscription: null, freePublicAvailable: true, ...over,
});

/** Open video settings, flip the plaza switch on, and close the dialog. */
async function enablePublic(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /video settings/i }));
  await user.click(await screen.findByRole("switch", { name: /public to plaza/i }));
  await user.click(screen.getByRole("button", { name: "Done" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("<HomeComposer> public toggle (in video settings)", () => {
  it("keeps the plaza switch out of the toolbar", () => {
    renderWithQuery(<Harness />);
    expect(screen.queryByRole("switch", { name: /public to plaza/i })).toBeNull();
  });

  it("defaults the toggle OFF inside the dialog", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(await screen.findByRole("switch", { name: /public to plaza/i })).not.toBeChecked();
  });

  it("shows the Free pill in the dialog whenever the grant is available", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits());
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    // Visible before the switch is even flipped — it advertises the incentive.
    expect(await screen.findByText("Free")).toBeInTheDocument();
  });

  it("hides the Free pill when the grant is used up", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits({ freePublicAvailable: false }));
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    await screen.findByRole("switch", { name: /public to plaza/i });
    expect(screen.queryByText("Free")).toBeNull();
  });

  it("marks the settings trigger active while public is on", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    const trigger = screen.getByRole("button", { name: /video settings/i });
    expect(trigger).not.toHaveAttribute("data-active");
    await enablePublic(user);
    expect(trigger).toHaveAttribute("data-active", "true");
  });

  it("passes isPublic + productUrl to createSession", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits());
    await enablePublic(user);
    await user.click(screen.getByRole("button", { name: /url/i }));
    await user.type(screen.getByLabelText("product url"), "https://acme.com");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: true, productUrl: "https://acme.com" }),
      ),
    );
  });

  it("bypasses the out-of-credits block when public + free", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits({ balance: 0, freePublicAvailable: true }));
    await enablePublic(user);
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
  });
});
```

Notes on the choices above:
- The dialog is modal, so tests must close it (the "Done" button) before clicking toolbar buttons like Generate — that is what `enablePublic` does.
- `data-active` is a new pass-through attribute on the `DialogTrigger`; asserting a class or the decorative dot span would be brittle.
- `getByText("Free")` is exact-match by default; no other exact "Free" string renders in the composer or dialog.

- [ ] **Step 2: Run the test file to verify it fails**

Run: `pnpm test apps/web/test/components/home-composer-public.test.tsx`
Expected: FAIL — "keeps the plaza switch out of the toolbar" finds the toolbar switch; the dialog-based tests time out finding `switch { name: /public to plaza/i }` inside the dialog / never find `data-active`.

- [ ] **Step 3: Add the plaza section + new props to `ComposerSettingsDialog`**

In `apps/web/src/components/composer-settings-dialog.tsx`:

3a. Add `Globe2` to the lucide-react import (first import block):

```tsx
import {
  SlidersHorizontal,
  Clock,
  Ratio,
  AudioLines,
  Mic2,
  Captions,
  Music2,
  Globe2,
  type LucideIcon,
} from "lucide-react";
```

3b. Extend `Props` (after the `voice` fields):

```tsx
  voice: Voice;
  onVoiceChange: (v: Voice) => void;
  isPublic: boolean;
  onIsPublicChange: (v: boolean) => void;
  /** True while the account's one free public generation is unclaimed. */
  freePublic: boolean;
```

3c. Destructure the new props in the component signature (after `onVoiceChange`):

```tsx
  voice,
  onVoiceChange,
  isPublic,
  onIsPublicChange,
  freePublic,
}: Props): React.ReactElement {
```

3d. Include `isPublic` in the trigger's active indicator and expose it as `data-active`. Replace:

```tsx
  const active = voiceover || bgm;
  return (
    <Dialog>
      <DialogTrigger
        aria-label="video settings"
```

with:

```tsx
  const active = voiceover || bgm || isPublic;
  return (
    <Dialog>
      <DialogTrigger
        aria-label="video settings"
        data-active={active ? "true" : undefined}
```

3e. Add the new section INSIDE the scrolling body `<div>`, after the closing `</Section>` of the Audio section (immediately before the body div's closing `</div>`):

```tsx
          <Section
            icon={Globe2}
            label="Public to plaza"
            caption="Show the finished video in the Product Plaza"
          >
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium leading-none text-foreground">
                  Publish this video
                  {freePublic && (
                    <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary">
                      Free
                    </span>
                  )}
                </div>
                <p aria-hidden className="mt-1 text-xs leading-none text-muted-foreground">
                  Anyone can watch and like it on the plaza
                </p>
              </div>
              <div className="ml-auto pl-2">
                <Switch checked={isPublic} onCheckedChange={onIsPublicChange} aria-label="public to plaza" />
              </div>
            </div>
          </Section>
```

(The Free pill renders whenever `freePublic` is true — deliberately not gated on the switch position, per the spec.)

- [ ] **Step 4: Remove the toolbar switch and pass the new props in `HomeComposer`**

In `apps/web/src/components/home-composer.tsx`:

4a. Delete the `Switch` import line (no other usage remains after 4c):

```tsx
import { Switch } from "@/components/ui/switch";
```

4b. Pass the new props to `ComposerSettingsDialog` (extend the existing JSX call):

```tsx
        <ComposerSettingsDialog
          duration={duration}
          onDurationChange={onDurationChange}
          aspect={aspect}
          onAspectChange={onAspectChange}
          voiceover={voiceover}
          onVoiceoverChange={setVoiceover}
          subtitles={subtitles}
          onSubtitlesChange={setSubtitles}
          bgm={bgm}
          onBgmChange={setBgm}
          voice={voice}
          onVoiceChange={setVoice}
          isPublic={isPublic}
          onIsPublicChange={setIsPublic}
          freePublic={freePublicAvailable}
        />
```

4c. Delete the entire inline toggle block from the toolbar (currently lines 518-531):

```tsx
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <Switch
            checked={isPublic}
            onCheckedChange={setIsPublic}
            aria-label="public to plaza"
            className="scale-90"
          />
          <span>Public to plaza</span>
          {isPublic && freePublicAvailable && (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              Free
            </span>
          )}
        </label>
```

Nothing else changes: `isPublic` state, `freePublicAvailable`, the `freeRun` gate, and the `createSession({ ...(isPublic ? { isPublic: true } : {}) })` call all stay as they are.

- [ ] **Step 5: Run the rewritten test file to verify it passes**

Run: `pnpm test apps/web/test/components/home-composer-public.test.tsx`
Expected: PASS (7 tests)

- [ ] **Step 6: Run the neighbouring suites that render the dialog**

Run: `pnpm test apps/web/test/components/home-composer-settings.test.tsx apps/web/test/components/home-page.test.tsx apps/web/test/components/home-composer-autopilot.test.tsx apps/web/test/components/home-composer-mentions.test.tsx`
Expected: PASS (these exercise `HomeComposer`/the dialog and must not regress)

- [ ] **Step 7: Typecheck the web app**

Run: `pnpm -F @ultracreator/web exec tsc --noEmit`
Expected: no output, exit 0

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/composer-settings-dialog.tsx apps/web/src/components/home-composer.tsx apps/web/test/components/home-composer-public.test.tsx
git commit -m "feat(web): move Public-to-plaza toggle into video settings dialog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Homepage plaza promo banner

**Files:**
- Create: `apps/web/src/components/plaza-promo-banner.tsx`
- Modify: `apps/web/src/components/home-page.tsx`
- Create: `apps/web/test/components/plaza-promo-banner.test.tsx`
- Test (modify): `apps/web/test/components/home-page.test.tsx`

A plain dismissible announcement card between the hero description and the mode pills. Not tied to credits or the toggle — the only state is `uc.plazaPromoDismissed` in localStorage.

- [ ] **Step 1: Write the failing banner tests**

Create `apps/web/test/components/plaza-promo-banner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlazaPromoBanner } from "@/components/plaza-promo-banner";

beforeEach(() => {
  localStorage.clear();
});

describe("<PlazaPromoBanner>", () => {
  it("shows the limited-time free publish pitch by default", () => {
    render(<PlazaPromoBanner />);
    expect(screen.getByText(/limited-time offer/i)).toBeInTheDocument();
    expect(screen.getByText(/product plaza/i)).toBeInTheDocument();
  });

  it("dismisses on ✕ and persists the choice", async () => {
    const user = userEvent.setup();
    render(<PlazaPromoBanner />);
    await user.click(screen.getByRole("button", { name: /dismiss plaza promo/i }));
    expect(screen.queryByText(/limited-time offer/i)).toBeNull();
    expect(localStorage.getItem("uc.plazaPromoDismissed")).toBe("true");
  });

  it("stays hidden when previously dismissed", async () => {
    localStorage.setItem("uc.plazaPromoDismissed", "true");
    render(<PlazaPromoBanner />);
    // usePersistentState hydrates in a mount effect, so disappearance is async.
    await waitFor(() => expect(screen.queryByText(/limited-time offer/i)).toBeNull());
  });
});
```

- [ ] **Step 2: Add the homepage assertion**

In `apps/web/test/components/home-page.test.tsx`, add inside the `describe("<HomePage>")` block (after the "offers the four B2B promo modes" test):

```tsx
  it("shows the plaza promo banner", () => {
    renderWithQuery(<HomePage />);
    expect(screen.getByText(/limited-time offer/i)).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `pnpm test apps/web/test/components/plaza-promo-banner.test.tsx apps/web/test/components/home-page.test.tsx`
Expected: FAIL — the banner suite can't resolve `@/components/plaza-promo-banner`; the home-page assertion finds no banner text.

- [ ] **Step 4: Create the banner component**

Create `apps/web/src/components/plaza-promo-banner.tsx`:

```tsx
"use client";
import { motion, useReducedMotion } from "motion/react";
import { Sparkles, X } from "lucide-react";
import { usePersistentState } from "@/lib/use-persistent-state";

/**
 * Limited-time "publish to the plaza for free" announcement on the logged-in
 * home page. Pure copy — visibility is deliberately not tied to the free-grant
 * or toggle state; the only control is a manual dismiss, persisted so the
 * banner never comes back. A previously-dismissed visitor technically renders
 * the banner for one frame before the storage read hides it, but the entrance
 * animation starts at opacity 0 so nothing is visible in practice.
 */
export function PlazaPromoBanner(): React.ReactElement | null {
  const reduce = useReducedMotion();
  const [dismissed, setDismissed] = usePersistentState("uc.plazaPromoDismissed", false);
  if (dismissed) return null;
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: reduce ? 0 : 0.12, ease: [0.16, 1, 0.3, 1] }}
      className="mx-auto mt-6 flex max-w-xl items-center gap-3 rounded-2xl bg-primary/5 py-3 pl-4 pr-2 ring-1 ring-primary/15"
    >
      <Sparkles aria-hidden className="h-4 w-4 shrink-0 text-primary" />
      <p className="flex-1 text-[13px] leading-snug text-foreground">
        <span className="font-semibold text-primary">Limited-time offer:</span>{" "}
        publish your video to the Product Plaza for free — turn on{" "}
        <span className="font-medium">“Public to plaza”</span> in video settings.
      </p>
      <button
        type="button"
        aria-label="dismiss plaza promo"
        onClick={() => setDismissed(true)}
        className="cursor-pointer rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </motion.div>
  );
}
```

Notes:
- The delay `0.12` slots between the hero description (`0.08`) and the mode pills (`0.16`), keeping the staggered reveal rhythm.
- Curly quotes (`“ ”`) avoid react/no-unescaped-entities lint errors.
- The component animates itself, so the homepage does not wrap it in another `motion.div` — and when dismissed it returns `null`, leaving no stray margin behind.

- [ ] **Step 5: Render it on the homepage**

In `apps/web/src/components/home-page.tsx`:

5a. Add the import (after the `HomeComposer` import):

```tsx
import { PlazaPromoBanner } from "./plaza-promo-banner";
```

5b. Render it between the hero description and the mode-pill row — insert immediately after the closing `</motion.p>` of the description paragraph and before `<div className="mt-8 flex flex-wrap justify-center gap-2">`:

```tsx
          <PlazaPromoBanner />
```

- [ ] **Step 6: Run both test files to verify they pass**

Run: `pnpm test apps/web/test/components/plaza-promo-banner.test.tsx apps/web/test/components/home-page.test.tsx`
Expected: PASS (3 banner tests + all home-page tests including the new one)

- [ ] **Step 7: Typecheck the web app**

Run: `pnpm -F @ultracreator/web exec tsc --noEmit`
Expected: no output, exit 0

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/plaza-promo-banner.tsx apps/web/src/components/home-page.tsx apps/web/test/components/plaza-promo-banner.test.tsx apps/web/test/components/home-page.test.tsx
git commit -m "feat(web): dismissible limited-time plaza promo banner on home

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire unit suite**

Run: `pnpm test`
Expected: all projects pass (`unit` fully; `pg` tests require a local Postgres — if they error on connection rather than assertions, note it and confirm the `unit` project is green; that matches the repo's status quo)

- [ ] **Step 2: Typecheck the whole monorepo**

Run: `pnpm typecheck`
Expected: exit 0

- [ ] **Step 3: Visual smoke check (optional but recommended)**

Start the web app with the preview tooling (worktree note: `next dev` hardcodes port 3000, so use an auto-port/portless invocation per the project's preview conventions) and verify on the homepage:
1. The promo banner renders under the hero text; ✕ dismisses it and it stays gone after reload.
2. The composer toolbar no longer shows the plaza switch.
3. "Settings" dialog shows the "Public to plaza" section; flipping it on and closing shows the trigger's active dot.

No commit — this task only proves the branch is green.
