// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PlazaPage from "@/app/plaza/page";
import { getServerSession } from "@/lib/server-session";

vi.mock("@/lib/server-session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderPage(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  render(<QueryClientProvider client={qc}>{await PlazaPage()}</QueryClientProvider>);
}

describe("/plaza page SSR", () => {
  it("ships the video grid (with /v/ links) in the server HTML for logged-out visitors", async () => {
    getSessionMock.mockResolvedValue(null);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([video]), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await renderPage();
    // No skeleton: crawlers get the real cards and can follow the links.
    expect(screen.queryByRole("status", { name: /loading videos/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Acme Launch" })).toHaveAttribute("href", "/v/abc123");
  });

  it("falls back to the client fetch (skeleton) when the API is unreachable", async () => {
    getSessionMock.mockResolvedValue(null);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await renderPage();
    expect(screen.getByRole("status", { name: /loading videos/i })).toBeInTheDocument();
  });
});
