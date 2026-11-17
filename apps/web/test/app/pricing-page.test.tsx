// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PricingPage from "@/app/pricing/page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

describe("/pricing page", () => {
  it("renders the shared header, the pricing tiers, and the footer", () => {
    const { container } = render(<PricingPage />);
    // Same header/footer as the homepage.
    expect(screen.getByRole("navigation", { name: /landing sections/i })).toBeInTheDocument();
    expect(within(screen.getByRole("contentinfo")).getByText(/© \d{4} UltraVora/)).toBeInTheDocument();
    // The pricing panel with all four tiers.
    expect(container.querySelector("#pricing")).not.toBeNull();
    for (const tier of ["Free", "Pro", "Max", "Ultra"]) {
      expect(screen.getByText(tier)).toBeInTheDocument();
    }
    expect(screen.getByText("$20")).toBeInTheDocument();
  });

  it("shares the landing header with its public Pricing nav entry", () => {
    render(<PricingPage />);
    // Billing is live: pricing must be publicly discoverable (Creem MoR).
    const nav = screen.getByRole("navigation", { name: /landing sections/i });
    expect(within(nav).getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/#pricing");
  });
});
