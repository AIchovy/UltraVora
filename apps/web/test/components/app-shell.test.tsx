// @vitest-environment jsdom
// apps/web/test/components/app-shell.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppShell } from "@/components/app-shell";

vi.mock("@/components/app-sidebar", () => ({ AppSidebar: () => <div data-testid="sidebar" /> }));
vi.mock("@/components/credits-badge", () => ({ CreditsBadge: () => <div data-testid="credits-badge" /> }));

describe("<AppShell>", () => {
  it("default: renders the credits badge inside the header bar", () => {
    render(<AppShell>content</AppShell>);
    const badge = screen.getByTestId("credits-badge");
    expect(badge.closest("header")).not.toBeNull();
    expect(document.querySelector('[data-slot="credits-overlay"]')).toBeNull();
  });

  it("floating: hides the desktop bar and floats the badge over the content", () => {
    render(<AppShell creditsPlacement="floating">content</AppShell>);
    // The bar survives only for mobile (sidebar trigger) — hidden from md up.
    const header = document.querySelector("header");
    expect(header?.className).toContain("md:hidden");
    // The floating badge is desktop-only, absolutely positioned over the content.
    const overlay = document.querySelector('[data-slot="credits-overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay!.className).toContain("absolute");
    expect(overlay!.querySelector('[data-testid="credits-badge"]')).not.toBeNull();
  });
});
