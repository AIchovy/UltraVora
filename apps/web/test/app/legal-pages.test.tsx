// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import PrivacyPage, { metadata as privacyMetadata } from "@/app/privacy/page";
import TermsPage, { metadata as termsMetadata } from "@/app/terms/page";
import { LandingFooter } from "@/components/marketing/landing-footer";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

describe("/privacy page", () => {
  it("exports title + canonical metadata", () => {
    expect(privacyMetadata.title).toBe("Privacy Policy — UltraVora");
    expect(privacyMetadata.alternates?.canonical).toBe("/privacy");
  });

  it("renders the policy inside the shared marketing chrome", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: /privacy policy/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /landing sections/i })).toBeInTheDocument();
    expect(within(screen.getByRole("contentinfo")).getByText(/© \d{4} UltraVora/)).toBeInTheDocument();
    // Effective date + the support contact must be present.
    expect(screen.getByText("Effective July 9, 2026")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /support@ultra-vora\.com/i }).length).toBeGreaterThan(0);
    // The Plaza public-visibility disclosure is the sharpest user-facing fact.
    expect(screen.getByRole("heading", { name: /product plaza and public content/i })).toBeInTheDocument();
  });
});

describe("/terms page", () => {
  it("exports title + canonical metadata", () => {
    expect(termsMetadata.title).toBe("Terms of Service — UltraVora");
    expect(termsMetadata.alternates?.canonical).toBe("/terms");
  });

  it("renders the terms inside the shared marketing chrome", () => {
    render(<TermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: /terms of service/i })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /landing sections/i })).toBeInTheDocument();
    expect(within(screen.getByRole("contentinfo")).getByText(/© \d{4} UltraVora/)).toBeInTheDocument();
    expect(screen.getByText("Effective July 22, 2026")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /support@ultra-vora\.com/i }).length).toBeGreaterThan(0);
    // Creem MoR compliance: the acceptable-use policy must explicitly prohibit
    // NSFW/sexual content generation and note automated prompt moderation.
    expect(screen.getByText(/NSFW, adult, pornographic, sexual, or sexually explicit/i)).toBeInTheDocument();
    expect(screen.getByText(/screened by automated content moderation/i)).toBeInTheDocument();
  });
});

describe("landing footer legal links", () => {
  it("links to the privacy policy and terms of service", () => {
    render(<LandingFooter />);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: /privacy policy/i })).toHaveAttribute("href", "/privacy");
    expect(within(footer).getByRole("link", { name: /terms of service/i })).toHaveAttribute("href", "/terms");
  });
});
