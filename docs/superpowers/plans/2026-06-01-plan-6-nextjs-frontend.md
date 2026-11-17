# UltraCreator Plan 6 — Next.js Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-user Next.js (App Router) frontend that drives the Fastify backend from Plan 5. The user lands on `/`, gets a session, then in `/s/[sid]` sees: a left sidebar of known sessions (persisted in `localStorage` — backend has no list endpoint in v1), a chat stream of agent events, an artifact viewer that switches on artifact kind (`BriefCard` / `DesignBoard` / `ScriptTimeline` / `VideoPreview`), and a composer with text + file upload + duration chips + aspect-ratio chips + voiceover toggle. Approval gates render inline approve/refine controls. After Plan 6 the entire system is driveable end-to-end from a browser: drop a URL or upload assets, watch the four phases run, approve design + script, watch the MP4 render and play it inline.

**Architecture:** Next.js 15 App Router, **frontend-only** — no `fetch` from server components, no route handlers proxying the backend. The browser talks directly to `http://127.0.0.1:3001` (configurable via `NEXT_PUBLIC_API_URL`) using native `fetch` for HTTP and native `EventSource` for SSE. State is split: TanStack React Query owns server-derived data (session metadata, artifact envelopes, MP4 URLs), a pure `sessionReducer(state, ServerEvent) → UiState` reduces the SSE event stream into UI state, and `useSessionStream` glues them together while persisting `lastEventId` per session in `sessionStorage` so a page refresh reconnects without missing events. Styling is Tailwind + shadcn/ui + Motion (the modern name for framer-motion); icons are `lucide-react` (shadcn default) with `react-icons` available for brand marks. Tests run under Vitest with `jsdom` (per-file `// @vitest-environment jsdom` pragma) using React Testing Library + a small fake `EventSource`; no real backend is contacted.

**Tech Stack:** Next.js 15.x (App Router), React 19, TypeScript 5.7, Tailwind CSS v4, shadcn/ui, Motion (`motion` package — successor to `framer-motion`), `react-icons` for brand marks, `lucide-react` for UI glyphs, TanStack React Query v5, Vitest 2 + `@testing-library/react` v16 + `@testing-library/user-event` v14 + `@testing-library/jest-dom` v6 + `jsdom` v25, `@ultracreator/shared` (workspace) for types/schemas.

**Roadmap context:** Plan 6 of 6 — the last plan. Plans 1–5 are merged. Plan 5 exposed:
- `POST /api/sessions` → `{ sessionId }` (201)
- `GET /api/sessions/:sid` → `{ state: SessionState, artifacts: ArtifactDescriptor[] }`
- `DELETE /api/sessions/:sid` → 204
- `POST /api/sessions/:sid/uploads` (multipart) → `{ files: [{ name, path }] }`
- `POST /api/sessions/:sid/messages` (JSON body validated by `UserMessageSchema`) → `{ accepted: true }` (202)
- `GET /api/sessions/:sid/artifacts` → `ArtifactDescriptor[]`
- `GET /api/sessions/:sid/artifacts/:kind[?version=N]` → `ArtifactEnvelope`
- `GET /api/sessions/:sid/files/*` (Range-supported)
- `GET /api/sessions/:sid/stream` — SSE with `Last-Event-Id` header or `?lastEventId=N` query; frames carry `id: <seq>`, `event: <event.type>`, `data: <JSON {seq, at, event}>`.

`SessionState` (from `apps/server/src/orchestrator/state.ts`):
```ts
type SessionState =
  | { kind: "idle" }
  | { kind: "running"; phase: PhaseId }
  | { kind: "awaiting-gate"; phase: PhaseId }
  | { kind: "error"; phase: PhaseId; error: string }
  | { kind: "done"; lastPhase: PhaseId };
```

`ServerEvent` (from `packages/shared/src/events.ts`) is the discriminated union of `phase.started`, `phase.progress`, `phase.error`, `gate.awaiting`, `artifact.created`, `artifact.stale`, `render.progress`, `render.done`, `render.error`.

---

## File Structure

```
apps/web/
  package.json
  next.config.mjs
  tsconfig.json
  postcss.config.mjs
  components.json                       # shadcn config
  vitest.setup.ts                       # imports @testing-library/jest-dom, polyfills fetch + sessionStorage if needed
  .env.local.example                    # NEXT_PUBLIC_API_URL=http://127.0.0.1:3001
  src/
    app/
      layout.tsx                        # html/body + globals.css + providers
      providers.tsx                     # QueryClientProvider + sonner Toaster
      globals.css                       # tailwind v4 import + shadcn css vars
      page.tsx                          # "/" — POST /api/sessions, redirect to /s/[sid]
      s/[sid]/page.tsx                  # session page
    lib/
      api-base.ts                       # apiBase() — reads NEXT_PUBLIC_API_URL
      api-client.ts                     # createSession, getSession, postMessage, uploadFiles, listArtifacts, getArtifact, deleteSession, fileUrl
      api-types.ts                      # SequencedEvent + SessionState (mirrors server) + HTTP response shapes
      session-store.ts                  # localStorage CRUD: SidebarSession[]
      utils.ts                          # cn() helper (shadcn convention)
    state/
      session-reducer.ts                # reduce(uiState, ServerEvent) → uiState (pure)
      use-session-stream.ts             # hook: subscribe → reducer → React state, persist lastEventId
      use-session.ts                    # combines useQuery(getSession) + use-session-stream
    components/
      sidebar.tsx                       # localStorage sessions + "+ New" button
      composer.tsx                      # text + files + duration + aspect + voiceover → POST
      chat-stream.tsx                   # render ChatItem[] from uiState
      approval-gate.tsx                 # buttons → POST /messages
      artifact-viewer.tsx               # switches on artifact kind
      brief-card.tsx                    # render Brief
      design-board.tsx                  # palette/typography/motion/sample frames
      script-timeline.tsx               # scenes with bars + narration
      video-preview.tsx                 # <video> from /files/output/...
      session-page.tsx                  # client component composing all of the above
      ui/                               # shadcn-generated primitives (button, card, badge, input, textarea, switch, toggle-group, scroll-area, separator, sonner)
  test/
    lib/
      api-client.test.ts
      session-store.test.ts
    state/
      session-reducer.test.ts
      use-session-stream.test.tsx       # uses a fake EventSource
    components/
      composer.test.tsx
      chat-stream.test.tsx
      brief-card.test.tsx
      design-board.test.tsx
      script-timeline.test.tsx
      video-preview.test.tsx
      approval-gate.test.tsx
      sidebar.test.tsx
      session-page.test.tsx             # the integration test: mocks api + EventSource
    helpers/
      fake-event-source.ts              # the test-only EventSource implementation
      render-with-query.tsx             # wraps RTL render() with a fresh QueryClient
      api-mocks.ts                      # vi.fn() builders for fetch responses
```

**Responsibility boundaries:**
- `lib/api-client.ts` — the only file that calls `fetch`. Returns typed values, throws typed errors. No React, no React Query.
- `lib/sse-client.ts` is intentionally **not present** in the structure above: SSE is consumed directly through `EventSource` inside `use-session-stream.ts`. We do not wrap it — wrapping forces a second protocol layer we'd have to test.
- `state/session-reducer.ts` — **pure**, no React, no fetch. Trivially unit-testable.
- `state/use-session-stream.ts` — owns one `EventSource` per `sid`, drives the reducer, invalidates the right React Query keys when artifacts change.
- `components/*` — display only. Buttons that mutate state call `api-client` directly (no Redux). Composer does its own form management.
- `app/page.tsx` (entry) and `app/s/[sid]/page.tsx` are **client components** (`"use client"`); the Next.js server runtime is unused beyond serving JS bundles.

---

## Task 1: Scaffold the Next.js app (deps, tsconfig, tailwind, root scripts)

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.mjs`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/.env.local.example`
- Modify: `package.json` (root) — add `dev:web` script
- Modify: `vitest.config.ts` (root) — widen include to also pick up `.tsx`
- Create: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/page.tsx` (placeholder)
- Create: `apps/web/src/app/globals.css`

- [ ] **Step 1: Create the package.json**

```json
{
  "name": "@ultracreator/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --port 3000",
    "build": "next build",
    "start": "next start --port 3000"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.62.0",
    "@ultracreator/shared": "workspace:*",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.460.0",
    "motion": "^11.13.0",
    "next": "^15.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-icons": "^5.4.0",
    "sonner": "^1.7.0",
    "tailwind-merge": "^2.5.5",
    "tailwindcss-animate": "^1.0.7",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.0.0-beta.7",
    "@testing-library/jest-dom": "^6.6.3",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/node": "^24.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.49",
    "tailwindcss": "^4.0.0-beta.7",
    "typescript": "^5.7.2"
  }
}
```

> Tailwind v4 reads its configuration from a `@theme` block inside CSS rather than a `tailwind.config.ts` — we won't need a config file. `@tailwindcss/postcss` is the v4 PostCSS plugin.

- [ ] **Step 2: Install**

Run from the repo root:

```bash
pnpm install
```

Expected: completes; `node_modules/next`, `node_modules/@tanstack/react-query`, `node_modules/jsdom` exist under the root + appropriate workspace.

- [ ] **Step 3: Create the tsconfig**

```jsonc
// apps/web/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "jsx": "preserve",
    "moduleResolution": "Bundler",
    "allowJs": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "incremental": true,
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    },
    "types": ["@testing-library/jest-dom"]
  },
  "include": [
    "next-env.d.ts",
    "src/**/*.ts",
    "src/**/*.tsx",
    "test/**/*.ts",
    "test/**/*.tsx",
    ".next/types/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create the Next.js config**

```js
// apps/web/next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next.js needs to be told the workspace package is intentionally
  // transpiled — otherwise it tries to import the .ts source as-is.
  transpilePackages: ["@ultracreator/shared"],
};
export default nextConfig;
```

- [ ] **Step 5: Create the PostCSS config (Tailwind v4)**

```js
// apps/web/postcss.config.mjs
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
```

- [ ] **Step 6: Create the env example**

```bash
# apps/web/.env.local.example
NEXT_PUBLIC_API_URL=http://127.0.0.1:3001
```

- [ ] **Step 7: Update the root package.json with a `dev:web` script**

Edit the root `package.json` `scripts` block so it reads:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:external": "vitest run -c vitest.external.config.ts",
    "typecheck": "pnpm -r exec tsc --noEmit",
    "dev:server": "pnpm -F @ultracreator/server dev",
    "dev:web": "pnpm -F @ultracreator/web dev"
  }
}
```

- [ ] **Step 8: Widen the root vitest include to pick up `.tsx`**

Edit `vitest.config.ts` to:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.{ts,tsx}",
    ],
    exclude: ["**/node_modules/**", "**/*.external.test.ts"],
    environment: "node",
    setupFiles: ["./apps/web/vitest.setup.ts"],
  },
});
```

> The setup file is harmless under the `node` environment — it imports `@testing-library/jest-dom`'s matchers which attach to `expect` globally; non-DOM tests just don't use them. Per-file `// @vitest-environment jsdom` pragmas (Tasks 4 onward) flip individual web tests into DOM mode.

- [ ] **Step 9: Create the vitest setup file**

```ts
// apps/web/vitest.setup.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 10: Create the placeholder app shell**

```tsx
// apps/web/src/app/layout.tsx
import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "UltraCreator" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
```

```tsx
// apps/web/src/app/page.tsx — placeholder; replaced in Task 17
export default function HomePage() {
  return <main className="p-8">UltraCreator</main>;
}
```

```css
/* apps/web/src/app/globals.css */
@import "tailwindcss";

@theme {
  --color-background: oklch(0.99 0 0);
  --color-foreground: oklch(0.18 0 0);
  --color-muted: oklch(0.96 0 0);
  --color-muted-foreground: oklch(0.45 0 0);
  --color-border: oklch(0.92 0 0);
  --color-primary: oklch(0.55 0.18 264);
  --color-primary-foreground: oklch(0.99 0 0);
  --color-card: oklch(1 0 0);
  --color-accent: oklch(0.95 0.04 264);
  --color-destructive: oklch(0.6 0.22 27);
}

html, body { height: 100%; }
```

- [ ] **Step 11: Typecheck and dev smoke**

Run: `pnpm typecheck`
Expected: passes.

Run: `pnpm -F @ultracreator/web dev` (in another terminal)
Expected: Next.js boots on http://localhost:3000; visiting it shows "UltraCreator". Ctrl-C.

- [ ] **Step 12: Commit**

```bash
git add apps/web package.json vitest.config.ts pnpm-lock.yaml
git commit -m "chore(web): scaffold Next.js 15 + Tailwind v4 + RTL + vitest jsdom setup"
```

---

## Task 2: shadcn/ui init + primitive components

**Files:**
- Create: `apps/web/components.json`
- Create: `apps/web/src/lib/utils.ts`
- Create: `apps/web/src/components/ui/button.tsx`
- Create: `apps/web/src/components/ui/card.tsx`
- Create: `apps/web/src/components/ui/badge.tsx`
- Create: `apps/web/src/components/ui/input.tsx`
- Create: `apps/web/src/components/ui/textarea.tsx`
- Create: `apps/web/src/components/ui/switch.tsx`
- Create: `apps/web/src/components/ui/toggle-group.tsx`
- Create: `apps/web/src/components/ui/scroll-area.tsx`
- Create: `apps/web/src/components/ui/separator.tsx`
- Create: `apps/web/src/components/ui/sonner.tsx`

We install shadcn primitives that the rest of the plan uses by name. We do **not** run `pnpm dlx shadcn init` interactively (this is an agentic plan) — instead we write the files directly. All primitives below are copy-pastes of shadcn's published source for the components.json `new-york` style with the dependencies we already installed.

- [ ] **Step 1: Write `components.json`**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib"
  },
  "iconLibrary": "lucide"
}
```

- [ ] **Step 2: Add `lib/utils.ts` (`cn` helper)**

```ts
// apps/web/src/lib/utils.ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Add the Radix peer deps and Sonner**

```bash
pnpm add -F @ultracreator/web \
  @radix-ui/react-slot@^1.1.1 \
  @radix-ui/react-switch@^1.1.2 \
  @radix-ui/react-toggle-group@^1.1.1 \
  @radix-ui/react-scroll-area@^1.2.2 \
  @radix-ui/react-separator@^1.1.1
```

- [ ] **Step 4: Write `button.tsx`**

```tsx
// apps/web/src/components/ui/button.tsx
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border border-border bg-background hover:bg-muted",
        secondary: "bg-muted text-foreground hover:bg-muted/80",
        ghost: "hover:bg-muted",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";

export { buttonVariants };
```

- [ ] **Step 5: Write `card.tsx`**

```tsx
// apps/web/src/components/ui/card.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border bg-card text-foreground shadow-sm", className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}
export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-center p-6 pt-0", className)} {...props} />;
}
```

- [ ] **Step 6: Write `badge.tsx`**

```tsx
// apps/web/src/components/ui/badge.tsx
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-muted text-foreground",
        outline: "text-foreground",
        destructive: "border-transparent bg-destructive text-white",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
```

- [ ] **Step 7: Write `input.tsx` + `textarea.tsx`**

```tsx
// apps/web/src/components/ui/input.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
```

```tsx
// apps/web/src/components/ui/textarea.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
```

- [ ] **Step 8: Write `switch.tsx`**

```tsx
// apps/web/src/components/ui/switch.tsx
"use client";
import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-muted",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
```

- [ ] **Step 9: Write `toggle-group.tsx`**

```tsx
// apps/web/src/components/ui/toggle-group.tsx
"use client";
import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "@/lib/utils";

export const ToggleGroup = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    className={cn("flex items-center gap-1", className)}
    {...props}
  />
));
ToggleGroup.displayName = "ToggleGroup";

export const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      "inline-flex h-8 items-center justify-center rounded-md px-3 text-xs font-medium ring-offset-background transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </ToggleGroupPrimitive.Item>
));
ToggleGroupItem.displayName = "ToggleGroupItem";
```

- [ ] **Step 10: Write `scroll-area.tsx`**

```tsx
// apps/web/src/components/ui/scroll-area.tsx
"use client";
import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";

export const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn("relative overflow-hidden", className)} {...props}>
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none p-px">
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border" />
    </ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = "ScrollArea";
```

- [ ] **Step 11: Write `separator.tsx`**

```tsx
// apps/web/src/components/ui/separator.tsx
"use client";
import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import { cn } from "@/lib/utils";

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn(
      "shrink-0 bg-border",
      orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
      className,
    )}
    {...props}
  />
));
Separator.displayName = "Separator";
```

- [ ] **Step 12: Write `sonner.tsx` toaster wrapper**

```tsx
// apps/web/src/components/ui/sonner.tsx
"use client";
import { Toaster as SonnerToaster } from "sonner";
export function Toaster() {
  return <SonnerToaster richColors closeButton />;
}
```

- [ ] **Step 13: Add the `--color-primary-foreground`-ish CSS extras to `globals.css`**

These were already in Task 1's globals.css. If you skipped any, re-verify the file contains `--color-primary-foreground` and `--color-card`. If the file rendering breaks at typecheck (it shouldn't — CSS isn't typechecked) move on.

- [ ] **Step 14: Typecheck**

Run: `pnpm typecheck`
Expected: passes — no React errors, no missing types from `@radix-ui/*` or `lucide-react`.

- [ ] **Step 15: Commit**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "feat(web): shadcn primitives — button/card/badge/input/textarea/switch/toggle-group/scroll-area/separator/sonner"
```

---

## Task 3: `api-types.ts` — shared HTTP shapes

**Files:**
- Create: `apps/web/src/lib/api-types.ts`

We mirror the backend's `SessionState` here (since it lives in the server source tree, not in the shared package) and define the HTTP response/SSE envelope shapes the frontend deals with. Everything else comes from `@ultracreator/shared`.

- [ ] **Step 1: Write the file**

```ts
// apps/web/src/lib/api-types.ts
import type {
  ArtifactDescriptor,
  ArtifactEnvelope,
  ArtifactKind,
  Brief,
  Design,
  PhaseId,
  Script,
  ServerEvent,
  Mp4Data,
  NarrationData,
  CompositionData,
} from "@ultracreator/shared";

// Mirror of apps/server/src/orchestrator/state.ts:SessionState.
// Kept here as a type-only mirror because the server source isn't a workspace dep.
export type SessionState =
  | { kind: "idle" }
  | { kind: "running"; phase: PhaseId }
  | { kind: "awaiting-gate"; phase: PhaseId }
  | { kind: "error"; phase: PhaseId; error: string }
  | { kind: "done"; lastPhase: PhaseId };

export interface GetSessionResponse {
  state: SessionState;
  artifacts: ArtifactDescriptor[];
}

export interface CreateSessionResponse {
  sessionId: string;
}

export interface UploadResponse {
  files: { name: string; path: string }[];
}

/** Wire envelope of a single SSE frame: `data: <SequencedEvent>`. */
export interface SequencedEvent {
  seq: number;
  at: string;
  event: ServerEvent;
}

export type ArtifactDataByKind = {
  brief: Brief;
  design: Design;
  script: Script;
  narration: NarrationData;
  composition: CompositionData;
  mp4: Mp4Data;
};

/** Typed envelope returned by `GET /artifacts/:kind`. */
export type TypedArtifactEnvelope<K extends ArtifactKind> = ArtifactEnvelope<ArtifactDataByKind[K]>;

export type { ArtifactDescriptor, ArtifactKind, PhaseId, ServerEvent };
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes — all imports resolve through `@ultracreator/shared`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api-types.ts
git commit -m "feat(web): api-types — SessionState mirror + HTTP response shapes"
```

---

## Task 4: `api-client.ts` + tests

**Files:**
- Create: `apps/web/src/lib/api-base.ts`
- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/test/lib/api-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom
// apps/web/test/lib/api-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSession,
  getSession,
  postMessage,
  uploadFiles,
  listArtifacts,
  getArtifact,
  deleteSession,
  fileUrl,
  ApiError,
} from "@/lib/api-client";
import type { Brief } from "@ultracreator/shared";

const BASE = "http://127.0.0.1:3001";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE;
  // Re-import inside each test to pick up env? Not needed: api-base reads at call time.
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("api-client", () => {
  it("createSession POSTs /api/sessions and returns { sessionId }", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions`);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ sessionId: "abc" }), { status: 201 });
    });
    const out = await createSession();
    expect(out).toEqual({ sessionId: "abc" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("createSession throws ApiError on non-2xx", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    await expect(createSession()).rejects.toBeInstanceOf(ApiError);
  });

  it("getSession GETs /api/sessions/:sid", async () => {
    mockFetch(async (url) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1`);
      return new Response(
        JSON.stringify({ state: { kind: "idle" }, artifacts: [] }),
        { status: 200 },
      );
    });
    const out = await getSession("sid1");
    expect(out.state.kind).toBe("idle");
    expect(out.artifacts).toEqual([]);
  });

  it("getSession returns null on 404 (so React Query can treat it as not-found)", async () => {
    mockFetch(async () => new Response("", { status: 404 }));
    const out = await getSession("missing");
    expect(out).toBeNull();
  });

  it("postMessage POSTs JSON to /messages", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/messages`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ text: "hi" });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
    await postMessage("sid1", { text: "hi" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("uploadFiles POSTs multipart and returns the file list", async () => {
    mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/uploads`);
      expect(init?.method).toBe("POST");
      // Browser sets multipart/form-data with boundary when body is FormData.
      // We just assert the body IS a FormData.
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ files: [{ name: "a.png", path: "uploads/a.png" }] }), { status: 201 });
    });
    const out = await uploadFiles("sid1", [new File(["x"], "a.png", { type: "image/png" })]);
    expect(out.files).toEqual([{ name: "a.png", path: "uploads/a.png" }]);
  });

  it("listArtifacts GETs /artifacts and returns descriptors", async () => {
    mockFetch(async (url) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/artifacts`);
      return new Response(JSON.stringify([{ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false, path: "p" }]), { status: 200 });
    });
    const out = await listArtifacts("sid1");
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("brief");
  });

  it("getArtifact returns the latest envelope by default and null on 404", async () => {
    const briefData: Brief = {
      product: { name: "Acme", tagline: "t", description: "d", category: "c" },
      audience: "a", keyMessages: ["k"],
      brandHints: { colors: ["#000"] },
      sourceAssets: { images: [], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    };
    mockFetch(async (url) => {
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: briefData }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    const out = await getArtifact("sid1", "brief");
    expect(out?.data.product.name).toBe("Acme");
    const miss = await getArtifact("sid1", "design");
    expect(miss).toBeNull();
  });

  it("getArtifact passes ?version=N", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ kind: "brief", version: 2, createdAt: "t", derivedFrom: null, data: {} }), { status: 200 }));
    await getArtifact("sid1", "brief", 2);
    expect(spy.mock.calls[0]![0]).toBe(`${BASE}/api/sessions/sid1/artifacts/brief?version=2`);
  });

  it("deleteSession DELETEs and resolves on 204", async () => {
    mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1`);
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    await expect(deleteSession("sid1")).resolves.toBeUndefined();
  });

  it("fileUrl composes the path", () => {
    expect(fileUrl("sid1", "output/x.mp4")).toBe(`${BASE}/api/sessions/sid1/files/output/x.mp4`);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/lib/api-client.test.ts`
Expected: FAIL — module `@/lib/api-client` not found.

- [ ] **Step 3: Write `api-base.ts`**

```ts
// apps/web/src/lib/api-base.ts
export function apiBase(): string {
  // Read each call so tests can mutate process.env between calls.
  const raw = process.env.NEXT_PUBLIC_API_URL;
  if (!raw || raw.length === 0) {
    throw new Error("NEXT_PUBLIC_API_URL is not set");
  }
  return raw.replace(/\/$/, "");
}
```

- [ ] **Step 4: Write `api-client.ts`**

```ts
// apps/web/src/lib/api-client.ts
import type {
  CreateSessionResponse,
  GetSessionResponse,
  SequencedEvent,
  TypedArtifactEnvelope,
  UploadResponse,
} from "./api-types.js";
import type { ArtifactDescriptor, ArtifactKind, UserMessage } from "@ultracreator/shared";
import { apiBase } from "./api-base.js";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit, opts: { allow404?: boolean } = {}): Promise<T | null> {
  const res = await fetch(url, init);
  if (opts.allow404 && res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiError(res.status, `${init?.method ?? "GET"} ${url} → ${res.status}`, body);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

export async function createSession(): Promise<CreateSessionResponse> {
  const out = await jsonFetch<CreateSessionResponse>(`${apiBase()}/api/sessions`, { method: "POST" });
  if (!out) throw new ApiError(0, "createSession: empty response");
  return out;
}

export async function getSession(sid: string): Promise<GetSessionResponse | null> {
  return jsonFetch<GetSessionResponse>(`${apiBase()}/api/sessions/${sid}`, undefined, { allow404: true });
}

export async function postMessage(sid: string, message: UserMessage): Promise<void> {
  await jsonFetch<{ accepted: true }>(`${apiBase()}/api/sessions/${sid}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

export async function uploadFiles(sid: string, files: File[]): Promise<UploadResponse> {
  const fd = new FormData();
  for (const f of files) fd.append("file", f, f.name);
  const out = await jsonFetch<UploadResponse>(`${apiBase()}/api/sessions/${sid}/uploads`, {
    method: "POST",
    body: fd,
  });
  if (!out) throw new ApiError(0, "uploadFiles: empty response");
  return out;
}

export async function listArtifacts(sid: string): Promise<ArtifactDescriptor[]> {
  return (await jsonFetch<ArtifactDescriptor[]>(`${apiBase()}/api/sessions/${sid}/artifacts`)) ?? [];
}

export async function getArtifact<K extends ArtifactKind>(
  sid: string,
  kind: K,
  version?: number,
): Promise<TypedArtifactEnvelope<K> | null> {
  const qs = version !== undefined ? `?version=${version}` : "";
  return jsonFetch<TypedArtifactEnvelope<K>>(
    `${apiBase()}/api/sessions/${sid}/artifacts/${kind}${qs}`,
    undefined,
    { allow404: true },
  );
}

export async function deleteSession(sid: string): Promise<void> {
  await jsonFetch<null>(`${apiBase()}/api/sessions/${sid}`, { method: "DELETE" });
}

export function fileUrl(sid: string, relative: string): string {
  return `${apiBase()}/api/sessions/${sid}/files/${relative.replace(/^\//, "")}`;
}

export type { SequencedEvent };
```

- [ ] **Step 5: Run tests, verify pass**

Run: `pnpm vitest run apps/web/test/lib/api-client.test.ts`
Expected: PASS — 10 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib apps/web/test/lib/api-client.test.ts
git commit -m "feat(web): api-client — typed REST surface over Plan 5 routes"
```

---

## Task 5: `session-store.ts` + tests

The Sidebar needs a list of known sessions. Backend doesn't expose `GET /api/sessions` in v1, so we persist `{ id, title, createdAt }` in `localStorage` and prune entries the backend has forgotten about (returning 404).

**Files:**
- Create: `apps/web/src/lib/session-store.ts`
- Create: `apps/web/test/lib/session-store.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// @vitest-environment jsdom
// apps/web/test/lib/session-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { listLocalSessions, addLocalSession, renameLocalSession, removeLocalSession, LOCAL_KEY } from "@/lib/session-store";

beforeEach(() => {
  localStorage.clear();
});

describe("session-store", () => {
  it("listLocalSessions returns [] when empty", () => {
    expect(listLocalSessions()).toEqual([]);
  });

  it("addLocalSession appends to the front (most-recent-first)", () => {
    addLocalSession({ id: "a", title: "Untitled" });
    addLocalSession({ id: "b", title: "Untitled" });
    const list = listLocalSessions();
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
    expect(typeof list[0]!.createdAt).toBe("string");
  });

  it("addLocalSession dedupes by id (keeps the newer entry, moves to front)", () => {
    addLocalSession({ id: "a", title: "First" });
    addLocalSession({ id: "b", title: "Second" });
    addLocalSession({ id: "a", title: "First-again" });
    const list = listLocalSessions();
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
    expect(list[0]!.title).toBe("First-again");
  });

  it("renameLocalSession updates the title and leaves position alone", () => {
    addLocalSession({ id: "a", title: "Old" });
    addLocalSession({ id: "b", title: "X" });
    renameLocalSession("a", "New");
    const list = listLocalSessions();
    expect(list.find((s) => s.id === "a")!.title).toBe("New");
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("removeLocalSession drops the entry", () => {
    addLocalSession({ id: "a", title: "x" });
    addLocalSession({ id: "b", title: "y" });
    removeLocalSession("a");
    expect(listLocalSessions().map((s) => s.id)).toEqual(["b"]);
  });

  it("survives malformed JSON in localStorage", () => {
    localStorage.setItem(LOCAL_KEY, "{not-json");
    expect(listLocalSessions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/lib/session-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/session-store.ts
export const LOCAL_KEY = "uc.sessions.v1";

export interface SidebarSession {
  id: string;
  title: string;
  createdAt: string;
}

function read(): SidebarSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is SidebarSession =>
        typeof s?.id === "string" && typeof s?.title === "string" && typeof s?.createdAt === "string",
    );
  } catch {
    return [];
  }
}

function write(list: SidebarSession[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
}

export function listLocalSessions(): SidebarSession[] {
  return read();
}

export function addLocalSession(entry: { id: string; title: string }): void {
  const list = read().filter((s) => s.id !== entry.id);
  list.unshift({ id: entry.id, title: entry.title, createdAt: new Date().toISOString() });
  write(list);
}

export function renameLocalSession(id: string, title: string): void {
  const list = read().map((s) => (s.id === id ? { ...s, title } : s));
  write(list);
}

export function removeLocalSession(id: string): void {
  write(read().filter((s) => s.id !== id));
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/lib/session-store.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/session-store.ts apps/web/test/lib/session-store.test.ts
git commit -m "feat(web): session-store — localStorage-backed sidebar list"
```

---

## Task 6: `session-reducer.ts` + tests

Pure reducer that folds `ServerEvent`s into the UI shape the components want. Separate from React, separate from SSE plumbing.

**Files:**
- Create: `apps/web/src/state/session-reducer.ts`
- Create: `apps/web/test/state/session-reducer.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/test/state/session-reducer.test.ts
import { describe, it, expect } from "vitest";
import { initialUiState, reduce, type UiState } from "@/state/session-reducer";
import type { ServerEvent } from "@ultracreator/shared";

const at = "2026-06-01T00:00:00.000Z";

describe("session-reducer", () => {
  it("initialUiState is idle with empty chat + no current phase + 0% render", () => {
    expect(initialUiState).toEqual({
      status: { kind: "idle" },
      chat: [],
      currentPhase: null,
      renderPercent: 0,
      mp4Path: null,
      lastError: null,
      latestArtifacts: {},
    });
  });

  it("phase.started sets currentPhase + status=running and appends a chat row", () => {
    const ev: ServerEvent = { type: "phase.started", phase: "research", at };
    const next = reduce(initialUiState, ev);
    expect(next.status).toEqual({ kind: "running", phase: "research" });
    expect(next.currentPhase).toBe("research");
    expect(next.chat).toEqual([{ kind: "phase-start", phase: "research", at }]);
  });

  it("phase.progress appends a progress row", () => {
    const a = reduce(initialUiState, { type: "phase.started", phase: "research", at });
    const b = reduce(a, { type: "phase.progress", phase: "research", message: "fetched" });
    expect(b.chat[b.chat.length - 1]).toEqual({ kind: "progress", phase: "research", message: "fetched" });
  });

  it("phase.error sets status=error and records lastError", () => {
    const a = reduce(initialUiState, { type: "phase.started", phase: "design", at });
    const b = reduce(a, { type: "phase.error", phase: "design", error: "boom" });
    expect(b.status).toEqual({ kind: "error", phase: "design", error: "boom" });
    expect(b.lastError).toEqual({ phase: "design", error: "boom" });
  });

  it("gate.awaiting flips status to awaiting-gate", () => {
    const a = reduce(initialUiState, { type: "phase.started", phase: "design", at });
    const b = reduce(a, { type: "gate.awaiting", phase: "design" });
    expect(b.status).toEqual({ kind: "awaiting-gate", phase: "design" });
    expect(b.chat[b.chat.length - 1]).toEqual({ kind: "gate", phase: "design" });
  });

  it("artifact.created updates latestArtifacts[kind]=version", () => {
    const a = reduce(initialUiState, { type: "artifact.created", kind: "brief", version: 1 });
    const b = reduce(a, { type: "artifact.created", kind: "brief", version: 2 });
    expect(b.latestArtifacts.brief).toBe(2);
  });

  it("artifact.stale does not delete latestArtifacts entries (UI uses staleness from descriptor)", () => {
    const a = reduce(initialUiState, { type: "artifact.created", kind: "design", version: 1 });
    const b = reduce(a, { type: "artifact.stale", kind: "design", version: 1 });
    expect(b.latestArtifacts.design).toBe(1);
  });

  it("render.progress updates renderPercent (clamped 0..100)", () => {
    const a = reduce(initialUiState, { type: "render.progress", percent: 35 });
    expect(a.renderPercent).toBe(35);
    const b = reduce(a, { type: "render.progress", percent: 999 });
    expect(b.renderPercent).toBe(100);
  });

  it("render.done sets mp4Path and status=done", () => {
    const a = reduce(initialUiState, { type: "render.done", mp4Path: "output/x.mp4" });
    expect(a.mp4Path).toBe("output/x.mp4");
    expect(a.status).toEqual({ kind: "done" });
    expect(a.renderPercent).toBe(100);
  });

  it("render.error sets status=error and records lastError", () => {
    const a = reduce(initialUiState, { type: "render.error", error: "ffmpeg died" });
    expect(a.status.kind).toBe("error");
    expect(a.lastError).toEqual({ phase: "render", error: "ffmpeg died" });
  });

  it("reduce is pure: input state is not mutated", () => {
    const a: UiState = initialUiState;
    reduce(a, { type: "phase.started", phase: "research", at });
    expect(a).toBe(initialUiState);
    expect(a.chat).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/state/session-reducer.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/state/session-reducer.ts
import type { ArtifactKind, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { SessionState } from "@/lib/api-types";

export type ChatItem =
  | { kind: "phase-start"; phase: PhaseId; at: string }
  | { kind: "progress"; phase: PhaseId; message: string }
  | { kind: "phase-error"; phase: PhaseId; error: string }
  | { kind: "gate"; phase: PhaseId }
  | { kind: "artifact"; artifactKind: ArtifactKind; version: number }
  | { kind: "render-done"; mp4Path: string };

export interface UiState {
  status: SessionState | { kind: "done" };
  chat: ChatItem[];
  currentPhase: PhaseId | null;
  renderPercent: number;
  mp4Path: string | null;
  lastError: { phase: PhaseId | "render"; error: string } | null;
  latestArtifacts: Partial<Record<ArtifactKind, number>>;
}

export const initialUiState: UiState = {
  status: { kind: "idle" },
  chat: [],
  currentPhase: null,
  renderPercent: 0,
  mp4Path: null,
  lastError: null,
  latestArtifacts: {},
};

function clampPercent(p: number): number {
  if (p < 0) return 0;
  if (p > 100) return 100;
  return p;
}

export function reduce(state: UiState, event: ServerEvent): UiState {
  switch (event.type) {
    case "phase.started":
      return {
        ...state,
        status: { kind: "running", phase: event.phase },
        currentPhase: event.phase,
        chat: [...state.chat, { kind: "phase-start", phase: event.phase, at: event.at }],
      };
    case "phase.progress":
      return {
        ...state,
        chat: [...state.chat, { kind: "progress", phase: event.phase, message: event.message }],
      };
    case "phase.error":
      return {
        ...state,
        status: { kind: "error", phase: event.phase, error: event.error },
        chat: [...state.chat, { kind: "phase-error", phase: event.phase, error: event.error }],
        lastError: { phase: event.phase, error: event.error },
      };
    case "gate.awaiting":
      return {
        ...state,
        status: { kind: "awaiting-gate", phase: event.phase },
        chat: [...state.chat, { kind: "gate", phase: event.phase }],
      };
    case "artifact.created":
      return {
        ...state,
        latestArtifacts: { ...state.latestArtifacts, [event.kind]: event.version },
        chat: [...state.chat, { kind: "artifact", artifactKind: event.kind, version: event.version }],
      };
    case "artifact.stale":
      // UI uses descriptor.stale for display; reducer-level state untouched.
      return state;
    case "render.progress":
      return { ...state, renderPercent: clampPercent(event.percent), currentPhase: "render" };
    case "render.done":
      return {
        ...state,
        status: { kind: "done" },
        mp4Path: event.mp4Path,
        renderPercent: 100,
        chat: [...state.chat, { kind: "render-done", mp4Path: event.mp4Path }],
      };
    case "render.error":
      return {
        ...state,
        status: { kind: "error", phase: "render", error: event.error },
        lastError: { phase: "render", error: event.error },
        chat: [...state.chat, { kind: "phase-error", phase: "render", error: event.error }],
      };
  }
}
```

> Note: in `render.done`, `status: { kind: "done" }` drops the `lastPhase` field from the typed mirror's `done` variant. That's intentional — the UI doesn't display `lastPhase` (the chat history already says what just rendered). The `useSessionStream` hook's React Query refetch of `GET /api/sessions/:sid` brings back the authoritative server-side `{ kind: "done", lastPhase }` if anything needs it.

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/state/session-reducer.test.ts`
Expected: PASS — 11 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/session-reducer.ts apps/web/test/state/session-reducer.test.ts
git commit -m "feat(web): session-reducer — pure ServerEvent → UiState fold"
```

---

## Task 7: Fake `EventSource` for tests

Vitest jsdom does not ship an `EventSource`. We need a controllable fake so SSE-driven hook tests are deterministic.

**Files:**
- Create: `apps/web/test/helpers/fake-event-source.ts`

- [ ] **Step 1: Write the helper**

```ts
// apps/web/test/helpers/fake-event-source.ts
type ListenerMap = Record<string, Set<(ev: MessageEvent) => void>>;

export class FakeEventSource implements EventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances.length = 0;
  }

  url: string;
  readyState: 0 | 1 | 2 = 0;
  withCredentials = false;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private listeners: ListenerMap = {};
  CONNECTING = 0 as const;
  OPEN = 1 as const;
  CLOSED = 2 as const;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
    // Open on next microtask, mirroring real EventSource behavior.
    queueMicrotask(() => this.markOpen());
  }

  /** Hook called by the implementation to simulate the server opening the stream. */
  markOpen(): void {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  /** Inject a frame parsed off the wire — test helper. */
  emit(type: string, data: string, lastEventId: string): void {
    if (this.readyState === 2) return;
    const ev = new MessageEvent(type, { data, lastEventId });
    this.listeners[type]?.forEach((cb) => cb(ev));
    if (type === "message") this.onmessage?.(ev);
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  addEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
    const fn = typeof cb === "function" ? cb : cb.handleEvent.bind(cb);
    (this.listeners[type] ??= new Set()).add(fn as (ev: MessageEvent) => void);
  }

  removeEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
    const fn = typeof cb === "function" ? cb : cb.handleEvent.bind(cb);
    this.listeners[type]?.delete(fn as (ev: MessageEvent) => void);
  }

  dispatchEvent(_: Event): boolean { return true; }

  close(): void { this.readyState = 2; }
}

export function installFakeEventSource(): void {
  // @ts-expect-error attach to global
  globalThis.EventSource = FakeEventSource;
}
```

> No tests for the fake itself — it's a test helper. Real coverage is in Task 8.

- [ ] **Step 2: Commit**

```bash
git add apps/web/test/helpers/fake-event-source.ts
git commit -m "test(web): FakeEventSource helper for SSE tests"
```

---

## Task 8: `use-session-stream` hook + tests

**Files:**
- Create: `apps/web/src/state/use-session-stream.ts`
- Create: `apps/web/test/state/use-session-stream.test.tsx`

The hook:
1. Opens an `EventSource` to `${apiBase()}/api/sessions/${sid}/stream?lastEventId=N` where `N` is `sessionStorage.getItem('uc.lastEventId.<sid>') ?? 0`.
2. Listens to **every event type** that the server emits (`phase.started`, etc.). For each, parses `data` as `SequencedEvent`, runs the reducer, updates the seq pointer.
3. On `artifact.created` it invalidates React Query keys `["artifact", sid, kind]` and `["artifacts", sid]` so any visible viewer refetches.
4. Returns `{ uiState, isStreaming, lastError }`.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/state/use-session-stream.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSessionStream } from "@/state/use-session-stream";
import { FakeEventSource, installFakeEventSource } from "../helpers/fake-event-source";
import type { ServerEvent } from "@ultracreator/shared";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  sessionStorage.clear();
  FakeEventSource.reset();
  installFakeEventSource();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function envelope(seq: number, event: ServerEvent) {
  return { seq, at: "t", event };
}

describe("useSessionStream", () => {
  it("opens an EventSource with lastEventId=0 on first connect", async () => {
    renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 0));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("http://127.0.0.1:3001/api/sessions/sid1/stream?lastEventId=0");
  });

  it("opens with the persisted lastEventId on reconnect", () => {
    sessionStorage.setItem("uc.lastEventId.sid1", "17");
    renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("http://127.0.0.1:3001/api/sessions/sid1/stream?lastEventId=17");
  });

  it("reduces incoming events into uiState", async () => {
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("phase.started", JSON.stringify(envelope(1, { type: "phase.started", phase: "research", at: "t" })), "1");
      es.emit("phase.progress", JSON.stringify(envelope(2, { type: "phase.progress", phase: "research", message: "x" })), "2");
    });
    expect(result.current.uiState.status).toEqual({ kind: "running", phase: "research" });
    expect(result.current.uiState.chat).toHaveLength(2);
  });

  it("persists lastEventId so reconnects pick up where we left off", async () => {
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("phase.progress", JSON.stringify(envelope(5, { type: "phase.progress", phase: "research", message: "x" })), "5");
    });
    expect(sessionStorage.getItem("uc.lastEventId.sid1")).toBe("5");
    expect(result.current.uiState.chat).toHaveLength(1);
  });

  it("ignores duplicates by seq (in case the server replays past the cutover)", async () => {
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      const ev: ServerEvent = { type: "phase.progress", phase: "research", message: "x" };
      es.emit("phase.progress", JSON.stringify(envelope(1, ev)), "1");
      es.emit("phase.progress", JSON.stringify(envelope(1, ev)), "1"); // dupe
    });
    expect(result.current.uiState.chat).toHaveLength(1);
  });

  it("invalidates the artifact query on artifact.created", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const W = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useSessionStream("sid1"), { wrapper: W });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("artifact.created", JSON.stringify(envelope(1, { type: "artifact.created", kind: "brief", version: 1 })), "1");
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["artifact", "sid1", "brief"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["artifacts", "sid1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["session", "sid1"] });
  });

  it("closes the EventSource on unmount", async () => {
    const { unmount } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 0));
    const es = FakeEventSource.instances[0]!;
    expect(es.readyState).toBe(1);
    unmount();
    expect(es.readyState).toBe(2);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/state/use-session-stream.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/state/use-session-stream.ts
"use client";
import { useEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "@ultracreator/shared";
import { initialUiState, reduce, type UiState } from "./session-reducer.js";
import { apiBase } from "@/lib/api-base";
import type { SequencedEvent } from "@/lib/api-types";

const ALL_EVENT_TYPES: ServerEvent["type"][] = [
  "phase.started",
  "phase.progress",
  "phase.error",
  "gate.awaiting",
  "artifact.created",
  "artifact.stale",
  "render.progress",
  "render.done",
  "render.error",
];

function seqKey(sid: string): string {
  return `uc.lastEventId.${sid}`;
}

interface ReducerAction {
  envelope: SequencedEvent;
}

function uiReducer(state: UiState, action: ReducerAction): UiState {
  return reduce(state, action.envelope.event);
}

export interface UseSessionStreamResult {
  uiState: UiState;
  isStreaming: boolean;
  lastError: Event | null;
}

export function useSessionStream(sid: string): UseSessionStreamResult {
  const [uiState, dispatch] = useReducer(uiReducer, initialUiState);
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastError, setLastError] = useState<Event | null>(null);
  const seenSeq = useRef<number>(0);
  const qc = useQueryClient();

  useEffect(() => {
    const initialSeq = Number(sessionStorage.getItem(seqKey(sid)) ?? "0");
    seenSeq.current = initialSeq;
    const url = `${apiBase()}/api/sessions/${sid}/stream?lastEventId=${initialSeq}`;
    const es = new EventSource(url);
    const handle = (raw: MessageEvent) => {
      try {
        const envelope = JSON.parse(raw.data) as SequencedEvent;
        if (envelope.seq <= seenSeq.current) return;
        seenSeq.current = envelope.seq;
        sessionStorage.setItem(seqKey(sid), String(envelope.seq));
        dispatch({ envelope });
        if (envelope.event.type === "artifact.created") {
          qc.invalidateQueries({ queryKey: ["artifact", sid, envelope.event.kind] });
          qc.invalidateQueries({ queryKey: ["artifacts", sid] });
          qc.invalidateQueries({ queryKey: ["session", sid] });
        }
      } catch {
        // Malformed frame — ignore.
      }
    };
    for (const type of ALL_EVENT_TYPES) es.addEventListener(type, handle);
    es.onopen = () => setIsStreaming(true);
    es.onerror = (ev) => {
      setIsStreaming(false);
      setLastError(ev);
    };
    return () => {
      for (const type of ALL_EVENT_TYPES) es.removeEventListener(type, handle);
      es.close();
    };
  }, [sid, qc]);

  return { uiState, isStreaming, lastError };
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/state/use-session-stream.test.tsx`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/state/use-session-stream.ts apps/web/test/state/use-session-stream.test.tsx
git commit -m "feat(web): useSessionStream — EventSource → reducer + query invalidation"
```

---

## Task 9: `<Composer>` + tests

**Files:**
- Create: `apps/web/src/components/composer.tsx`
- Create: `apps/web/test/helpers/render-with-query.tsx`
- Create: `apps/web/test/helpers/api-mocks.ts`
- Create: `apps/web/test/components/composer.test.tsx`

The Composer is a form with:
- `<Textarea>` for prompt
- A file input (`<input type=file multiple>`) — list selected file names with a remove button
- Duration chips: 15/30/45/60
- Aspect chips: 16:9 / 9:16 / 1:1
- Voiceover toggle: `<Switch>`
- "Generate" button → on submit: upload files via `uploadFiles`, then `postMessage({ text, uploadedFiles, constraints })`, then clear the textarea.

For follow-up messages (no constraints needed) it just sends `{ text }`.

- [ ] **Step 1: Add the test helpers**

```tsx
// apps/web/test/helpers/render-with-query.tsx
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

export function renderWithQuery(ui: ReactElement, options?: RenderOptions): RenderResult & { qc: QueryClient } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...render(ui, { wrapper, ...options }), qc };
}
```

```ts
// apps/web/test/helpers/api-mocks.ts
import { vi } from "vitest";

export function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}
```

- [ ] **Step 2: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/composer.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "@/components/composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

const BASE = "http://127.0.0.1:3001";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE;
});
afterEach(() => vi.restoreAllMocks());

describe("<Composer>", () => {
  it("renders text + duration + aspect + voiceover controls", () => {
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    expect(screen.getByPlaceholderText(/describe your product/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "15s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "30s" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "16:9" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /voiceover/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
  });

  it("submitting with constraints sends a UserMessage to /messages", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      return new Response("", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    await user.type(screen.getByPlaceholderText(/describe your product/i), "make a promo for example.com");
    await user.click(screen.getByRole("button", { name: "30s" }));
    await user.click(screen.getByRole("button", { name: "9:16" }));
    await user.click(screen.getByRole("switch", { name: /voiceover/i }));
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const call = spy.mock.calls.find(([url]) => String(url).endsWith("/messages"))!;
    const body = JSON.parse((call[1]!.body as string));
    expect(body.text).toBe("make a promo for example.com");
    expect(body.constraints).toEqual({ durationSec: 30, aspectRatio: "9:16", withVoiceover: true });
  });

  it("uploads files before sending the message, attaching uploadedFiles paths", async () => {
    let uploadDone = false;
    const spy = mockFetch(async (url, init) => {
      if (url.endsWith("/uploads")) {
        expect(init?.body).toBeInstanceOf(FormData);
        uploadDone = true;
        return new Response(
          JSON.stringify({ files: [{ name: "logo.png", path: "uploads/logo.png" }] }),
          { status: 201 },
        );
      }
      if (url.endsWith("/messages")) {
        expect(uploadDone).toBe(true);
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response("", { status: 404 });
    });

    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    const file = new File(["x"], "logo.png", { type: "image/png" });
    const input = screen.getByLabelText(/attach files/i) as HTMLInputElement;
    await user.upload(input, file);
    await user.type(screen.getByPlaceholderText(/describe your product/i), "hello");
    await user.click(screen.getByRole("button", { name: /generate/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const messageCall = spy.mock.calls.find(([url]) => String(url).endsWith("/messages"))!;
    expect(JSON.parse((messageCall[1]!.body as string)).uploadedFiles).toEqual(["uploads/logo.png"]);
  });

  it("in follow-up mode (no requireConstraints) sends just {text}", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" />);
    await user.type(screen.getByPlaceholderText(/refine/i), "make it punchier");
    await user.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const body = JSON.parse((spy.mock.calls[0]![1]!.body as string));
    expect(body).toEqual({ text: "make it punchier" });
  });

  it("does not submit when text is empty", async () => {
    const spy = mockFetch(async () => new Response("", { status: 202 }));
    const user = userEvent.setup();
    renderWithQuery(<Composer sid="sid1" requireConstraints />);
    await user.click(screen.getByRole("button", { name: /generate/i }));
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/composer.test.tsx`
Expected: FAIL — `@/components/composer` not found.

- [ ] **Step 4: Write the Composer**

```tsx
// apps/web/src/components/composer.tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Paperclip, X } from "lucide-react";
import { ALLOWED_DURATIONS, ALLOWED_ASPECT_RATIOS, type AspectRatio, type Duration } from "@ultracreator/shared";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { postMessage, uploadFiles } from "@/lib/api-client";

interface Props {
  sid: string;
  /** First-message mode: surfaces duration + aspect + voiceover; "Generate" CTA. */
  requireConstraints?: boolean;
  /** Optional callback after a successful submit (for clearing parent state etc.). */
  onSubmitted?: () => void;
}

export function Composer({ sid, requireConstraints = false, onSubmitted }: Props): React.ReactElement {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [duration, setDuration] = useState<Duration>(30);
  const [aspect, setAspect] = useState<AspectRatio>("16:9");
  const [voiceover, setVoiceover] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (text.trim().length === 0) return;
    setBusy(true);
    try {
      let uploadedFiles: string[] | undefined;
      if (files.length > 0) {
        const out = await uploadFiles(sid, files);
        uploadedFiles = out.files.map((f) => f.path);
      }
      await postMessage(sid, {
        text: text.trim(),
        ...(uploadedFiles ? { uploadedFiles } : {}),
        ...(requireConstraints
          ? { constraints: { durationSec: duration, aspectRatio: aspect, withVoiceover: voiceover } }
          : {}),
      });
      setText("");
      setFiles([]);
      onSubmitted?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <Textarea
        placeholder={requireConstraints ? "Describe your product (or paste a URL)" : "Refine, ask, or instruct…"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        disabled={busy}
      />

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-md bg-muted px-2 py-1">
              {f.name}
              <button
                type="button"
                aria-label={`remove ${f.name}`}
                onClick={() => setFiles(files.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Paperclip className="h-4 w-4" />
          <span>Attach files</span>
          <input
            type="file"
            multiple
            className="sr-only"
            aria-label="attach files"
            onChange={(e) => setFiles([...(files), ...Array.from(e.target.files ?? [])])}
          />
        </label>

        {requireConstraints && (
          <>
            <ToggleGroup
              type="single"
              value={String(duration)}
              onValueChange={(v) => v && setDuration(Number(v) as Duration)}
              aria-label="duration"
            >
              {ALLOWED_DURATIONS.map((d) => (
                <ToggleGroupItem key={d} value={String(d)}>{d}s</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <ToggleGroup
              type="single"
              value={aspect}
              onValueChange={(v) => v && setAspect(v as AspectRatio)}
              aria-label="aspect ratio"
            >
              {ALLOWED_ASPECT_RATIOS.map((a) => (
                <ToggleGroupItem key={a} value={a}>{a}</ToggleGroupItem>
              ))}
            </ToggleGroup>
            <label className="ml-auto flex items-center gap-2 text-xs">
              <Switch
                checked={voiceover}
                onCheckedChange={setVoiceover}
                aria-label="voiceover"
              />
              Voiceover
            </label>
          </>
        )}

        <Button type="submit" disabled={busy} className={requireConstraints ? "" : "ml-auto"}>
          {requireConstraints ? "Generate" : "Send"}
        </Button>
      </div>
    </form>
  );
}
```

- [ ] **Step 5: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/composer.test.tsx`
Expected: PASS — 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/composer.tsx apps/web/test/components/composer.test.tsx apps/web/test/helpers/render-with-query.tsx apps/web/test/helpers/api-mocks.ts
git commit -m "feat(web): <Composer> — text + files + duration/aspect/voiceover → upload + message"
```

---

## Task 10: `<ChatStream>` + tests

**Files:**
- Create: `apps/web/src/components/chat-stream.tsx`
- Create: `apps/web/test/components/chat-stream.test.tsx`

Renders an array of `ChatItem`s (from `session-reducer.ts`) as a scrollable list. Each item kind gets a distinct row.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/chat-stream.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatStream } from "@/components/chat-stream";
import type { ChatItem } from "@/state/session-reducer";

describe("<ChatStream>", () => {
  it("renders nothing useful when empty (has an empty-state hint)", () => {
    render(<ChatStream items={[]} />);
    expect(screen.getByText(/waiting|nothing yet/i)).toBeInTheDocument();
  });

  it("renders a phase-start row with the phase name", () => {
    const items: ChatItem[] = [{ kind: "phase-start", phase: "research", at: "t" }];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/research/i)).toBeInTheDocument();
  });

  it("renders progress text and a gate row", () => {
    const items: ChatItem[] = [
      { kind: "progress", phase: "design", message: "drafted palette" },
      { kind: "gate", phase: "design" },
    ];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/drafted palette/i)).toBeInTheDocument();
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
  });

  it("renders an artifact row with kind + version", () => {
    const items: ChatItem[] = [{ kind: "artifact", artifactKind: "brief", version: 1 }];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/brief v1/i)).toBeInTheDocument();
  });

  it("renders a phase error row with the message", () => {
    const items: ChatItem[] = [{ kind: "phase-error", phase: "render", error: "ffmpeg died" }];
    render(<ChatStream items={items} />);
    expect(screen.getByText(/ffmpeg died/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/chat-stream.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/chat-stream.tsx
"use client";
import { motion } from "motion/react";
import { CheckCircle2, AlertTriangle, Loader2, Sparkles, FileText, PauseCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ChatItem } from "@/state/session-reducer";

interface Props { items: ChatItem[] }

export function ChatStream({ items }: Props): React.ReactElement {
  if (items.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">Waiting for the agent. Nothing yet.</p>;
  }
  return (
    <ScrollArea className="h-full">
      <ol className="flex flex-col gap-3 p-4">
        {items.map((item, i) => (
          <motion.li
            key={i}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="flex items-start gap-2 text-sm"
          >
            {renderRow(item)}
          </motion.li>
        ))}
      </ol>
    </ScrollArea>
  );
}

function renderRow(item: ChatItem): React.ReactElement {
  switch (item.kind) {
    case "phase-start":
      return (
        <>
          <Loader2 className="mt-0.5 h-4 w-4 animate-spin text-primary" />
          <span><Badge variant="outline" className="mr-2">{item.phase}</Badge>started</span>
        </>
      );
    case "progress":
      return (
        <>
          <Sparkles className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <span><Badge variant="outline" className="mr-2">{item.phase}</Badge>{item.message}</span>
        </>
      );
    case "phase-error":
      return (
        <>
          <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
          <span className="text-destructive"><Badge variant="destructive" className="mr-2">{item.phase}</Badge>{item.error}</span>
        </>
      );
    case "gate":
      return (
        <>
          <PauseCircle className="mt-0.5 h-4 w-4 text-primary" />
          <span><Badge className="mr-2">{item.phase}</Badge>awaiting approval</span>
        </>
      );
    case "artifact":
      return (
        <>
          <FileText className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <span><Badge variant="secondary" className="mr-2">{item.artifactKind}</Badge>v{item.version}</span>
        </>
      );
    case "render-done":
      return (
        <>
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" />
          <span>rendered <code className="text-xs">{item.mp4Path}</code></span>
        </>
      );
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/chat-stream.test.tsx`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat-stream.tsx apps/web/test/components/chat-stream.test.tsx
git commit -m "feat(web): <ChatStream> — render ChatItem[] with motion entry + iconography"
```

---

## Task 11: `<BriefCard>` + tests

**Files:**
- Create: `apps/web/src/components/brief-card.tsx`
- Create: `apps/web/test/components/brief-card.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/brief-card.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BriefCard } from "@/components/brief-card";
import type { Brief } from "@ultracreator/shared";

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A widget", category: "saas" },
  audience: "developers",
  keyMessages: ["fast", "simple", "fun"],
  brandHints: { colors: ["#ff0066", "#000000"], logoUrl: "uploads/logo.png", fonts: ["Inter"] },
  sourceAssets: { images: ["uploads/a.png"], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "9:16", withVoiceover: true },
};

describe("<BriefCard>", () => {
  it("renders product name + tagline + audience", () => {
    render(<BriefCard brief={brief} />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText(/do more/i)).toBeInTheDocument();
    expect(screen.getByText(/developers/i)).toBeInTheDocument();
  });

  it("renders each keyMessage as its own item", () => {
    render(<BriefCard brief={brief} />);
    for (const m of brief.keyMessages) {
      expect(screen.getByText(m)).toBeInTheDocument();
    }
  });

  it("renders the constraints (duration / aspect / voiceover)", () => {
    render(<BriefCard brief={brief} />);
    expect(screen.getByText(/30s/i)).toBeInTheDocument();
    expect(screen.getByText(/9:16/i)).toBeInTheDocument();
    expect(screen.getByText(/voiceover/i)).toBeInTheDocument();
  });

  it("renders color swatches via inline backgroundColor", () => {
    render(<BriefCard brief={brief} />);
    const pink = screen.getByTestId("swatch-#ff0066");
    expect(pink).toHaveStyle({ backgroundColor: "rgb(255, 0, 102)" });
  });

  it("renders 'stale' badge when stale=true", () => {
    render(<BriefCard brief={brief} stale />);
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/brief-card.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/brief-card.tsx
"use client";
import type { Brief } from "@ultracreator/shared";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

interface Props { brief: Brief; stale?: boolean }

export function BriefCard({ brief, stale = false }: Props): React.ReactElement {
  const { product, audience, keyMessages, brandHints, constraints } = brief;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>{product.name}</CardTitle>
          {stale && <Badge variant="destructive">stale</Badge>}
        </div>
        <CardDescription>{product.tagline}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{product.description}</p>
        <Separator />

        <Section title="Audience">
          <p className="text-sm">{audience}</p>
        </Section>

        <Section title="Key messages">
          <ul className="grid gap-1 text-sm">
            {keyMessages.map((m) => (
              <li key={m} className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
                {m}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Brand">
          <div className="flex flex-wrap gap-2">
            {brandHints.colors.map((c) => (
              <span
                key={c}
                data-testid={`swatch-${c}`}
                title={c}
                className="h-6 w-6 rounded-md border"
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </Section>

        <Section title="Constraints">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline">{constraints.durationSec}s</Badge>
            <Badge variant="outline">{constraints.aspectRatio}</Badge>
            {constraints.withVoiceover && <Badge>voiceover</Badge>}
          </div>
        </Section>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/brief-card.test.tsx`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/brief-card.tsx apps/web/test/components/brief-card.test.tsx
git commit -m "feat(web): <BriefCard> — render Brief artifact with palette + constraints"
```

---

## Task 12: `<DesignBoard>` + tests

**Files:**
- Create: `apps/web/src/components/design-board.tsx`
- Create: `apps/web/test/components/design-board.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/design-board.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DesignBoard } from "@/components/design-board";
import type { Design } from "@ultracreator/shared";

const design: Design = {
  mood: "energetic and minimal",
  palette: [
    { name: "Primary", hex: "#ff0066" },
    { name: "Ink", hex: "#0a0a0a" },
  ],
  typography: { heading: "Inter", body: "Source Sans" },
  motionStyle: "kinetic captions",
  keyVisuals: [{ description: "wordmark on grid" }],
  sampleFrames: [
    { caption: "Open with logo punch-in", layoutHint: "centered" },
    { caption: "Feature trio", layoutHint: "split-thirds" },
  ],
};

describe("<DesignBoard>", () => {
  it("renders the mood + motion + typography", () => {
    render(<DesignBoard design={design} />);
    expect(screen.getByText(/energetic and minimal/i)).toBeInTheDocument();
    expect(screen.getByText(/kinetic captions/i)).toBeInTheDocument();
    expect(screen.getByText(/inter/i)).toBeInTheDocument();
    expect(screen.getByText(/source sans/i)).toBeInTheDocument();
  });

  it("renders each palette entry with the hex value", () => {
    render(<DesignBoard design={design} />);
    expect(screen.getByText("#ff0066")).toBeInTheDocument();
    expect(screen.getByText("#0a0a0a")).toBeInTheDocument();
  });

  it("renders one tile per sample frame", () => {
    render(<DesignBoard design={design} />);
    expect(screen.getByText(/open with logo punch-in/i)).toBeInTheDocument();
    expect(screen.getByText(/feature trio/i)).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows 'stale' badge when stale=true", () => {
    render(<DesignBoard design={design} stale />);
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/design-board.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/design-board.tsx
"use client";
import { motion } from "motion/react";
import type { Design } from "@ultracreator/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Props { design: Design; stale?: boolean }

export function DesignBoard({ design, stale = false }: Props): React.ReactElement {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Design</CardTitle>
            {stale && <Badge variant="destructive">stale</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Row label="Mood"><p className="text-sm">{design.mood}</p></Row>
          <Row label="Motion"><p className="text-sm">{design.motionStyle}</p></Row>
          <Row label="Typography">
            <p className="text-sm">
              <span className="font-medium">{design.typography.heading}</span>
              <span className="text-muted-foreground"> · {design.typography.body}</span>
            </p>
          </Row>
          <Row label="Palette">
            <div className="flex flex-wrap gap-3">
              {design.palette.map((c) => (
                <div key={c.hex} className="flex items-center gap-2">
                  <span className="h-7 w-7 rounded-md border" style={{ backgroundColor: c.hex }} />
                  <div className="text-xs">
                    <div>{c.name}</div>
                    <div className="text-muted-foreground">{c.hex}</div>
                  </div>
                </div>
              ))}
            </div>
          </Row>
          {design.keyVisuals.length > 0 && (
            <Row label="Key visuals">
              <ul className="grid gap-1 text-sm">
                {design.keyVisuals.map((v, i) => <li key={i}>· {v.description}</li>)}
              </ul>
            </Row>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {design.sampleFrames.map((f, i) => (
          <motion.article
            key={i}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2, delay: i * 0.04 }}
            className="aspect-video overflow-hidden rounded-lg border bg-muted"
          >
            <div className="flex h-full flex-col justify-between p-3">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.layoutHint}</span>
              <p className="text-sm font-medium leading-tight">{f.caption}</p>
            </div>
          </motion.article>
        ))}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h4>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/design-board.test.tsx`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/design-board.tsx apps/web/test/components/design-board.test.tsx
git commit -m "feat(web): <DesignBoard> — palette + typography + motion + sample frame tiles"
```

---

## Task 13: `<ScriptTimeline>` + tests

**Files:**
- Create: `apps/web/src/components/script-timeline.tsx`
- Create: `apps/web/test/components/script-timeline.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/script-timeline.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ScriptTimeline } from "@/components/script-timeline";
import type { Script } from "@ultracreator/shared";

const script: Script = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 10, visual: "logo punch-in", narration: "Welcome" },
    { id: "s2", startSec: 10, durationSec: 12, visual: "feature trio", onScreenText: "FAST" },
    { id: "s3", startSec: 22, durationSec: 8, visual: "CTA card" },
  ],
};

describe("<ScriptTimeline>", () => {
  it("renders the total duration", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getByText(/30s/i)).toBeInTheDocument();
  });

  it("renders one row per scene", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("each scene bar widths are proportional to durationSec/totalSec", () => {
    render(<ScriptTimeline script={script} />);
    const items = screen.getAllByRole("listitem");
    const bar0 = within(items[0]!).getByTestId("bar");
    const bar1 = within(items[1]!).getByTestId("bar");
    const bar2 = within(items[2]!).getByTestId("bar");
    expect(bar0).toHaveStyle({ width: `${(10 / 30) * 100}%` });
    expect(bar1).toHaveStyle({ width: `${(12 / 30) * 100}%` });
    expect(bar2).toHaveStyle({ width: `${(8 / 30) * 100}%` });
  });

  it("shows narration text when present", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getByText(/welcome/i)).toBeInTheDocument();
  });

  it("shows on-screen text when present", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getByText("FAST")).toBeInTheDocument();
  });

  it("renders stale badge", () => {
    render(<ScriptTimeline script={script} stale />);
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/script-timeline.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/script-timeline.tsx
"use client";
import type { Script } from "@ultracreator/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Props { script: Script; stale?: boolean }

export function ScriptTimeline({ script, stale = false }: Props): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Script · {script.totalSec}s</CardTitle>
          {stale && <Badge variant="destructive">stale</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2">
          {script.scenes.map((scene) => {
            const widthPct = (scene.durationSec / script.totalSec) * 100;
            return (
              <li key={scene.id} className="rounded-md border bg-muted/40 p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{scene.startSec}s</span>
                  <span>·</span>
                  <span>{scene.durationSec}s</span>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-full bg-border">
                  <div data-testid="bar" className="h-full rounded-full bg-primary" style={{ width: `${widthPct}%` }} />
                </div>
                <div className="mt-2 text-sm font-medium">{scene.visual}</div>
                {scene.onScreenText && (
                  <div className="mt-1 text-xs">
                    <Badge variant="outline" className="mr-2">on-screen</Badge>
                    <span className="uppercase tracking-wide">{scene.onScreenText}</span>
                  </div>
                )}
                {scene.narration && (
                  <p className="mt-1 text-xs text-muted-foreground">“{scene.narration}”</p>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/script-timeline.test.tsx`
Expected: PASS — 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/script-timeline.tsx apps/web/test/components/script-timeline.test.tsx
git commit -m "feat(web): <ScriptTimeline> — proportional scene bars with narration + on-screen text"
```

---

## Task 14: `<VideoPreview>` + tests

**Files:**
- Create: `apps/web/src/components/video-preview.tsx`
- Create: `apps/web/test/components/video-preview.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/video-preview.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { VideoPreview } from "@/components/video-preview";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});

describe("<VideoPreview>", () => {
  it("renders an <video controls> with the file URL composed from sid + path", () => {
    const { container } = render(<VideoPreview sid="sid1" mp4Path="output/x.mp4" />);
    const video = container.querySelector("video")!;
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute("src", "http://127.0.0.1:3001/api/sessions/sid1/files/output/x.mp4");
    expect(video).toHaveAttribute("controls");
  });

  it("strips a leading slash from the path", () => {
    const { container } = render(<VideoPreview sid="sid1" mp4Path="/output/x.mp4" />);
    expect(container.querySelector("video")!).toHaveAttribute(
      "src",
      "http://127.0.0.1:3001/api/sessions/sid1/files/output/x.mp4",
    );
  });

  it("shows a download link", () => {
    render(<VideoPreview sid="sid1" mp4Path="output/x.mp4" />);
    const link = screen.getByRole("link", { name: /download/i });
    expect(link).toHaveAttribute("href", "http://127.0.0.1:3001/api/sessions/sid1/files/output/x.mp4");
    expect(link).toHaveAttribute("download");
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/video-preview.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/video-preview.tsx
"use client";
import { Download } from "lucide-react";
import { fileUrl } from "@/lib/api-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props { sid: string; mp4Path: string }

export function VideoPreview({ sid, mp4Path }: Props): React.ReactElement {
  const src = fileUrl(sid, mp4Path);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle>Video</CardTitle>
          <a
            href={src}
            download
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        </div>
      </CardHeader>
      <CardContent>
        <video src={src} controls className="aspect-video w-full rounded-lg bg-black" />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/video-preview.test.tsx`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/video-preview.tsx apps/web/test/components/video-preview.test.tsx
git commit -m "feat(web): <VideoPreview> — <video> + download link sourced from /files"
```

---

## Task 15: `<ApprovalGate>` + tests

**Files:**
- Create: `apps/web/src/components/approval-gate.tsx`
- Create: `apps/web/test/components/approval-gate.test.tsx`

Renders two buttons when `state.kind === 'awaiting-gate'`: **Approve** (`/approve`) and **Refine** (focuses the composer textarea — no message yet). For v1 we keep it minimal: clicking Refine just calls an `onRefineRequested` callback the parent provides (Task 17 wires that to focus the composer).

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/approval-gate.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalGate } from "@/components/approval-gate";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

const BASE = "http://127.0.0.1:3001";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE;
});
afterEach(() => vi.restoreAllMocks());

describe("<ApprovalGate>", () => {
  it("returns null when state is not awaiting-gate", () => {
    const { container } = renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "idle" }} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 'approve design' label when phase=design", () => {
    renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "design" }} />);
    expect(screen.getByRole("button", { name: /approve design/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refine/i })).toBeInTheDocument();
  });

  it("approve POSTs /messages with text='/approve'", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const user = userEvent.setup();
    renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "design" }} />);
    await user.click(screen.getByRole("button", { name: /approve design/i }));
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(spy.mock.calls[0]![1]!.body as string)).toEqual({ text: "/approve" });
  });

  it("Refine calls onRefineRequested and does NOT POST", async () => {
    const spy = mockFetch(async () => new Response("", { status: 200 }));
    const cb = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "script" }} onRefineRequested={cb} />);
    await user.click(screen.getByRole("button", { name: /refine/i }));
    expect(cb).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/approval-gate.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/approval-gate.tsx
"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Pencil } from "lucide-react";
import type { SessionState } from "@/lib/api-types";
import { postMessage } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

interface Props {
  sid: string;
  state: SessionState;
  onRefineRequested?: () => void;
}

export function ApprovalGate({ sid, state, onRefineRequested }: Props): React.ReactElement | null {
  const [busy, setBusy] = useState(false);
  if (state.kind !== "awaiting-gate") return null;
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-accent/40 p-3 text-sm">
      <span className="mr-auto">Review the {state.phase}.</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onRefineRequested?.()}
      >
        <Pencil className="mr-1 h-3.5 w-3.5" /> Refine
      </Button>
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await postMessage(sid, { text: "/approve" });
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Approve failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Check className="mr-1 h-3.5 w-3.5" /> Approve {state.phase}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/approval-gate.test.tsx`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/approval-gate.tsx apps/web/test/components/approval-gate.test.tsx
git commit -m "feat(web): <ApprovalGate> — approve/refine row when awaiting-gate"
```

---

## Task 16: `<Sidebar>` + tests

**Files:**
- Create: `apps/web/src/components/sidebar.tsx`
- Create: `apps/web/test/components/sidebar.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/sidebar.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "@/components/sidebar";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";
import { addLocalSession, listLocalSessions } from "@/lib/session-store";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: pushMock, refresh: () => {} }),
  usePathname: () => "/s/sid1",
}));

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  localStorage.clear();
  pushMock.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe("<Sidebar>", () => {
  it("renders an empty hint when no sessions stored", () => {
    renderWithQuery(<Sidebar activeSid={null} />);
    expect(screen.getByText(/no sessions/i)).toBeInTheDocument();
  });

  it("renders each stored session", () => {
    addLocalSession({ id: "a", title: "Alpha" });
    addLocalSession({ id: "b", title: "Beta" });
    renderWithQuery(<Sidebar activeSid="a" />);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("'+ New' button POSTs /api/sessions then routes to /s/<sid>", async () => {
    mockFetch(async (url) => {
      expect(url).toBe("http://127.0.0.1:3001/api/sessions");
      return new Response(JSON.stringify({ sessionId: "new-sid" }), { status: 201 });
    });
    const user = userEvent.setup();
    renderWithQuery(<Sidebar activeSid={null} />);
    await user.click(screen.getByRole("button", { name: /new/i }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/s/new-sid"));
    expect(listLocalSessions().some((s) => s.id === "new-sid")).toBe(true);
  });

  it("delete button DELETEs and removes the entry from localStorage", async () => {
    addLocalSession({ id: "a", title: "Alpha" });
    const spy = mockFetch(async (url, init) => {
      expect(init?.method).toBe("DELETE");
      expect(url).toBe("http://127.0.0.1:3001/api/sessions/a");
      return new Response(null, { status: 204 });
    });
    const user = userEvent.setup();
    renderWithQuery(<Sidebar activeSid={null} />);
    await user.click(screen.getByRole("button", { name: /delete alpha/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(listLocalSessions()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/sidebar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the component**

```tsx
// apps/web/src/components/sidebar.tsx
"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Film } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { createSession, deleteSession } from "@/lib/api-client";
import { addLocalSession, listLocalSessions, removeLocalSession, type SidebarSession } from "@/lib/session-store";

interface Props { activeSid: string | null }

export function Sidebar({ activeSid }: Props): React.ReactElement {
  const router = useRouter();
  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  useEffect(() => {
    setSessions(listLocalSessions());
  }, []);

  async function handleNew() {
    try {
      const { sessionId } = await createSession();
      addLocalSession({ id: sessionId, title: "Untitled" });
      setSessions(listLocalSessions());
      router.push(`/s/${sessionId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create session");
    }
  }

  async function handleDelete(s: SidebarSession) {
    try {
      await deleteSession(s.id);
    } catch {
      // ignore — workspace may already be gone
    }
    removeLocalSession(s.id);
    setSessions(listLocalSessions());
    if (s.id === activeSid) router.push("/");
  }

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-muted/30">
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-2 font-semibold">
          <Film className="h-4 w-4 text-primary" /> UltraCreator
        </div>
        <Button size="sm" onClick={handleNew}>
          <Plus className="mr-1 h-3.5 w-3.5" /> New
        </Button>
      </div>
      <Separator />
      <ScrollArea className="flex-1">
        {sessions.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">No sessions yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 p-2">
            {sessions.map((s) => (
              <li key={s.id} className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                s.id === activeSid && "bg-muted",
              )}>
                <button
                  className="flex-1 truncate text-left"
                  onClick={() => router.push(`/s/${s.id}`)}
                >
                  {s.title}
                </button>
                <button
                  aria-label={`delete ${s.title}`}
                  onClick={() => handleDelete(s)}
                  className="opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </aside>
  );
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/sidebar.test.tsx`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/sidebar.tsx apps/web/test/components/sidebar.test.tsx
git commit -m "feat(web): <Sidebar> — localStorage session list + new/delete"
```

---

## Task 17: `<ArtifactViewer>` (dispatcher) — no separate tests

**Files:**
- Create: `apps/web/src/components/artifact-viewer.tsx`

This component picks an artifact descriptor (the highest-priority kind to display, defaulting to mp4 > script > design > brief), fetches the typed envelope with React Query, and renders the appropriate child. We rely on the children's tests for behavior; this dispatcher is a thin switch.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/components/artifact-viewer.tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import type { ArtifactDescriptor, ArtifactKind } from "@ultracreator/shared";
import { getArtifact } from "@/lib/api-client";
import { BriefCard } from "./brief-card";
import { DesignBoard } from "./design-board";
import { ScriptTimeline } from "./script-timeline";
import { VideoPreview } from "./video-preview";

const PRIORITY: ArtifactKind[] = ["mp4", "script", "design", "brief"];

interface Props { sid: string; artifacts: ArtifactDescriptor[] }

export function ArtifactViewer({ sid, artifacts }: Props): React.ReactElement | null {
  const chosen = pickHighest(artifacts);
  if (!chosen) return null;
  return <Pane sid={sid} kind={chosen.kind} stale={chosen.stale} />;
}

function pickHighest(artifacts: ArtifactDescriptor[]): ArtifactDescriptor | null {
  for (const k of PRIORITY) {
    const latest = artifacts
      .filter((a) => a.kind === k)
      .sort((a, b) => b.version - a.version)[0];
    if (latest) return latest;
  }
  return null;
}

function Pane({ sid, kind, stale }: { sid: string; kind: ArtifactKind; stale: boolean }): React.ReactElement {
  const q = useQuery({
    queryKey: ["artifact", sid, kind],
    queryFn: () => getArtifact(sid, kind),
  });
  if (q.isLoading || !q.data) {
    return <p className="p-6 text-sm text-muted-foreground">Loading {kind}…</p>;
  }
  switch (kind) {
    case "brief":
      return <BriefCard brief={q.data.data as never} stale={stale} />;
    case "design":
      return <DesignBoard design={q.data.data as never} stale={stale} />;
    case "script":
      return <ScriptTimeline script={q.data.data as never} stale={stale} />;
    case "mp4":
      return <VideoPreview sid={sid} mp4Path={(q.data.data as { path: string }).path.replace(/^.*\/output\//, "output/")} />;
    case "composition":
    case "narration":
      return <p className="p-6 text-sm text-muted-foreground">{kind} ready.</p>;
  }
}
```

> The mp4 path massage is defensive: `RenderWorker` writes an absolute `path`, but the file route requires a *workspace-relative* path. We strip everything up to `output/`. If Plan 4 ever changes the artifact shape to a relative path, this becomes a no-op and we can remove it in a follow-up.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/artifact-viewer.tsx
git commit -m "feat(web): <ArtifactViewer> — dispatch by artifact kind with priority order"
```

---

## Task 18: `<SessionPage>` + integration test

**Files:**
- Create: `apps/web/src/components/session-page.tsx`
- Create: `apps/web/src/app/providers.tsx`
- Create: `apps/web/test/components/session-page.test.tsx`

`SessionPage` is the client component that composes everything: Sidebar | (ChatStream + ApprovalGate + Composer) | ArtifactViewer. It reads the sid from props, calls `useSession` (which wraps `useQuery(getSession)` + `useSessionStream`).

We also create `use-session.ts` here because it's only used by `SessionPage`.

- [ ] **Step 1: Write `state/use-session.ts`**

```ts
// apps/web/src/state/use-session.ts
"use client";
import { useQuery } from "@tanstack/react-query";
import { getSession } from "@/lib/api-client";
import { useSessionStream } from "./use-session-stream.js";

export function useSession(sid: string) {
  const stream = useSessionStream(sid);
  const session = useQuery({
    queryKey: ["session", sid],
    queryFn: () => getSession(sid),
  });
  return { stream, session };
}
```

- [ ] **Step 2: Write the Providers component**

```tsx
// apps/web/src/app/providers.tsx
"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1 } } }));
  return (
    <QueryClientProvider client={qc}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
```

- [ ] **Step 3: Write the failing test**

```tsx
// @vitest-environment jsdom
// apps/web/test/components/session-page.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionPage } from "@/components/session-page";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";
import { FakeEventSource, installFakeEventSource } from "../helpers/fake-event-source";
import { addLocalSession } from "@/lib/session-store";
import type { ArtifactDescriptor, Brief } from "@ultracreator/shared";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/s/sid1",
}));

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A widget", category: "saas" },
  audience: "developers",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  localStorage.clear();
  sessionStorage.clear();
  FakeEventSource.reset();
  installFakeEventSource();
  addLocalSession({ id: "sid1", title: "Acme" });
});

afterEach(() => vi.restoreAllMocks());

describe("<SessionPage> integration", () => {
  it("shows the composer when state=idle and no artifacts", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(screen.getByPlaceholderText(/describe your product/i)).toBeInTheDocument());
  });

  it("renders the BriefCard when an artifact descriptor is returned and the envelope loads", async () => {
    const descriptor: ArtifactDescriptor = {
      kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false, path: "artifacts/brief.v1.json",
    };
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "awaiting-gate", phase: "design" }, artifacts: [descriptor] }), { status: 200 });
      }
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: brief }), { status: 200 });
      }
      if (url.endsWith("/artifacts")) {
        return new Response(JSON.stringify([descriptor]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
    // The approval gate is visible when awaiting-gate
    await waitFor(() => expect(screen.getByRole("button", { name: /approve design/i })).toBeInTheDocument());
  });

  it("approving from the gate POSTs /messages", async () => {
    const descriptor: ArtifactDescriptor = {
      kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false, path: "p",
    };
    const spy = mockFetch(async (url, init) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "awaiting-gate", phase: "design" }, artifacts: [descriptor] }), { status: 200 });
      }
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: brief }), { status: 200 });
      }
      if (url.endsWith("/artifacts")) {
        return new Response(JSON.stringify([descriptor]), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response("not found", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(<SessionPage sid="sid1" />);
    const approve = await screen.findByRole("button", { name: /approve design/i });
    await user.click(approve);
    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => String(url).endsWith("/messages"))).toBe(true),
    );
  });
});
```

- [ ] **Step 4: Run, verify failure**

Run: `pnpm vitest run apps/web/test/components/session-page.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the SessionPage**

```tsx
// apps/web/src/components/session-page.tsx
"use client";
import { useRef } from "react";
import { useSession } from "@/state/use-session";
import { Sidebar } from "./sidebar";
import { ChatStream } from "./chat-stream";
import { ApprovalGate } from "./approval-gate";
import { Composer } from "./composer";
import { ArtifactViewer } from "./artifact-viewer";

interface Props { sid: string }

export function SessionPage({ sid }: Props): React.ReactElement {
  const { stream, session } = useSession(sid);
  const composerRef = useRef<HTMLDivElement>(null);
  const data = session.data;
  const requireConstraints = data?.state.kind === "idle" && (data?.artifacts.length ?? 0) === 0;
  const sessionState = data?.state ?? { kind: "idle" as const };

  return (
    <div className="flex h-screen">
      <Sidebar activeSid={sid} />

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          <section className="flex w-1/2 flex-col border-r">
            <header className="border-b p-3 text-sm text-muted-foreground">
              {phaseLabel(sessionState)}
            </header>
            <div className="flex-1 overflow-hidden">
              <ChatStream items={stream.uiState.chat} />
            </div>
            <div className="border-t p-3 space-y-2" ref={composerRef}>
              <ApprovalGate
                sid={sid}
                state={sessionState}
                onRefineRequested={() => composerRef.current?.querySelector("textarea")?.focus()}
              />
              <Composer sid={sid} requireConstraints={requireConstraints} />
            </div>
          </section>

          <section className="flex-1 overflow-auto p-4">
            <ArtifactViewer sid={sid} artifacts={data?.artifacts ?? []} />
          </section>
        </div>
      </main>
    </div>
  );
}

function phaseLabel(state: { kind: string; phase?: string; lastPhase?: string }): string {
  if (state.kind === "idle") return "Waiting for your prompt";
  if (state.kind === "running") return `Running ${state.phase}…`;
  if (state.kind === "awaiting-gate") return `Awaiting approval — ${state.phase}`;
  if (state.kind === "done") return "Done";
  if (state.kind === "error") return `Error in ${state.phase}`;
  return state.kind;
}
```

- [ ] **Step 6: Run, verify pass**

Run: `pnpm vitest run apps/web/test/components/session-page.test.tsx`
Expected: PASS — 3 tests green.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/session-page.tsx apps/web/src/state/use-session.ts apps/web/src/app/providers.tsx apps/web/test/components/session-page.test.tsx
git commit -m "feat(web): <SessionPage> + useSession + Providers — three-pane layout"
```

---

## Task 19: Routes — `/` and `/s/[sid]`

**Files:**
- Modify: `apps/web/src/app/layout.tsx` (wrap children in Providers)
- Modify: `apps/web/src/app/page.tsx` (auto-create + redirect)
- Create: `apps/web/src/app/s/[sid]/page.tsx`

- [ ] **Step 1: Update `layout.tsx` to wrap children in Providers**

```tsx
// apps/web/src/app/layout.tsx
import "./globals.css";
import type { ReactNode } from "react";
import { Providers } from "./providers";

export const metadata = { title: "UltraCreator" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Update `app/page.tsx` to create a session and redirect**

```tsx
// apps/web/src/app/page.tsx
"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSession } from "@/lib/api-client";
import { addLocalSession, listLocalSessions } from "@/lib/session-store";

export default function HomePage() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = listLocalSessions();
      if (existing.length > 0) {
        router.replace(`/s/${existing[0]!.id}`);
        return;
      }
      try {
        const { sessionId } = await createSession();
        if (cancelled) return;
        addLocalSession({ id: sessionId, title: "Untitled" });
        router.replace(`/s/${sessionId}`);
      } catch (err) {
        console.error(err);
      }
    })();
    return () => { cancelled = true; };
  }, [router]);
  return <p className="p-8 text-sm text-muted-foreground">Creating a session…</p>;
}
```

- [ ] **Step 3: Write `s/[sid]/page.tsx`**

```tsx
// apps/web/src/app/s/[sid]/page.tsx
"use client";
import { use } from "react";
import { SessionPage } from "@/components/session-page";

export default function Page({ params }: { params: Promise<{ sid: string }> }): React.ReactElement {
  const { sid } = use(params);
  return <SessionPage sid={sid} />;
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app
git commit -m "feat(web): routes — / auto-creates and redirects, /s/[sid] hosts SessionPage"
```

---

## Task 20: Full suite + typecheck + manual smoke

**Files:** none (verification task)

- [ ] **Step 1: Run the full default suite**

Run: `pnpm test`
Expected: PASS. New / extended counts vs. Plan 5:
- `api-client.test.ts` — 11
- `session-store.test.ts` — 6
- `session-reducer.test.ts` — 11
- `use-session-stream.test.tsx` — 7
- `composer.test.tsx` — 5
- `chat-stream.test.tsx` — 5
- `brief-card.test.tsx` — 5
- `design-board.test.tsx` — 4
- `script-timeline.test.tsx` — 6
- `video-preview.test.tsx` — 3
- `approval-gate.test.tsx` — 4
- `sidebar.test.tsx` — 4
- `session-page.test.tsx` — 3
All Plan 1–5 suites stay green; no test should have been touched outside `apps/web/`.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0 across all workspace packages.

- [ ] **Step 3: External suite — confirm no regression**

Run: `pnpm test:external`
Expected: PASS (Plan 4's `render.external.test.ts`; Plan 6 added no external tests).

- [ ] **Step 4: Production build smoke**

Run: `pnpm -F @ultracreator/web build`
Expected: Next.js build completes — `.next/` produced, no type errors.

- [ ] **Step 5: Manual dev smoke (two terminals)**

> Skip this step if the agent has no way to run two processes — but if it can, run it. It's the only check that the frontend and backend actually communicate.

Terminal A:
```bash
WORKSPACES_DIR=$(mktemp -d) \
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
GEMINI_API_KEY=$GEMINI_API_KEY \
  pnpm dev:server
```

Terminal B:
```bash
cp apps/web/.env.local.example apps/web/.env.local
pnpm dev:web
```

Open http://localhost:3000 — the app should auto-create a session and redirect to `/s/<uuid>`. The composer should accept a prompt; submitting kicks off `phase.started` events in the chat (visible in the chat panel). With dummy API keys the agent calls will fail at the research phase — that's expected; the UI should display a `phase.error` row, not crash.

For a full end-to-end without real API keys, point both at a fake-handler backend: that's exactly what Plan 5 Task 14 (`end-to-end.test.ts`) already proves.

- [ ] **Step 6: Final commit if anything changed**

```bash
git add -A
git commit -m "chore: plan 6 green (Next.js frontend + composer + artifact viewers)" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:**
  - §3 tech stack: Next.js App Router (Tasks 1, 19), shadcn/ui (Task 2), Motion (Task 10's chat-stream + Task 12's design board), react-icons (Task 1 dep — used in brand marks if added later; the v1 set uses lucide for UI glyphs which is shadcn's convention), TanStack React Query (Task 1 dep + Task 18 Providers + Task 17 ArtifactViewer + Task 18 useSession).
  - §4 frontend block: Sidebar (Task 16), Main Panel ChatStream + ArtifactViewer (Tasks 10, 17) including BriefCard / DesignBoard / ScriptTimeline / VideoPreview (Tasks 11–14), Composer with text/files/duration/aspect/voiceover (Task 9). The HTTP+SSE flow targets Plan 5 routes exactly: REST for `/sessions`, `/messages`, `/upload`, `/artifacts/*`, SSE for `/stream/:sid`.
  - §5 frontend component table — every row mapped: `<Composer>` (Task 9), `<ChatStream>` (Task 10), `<ArtifactViewer>` (Task 17), `<DesignBoard>` (Task 12), `<ApprovalGate>` (Task 15), `<Sidebar>` (Task 16), `useSessionStream` (Task 8).
  - §5 "Frontend holds only UI state; all business state changes happen on the backend and are pushed via SSE" — the reducer mutates only the UI-derived shape; mutations (`postMessage`, `createSession`, `uploadFiles`, `deleteSession`) go through `api-client.ts`, the server emits events, the SSE hook folds them in.
  - §7 schemas — Brief, Design, Script, Constraints, ServerEvent, ArtifactDescriptor, ArtifactEnvelope all imported by their canonical names from `@ultracreator/shared`. `UserMessage` is sent through `postMessage`; the server validates with `UserMessageSchema` so the wire shape stays sealed.
  - §8 "Same session in multiple browser tabs" — each tab opens its own `EventSource` and stores its own `lastEventId` in `sessionStorage` (note: `sessionStorage` is per-tab; `localStorage` is shared — chose the per-tab one deliberately so two tabs reconnecting after a server restart both replay everything from disk rather than fighting over a shared cursor).
  - §8 "User refreshes mid-render" — the SSE route's `Last-Event-Id` replay (Plan 5 Task 12) plus `sessionStorage.uc.lastEventId.<sid>` means a refresh continues without missing or duplicating events. The reducer's `seq` guard catches duplicates if the server ever sends one.
  - §9 frontend testing: "components tested against mock SSE event streams (React Testing Library); `useSessionStream` reducer unit-tested as a pure function; Design Board / Script Timeline snapshot-tested with fixed artifacts" — reducer is a pure function with its own test file (Task 6), `useSessionStream` is exercised via the FakeEventSource (Task 8), Design Board and Script Timeline are tested with fixed artifacts (Tasks 12, 13). No snapshots — explicit assertions are more durable.
- **Out of scope here:**
  - Auth, multi-user, project history persistence — spec §10 v2.
  - Drag-to-reorder / search in the sidebar — v1 keeps it dumb.
  - Templates, music, stock — spec §10 v2 (Composer doesn't surface them).
  - Multi-variant fan-out — backend doesn't expose it; UI would surface it as a `<ToggleGroup type='multiple'>` on aspect ratio when that lands.
  - "Render-superseded-but-kept" UX from Plan 4 — needs a backend route to list historical renders; out of scope.
  - Inline edits to artifacts (e.g. tweaking a palette swatch) — design board is currently read-only; spec §6 leaves room for inline editing as a v2 follow-up.
  - i18n — single-locale English only.
  - Accessibility audit — keyboard focus and ARIA labels are wired everywhere (composer's file input, sidebar's delete buttons, approval gate buttons all have explicit `aria-label`s), but no full WCAG sweep.
- **Type-consistency self-check:**
  - `SessionState` mirror in `api-types.ts` matches `apps/server/src/orchestrator/state.ts` byte-for-byte. If Plan 7 ever changes the server-side state union, both must change together; the type would otherwise diverge silently because they aren't a shared dep.
  - `SequencedEvent` matches Plan 5's `SessionEventLog.SequencedEvent` (same field names, same `event: ServerEvent`).
  - `ChatItem.artifactKind` lines up with `ArtifactKind` from `@ultracreator/shared` (no string-typing).
  - The `UserMessage` body posted by `<Composer>` and `<ApprovalGate>` matches `UserMessageSchema` in `packages/shared/src/message.ts` exactly: `{ text, uploadedFiles?, constraints? }`. The server parses with that schema (Plan 5 Task 9) so any drift is caught at the boundary by the 400 error handler.
  - `getArtifact<K>(sid, kind)` returns `TypedArtifactEnvelope<K> | null`; consumers do `q.data.data` and TypeScript narrows the `data` to the matching schema (e.g. `Brief` for `kind === "brief"`). The `as never` cast in `ArtifactViewer.Pane` is a hatch because the switch's `kind` discriminant doesn't propagate through `useQuery` — keeping it scoped to that one file is the cheapest fix; a typed `useArtifact<K>` wrapper would clean it up in a v2.
  - `fileUrl(sid, path)` always returns an absolute URL; `<VideoPreview>` strips a leading `/`; `<ArtifactViewer>` strips up to `output/` because the backend `Mp4Data.path` is currently absolute.
- **Determinism:** every Plan 6 test runs against jsdom + mocked `fetch` + `FakeEventSource`. No real backend, no real EventSource, no network. The `session-page.test.tsx` is the only one that exercises a chain of mocked calls — its URL-matching predicates are exact-suffix to avoid false hits.
- **Where to push if something surprises you:**
  - If shadcn primitives behave differently in your install (e.g. `<Switch>` doesn't expose `role="switch"`), inspect the rendered HTML and update the test selector; do not reach for `data-testid` unless the semantic role really is unavailable.
  - If `tailwind-merge` doesn't tree-shake under the Next.js production build, swap to `clsx`-only and accept duplicate classnames; the cn() output is stable either way.
  - If `motion/react` import fails (the package re-exported `motion` from `framer-motion` in v11), use `framer-motion` directly — the API is identical and Plan 1's lockfile may have picked the older alias.
  - If `EventSource` is missing in the dev browser (very old browsers / strict CSP), the `Sidebar` still works for navigation and `Composer` still POSTs; only the chat stream goes silent. A polyfill is a v2 concern.
  - If `tailwindcss@4.0.0-beta.7` ships breaking changes by the time you run this, downgrade to v3.4.x with a standard `tailwind.config.ts` — the rest of the plan does not depend on v4 features.
  - If the production build fails because the `transpilePackages: ["@ultracreator/shared"]` config in `next.config.mjs` isn't enough (e.g. Next.js refuses to read raw TypeScript across the workspace), the smallest fix is `"exports": { ".": { "import": "./src/index.ts", "types": "./src/index.ts" } }` in `packages/shared/package.json` — which it already has — *plus* setting `tsconfig.json`'s `paths` for `@ultracreator/shared` in the web app. Don't add a build step to `@ultracreator/shared`; that's a Plan-1 invariant we're keeping.
