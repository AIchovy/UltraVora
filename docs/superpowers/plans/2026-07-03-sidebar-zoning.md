# Sidebar Zoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Visually separate the sidebar's three zones (New task / Product Plaza / Tasks) with gradient hairline dividers, a wider spacing rhythm, and a task-count badge — per the approved spec `docs/superpowers/specs/2026-07-03-sidebar-zoning-design.md`.

**Architecture:** Pure presentational change inside two components: `apps/web/src/components/app-sidebar.tsx` gains a local `SidebarDivider` (1px gradient hairline, `role="separator"`) placed at both zone boundaries plus a count badge in the Tasks header; `apps/web/src/components/sidebar-user.tsx` swaps its `border-t` for the same hairline. No routing, data, or `ui/sidebar.tsx` changes.

**Tech Stack:** Next.js App Router client components, Tailwind v4 utilities, vitest + testing-library (jsdom), pnpm workspace.

**Conventions:** All commands run from the repo root (the worktree root). Tests run via the root workspace runner: `pnpm vitest run --workspace ./vitest.suites.ts <file-filter>`.

---

### Task 1: Worktree setup + baseline

**Files:** none (environment only)

- [ ] **Step 1: Install deps if missing**

Fresh worktrees have no `node_modules` (see memory `web-preview-from-worktree`):

```bash
[ -d node_modules ] || pnpm install --frozen-lockfile
```

- [ ] **Step 2: Baseline test run**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/app-sidebar.test.tsx apps/web/test/components/sidebar-user.test.tsx
```

Expected: all existing tests PASS (8 in app-sidebar, 5 in sidebar-user). If baseline fails, stop and report — do not build on a broken base.

---

### Task 2: Zone dividers + spacing rhythm

**Files:**
- Modify: `apps/web/src/components/app-sidebar.tsx` (component `AppSidebar`, zones at lines ~72–110)
- Test: `apps/web/test/components/app-sidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

Append inside `describe("<AppSidebar>", ...)`:

```tsx
  it("separates the zones with two hairline dividers", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    await screen.findByText(/no tasks yet/i);
    // One divider between New task and Plaza, one between Plaza and Tasks.
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });
```

Note: `SidebarUser` renders `null` in these tests (session mocked to `null`), so the footer divider added in Task 4 won't inflate this count.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/app-sidebar.test.tsx
```

Expected: FAIL — `Unable to find an accessible element with the role "separator"`.

- [ ] **Step 3: Implement dividers + rhythm**

In `apps/web/src/components/app-sidebar.tsx`, add below the `taskIcon` helper:

```tsx
// Zone boundary — a hairline that fades at both ends, per the theme's
// "depth over strokes" rule (no hard full-width borders).
function SidebarDivider({ className }: { className?: string }): React.ReactElement {
  return (
    <div
      role="separator"
      className={cn(
        "mx-4 h-px shrink-0 bg-gradient-to-r from-transparent via-border to-transparent",
        className,
      )}
    />
  );
}
```

Then rework the zone JSX (currently the `{/* New task */}` div, `{/* Product Plaza */}` nav with `mt-2`, and `{/* Tasks */}` div with `mt-5`):

```tsx
      {/* New task — entry point is Home */}
      <div className="px-3">
        <Button
          onClick={() => {
            router.push("/");
            closeIfMobile();
          }}
          className={cn("rounded-xl shadow-xs", open ? "w-full justify-center" : "mx-auto h-9 w-9 p-0")}
          aria-label="New task"
        >
          <Plus className="h-4 w-4" />
          {open && "New task"}
        </Button>
      </div>

      <SidebarDivider className="mt-4 mb-2" />

      {/* Product Plaza — public gallery of everyone's public videos */}
      <nav className="px-2">
        ... (Link unchanged) ...
      </nav>

      <SidebarDivider className="mt-4 mb-3" />

      {/* Tasks */}
      <div className="flex min-h-0 flex-1 flex-col">
```

Only the spacing wrappers change: `nav` loses `mt-2`, the Tasks `div` loses `mt-5`; everything inside them stays byte-identical.

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/app-sidebar.test.tsx
```

Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app-sidebar.tsx apps/web/test/components/app-sidebar.test.tsx
git commit -m "feat(web): separate sidebar zones with fading hairline dividers"
```

---

### Task 3: Task-count badge in the Tasks header

**Files:**
- Modify: `apps/web/src/components/app-sidebar.tsx` (Tasks header, the `{open && (<div className="px-4 pb-1.5 ...">Tasks</div>)}` block)
- Test: `apps/web/test/components/app-sidebar.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append inside the describe block:

```tsx
  it("shows a task-count badge next to the Tasks label", async () => {
    mockFetch(async (url) => {
      if (String(url).endsWith("/api/sessions"))
        return new Response(JSON.stringify([summary("a", "Alpha"), summary("b", "Beta")]), { status: 200 });
      return new Response("", { status: 404 });
    });
    renderSidebar();
    await screen.findByText("Alpha");
    expect(screen.getByTestId("task-count")).toHaveTextContent("2");
  });

  it("hides the task-count badge when there are no tasks", async () => {
    mockFetch(async () => new Response(JSON.stringify([]), { status: 200 }));
    renderSidebar();
    await screen.findByText(/no tasks yet/i);
    expect(screen.queryByTestId("task-count")).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify the first fails**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/app-sidebar.test.tsx
```

Expected: FAIL — `Unable to find an element by: [data-testid="task-count"]` (the empty-state test passes trivially).

- [ ] **Step 3: Implement the badge**

Replace the Tasks header block:

```tsx
        {open && (
          <div className="flex items-center gap-2 px-4 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Tasks
            {sessions.length > 0 && (
              <span
                data-testid="task-count"
                className="rounded-full bg-foreground/[0.06] px-1.5 py-px font-mono text-[11px] font-medium normal-case tabular-nums"
              >
                {sessions.length}
              </span>
            )}
          </div>
        )}
```

(`font-mono` per the theme's "mono for numbers" rule; `normal-case` opts the digits out of the parent's `uppercase` tracking context.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/app-sidebar.test.tsx
```

Expected: 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app-sidebar.tsx apps/web/test/components/app-sidebar.test.tsx
git commit -m "feat(web): task-count badge on the sidebar Tasks header"
```

---

### Task 4: Footer divider unification

**Files:**
- Modify: `apps/web/src/components/sidebar-user.tsx` (wrapper div, line ~42)
- Test: `apps/web/test/components/sidebar-user.test.tsx`

- [ ] **Step 1: Write the failing test**

Append inside `describe("SidebarUser", ...)`:

```tsx
  it("draws the shared hairline divider above the account row", () => {
    renderUser();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });
```

(The closed dropdown renders no menu separators, so exactly one match. The existing "renders nothing while logged out" test already guards the null case.)

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/sidebar-user.test.tsx
```

Expected: FAIL — no element with role "separator".

- [ ] **Step 3: Implement the swap**

In `sidebar-user.tsx`, replace the wrapper `<div className="border-t border-border/60 px-2 py-2">` with:

```tsx
    <div className="px-2 pb-2">
      <div
        role="separator"
        className="mx-2 mb-2 h-px shrink-0 bg-gradient-to-r from-transparent via-border to-transparent"
      />
```

(`mx-2` inside the `px-2` wrapper lines the fade up with the `mx-4` dividers above. Duplicating the 3-line hairline here is deliberate — the spec says don't extract a shared module for one reuse.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/sidebar-user.test.tsx
```

Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/sidebar-user.tsx apps/web/test/components/sidebar-user.test.tsx
git commit -m "feat(web): unify sidebar footer divider with the zone hairlines"
```

---

### Task 5: Full verification (suite, typecheck, visual)

**Files:** none

- [ ] **Step 1: Full test suite + typecheck**

```bash
pnpm test && pnpm typecheck
```

Expected: all workspaces PASS, tsc clean.

- [ ] **Step 2: Visual check in the preview (logged-in)**

The sidebar only renders for a signed-in user. Follow memories
`web-preview-from-worktree` and `preview-logged-in-session`:

1. `preview_start` with autoPort and a portless dev command (`next dev`, NOT the package's `dev` script which pins `--port 3000`).
2. Sign up via curl with a spoofed `Origin: http://localhost:3000` (better-auth rejects the autoPort origin; nickname must be 3–20 alnum/underscore), flip `email_verified` in Postgres, then inject the session cookie via `preview_eval` `document.cookie`.
3. Load `/`, `preview_resize` to a desktop size (headless viewport starts 0-width).

Verify with `preview_screenshot`:
- Expanded rail: two fading dividers, air around each zone, TASKS label with count badge when tasks exist, footer hairline (no hard border).
- Collapsed rail (click the panel toggle): short centered hairlines keep the zone structure.
- Empty state: no badge, "No tasks yet." intact.

- [ ] **Step 3: Tune spacing only if the screenshot shows a problem**

Spec allows ±4px adjustments to divider margins. If adjusted, re-run
`pnpm vitest run --workspace ./vitest.suites.ts apps/web/test/components/app-sidebar.test.tsx` and amend the relevant commit.

- [ ] **Step 4: Finish the branch**

Per memory `merge-workflow`: work is committed on the `claude/*` branch; check `git log HEAD..main` for mid-session main advances, then ff-merge to local main (rebase first if main moved). Push only on request.
