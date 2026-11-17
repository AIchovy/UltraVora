import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// The theme is hand-authored (no shadcn generator), so the @theme block and the
// base layer are the *contract* the shadcn UI primitives silently depend on.
// Two gaps here surface as the "weird black border" on the sidebar account menu:
//   1. DropdownMenuContent / Command use `bg-popover` + `text-popover-foreground`,
//      which compile to nothing unless --color-popover{,-foreground} are registered.
//   2. They also use the bare `border` utility. Tailwind v4 no longer defaults the
//      border color to gray-200 — bare `border` resolves to `currentColor` (the
//      inherited near-black text color) unless a base layer pins it to the token.
const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

describe("globals.css theme contract", () => {
  it("registers popover surface tokens used by DropdownMenu/Command", () => {
    expect(css).toMatch(/--color-popover:\s*\S/);
    expect(css).toMatch(/--color-popover-foreground:\s*\S/);
  });

  it("pins a default border-color so bare `border` is not currentColor", () => {
    // @layer base { *, ... { border-color: var(--color-border) } }
    expect(css).toMatch(
      /@layer\s+base\s*\{[\s\S]*?\*[\s\S]*?border-color:\s*var\(--color-border\)/,
    );
  });
});
