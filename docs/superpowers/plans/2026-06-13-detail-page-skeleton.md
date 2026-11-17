# Detail Page Loading Skeletons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three placeholder/empty-state flashes on the session detail page (`/s/[sid]`) with pulsing skeleton placeholders while data is in flight, behind one shared `<Skeleton>` primitive.

**Architecture:** Per-zone, in-component skeletons. Each of the three zones (title bar, conversation, preview) keys off its own loading signal so the shell stays stable and content fades in per-zone. Title and preview key off the React Query `session.isLoading`; the conversation keys off a small pure predicate (`isChatLoading`) that accounts for SSE connection state, since the stream has no "replay-complete" sentinel. Genuine empty states render only after loading completes.

**Tech Stack:** Next.js 15 / React 19, Tailwind v4 (`animate-pulse`, `bg-muted`), `@tanstack/react-query`, vitest + React Testing Library (jsdom).

**Spec:** [docs/superpowers/specs/2026-06-13-detail-page-skeleton-design.md](../specs/2026-06-13-detail-page-skeleton-design.md)

---

## File Structure

**New files:**
- `apps/web/src/lib/detail-loading.ts` — pure `isChatLoading` predicate (the one non-trivial loading decision).
- `apps/web/src/components/ui/skeleton.tsx` — shared `<Skeleton>` primitive (shadcn-style, `data-slot="skeleton"`).
- `apps/web/test/lib/detail-loading.test.ts` — truth-table unit tests for the predicate (node env).
- `apps/web/test/components/skeleton.test.tsx` — primitive unit tests (jsdom).

**Modified files:**
- `apps/web/src/components/chat-stream.tsx` — add `loading` prop + `ChatStreamSkeleton`.
- `apps/web/src/components/preview-panel.tsx` — add `loading` prop + `PreviewSkeleton`; refactor existing `PaneSkeleton` onto `<Skeleton>`.
- `apps/web/src/components/session-page.tsx` — compute the loading flags, pass them down, add the title-bar skeleton in `ChatHeader`.
- `apps/web/test/components/chat-stream.test.tsx` — add loading-state cases.
- `apps/web/test/components/preview-panel.test.tsx` — add loading-state case.
- `apps/web/test/components/session-page.test.tsx` — add wiring + fall-through tests.

**Test commands** (run from repo root):
- Focused: `pnpm test <filename-substring>` (e.g. `pnpm test detail-loading`) — vitest filters test files by path substring.
- Full suite: `pnpm test`
- Types: `pnpm typecheck`

---

### Task 1: `isChatLoading` predicate

The conversation is the only zone whose loading decision is non-trivial (SSE has no replay-complete signal). Extract it as a pure, exhaustively-testable function.

**Files:**
- Create: `apps/web/src/lib/detail-loading.ts`
- Test: `apps/web/test/lib/detail-loading.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/lib/detail-loading.test.ts`:

```ts
// apps/web/test/lib/detail-loading.test.ts
import { describe, it, expect } from "vitest";
import { isChatLoading } from "@/lib/detail-loading";

describe("isChatLoading", () => {
  it("is false the moment any message exists, regardless of other state", () => {
    expect(
      isChatLoading({ chatEmpty: false, sessionLoading: true, streaming: false, streamErrored: false }),
    ).toBe(false);
  });

  it("is true while the session metadata query is still loading", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: true, streaming: false, streamErrored: false }),
    ).toBe(true);
  });

  it("is true while the stream is still connecting (not open, no error)", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: false, streaming: false, streamErrored: false }),
    ).toBe(true);
  });

  it("is false once the stream is open with an empty log (genuinely empty)", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: false, streaming: true, streamErrored: false }),
    ).toBe(false);
  });

  it("is false when the stream errored before opening (falls through, never stuck)", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: false, streaming: false, streamErrored: true }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test detail-loading`
Expected: FAIL — `Failed to resolve import "@/lib/detail-loading"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/lib/detail-loading.ts`:

```ts
export interface ChatLoadingInput {
  /** The conversation timeline has zero messages. */
  chatEmpty: boolean;
  /** React Query is still fetching the session metadata. */
  sessionLoading: boolean;
  /** The SSE stream connection is open. */
  streaming: boolean;
  /** The SSE stream has errored. */
  streamErrored: boolean;
}

/**
 * The conversation zone shows a skeleton only while it has no messages AND we're
 * still waiting on data: either the session metadata query is in flight, or the
 * SSE stream hasn't connected yet (and hasn't errored). The server emits no
 * "replay complete" sentinel, so once the stream opens — or errors out — with an
 * empty log we stop the skeleton and fall through to the real conversation or
 * the genuine empty state, never stuck on the skeleton.
 */
export function isChatLoading(input: ChatLoadingInput): boolean {
  if (!input.chatEmpty) return false;
  const connecting = !input.streaming && !input.streamErrored;
  return input.sessionLoading || connecting;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test detail-loading`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/detail-loading.ts apps/web/test/lib/detail-loading.test.ts
git commit -m "feat(web): add isChatLoading predicate for detail-page conversation skeleton"
```

---

### Task 2: `<Skeleton>` primitive

**Files:**
- Create: `apps/web/src/components/ui/skeleton.tsx`
- Test: `apps/web/test/components/skeleton.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/components/skeleton.test.tsx`:

```tsx
// @vitest-environment jsdom
// apps/web/test/components/skeleton.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton } from "@/components/ui/skeleton";

describe("<Skeleton>", () => {
  it("renders a pulsing muted block tagged data-slot=skeleton", () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).not.toBeNull();
    expect(el).toHaveClass("animate-pulse", "bg-muted", "rounded-md");
  });

  it("merges a custom className over the defaults", () => {
    const { container } = render(<Skeleton className="h-4 w-40" />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).toHaveClass("h-4", "w-40", "animate-pulse");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test skeleton`
Expected: FAIL — `Failed to resolve import "@/components/ui/skeleton"`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/web/src/components/ui/skeleton.tsx`:

```tsx
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}

export { Skeleton };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test skeleton`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/skeleton.tsx apps/web/test/components/skeleton.test.tsx
git commit -m "feat(web): add shared Skeleton ui primitive"
```

---

### Task 3: Conversation skeleton (`ChatStream`)

Add a `loading` prop to `ChatStream`. When loading, render ghost bubbles instead of the genuine "Waiting for the agent" empty state.

**Files:**
- Modify: `apps/web/src/components/chat-stream.tsx`
- Test: `apps/web/test/components/chat-stream.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append these two `it` blocks inside the existing `describe("<ChatStream>", ...)` in `apps/web/test/components/chat-stream.test.tsx`:

```tsx
  it("shows skeleton placeholders while loading (not the empty-state hint)", () => {
    const { container } = render(<ChatStream items={[]} loading />);
    expect(screen.getByRole("status", { name: /loading conversation/i })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/waiting|nothing yet/i)).toBeNull();
  });

  it("shows the empty-state hint when not loading and empty", () => {
    render(<ChatStream items={[]} loading={false} />);
    expect(screen.getByText(/waiting|nothing yet/i)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test chat-stream`
Expected: FAIL — the loading test errors because `loading` is not a prop yet and no `status` role exists (the empty-state hint renders instead).

- [ ] **Step 3: Implement the `loading` prop + skeleton**

In `apps/web/src/components/chat-stream.tsx`:

1. Add the import near the other component imports (after the `MatrixLoader` import on line 33):

```tsx
import { Skeleton } from "@/components/ui/skeleton";
```

2. Replace the `Props` interface (currently lines 35-37):

```tsx
interface Props {
  items: ChatItem[];
  loading?: boolean;
}
```

3. Change the function signature (currently line 69 `export function ChatStream({ items }: Props)...`) to destructure `loading` and short-circuit to the skeleton **after** the existing hooks but **before** the `blocks.length === 0` check. The function head becomes:

```tsx
export function ChatStream({ items, loading = false }: Props): React.ReactElement {
  const reduce = useReducedMotion();
  const blocks = groupConversation(items);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "end" });
  }, [items.length, reduce]);

  if (loading) {
    return <ChatStreamSkeleton />;
  }

  if (blocks.length === 0) {
```

(Leave the rest of the function body unchanged.)

4. Add the `ChatStreamSkeleton` component. Place it right after the `ChatStream` function (before the `GroupedEntry` type on line 118):

```tsx
function ChatStreamSkeleton(): React.ReactElement {
  return (
    <div className="flex h-full flex-col gap-4 p-4" role="status" aria-label="Loading conversation">
      <Skeleton className="ml-auto h-10 w-3/5 rounded-2xl rounded-br-sm" />
      {[0, 1].map((i) => (
        <div key={i} className="flex gap-2.5">
          <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-[90%]" />
            <Skeleton className="h-3 w-[65%]" />
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test chat-stream`
Expected: PASS (all existing tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat-stream.tsx apps/web/test/components/chat-stream.test.tsx
git commit -m "feat(web): conversation loading skeleton in ChatStream"
```

---

### Task 4: Preview skeleton (`PreviewPanel`) + refactor `PaneSkeleton`

Add a `loading` prop. When there are no tabs and we are loading, render a skeleton instead of the "Nothing to preview yet" empty state. Refactor the existing inline `PaneSkeleton` onto the new primitive.

**Files:**
- Modify: `apps/web/src/components/preview-panel.tsx`
- Test: `apps/web/test/components/preview-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

Append this `it` block inside the existing `describe("<PreviewPanel>", ...)` in `apps/web/test/components/preview-panel.test.tsx`:

```tsx
  it("shows a skeleton (not the empty state) while loading with no artifacts", () => {
    const { container } = renderWithQuery(<PreviewPanel sid="s1" artifacts={[]} loading />);
    expect(screen.getByRole("status", { name: /loading preview/i })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/nothing to preview yet/i)).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test preview-panel`
Expected: FAIL — `loading` is not a prop yet, so the empty state renders and no `status` role exists.

- [ ] **Step 3: Implement the `loading` prop, `PreviewSkeleton`, and `PaneSkeleton` refactor**

In `apps/web/src/components/preview-panel.tsx`:

1. Add the import after the existing component imports (after the `BrandAssets` import on line 14):

```tsx
import { Skeleton } from "@/components/ui/skeleton";
```

2. Replace the `Props` interface (currently lines 26-29):

```tsx
interface Props {
  sid: string;
  artifacts: ArtifactDescriptor[];
  loading?: boolean;
}
```

3. Change the function signature (currently line 31 `export function PreviewPanel({ sid, artifacts }: Props)...`) to:

```tsx
export function PreviewPanel({ sid, artifacts, loading = false }: Props): React.ReactElement {
```

4. Replace the empty-state early-return block (currently lines 56-70, the `if (tabs.length === 0) { return ( ...Sparkles... ); }`) with a version that shows the skeleton while loading:

```tsx
  if (tabs.length === 0) {
    if (loading) return <PreviewSkeleton />;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Sparkles className="h-5 w-5" />
        </span>
        <div>
          <p className="text-sm font-medium">Nothing to preview yet</p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            Describe your video on the left. The brief, design, script, and final cut appear here as the agent works.
          </p>
        </div>
      </div>
    );
  }
```

5. Replace the existing `PaneSkeleton` function (currently lines 161-173) with a version built on `<Skeleton>`, and add `PreviewSkeleton` directly above it:

```tsx
function PreviewSkeleton(): React.ReactElement {
  return (
    <div className="flex h-full flex-col" role="status" aria-label="Loading preview">
      <div className="px-5 pt-4">
        <Skeleton className="h-9 w-64 rounded-full" />
      </div>
      <div className="flex-1 px-5 pb-5 pt-4">
        <div className="mx-auto max-w-3xl">
          <PaneSkeleton />
        </div>
      </div>
    </div>
  );
}

function PaneSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-4 w-64" />
      <div className="grid grid-cols-2 gap-3 pt-2 sm:grid-cols-3">
        <Skeleton className="aspect-video rounded-lg" />
        <Skeleton className="aspect-video rounded-lg" />
        <Skeleton className="aspect-video rounded-lg" />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test preview-panel`
Expected: PASS (all existing tests + the new one). The existing "shows an empty state when there are no artifacts" test still passes because `loading` defaults to `false`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/preview-panel.tsx apps/web/test/components/preview-panel.test.tsx
git commit -m "feat(web): preview loading skeleton + PaneSkeleton on shared primitive"
```

---

### Task 5: Wire it up in `SessionPage` + title-bar skeleton

Compute the three loading flags in `SessionPage` and pass them to the three zones; add the title-bar skeleton to `ChatHeader`.

**Files:**
- Modify: `apps/web/src/components/session-page.tsx`
- Test: `apps/web/test/components/session-page.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append these two `it` blocks inside the existing `describe("<SessionPage> integration", ...)` in `apps/web/test/components/session-page.test.tsx`:

```tsx
  it("shows loading skeletons before data arrives, then real content", async () => {
    const descriptor: ArtifactDescriptor = {
      kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false,
    };
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [descriptor], title: "My promo" }), { status: 200 });
      }
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: brief }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const { container } = renderWithQuery(<SessionPage sid="sid1" />);

    // Initial synchronous render: metadata query pending, stream not yet open.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/nothing to preview yet/i)).toBeNull();

    // Once metadata + artifact resolve, the title shows and skeletons clear.
    await waitFor(() => expect(screen.getByText("My promo")).toBeInTheDocument());
    await waitFor(() => expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0));
  });

  it("drops the conversation skeleton once connected with an empty log", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [], title: "Empty" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    // After metadata loads and the (fake) stream opens, the conversation shows
    // its genuine empty state rather than staying on the skeleton.
    await waitFor(() => expect(screen.getByText(/waiting for the agent/i)).toBeInTheDocument());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test session-page`
Expected: FAIL — no `[data-slot="skeleton"]` elements exist on first render yet (the page currently renders "Untitled" + empty states immediately), so the synchronous skeleton-count assertion fails.

- [ ] **Step 3: Implement the wiring + title skeleton**

In `apps/web/src/components/session-page.tsx`:

1. Add imports after the existing imports (after the `PreviewPanel` import on line 10):

```tsx
import { isChatLoading } from "@/lib/detail-loading";
import { Skeleton } from "@/components/ui/skeleton";
```

2. Inside `SessionPage`, after the existing `const sessionState = stream.uiState.status;` line (line 30), add:

```tsx
  const loading = session.isLoading;
  const chatLoading = isChatLoading({
    chatEmpty: stream.uiState.chat.length === 0,
    sessionLoading: session.isLoading,
    streaming: stream.isStreaming,
    streamErrored: stream.lastError !== null,
  });
```

3. Pass the flags into the three zones. Update the `ChatHeader` usage (line 46):

```tsx
        <ChatHeader title={session.data?.title ?? null} state={sessionState} loading={loading} />
```

Update the `ChatStream` usage (line 48):

```tsx
          <ChatStream items={stream.uiState.chat} loading={chatLoading} />
```

Update the `PreviewPanel` usage (line 71):

```tsx
        <PreviewPanel sid={sid} artifacts={data?.artifacts ?? []} loading={loading} />
```

4. Replace the `ChatHeader` component (currently lines 77-84) to render the title skeleton while loading:

```tsx
function ChatHeader({
  title,
  state,
  loading,
}: {
  title: string | null;
  state: { kind: string; phase?: string };
  loading: boolean;
}): React.ReactElement {
  return (
    <header className="flex items-center gap-2 px-4 py-3">
      {loading ? (
        <Skeleton className="h-4 w-40" />
      ) : (
        <>
          <span className="truncate text-sm font-medium" title={title ?? "Untitled"}>{title ?? "Untitled"}</span>
          <StatusPill state={state} />
        </>
      )}
    </header>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test session-page`
Expected: PASS (all existing tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/session-page.tsx apps/web/test/components/session-page.test.tsx
git commit -m "feat(web): wire detail-page loading skeletons into SessionPage"
```

---

### Task 6: Full verification

- [ ] **Step 1: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Run the full unit suite**

Run: `pnpm test`
Expected: PASS, no regressions across all projects.

- [ ] **Step 3: Visually verify in the browser**

Start the web dev server (`pnpm dev:web`, port 3000) and, using the preview tooling, throttle the network (or rely on prod-like latency), then:
- Click a task in the sidebar → confirm the detail page shows: a title-bar skeleton, ghost conversation bubbles, and a preview tab/card skeleton — and that no "Untitled" / "Waiting for the agent" / "Nothing to preview yet" text flashes during load.
- Confirm content fades in per-zone as it resolves, and an empty/new session still shows the genuine "Waiting for the agent" / "Nothing to preview yet" states once loaded.
- Toggle OS "reduce motion" → confirm the pulse stops (no animation) but the layout is intact.

Capture a screenshot of the loading state as proof.

- [ ] **Step 4: Final commit (if any verification fixes were needed)**

```bash
git add -A
git commit -m "chore(web): detail-page skeleton verification fixes"
```

(Skip if Steps 1-3 produced no changes.)

---

## Notes for the implementer

- `animate-pulse` is pure CSS; the global `prefers-reduced-motion` block in `apps/web/src/app/globals.css` already collapses it — no extra a11y wiring needed.
- The `data-slot="skeleton"` attribute is the test hook for "how many skeletons are showing"; keep it on the primitive.
- Hook order: in both `ChatStream` and `PreviewPanel` the new `if (loading) return ...` / `if (tabs.length === 0)` early returns stay **after** all `use*` calls — do not move hooks below them.
- `session.isLoading` (React Query v5) is true only on the first load with no cached data, so background refetches will not re-show the skeletons. This is intended.
