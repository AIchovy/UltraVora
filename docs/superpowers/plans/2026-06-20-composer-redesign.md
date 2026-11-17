# Composer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the logged-in home composer into a clean two-tier layout (`+` attach, a settings modal, a Chat/Auto-pilot mode dropdown, an up-arrow Generate), add image-only uploads with `@`-mention referencing wired to the research prompt, turn Promo styles into animated expandable categories, and tidy the sidebar (New task + varied icons).

**Architecture:** Most work is in `apps/web`. New focused components (`mode-select.tsx`, `composer-settings-dialog.tsx`, `mention-picker.tsx`) keep `home-composer.tsx` from ballooning. Two cross-cutting changes land first: `packages/shared` gains the new durations + an `assets` field on `UserMessage`, and `apps/server` teaches the research prompt about labeled assets. Then the web work builds on those.

**Tech Stack:** Next.js App Router + React, TanStack Query, Radix UI primitives (`dialog`, `dropdown-menu`), `motion` v11, Tailwind, Zod (shared), Fastify + faux pi-ai provider (server). Tests: Vitest (+ jsdom for web), `@testing-library/user-event`, `renderWithQuery` helper.

---

## File Structure

**Create:**
- `apps/web/src/components/mode-select.tsx` — Chat/Auto-pilot dropdown (presentational).
- `apps/web/src/components/composer-settings-dialog.tsx` — settings modal (duration/aspect/audio) + the moved `Segmented`/`SegButton`/`SettingRow` helpers.
- `apps/web/src/components/mention-picker.tsx` — `@`-mention suggestion list (presentational).
- `apps/web/test/components/mode-select.test.tsx`
- `apps/web/test/components/composer-settings-dialog.test.tsx`
- `apps/web/test/components/home-composer-mentions.test.tsx`
- `apps/web/test/lib/seed-styles.test.ts`
- `apps/server/test/build-research-prompt.test.ts`

**Modify:**
- `packages/shared/src/constraints.ts` — add 120/180 durations.
- `packages/shared/src/message.ts` — add `AssetRefSchema` + `UserMessage.assets`.
- `packages/shared/test/schemas.test.ts` — update `ALLOWED_DURATIONS` assertion + add cases.
- `apps/server/src/phases/pi-research-handler.ts` — extract `buildResearchPrompt`, add assets block + system-prompt line.
- `apps/web/src/lib/seed-styles.ts` — restructure `SeedStyle` (add `id/icon/accent/prompts`, keep `img/title/inspiration`).
- `apps/web/src/components/home-page.tsx` — promo styles → expandable animated categories.
- `apps/web/src/components/home-composer.tsx` — toolbar refactor + image assets + `@` mentions.
- `apps/web/src/components/app-sidebar.tsx` — New task label + per-task icons.
- `apps/web/test/components/home-page.test.tsx` — update promo + duration/aspect tests.
- `apps/web/test/components/home-composer-autopilot.test.tsx` — switch → dropdown.
- `apps/web/test/components/app-sidebar.test.tsx` — New task + icon test.

**Commands:** shared/server tests `pnpm test -- <path>`; web tests `pnpm --filter @ultracreator/web test -- <path>` (or `pnpm test -- <path>` from the web package). Typecheck: `pnpm typecheck`.

---

## Task 1: Shared schema — durations 120/180 + asset references

**Files:**
- Modify: `packages/shared/src/constraints.ts`
- Modify: `packages/shared/src/message.ts`
- Modify: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: Update the failing assertions + add new cases**

In `packages/shared/test/schemas.test.ts`, change the allowed-set assertion (currently line ~49):

```ts
  it("exposes the allowed sets for the UI", () => {
    expect(ALLOWED_DURATIONS).toEqual([15, 30, 45, 60, 120, 180]);
    expect(ALLOWED_ASPECT_RATIOS).toEqual(["16:9", "9:16", "1:1"]);
  });

  it("accepts the new 2m and 3m durations", () => {
    for (const durationSec of [120, 180]) {
      const value = { durationSec, aspectRatio: "16:9", withVoiceover: false };
      expect(ConstraintsSchema.parse(value)).toEqual(value);
    }
  });
```

Add an `AssetRefSchema` import and a describe block (place after the existing `UserMessageSchema` describe):

```ts
import { UserMessageSchema, AssetRefSchema } from "../src/message.js";

describe("AssetRefSchema / UserMessage.assets", () => {
  it("accepts a labeled asset reference", () => {
    const v = { label: "logo", path: "uploads/logo.png", role: "logo" };
    expect(AssetRefSchema.parse(v)).toEqual(v);
  });

  it("rejects an unknown role", () => {
    expect(() => AssetRefSchema.parse({ label: "x", path: "p", role: "banner" })).toThrow();
  });

  it("accepts a message carrying labeled assets", () => {
    const v = {
      text: "Use @logo and @image1",
      uploadedFiles: ["uploads/logo.png", "uploads/a.png"],
      assets: [
        { label: "logo", path: "uploads/logo.png", role: "logo" },
        { label: "image1", path: "uploads/a.png", role: "image" },
      ],
    };
    expect(UserMessageSchema.parse(v)).toEqual(v);
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm test -- packages/shared/test/schemas.test.ts`
Expected: FAIL — `ALLOWED_DURATIONS` mismatch, `120/180` rejected, `AssetRefSchema` is not exported.

- [ ] **Step 3: Add the durations**

In `packages/shared/src/constraints.ts`:

```ts
export const ALLOWED_DURATIONS = [15, 30, 45, 60, 120, 180] as const;
export const ALLOWED_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

export const DurationSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(45),
  z.literal(60),
  z.literal(120),
  z.literal(180),
]);
```

- [ ] **Step 4: Add the asset schema**

Replace `packages/shared/src/message.ts` with:

```ts
import { z } from "zod";
import { ConstraintsSchema } from "./constraints.js";

/** A user-uploaded image the message refers to by an @label (e.g. @logo, @image1). */
export const AssetRefSchema = z.object({
  label: z.string(),
  path: z.string(),
  role: z.enum(["logo", "image"]),
});

export const UserMessageSchema = z.object({
  text: z.string(),
  uploadedFiles: z.array(z.string()).optional(),
  assets: z.array(AssetRefSchema).optional(),
  constraints: ConstraintsSchema.optional(),
});

export type AssetRef = z.infer<typeof AssetRefSchema>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
```

(`packages/shared/src/index.ts` already does `export * from "./message.js"`, so `AssetRefSchema`/`AssetRef` are re-exported automatically.)

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm test -- packages/shared/test/schemas.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constraints.ts packages/shared/src/message.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add 2m/3m durations and labeled asset refs"
```

---

## Task 2: Server — labeled assets in the research prompt

**Files:**
- Modify: `apps/server/src/phases/pi-research-handler.ts`
- Create: `apps/server/test/build-research-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/build-research-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildResearchPrompt } from "../src/phases/pi-research-handler.js";

describe("buildResearchPrompt", () => {
  it("lists labeled assets and marks the logo", () => {
    const prompt = buildResearchPrompt(
      {
        text: "Use @logo and @image1 for the promo",
        assets: [
          { label: "logo", path: "assets/logo.png", role: "logo" },
          { label: "image1", path: "assets/a.png", role: "image" },
        ],
      },
      undefined,
    );
    expect(prompt).toContain("Referenced assets");
    expect(prompt).toContain("- @logo → assets/logo.png (the brand LOGO)");
    expect(prompt).toContain("- @image1 → assets/a.png");
    expect(prompt).toContain("Use @logo and @image1");
  });

  it("falls back to the flat uploaded-files line when no assets", () => {
    const prompt = buildResearchPrompt(
      { text: "hello", uploadedFiles: ["uploads/x.png"] },
      undefined,
    );
    expect(prompt).toContain("Uploaded files: uploads/x.png");
    expect(prompt).not.toContain("Referenced assets");
  });

  it("returns a default when there is nothing to say", () => {
    expect(buildResearchPrompt(undefined, undefined)).toBe("Begin research.");
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test -- apps/server/test/build-research-prompt.test.ts`
Expected: FAIL — `buildResearchPrompt` is not exported.

- [ ] **Step 3: Extract + extend the prompt builder**

In `apps/server/src/phases/pi-research-handler.ts`, add an import and an exported function near the top (after the existing imports), then use it in `run`:

```ts
import type { UserMessage } from "@ultracreator/shared";

export function buildResearchPrompt(
  initial: UserMessage | undefined,
  refinement: string | undefined,
): string {
  const promptParts: string[] = [];
  if (initial) {
    promptParts.push(`User message: ${initial.text}`);
    if (initial.assets?.length) {
      const lines = initial.assets.map(
        (a) => `- @${a.label} → ${a.path}${a.role === "logo" ? " (the brand LOGO)" : ""}`,
      );
      promptParts.push(
        `Referenced assets (the user may cite these as @label in their message):\n${lines.join("\n")}`,
      );
    } else if (initial.uploadedFiles?.length) {
      promptParts.push(`Uploaded files: ${initial.uploadedFiles.join(", ")}`);
    }
    if (initial.constraints) {
      promptParts.push(`Constraints: ${JSON.stringify(initial.constraints)}`);
    }
  }
  if (refinement) {
    promptParts.push(`Refinement: ${refinement}`);
  }
  return promptParts.join("\n\n") || "Begin research.";
}
```

Then in `run`, replace the inline `promptParts` block with:

```ts
    const prompt = buildResearchPrompt(ctx.initialMessage, ctx.refinement);
```

(Delete the now-dead `const initial = …; const refinement = …; const promptParts …` lines.)

- [ ] **Step 4: Add the system-prompt guidance**

In the `SYSTEM_PROMPT` `Rules:` list of the same file, add a bullet after the `read_upload` rule:

```
- The user's message may contain @label mentions (e.g. @logo, @image1) that refer to
  the "Referenced assets" listed beneath it. Treat the asset labelled "logo" as the
  brand logo; use read_upload to inspect any referenced asset by its path.
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm test -- apps/server/test/build-research-prompt.test.ts apps/server/test/pi-research-handler.test.ts`
Expected: PASS (the existing handler tests still pass — behavior is unchanged for runs without assets).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/phases/pi-research-handler.ts apps/server/test/build-research-prompt.test.ts
git commit -m "feat(server): teach the research prompt about labeled @assets"
```

---

## Task 3: Restructure the promo-style seed data

**Files:**
- Modify: `apps/web/src/lib/seed-styles.ts`
- Create: `apps/web/test/lib/seed-styles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/lib/seed-styles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SEED_STYLES, ACCENT_KEYS } from "@/lib/seed-styles";

describe("SEED_STYLES", () => {
  it("keeps the four named styles", () => {
    expect(SEED_STYLES.map((s) => s.title)).toEqual([
      "Minimalist Tech",
      "Pro Walkthrough",
      "Dynamic Promo",
      "Brand Narrative",
    ]);
  });

  it("gives each style a unique id, an accent, an icon and 4–5 prompts", () => {
    const ids = new Set<string>();
    for (const s of SEED_STYLES) {
      ids.add(s.id);
      expect(ACCENT_KEYS).toContain(s.accent);
      expect(typeof s.icon).toBe("function");
      expect(s.prompts.length).toBeGreaterThanOrEqual(4);
      expect(s.prompts.length).toBeLessThanOrEqual(5);
      expect(s.img).toMatch(/^https?:\/\//); // kept for the marketing page
      expect(s.inspiration.length).toBeGreaterThan(0);
    }
    expect(ids.size).toBe(SEED_STYLES.length);
  });

  it("assigns a distinct accent to each style", () => {
    expect(new Set(SEED_STYLES.map((s) => s.accent)).size).toBe(SEED_STYLES.length);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test -- apps/web/test/lib/seed-styles.test.ts`
Expected: FAIL — `ACCENT_KEYS`, `id`, `icon`, `accent`, `prompts` don't exist.

- [ ] **Step 3: Rewrite the seed data**

Replace `apps/web/src/lib/seed-styles.ts` with:

```ts
import type { LucideIcon } from "lucide-react";
import { Cpu, ListChecks, Zap, Clapperboard } from "lucide-react";

export const ACCENT_KEYS = ["blue", "emerald", "amber", "violet"] as const;
export type AccentKey = (typeof ACCENT_KEYS)[number];

/**
 * The four "promo style" seeds. `title/inspiration/img` are kept for the
 * marketing landing page (`marketing/landing-features.tsx`). The logged-in home
 * gallery uses `icon/accent/prompts`: clicking a style pill expands its preset
 * prompts, and each style is tinted by its accent.
 */
export interface SeedStyle {
  id: string;
  title: string;
  inspiration: string;
  img: string;
  icon: LucideIcon;
  accent: AccentKey;
  prompts: string[];
}

export const SEED_STYLES: SeedStyle[] = [
  {
    id: "minimalist-tech",
    title: "Minimalist Tech",
    inspiration: "Clean, bright, futuristic",
    img: "https://picsum.photos/seed/uc-minimalist-tech/600/800",
    icon: Cpu,
    accent: "blue",
    prompts: [
      "A 15-second clean product reveal: white seamless background, soft studio lighting, the product rotating slowly with crisp UI callouts.",
      "Bright minimal walkthrough of the dashboard's three core features, generous whitespace, subtle depth-of-field, calm pacing.",
      "Futuristic hero shot: the app floating in a softly lit gradient space, thin geometric accents, kinetic typography for each benefit.",
      "Macro close-ups of the interface with smooth pans, a monochrome palette plus one accent color, confident minimal captions.",
    ],
  },
  {
    id: "pro-walkthrough",
    title: "Pro Walkthrough",
    inspiration: "Logical SaaS walkthrough",
    img: "https://picsum.photos/seed/uc-pro-walkthrough/600/800",
    icon: ListChecks,
    accent: "emerald",
    prompts: [
      "A structured SaaS walkthrough: screen recording framed in a clean device mockup, numbered steps, voiceover-friendly pacing.",
      "Explain the core workflow end to end, annotated cursor highlights, section title cards, a professional and reassuring tone.",
      "Before/after comparison of the manual process vs. our product, split-screen, clear labels, a measurable outcome at the end.",
      "Feature deep-dive: zoom into one capability, callout bubbles, a short customer-style scenario, a crisp corporate look.",
    ],
  },
  {
    id: "dynamic-promo",
    title: "Dynamic Promo",
    inspiration: "Fast, punchy, scroll-stopping",
    img: "https://picsum.photos/seed/uc-dynamic-promo/600/800",
    icon: Zap,
    accent: "amber",
    prompts: [
      "Fast-cut 15-second social ad: punchy beat-synced edits, bold full-screen captions, high-energy product moments.",
      "Scroll-stopping vertical teaser: a hook in the first 2 seconds, zoom punches, sticker-style text, a trending vibe.",
      "Montage of the product in action set to an upbeat track, snappy transitions, a vivid color grade, a strong end-card CTA.",
      "Event-style hype reel: countdown intro, flashing key features, energetic motion graphics, loud and confident.",
    ],
  },
  {
    id: "brand-narrative",
    title: "Brand Narrative",
    inspiration: "Immersive brand storytelling",
    img: "https://picsum.photos/seed/uc-brand-narrative/600/800",
    icon: Clapperboard,
    accent: "violet",
    prompts: [
      "Cinematic 60-second brand story: a warm film look, slow push-ins, evocative b-roll, an emotional voiceover arc.",
      "Origin story — the problem we kept hitting and the team that set out to fix it, an intimate tone, textured visuals.",
      "Immersive lifestyle film showing the product woven into real moments, soft music, elegant typography, a premium feel.",
      "Values-driven manifesto: poetic narration, striking hero imagery, a memorable closing brand statement.",
    ],
  },
];
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm test -- apps/web/test/lib/seed-styles.test.ts`
Expected: PASS. (The marketing page still compiles — it only reads `img/title/inspiration`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/seed-styles.ts apps/web/test/lib/seed-styles.test.ts
git commit -m "feat(web): restructure promo-style seeds into expandable categories"
```

---

## Task 4: ModeSelect dropdown component

**Files:**
- Create: `apps/web/src/components/mode-select.tsx`
- Create: `apps/web/test/components/mode-select.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/mode-select.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModeSelect } from "@/components/mode-select";
import { renderWithQuery } from "../helpers/render-with-query";

describe("<ModeSelect>", () => {
  it("shows the current mode label", () => {
    renderWithQuery(<ModeSelect autoApprove onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Auto-pilot");
  });

  it("shows Chat when auto-pilot is off", () => {
    renderWithQuery(<ModeSelect autoApprove={false} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Chat");
  });

  it("selecting Chat calls onChange(false)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<ModeSelect autoApprove onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /mode/i }));
    await user.click(await screen.findByRole("menuitem", { name: /chat/i }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test -- apps/web/test/components/mode-select.test.tsx`
Expected: FAIL — module `@/components/mode-select` not found.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/mode-select.tsx`:

```tsx
"use client";
import { MessageSquare, Rocket, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

interface Props {
  autoApprove: boolean;
  onChange: (value: boolean) => void;
}

export function ModeSelect({ autoApprove, onChange }: Props): React.ReactElement {
  const Icon = autoApprove ? Rocket : MessageSquare;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="mode"
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground"
      >
        <Icon className="h-4 w-4" />
        <span>{autoApprove ? "Auto-pilot" : "Chat"}</span>
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onChange(false)}>
          <MessageSquare className="h-4 w-4" />
          <span>Chat</span>
          <span className="ml-auto text-[11px] text-muted-foreground">Manual</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange(true)}>
          <Rocket className="h-4 w-4" />
          <span>Auto-pilot</span>
          <span className="ml-auto text-[11px] text-muted-foreground">Auto</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm test -- apps/web/test/components/mode-select.test.tsx`
Expected: PASS. (If Radix needs pointer polyfills the shared jsdom setup already provides them — `sidebar-user` uses the same dropdown in tests.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/mode-select.tsx apps/web/test/components/mode-select.test.tsx
git commit -m "feat(web): Chat/Auto-pilot mode dropdown"
```

---

## Task 5: Settings modal component

**Files:**
- Create: `apps/web/src/components/composer-settings-dialog.tsx`
- Create: `apps/web/test/components/composer-settings-dialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/composer-settings-dialog.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerSettingsDialog } from "@/components/composer-settings-dialog";
import { renderWithQuery } from "../helpers/render-with-query";

function setup(overrides: Partial<React.ComponentProps<typeof ComposerSettingsDialog>> = {}) {
  const props = {
    duration: 30 as const,
    onDurationChange: vi.fn(),
    aspect: "16:9" as const,
    onAspectChange: vi.fn(),
    voiceover: false,
    onVoiceoverChange: vi.fn(),
    subtitles: false,
    onSubtitlesChange: vi.fn(),
    bgm: false,
    onBgmChange: vi.fn(),
    ...overrides,
  };
  renderWithQuery(<ComposerSettingsDialog {...props} />);
  return props;
}

describe("<ComposerSettingsDialog>", () => {
  it("opens the modal and shows all six durations", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const group = await screen.findByRole("group", { name: "duration" });
    for (const label of ["15s", "30s", "45s", "60s", "2m", "3m"]) {
      expect(within(group).getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("picking 2m reports 120 seconds", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    await user.click(within(await screen.findByRole("group", { name: "duration" })).getByRole("button", { name: "2m" }));
    expect(props.onDurationChange).toHaveBeenCalledWith(120);
  });

  it("disables subtitles until voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: false });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(await screen.findByRole("switch", { name: "subtitles" })).toBeDisabled();
  });

  it("subtitles is enabled when voiceover is on", async () => {
    const user = userEvent.setup();
    setup({ voiceover: true });
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(await screen.findByRole("switch", { name: "subtitles" })).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test -- apps/web/test/components/composer-settings-dialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component (carries the moved Segmented/SegButton/SettingRow)**

Create `apps/web/src/components/composer-settings-dialog.tsx`:

```tsx
"use client";
import { Settings2, RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import {
  ALLOWED_DURATIONS,
  ALLOWED_ASPECT_RATIOS,
  type AspectRatio,
  type Duration,
} from "@ultracreator/shared";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

interface Props {
  duration: Duration;
  onDurationChange: (d: Duration) => void;
  aspect: AspectRatio;
  onAspectChange: (a: AspectRatio) => void;
  voiceover: boolean;
  onVoiceoverChange: (v: boolean) => void;
  subtitles: boolean;
  onSubtitlesChange: (v: boolean) => void;
  bgm: boolean;
  onBgmChange: (v: boolean) => void;
}

const ASPECT_ICON: Record<AspectRatio, typeof Square> = {
  "16:9": RectangleHorizontal,
  "9:16": RectangleVertical,
  "1:1": Square,
};

function durationLabel(d: Duration): string {
  return d < 120 ? `${d}s` : `${d / 60}m`;
}

export function ComposerSettingsDialog({
  duration,
  onDurationChange,
  aspect,
  onAspectChange,
  voiceover,
  onVoiceoverChange,
  subtitles,
  onSubtitlesChange,
  bgm,
  onBgmChange,
}: Props): React.ReactElement {
  const active = voiceover || bgm;
  return (
    <Dialog>
      <DialogTrigger
        aria-label="video settings"
        className={cn(
          "relative inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium outline-none transition-colors",
          active
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <Settings2 className="h-4 w-4" />
        <span>Settings</span>
        {active && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Video settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <Field label="Duration">
            <Segmented aria-label="duration">
              {ALLOWED_DURATIONS.map((d) => (
                <SegButton key={d} active={duration === d} onClick={() => onDurationChange(d)}>
                  {durationLabel(d)}
                </SegButton>
              ))}
            </Segmented>
          </Field>

          <Field label="Aspect ratio">
            <Segmented aria-label="aspect ratio">
              {ALLOWED_ASPECT_RATIOS.map((a) => {
                const Icon = ASPECT_ICON[a];
                return (
                  <SegButton key={a} active={aspect === a} onClick={() => onAspectChange(a)}>
                    <Icon className="h-3.5 w-3.5" />
                    {a}
                  </SegButton>
                );
              })}
            </Segmented>
          </Field>

          <Field label="Audio">
            <div className="space-y-3">
              <SettingRow label="Voiceover">
                <Switch checked={voiceover} onCheckedChange={onVoiceoverChange} aria-label="voiceover" />
              </SettingRow>
              <SettingRow label="Subtitles" muted={!voiceover}>
                <Switch
                  checked={voiceover && subtitles}
                  onCheckedChange={onSubtitlesChange}
                  disabled={!voiceover}
                  aria-label="subtitles"
                />
              </SettingRow>
              <SettingRow label="Background music">
                <Switch checked={bgm} onCheckedChange={onBgmChange} aria-label="background music" />
              </SettingRow>
            </div>
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function Segmented({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div role="group" className="flex flex-wrap items-center gap-0.5 rounded-lg bg-muted p-0.5" {...rest}>
      {children}
    </div>
  );
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors",
        active ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SettingRow({
  label,
  muted,
  children,
}: {
  label: string;
  muted?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={cn("flex items-center justify-between text-sm", muted && "opacity-50")}>
      <span>{label}</span>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm test -- apps/web/test/components/composer-settings-dialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/composer-settings-dialog.tsx apps/web/test/components/composer-settings-dialog.test.tsx
git commit -m "feat(web): composer settings modal (duration/aspect/audio)"
```

---

## Task 6: Promo styles — expandable animated categories

**Files:**
- Modify: `apps/web/src/components/home-page.tsx` (the `Promo styles` `<section>` only)
- Modify: `apps/web/test/components/home-page.test.tsx` (the style-card test)

- [ ] **Step 1: Update the failing test**

In `apps/web/test/components/home-page.test.tsx`, replace the `clicking a style card fills the composer` test with:

```ts
import { SEED_STYLES } from "@/lib/seed-styles";

  it("expanding a style and clicking a preset fills the composer", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    const style = SEED_STYLES[0]!; // Minimalist Tech
    await user.click(screen.getByRole("button", { name: new RegExp(style.title, "i") }));
    const preset = style.prompts[0]!;
    await user.click(await screen.findByRole("button", { name: preset }));
    expect(screen.getByRole("textbox")).toHaveValue(preset);
  });

  it("only one style expands at a time", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: /minimalist tech/i }));
    expect(await screen.findByRole("button", { name: SEED_STYLES[0]!.prompts[0]! })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /dynamic promo/i }));
    expect(screen.queryByRole("button", { name: SEED_STYLES[0]!.prompts[0]! })).toBeNull();
    expect(await screen.findByRole("button", { name: SEED_STYLES[2]!.prompts[0]! })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `pnpm test -- apps/web/test/components/home-page.test.tsx`
Expected: FAIL — old image cards don't expose preset buttons.

- [ ] **Step 3: Rewrite the promo section**

In `apps/web/src/components/home-page.tsx`:

1. Extend imports:

```tsx
import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { SEED_STYLES, type AccentKey } from "@/lib/seed-styles";
```

2. Add accent class maps + expand state inside `HomePage` (near the other `useState`s):

```tsx
  const [expandedStyle, setExpandedStyle] = useState<string | null>(null);
```

3. Add this module-level constant (top of file, after imports):

```tsx
const ACCENT: Record<AccentKey, { pill: string; item: string }> = {
  blue: {
    pill: "bg-blue-500/10 text-blue-700 ring-blue-500/30 dark:text-blue-300",
    item: "hover:border-blue-500/60 hover:bg-blue-500/10 hover:text-blue-700 dark:hover:text-blue-300",
  },
  emerald: {
    pill: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300",
    item: "hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300",
  },
  amber: {
    pill: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300",
    item: "hover:border-amber-500/60 hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300",
  },
  violet: {
    pill: "bg-violet-500/10 text-violet-700 ring-violet-500/30 dark:text-violet-300",
    item: "hover:border-violet-500/60 hover:bg-violet-500/10 hover:text-violet-700 dark:hover:text-violet-300",
  },
};
```

4. Replace the entire `<section className="mt-12">…</section>` block with:

```tsx
          <section className="mt-12">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Promo styles</h2>
              <span className="text-xs text-muted-foreground/70">Pick a style, then a starting prompt</span>
            </div>

            <div className="flex flex-wrap gap-2">
              {SEED_STYLES.map((style) => {
                const Icon = style.icon;
                const open = expandedStyle === style.id;
                return (
                  <motion.button
                    key={style.id}
                    type="button"
                    aria-expanded={open}
                    onClick={() => setExpandedStyle((cur) => (cur === style.id ? null : style.id))}
                    whileHover={reduce ? undefined : { y: -2 }}
                    whileTap={reduce ? undefined : { scale: 0.97 }}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium ring-1 transition-colors",
                      open
                        ? cn("ring-1", ACCENT[style.accent].pill)
                        : "bg-muted text-muted-foreground ring-transparent hover:bg-muted/70 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {style.title}
                  </motion.button>
                );
              })}
            </div>

            <AnimatePresence initial={false}>
              {expandedStyle &&
                (() => {
                  const style = SEED_STYLES.find((s) => s.id === expandedStyle)!;
                  return (
                    <motion.div
                      key={style.id}
                      initial={reduce ? false : { height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
                      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                        {style.prompts.map((prompt, i) => (
                          <motion.li
                            key={prompt}
                            initial={reduce ? false : { opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: reduce ? 0 : i * 0.04 }}
                          >
                            <button
                              type="button"
                              onClick={() => setText(prompt)}
                              className={cn(
                                "w-full rounded-xl border border-border bg-card px-3 py-2.5 text-left text-[13px] leading-snug text-muted-foreground transition-colors",
                                ACCENT[style.accent].item,
                              )}
                            >
                              {prompt}
                            </button>
                          </motion.li>
                        ))}
                      </ul>
                    </motion.div>
                  );
                })()}
            </AnimatePresence>
          </section>
```

(`reduce` already exists via `useReducedMotion()` at the top of `HomePage`. Remove the now-unused image `<img>`/gradient markup — it lived only in the old section. The `motion` import already existed; just add `AnimatePresence`.)

- [ ] **Step 4: Run the test — verify it passes**

Run: `pnpm test -- apps/web/test/components/home-page.test.tsx`
Expected: PASS for the two new promo tests. (The duration/aspect group tests in this file still pass — the composer's inline controls are untouched until Task 7.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/home-page.tsx apps/web/test/components/home-page.test.tsx
git commit -m "feat(web): expandable animated promo-style categories"
```

---

## Task 7: Composer toolbar refactor

**Files:**
- Modify: `apps/web/src/components/home-composer.tsx`
- Modify: `apps/web/test/components/home-composer-autopilot.test.tsx`
- Modify: `apps/web/test/components/home-page.test.tsx` (duration/aspect tests now open the modal)

- [ ] **Step 1: Update the auto-pilot test to the dropdown**

Replace `apps/web/test/components/home-composer-autopilot.test.tsx`'s three `it(...)` bodies with:

```tsx
describe("<HomeComposer> auto-pilot", () => {
  it("defaults to Auto-pilot and sends autoApprove:true on generate", async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Auto-pilot");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ autoApprove: true }));
  });

  it("picking Chat persists OFF and sends autoApprove:false", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.click(screen.getByRole("button", { name: /mode/i }));
    await user.click(await screen.findByRole("menuitem", { name: /chat/i }));
    expect(localStorage.getItem("uc.autoApprove")).toBe("false");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(createSession).toHaveBeenCalledWith({ autoApprove: false }));
  });

  it("starts as Chat when localStorage says so", async () => {
    localStorage.setItem("uc.autoApprove", "false");
    renderComposer();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /mode/i })).toHaveTextContent("Chat"),
    );
  });
});
```

- [ ] **Step 2: Update the home-page duration/aspect tests to open the modal**

In `apps/web/test/components/home-page.test.tsx`, replace the two `seeds the composer …` tests with versions that open the settings modal first:

```ts
  it("seeds the composer to 60s / 16:9 when Brand story is picked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Brand story" }));
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const duration = await screen.findByRole("group", { name: "duration" });
    const aspect = screen.getByRole("group", { name: "aspect ratio" });
    expect(within(duration).getByRole("button", { name: "60s", pressed: true })).toBeInTheDocument();
    expect(within(aspect).getByRole("button", { name: "16:9", pressed: true })).toBeInTheDocument();
  });

  it("seeds the composer to 45s / 1:1 when Freeform is picked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<HomePage />);
    await user.click(screen.getByRole("button", { name: "Freeform" }));
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    const duration = await screen.findByRole("group", { name: "duration" });
    const aspect = screen.getByRole("group", { name: "aspect ratio" });
    expect(within(duration).getByRole("button", { name: "45s", pressed: true })).toBeInTheDocument();
    expect(within(aspect).getByRole("button", { name: "1:1", pressed: true })).toBeInTheDocument();
  });
```

- [ ] **Step 3: Run the tests — verify they fail**

Run: `pnpm test -- apps/web/test/components/home-composer-autopilot.test.tsx apps/web/test/components/home-page.test.tsx`
Expected: FAIL — no `mode` button / no `video settings` trigger yet.

- [ ] **Step 4: Refactor the composer toolbar**

In `apps/web/src/components/home-composer.tsx`:

1. Replace the icon imports line with:

```tsx
import { X, Loader2, ArrowUp, Plus, Link2, ImagePlus } from "lucide-react";
```

2. Remove the now-unused imports: `ALLOWED_DURATIONS`, `ALLOWED_ASPECT_RATIOS`, `Switch`, and `Settings2`/`Paperclip`. Keep `AspectRatio`, `Duration` types. Add:

```tsx
import { ModeSelect } from "@/components/mode-select";
import { ComposerSettingsDialog } from "@/components/composer-settings-dialog";
```

3. Delete the `settingsOpen` state and the entire inline "Audio" popover `<div className="relative">…</div>` block, the two `<Segmented>` blocks (duration + aspect), the standalone `<label>` Attach block, the Auto-pilot `<div>` Switch block, and the old `<Button>Generate</Button>`.

4. Replace the whole controls row `<div className="flex flex-wrap items-center gap-2">…</div>` with:

```tsx
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
          <Plus className="h-4 w-4" />
          <span>Attach</span>
          <input
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            aria-label="attach images"
            onChange={(e) => setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])])}
          />
        </label>

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
        />

        <div className="ml-auto flex items-center gap-1">
          <ModeSelect autoApprove={autoApprove} onChange={toggleAutoApprove} />
          <Button
            onClick={handleGenerate}
            disabled={busy || !canSubmit}
            size="icon"
            aria-label="Generate"
            className="rounded-full"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </Button>
        </div>
      </div>
```

5. Change the textarea `onKeyDown` to Enter-submits / Shift+Enter-newline:

```tsx
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleGenerate();
          }
        }}
```

6. Delete the now-unused `Segmented`, `SegButton`, and `SettingRow` function definitions at the bottom of the file (they moved into `composer-settings-dialog.tsx`).

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm test -- apps/web/test/components/home-composer-autopilot.test.tsx apps/web/test/components/home-composer.test.tsx apps/web/test/components/home-page.test.tsx`
Expected: PASS. (`home-composer.test.tsx` is unchanged — the up-arrow button keeps `aria-label="Generate"`, and constraints still come from the duration/aspect props.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/home-composer.tsx apps/web/test/components/home-composer-autopilot.test.tsx apps/web/test/components/home-page.test.tsx
git commit -m "feat(web): two-tier composer toolbar (+, settings modal, mode dropdown, up-arrow)"
```

---

## Task 8: Image uploads + `@`-mention referencing

**Files:**
- Create: `apps/web/src/components/mention-picker.tsx`
- Modify: `apps/web/src/components/home-composer.tsx`
- Create: `apps/web/test/components/home-composer-mentions.test.tsx`

This task replaces the composer's separate `logo`/`files` state with a single asset model: a dedicated logo (the Logo tile) plus an ordered list of attached images carrying stable `@image{n}` labels. It adds a `@`-picker, sends `assets` on submit, and caps total images at 5.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/components/home-composer-mentions.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { createSession, uploadFiles, postMessage } from "@/lib/api-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  uploadFiles: vi.fn(async (_sid: string, files: File[]) => ({
    files: files.map((f, i) => ({ path: `uploads/${i}-${f.name}` })),
  })),
  postMessage: vi.fn(async () => {}),
}));

// Stateful wrapper so typing + mention insertion actually update the textarea.
function Harness() {
  const [text, setText] = useState("Promo for Acme ");
  return (
    <HomeComposer
      text={text}
      onTextChange={setText}
      duration={30}
      onDurationChange={() => {}}
      aspect="16:9"
      onAspectChange={() => {}}
      placeholder="describe…"
    />
  );
}

function pngFile(name: string) {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("<HomeComposer> image assets + @ mentions", () => {
  it("attaching an image shows a thumbnail labeled image1", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    expect(await screen.findByText("@image1")).toBeInTheDocument();
  });

  it("typing @ opens the picker; selecting inserts the label", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    // userEvent.type focuses the textarea and appends at the end of the value.
    await user.type(screen.getByRole("textbox"), "@");
    await user.click(await screen.findByRole("option", { name: /@image1/i }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Promo for Acme @image1 "));
  });

  it("sends assets on generate", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.upload(screen.getByLabelText("attach images"), pngFile("a.png"));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(uploadFiles).toHaveBeenCalled();
    const body = vi.mocked(postMessage).mock.calls[0]![1];
    expect(body.assets).toEqual([
      { label: "image1", path: "uploads/0-a.png", role: "image" },
    ]);
  });

  it("disables Attach once five images are attached", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    const input = screen.getByLabelText("attach images");
    await user.upload(input, [pngFile("1.png"), pngFile("2.png"), pngFile("3.png"), pngFile("4.png"), pngFile("5.png")]);
    await waitFor(() => expect(screen.getByLabelText("attach images")).toBeDisabled());
  });
});
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm test -- apps/web/test/components/home-composer-mentions.test.tsx`
Expected: FAIL — no `@image1` thumbnail, no picker `option`, `assets` not sent, input not disabled at cap.

- [ ] **Step 3: Implement the mention picker**

Create `apps/web/src/components/mention-picker.tsx`:

```tsx
"use client";
import { cn } from "@/lib/utils";

export interface MentionItem {
  label: string;
  previewUrl: string | null;
}

interface Props {
  items: MentionItem[];
  activeIndex: number;
  onSelect: (label: string) => void;
}

export function MentionPicker({ items, activeIndex, onSelect }: Props): React.ReactElement {
  return (
    <ul
      role="listbox"
      aria-label="reference an image"
      className="absolute bottom-full left-0 z-50 mb-2 max-h-56 w-56 overflow-y-auto rounded-xl border bg-popover p-1 shadow-pop"
    >
      {items.map((item, i) => (
        <li key={item.label}>
          <button
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            // Prevent the textarea from losing focus before onSelect runs.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(item.label)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              i === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted",
            )}
          >
            {item.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.previewUrl} alt="" className="h-6 w-6 rounded object-cover" />
            ) : (
              <span className="h-6 w-6 rounded bg-muted" />
            )}
            <span className="font-medium">@{item.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Rework the composer's asset model + `@` logic**

In `apps/web/src/components/home-composer.tsx`:

1. Add imports:

```tsx
import { useRef } from "react";
import type { AssetRef } from "@ultracreator/shared";
import { MentionPicker, type MentionItem } from "@/components/mention-picker";
```

2. Replace the `files`/`logo` state region with the asset model. Keep `logo` (the Logo tile) and add an `images` array + a monotonic counter:

```tsx
  interface ImageAsset { id: number; file: File; label: string; previewUrl: string }
  const [images, setImages] = useState<ImageAsset[]>([]);
  const imageCounter = useRef(0);

  const MAX_IMAGES = 5; // logo counts toward this cap
  const imageCount = images.length + (logo ? 1 : 0);

  function addImages(files: File[]) {
    setImages((prev) => {
      const room = MAX_IMAGES - (prev.length + (logo ? 1 : 0));
      const next = files.slice(0, Math.max(0, room)).map((file) => {
        imageCounter.current += 1;
        return {
          id: imageCounter.current,
          file,
          label: `image${imageCounter.current}`,
          previewUrl: URL.createObjectURL(file),
        };
      });
      return [...prev, ...next];
    });
  }

  function removeImage(id: number) {
    setImages((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  useEffect(() => {
    return () => images.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

(The old `files` state and its `setFiles` usages are removed. The `logo`/`logoPreview` state stays as-is.)

3. Add the `@`-mention state + helpers (place above the return):

```tsx
  const [caret, setCaret] = useState(0);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionSuppressed, setMentionSuppressed] = useState(false);

  const mentionAssets: MentionItem[] = [
    ...(logo ? [{ label: "logo", previewUrl: logoPreview }] : []),
    ...images.map((a) => ({ label: a.label, previewUrl: a.previewUrl })),
  ];

  // Returns the @-fragment immediately before the caret, or null. Triggers only
  // at string start or after whitespace, with no whitespace between @ and caret.
  function mentionQuery(): { start: number; query: string } | null {
    const upto = text.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
    const query = upto.slice(at + 1);
    if (/\s/.test(query)) return null;
    return { start: at, query };
  }

  const mq = mentionQuery();
  const mentionMatches = mq
    ? mentionAssets.filter((a) => a.label.toLowerCase().startsWith(mq.query.toLowerCase()))
    : [];
  const mentionOpen = mq !== null && mentionMatches.length > 0 && !mentionSuppressed;

  function insertMention(label: string) {
    if (!mq) return;
    const before = text.slice(0, mq.start);
    const after = text.slice(caret);
    const next = `${before}@${label} ${after}`;
    onTextChange(next);
    setMentionActive(0);
    // Move the caret past the inserted token on the next tick.
    const pos = before.length + label.length + 2;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos, pos);
        setCaret(pos);
      }
    });
  }
```

4. Add a textarea ref and wire change/keydown/select to track the caret and drive the picker. Give the `Textarea` a `ref={textareaRef}`:

```tsx
  const textareaRef = useRef<HTMLTextAreaElement>(null);
```

Replace the `Textarea`'s `onChange`/`onKeyDown` with:

```tsx
        ref={textareaRef}
        onChange={(e) => {
          onTextChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setMentionSuppressed(false); // typing re-opens the picker after an Escape
        }}
        onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={(e) => {
          if (mentionOpen) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setMentionActive((i) => (i + 1) % mentionMatches.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setMentionActive((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              insertMention(mentionMatches[mentionActive]!.label);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setMentionSuppressed(true); // collapse the picker until the next keystroke
              return;
            }
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void handleGenerate();
          }
        }}
```

Wrap the `Textarea` in a `relative` container and render the picker:

```tsx
      <div className="relative">
        <Textarea
          /* …existing props + the ref/handlers above… */
        />
        {mentionOpen && (
          <MentionPicker
            items={mentionMatches}
            activeIndex={mentionActive}
            onSelect={insertMention}
          />
        )}
      </div>
```

5. Render image thumbnails in the URL/Logo row (after the Logo `<label>`), and disable Attach at the cap. Inside the asset row `<div className="flex gap-2.5">`, append:

```tsx
        {images.map((a) => (
          <div key={a.id} className="relative h-20 w-20 overflow-hidden rounded-2xl bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.previewUrl} alt={a.label} className="h-full w-full object-cover" />
            <span className="absolute bottom-0 left-0 right-0 bg-black/55 px-1 py-0.5 text-center text-[10px] font-medium text-white">
              @{a.label}
            </span>
            <button
              type="button"
              aria-label={`remove ${a.label}`}
              onClick={() => removeImage(a.id)}
              className="absolute right-0.5 top-0.5 rounded-full bg-black/55 p-0.5 text-white hover:bg-black/75"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
```

Update the Attach `<input>` to use `addImages` and disable at the cap:

```tsx
          <input
            type="file"
            accept="image/*"
            multiple
            disabled={imageCount >= MAX_IMAGES}
            className="sr-only"
            aria-label="attach images"
            onChange={(e) => {
              addImages(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
```

Make the wrapping `<label>` reflect the disabled state:

```tsx
        <label
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors",
            imageCount >= MAX_IMAGES
              ? "cursor-not-allowed opacity-40"
              : "cursor-pointer hover:bg-muted hover:text-foreground",
          )}
        >
```

Also delete the old `(files.length > 0 || logo) && (...)` chip list block — thumbnails now live in the asset row.

6. Build `assets` in `handleGenerate`. Replace the `toUpload`/`uploadedFiles` region with:

```tsx
    const orderedAssets: { file: File; label: string; role: "logo" | "image" }[] = [
      ...(logo ? [{ file: logo, label: "logo", role: "logo" as const }] : []),
      ...images.map((a) => ({ file: a.file, label: a.label, role: "image" as const })),
    ];
    try {
      const { sessionId } = await createSession({ autoApprove });
      let uploadedFiles: string[] | undefined;
      let assets: AssetRef[] | undefined;
      if (orderedAssets.length > 0) {
        const out = await uploadFiles(sessionId, orderedAssets.map((a) => a.file));
        uploadedFiles = out.files.map((f) => f.path);
        assets = orderedAssets.map((a, i) => ({ label: a.label, path: out.files[i]!.path, role: a.role }));
      }
      await postMessage(sessionId, {
        text: messageText,
        ...(uploadedFiles ? { uploadedFiles } : {}),
        ...(assets ? { assets } : {}),
        constraints: {
          durationSec: duration,
          aspectRatio: aspect,
          withVoiceover: voiceover,
          subtitles: voiceover && subtitles,
          bgm,
        },
      });
      void qc.invalidateQueries({ queryKey: ["sessions"] });
      setPendingMessage(sessionId, { text: bubble, files: orderedAssets.map((a) => a.file.name) });
      router.push(`/s/${sessionId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the project");
      setBusy(false);
    }
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `pnpm test -- apps/web/test/components/home-composer-mentions.test.tsx apps/web/test/components/home-composer.test.tsx apps/web/test/components/home-composer-autopilot.test.tsx`
Expected: PASS. (`home-composer.test.tsx` still passes — with no attachments, `orderedAssets` is empty, so no upload and no `assets` field.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/mention-picker.tsx apps/web/src/components/home-composer.tsx apps/web/test/components/home-composer-mentions.test.tsx
git commit -m "feat(web): image-only uploads with @-mention referencing"
```

---

## Task 9: Sidebar — New task label + varied icons

**Files:**
- Modify: `apps/web/src/components/app-sidebar.tsx`
- Modify: `apps/web/test/components/app-sidebar.test.tsx`

- [ ] **Step 1: Update + add the failing tests**

In `apps/web/test/components/app-sidebar.test.tsx`:

Change the `'New project' routes to Home` test name + matcher to `New task`:

```ts
  it("'New task' routes to Home", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: /new task/i }));
    expect(pushMock).toHaveBeenCalledWith("/");
  });
```

Add a unit test for the icon picker (import it at the top of the file):

```ts
import { taskIcon } from "@/components/app-sidebar";

  it("picks a stable, varied icon per session id", () => {
    expect(taskIcon("abc")).toBe(taskIcon("abc"));
    const distinct = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map(taskIcon));
    expect(distinct.size).toBeGreaterThan(1);
  });
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `pnpm test -- apps/web/test/components/app-sidebar.test.tsx`
Expected: FAIL — no `/new task/i` button, `taskIcon` not exported.

- [ ] **Step 3: Implement the label + icon picker**

In `apps/web/src/components/app-sidebar.tsx`:

1. Extend the lucide import and add the icon set + picker (top-level, after imports):

```tsx
import { Plus, Trash2, Film, Clapperboard, Video, Megaphone, Sparkles, Wand2, Play, Tv } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const TASK_ICONS: LucideIcon[] = [Film, Clapperboard, Video, Megaphone, Sparkles, Wand2, Play, Tv];

export function taskIcon(id: string): LucideIcon {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TASK_ICONS[h % TASK_ICONS.length]!;
}
```

2. Change the New-task button label + aria-label:

```tsx
          aria-label="New task"
        >
          <Plus className="h-4 w-4" />
          {open && "New task"}
```

3. In the session list `.map`, replace the hard-coded `<Film … />` with the per-id icon. Just inside the `sessions.map((s) => {` body, before `return`:

```tsx
                const Icon = taskIcon(s.id);
```

and replace `<Film className="h-4 w-4 shrink-0" />` with `<Icon className="h-4 w-4 shrink-0" />`.

- [ ] **Step 4: Run the tests — verify they pass**

Run: `pnpm test -- apps/web/test/components/app-sidebar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app-sidebar.tsx apps/web/test/components/app-sidebar.test.tsx
git commit -m "feat(web): sidebar New task label + per-task icons"
```

---

## Final verification

- [ ] **Step 1: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: all green (the pre-existing single skip is unrelated).

- [ ] **Step 3: Browser smoke check (preview)**

Start the web preview, open `/` signed-in, and confirm: the composer shows `+ / Settings / mode dropdown / up-arrow`; the settings modal opens with six durations incl. `2m`/`3m`; attaching an image previews it with an `@imageN` chip; typing `@` opens the picker; a promo pill expands its prompts with accent coloring; the sidebar reads "New task" with varied icons.
