// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { rootMetadata, siteOrigin } from "@/lib/seo";
import { blogPosts } from "@/lib/blog";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import Page, { metadata as homeMetadata } from "@/app/page";
import { metadata as pricingMetadata } from "@/app/pricing/page";
import { metadata as plazaMetadata } from "@/app/plaza/page";
import { metadata as loginMetadata } from "@/app/login/page";
import { metadata as sessionMetadata } from "@/app/s/[sid]/page";
import { generateMetadata as videoGenerateMetadata } from "@/app/v/[sid]/page";
import { getServerSession } from "@/lib/server-session";

vi.mock("@/lib/server-session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));
vi.mock("@/components/home-page", () => ({ HomePage: () => <div data-testid="home-page" /> }));
vi.mock("@/components/marketing/landing-page", () => ({
  LandingPage: () => <div data-testid="landing-page" />,
}));

const getSessionMock = vi.mocked(getServerSession);

const video = {
  sid: "abc123",
  title: "Acme Launch",
  author: { name: "Jane", image: null },
  productUrl: null,
  likeCount: 3,
  createdAt: "2026-07-01T00:00:00.000Z",
  likedByMe: false,
};

describe("root metadata (layout defaults)", () => {
  it("sets metadataBase to the canonical site origin", () => {
    expect(siteOrigin).toBe("https://ultra-vora.com");
    expect(rootMetadata.metadataBase?.href).toBe("https://ultra-vora.com/");
  });

  it("carries default title, description and social-card defaults", () => {
    expect(rootMetadata.title).toMatch(/UltraVora/);
    expect(rootMetadata.description).toMatch(/promo video/i);
    expect(rootMetadata.openGraph?.siteName).toBe("UltraVora");
    expect(rootMetadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("does NOT set a canonical at the root — pages own their canonicals", () => {
    // A root-level canonical is inherited by every page that doesn't override
    // it, which would canonicalize the whole site onto the homepage.
    expect(rootMetadata.alternates).toBeUndefined();
  });
});

describe("per-page canonicals", () => {
  it("homepage: canonical / with open-graph url", () => {
    expect(homeMetadata.alternates?.canonical).toBe("/");
    expect(homeMetadata.openGraph?.url).toBe("/");
  });
  it("pricing: canonical /pricing", () => {
    expect(pricingMetadata.alternates?.canonical).toBe("/pricing");
  });
  it("plaza: canonical /plaza", () => {
    expect(plazaMetadata.alternates?.canonical).toBe("/plaza");
  });
  it("login: has a title and canonical /login", () => {
    expect(loginMetadata.title).toMatch(/log in/i);
    expect(loginMetadata.alternates?.canonical).toBe("/login");
  });
  it("private session workspace /s/[sid] is noindex", () => {
    expect(sessionMetadata.robots).toMatchObject({ index: false });
  });
});

describe("robots.txt", () => {
  it("allows crawling but blocks private + proxied paths, and links the sitemap", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rules?.allow).toBe("/");
    expect(rules?.disallow).toEqual(expect.arrayContaining(["/s/", "/api/"]));
    expect(r.sitemap).toBe("https://ultra-vora.com/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("lists marketing pages and public videos from the plaza API", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([video]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        "https://ultra-vora.com/",
        "https://ultra-vora.com/pricing",
        "https://ultra-vora.com/plaza",
        "https://ultra-vora.com/blog",
        "https://ultra-vora.com/privacy",
        "https://ultra-vora.com/terms",
        "https://ultra-vora.com/v/abc123",
      ]),
    );
    const videoEntry = entries.find((e) => e.url.endsWith("/v/abc123"));
    expect(videoEntry?.lastModified).toEqual(new Date(video.createdAt));
  });

  it("lists every blog post with a lastModified date, and never /login", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    for (const p of blogPosts) {
      const entry = entries.find((e) => e.url === `https://ultra-vora.com/blog/${p.slug}`);
      expect(entry, p.slug).toBeDefined();
      expect(entry?.lastModified).toBeInstanceOf(Date);
    }
    // A sign-in form isn't a page worth advertising to crawlers.
    expect(urls).not.toContain("https://ultra-vora.com/login");
  });

  it("falls back to the static pages when the API is unreachable (build time)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls).toContain("https://ultra-vora.com/");
    expect(urls).toContain("https://ultra-vora.com/pricing");
    expect(urls.some((u) => u.includes("/v/"))).toBe(false);
  });
});

describe("/v/[sid] share metadata", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("builds title/description/canonical + og video from the public video", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(video), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const meta = await videoGenerateMetadata({ params: Promise.resolve({ sid: "abc123" }) });
    expect(meta.title).toBe("Acme Launch — UltraVora");
    expect(meta.description).toMatch(/Jane/);
    expect(meta.alternates?.canonical).toBe("/v/abc123");
    expect(meta.openGraph?.url).toBe("/v/abc123");
    const videos = meta.openGraph && "videos" in meta.openGraph ? meta.openGraph.videos : undefined;
    expect(videos).toEqual([{ url: "/api/public/videos/abc123/video" }]);
  });

  it("untitled videos get a fallback title", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...video, title: null }), { status: 200 }),
    );
    const meta = await videoGenerateMetadata({ params: Promise.resolve({ sid: "abc123" }) });
    expect(meta.title).toBe("Untitled video — UltraVora");
  });

  it("missing/unreachable video → generic noindex metadata (page still renders client-side)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("null", { status: 404 }));
    const meta = await videoGenerateMetadata({ params: Promise.resolve({ sid: "nope" }) });
    expect(meta.robots).toMatchObject({ index: false });
    expect(meta.title).toMatch(/UltraVora/);
  });
});

describe("landing page JSON-LD", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
  });

  it("embeds SoftwareApplication + Organization + WebSite structured data for logged-out visitors", async () => {
    getSessionMock.mockResolvedValue(null);
    render(await Page());
    const script = document.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    const entities = JSON.parse(script?.textContent ?? "[]") as Record<string, unknown>[];
    const byType = new Map(entities.map((e) => [e["@type"], e]));
    expect([...byType.keys()]).toEqual(
      expect.arrayContaining(["SoftwareApplication", "Organization", "WebSite"]),
    );
    const app = byType.get("SoftwareApplication");
    expect(app?.name).toBe("UltraVora");
    expect(app?.url).toBe("https://ultra-vora.com");
    expect(byType.get("Organization")?.logo).toBe("https://ultra-vora.com/icon.svg");
  });

  it("does not ship marketing JSON-LD inside the logged-in app", async () => {
    getSessionMock.mockResolvedValue({ user: { id: "u1", email: "u@example.com", name: "U" } });
    render(await Page());
    expect(document.querySelector('script[type="application/ld+json"]')).toBeNull();
  });
});

describe("opengraph image route", () => {
  it("exports a 1200x630 png with alt text", async () => {
    const mod = await import("@/app/opengraph-image");
    expect(mod.size).toEqual({ width: 1200, height: 630 });
    expect(mod.contentType).toBe("image/png");
    expect(mod.alt).toMatch(/UltraVora/);
    expect(typeof mod.default).toBe("function");
  });
});
