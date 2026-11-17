// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { LandingPage } from "@/components/marketing/landing-page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

describe("LandingPage", () => {
  it("renders exactly one h1 with the hero pitch", () => {
    render(<LandingPage />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(/promo videos/i);
  });

  it("every Get started CTA links to /login", () => {
    render(<LandingPage />);
    const ctas = screen.getAllByRole("link", { name: /get started/i });
    expect(ctas.length).toBeGreaterThanOrEqual(2); // header + hero
    for (const cta of ctas) expect(cta).toHaveAttribute("href", "/login");
  });

  it("every Sign in link points to /login", () => {
    render(<LandingPage />);
    const links = screen.getAllByRole("link", { name: /^sign in$/i });
    expect(links.length).toBeGreaterThanOrEqual(2); // header + footer
    for (const l of links) expect(l).toHaveAttribute("href", "/login");
  });

  it("header anchors navigate to the homepage #features and #faq, and both targets exist", () => {
    const { container } = render(<LandingPage />);
    const nav = screen.getByRole("navigation", { name: /landing sections/i });
    expect(within(nav).getByRole("link", { name: "Features" })).toHaveAttribute("href", "/#features");
    expect(within(nav).getByRole("link", { name: "FAQ" })).toHaveAttribute("href", "/#faq");
    expect(container.querySelector("#features")).not.toBeNull();
    expect(container.querySelector("#faq")).not.toBeNull();
  });

  it("features section renders the process showcases", () => {
    const { container } = render(<LandingPage />);
    const features = container.querySelector("#features");
    expect(features).not.toBeNull();
    const scoped = within(features as HTMLElement);
    for (const title of [
      /it studies your product first/i,
      /a creative brief you approve/i,
      /scene by scene, on a timeline/i,
      /voiceover, then the final cut/i,
    ]) {
      expect(scoped.getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });

  it("shows no testimonials (Creem compliance: no unverifiable social proof)", () => {
    render(<LandingPage />);
    expect(screen.queryByRole("region", { name: /what people say/i })).toBeNull();
    expect(screen.queryByText("Maya Reyes")).toBeNull();
  });

  it("FAQ renders as native details/summary with the lead question", () => {
    const { container } = render(<LandingPage />);
    const items = container.querySelectorAll("#faq details");
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText("What is UltraVora?")).toBeInTheDocument();
  });

  it("FAQ discloses the AI models used for generation (Gemini)", () => {
    render(<LandingPage />);
    expect(screen.getByText("What AI models does UltraVora use?")).toBeInTheDocument();
    expect(screen.getByText(/Google's Gemini model family/i)).toBeInTheDocument();
    expect(screen.getByText(/automated content moderation/i)).toBeInTheDocument();
  });

  it("footer shows the copyright line", () => {
    render(<LandingPage />);
    expect(within(screen.getByRole("contentinfo")).getByText(/© \d{4} UltraVora/)).toBeInTheDocument();
  });

  it("hero product glimpse is aria-hidden decoration", () => {
    const { container } = render(<LandingPage />);
    // The mockup (incl. its stage strings like "Compose & render") must stay
    // hidden from assistive tech — this is what lets the six-stage test rely
    // on within() scoping to the real pipeline list.
    const hero = container.querySelector("main section");
    expect(hero).not.toBeNull();
    const glimpse = hero!.querySelector('[aria-hidden="true"]');
    expect(glimpse).not.toBeNull();
    expect(glimpse!.textContent).toContain("UltraVora — Sunlit kitchen promo");
  });

  it("shows public pricing: nav + footer links and an inline #pricing section with plan prices", () => {
    const { container } = render(<LandingPage />);
    // Billing is live: pricing must be publicly visible (Creem MoR requirement).
    const nav = screen.getByRole("navigation", { name: /landing sections/i });
    expect(within(nav).getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/#pricing");
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
    const pricing = container.querySelector("#pricing");
    expect(pricing).not.toBeNull();
    const scoped = within(pricing as HTMLElement);
    expect(scoped.getByText("$20")).toBeInTheDocument(); // Pro monthly
    expect(scoped.getByText("$200")).toBeInTheDocument(); // Ultra monthly
  });

  it("links into the blog from header nav, footer, and a From-the-blog section", () => {
    const { container } = render(<LandingPage />);
    const nav = screen.getByRole("navigation", { name: /landing sections/i });
    expect(within(nav).getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByRole("link", { name: "Blog" })).toHaveAttribute("href", "/blog");
    expect(within(footer).getByRole("link", { name: "Product Plaza" })).toHaveAttribute("href", "/plaza");
    const blogSection = container.querySelector("#blog");
    expect(blogSection).not.toBeNull();
    const scoped = within(blogSection as HTMLElement);
    expect(scoped.getByRole("link", { name: /view all posts/i })).toHaveAttribute("href", "/blog");
    // Three latest posts, each linking to its article.
    const postLinks = scoped
      .getAllByRole("link")
      .filter((l) => l.getAttribute("href")?.startsWith("/blog/"));
    expect(postLinks).toHaveLength(3);
  });

  it("embeds FAQPage JSON-LD that mirrors the visible questions", () => {
    const { container } = render(<LandingPage />);
    const scripts = [...container.querySelectorAll('script[type="application/ld+json"]')];
    const faq = scripts
      .map((s) => JSON.parse(s.textContent ?? "{}") as { "@type"?: string; mainEntity?: { name: string }[] })
      .find((d) => d["@type"] === "FAQPage");
    expect(faq).toBeDefined();
    expect(faq?.mainEntity?.length).toBeGreaterThanOrEqual(5);
    expect(faq?.mainEntity?.map((q) => q.name)).toContain("What is UltraVora?");
  });

  it("hero and footer use the product-promo positioning, not the old studio tagline", () => {
    render(<LandingPage />);
    expect(screen.queryByText(/everyday video studio/i)).toBeNull();
    expect(screen.getByText(/your ai video agent/i)).toBeInTheDocument();
    expect(screen.getByText(/promo videos for your product/i)).toBeInTheDocument();
  });
});
