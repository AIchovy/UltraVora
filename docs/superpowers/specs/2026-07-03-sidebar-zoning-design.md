# Sidebar zoning — breathing-room separation (方案 A)

**Date:** 2026-07-03
**Status:** Approved
**Scope:** `apps/web` only — `app-sidebar.tsx`, `sidebar-user.tsx`, and their tests.

## Problem

The sidebar stacks three zones — the "New task" button, the Product Plaza link,
and the Tasks list — on one flat rail with only small margins (`mt-2` / `mt-5`)
between them. Nothing marks where one zone ends and the next begins, so the
rail reads as a single squeezed column. The user asked for clearly separated
zones with more design intent.

## Direction (chosen from three mockups)

"呼吸感分区" — restrained zoning through rhythm, not new surfaces:

- soft gradient hairline dividers between zones,
- a wider spacing rhythm,
- a task-count badge on the Tasks section label.

Rejected alternatives: **B** floating white card grouping New task + Plaza
(competes with the white active-item pill), **C** recessed inset tray for the
task list (boldest, visually heavy). Both prototyped as mockups; user picked A.

## Design

### 1. `SidebarDivider` — gradient hairline

A tiny presentational component local to `app-sidebar.tsx` (not exported from
`ui/`; nothing else needs it yet):

```tsx
function SidebarDivider(): React.ReactElement {
  return (
    <div
      role="separator"
      className="mx-4 h-px shrink-0 bg-gradient-to-r from-transparent via-border to-transparent"
    />
  );
}
```

- 1px tall, fades out at both ends — consistent with the theme's
  "depth over strokes" rule (no hard full-width 1px borders).
- Placed twice: between New task and Product Plaza, and between Product Plaza
  and the Tasks section.
- Visible in the collapsed `md:w-16` rail too (`mx-4` on a 64px rail leaves a
  short centered hairline), so the icon rail keeps the same zone structure.

### 2. Spacing rhythm

Replace the cramped `mt-2` / `mt-5` chain with room around each divider:

- New task button zone: unchanged (`px-3`).
- Divider 1 wrapped with `mt-4 mb-2` (16px above, 8px below).
- Plaza nav: drops its own `mt-2`.
- Divider 2 wrapped with `mt-4 mb-3`.
- Tasks zone: drops its own `mt-5`; header keeps `px-4 pb-1.5`.

Exact pixel values may be tuned ±4px during visual verification; the invariant
is: every zone boundary = divider + visibly more air than intra-zone gaps.

### 3. Tasks label with count badge

The "Tasks" micro-label gains a count badge when there are sessions:

```tsx
<div className="flex items-center gap-2 px-4 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
  Tasks
  {sessions.length > 0 && (
    <span className="rounded-full bg-foreground/[0.06] px-1.5 py-px font-mono text-[11px] font-medium normal-case tabular-nums">
      {sessions.length}
    </span>
  )}
</div>
```

- Mono/tabular per the theme's "mono for numbers" rule.
- Hidden when the list is empty (the "No tasks yet." hint carries that state)
  and when the rail is collapsed (whole header row is already `open`-gated).

### 4. Footer divider unification

`sidebar-user.tsx` swaps `border-t border-border/60` on its wrapper for the
same gradient hairline rendered above the wrapper, so the sidebar uses one
divider language top to bottom. The wrapper keeps its padding. (Duplicating
the 3-line divider markup in `sidebar-user.tsx` is acceptable; do not create a
shared module for one reuse.)

## What this deliberately does NOT do

- No new surfaces, cards, or background colors — existing tokens only
  (`border`, `foreground/…` alphas).
- No changes to routing, session fetching, delete, or collapse behavior.
- No changes to `ui/sidebar.tsx` primitives.

## Testing (TDD)

New assertions in `test/components/app-sidebar.test.tsx`:

1. Renders at least two `role="separator"` zone dividers.
2. With 2 sessions, the Tasks header shows a "2" count badge.
3. With 0 sessions, no count badge renders (only "No tasks yet.").

`sidebar-user.test.tsx` untouched unless the border swap breaks a selector.
All existing tests must stay green — they assert behavior, not styling.

## Verification

Visual check in the browser preview: expanded rail, collapsed rail (w-16),
empty vs populated task list.
