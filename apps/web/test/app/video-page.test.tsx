// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PublicVideoPage from "@/app/v/[sid]/page";

vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  // LikeButton needs a router outside a real app shell; notFound keeps its
  // real throwing behavior via the passthrough above.
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const video = {
  sid: "abc123",
  title: "Acme Launch",
  author: { name: "Jane", image: null },
  productUrl: null,
  likeCount: 3,
  createdAt: "2026-07-01T00:00:00.000Z",
  likedByMe: false,
};

const params = { params: Promise.resolve({ sid: "abc123" }) };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderPage(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  render(<QueryClientProvider client={qc}>{await PublicVideoPage(params)}</QueryClientProvider>);
}

describe("/v/[sid] page", () => {
  it("server-renders the video content with VideoObject JSON-LD and site links", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(video), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await renderPage();

    // Real content in the first HTML paint — no client fetch needed.
    expect(screen.getByText("Acme Launch")).toBeInTheDocument();
    expect(screen.getByText("Jane")).toBeInTheDocument();

    const script = document.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(script?.textContent ?? "{}") as Record<string, unknown>;
    expect(data["@type"]).toBe("VideoObject");
    expect(data.name).toBe("Acme Launch");
    expect(data.uploadDate).toBe(video.createdAt);
    expect(data.contentUrl).toBe("https://ultra-vora.com/api/public/videos/abc123/video");
    expect(data.thumbnailUrl).toBe("https://ultra-vora.com/opengraph-image");

    // Crawlable footer links back into the site (scoped: the header logo is
    // also accessible-named "Product Plaza").
    const siteNav = within(screen.getByRole("navigation", { name: "Site" }));
    for (const [name, href] of [
      ["Home", "/"],
      ["Product Plaza", "/plaza"],
      ["Blog", "/blog"],
      ["Pricing", "/pricing"],
    ] as const) {
      expect(siteNav.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it("404s (notFound) when the API says the video does not exist", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("null", { status: 404 }));
    await expect(PublicVideoPage(params)).rejects.toThrow();
  });

  it("degrades to the client-fetch shell (no JSON-LD, no 404) when the API is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await renderPage();
    expect(document.querySelector('script[type="application/ld+json"]')).toBeNull();
    // The client view renders its loading skeleton and retries on its own.
    expect(screen.getByRole("status", { name: /loading video/i })).toBeInTheDocument();
  });
});
