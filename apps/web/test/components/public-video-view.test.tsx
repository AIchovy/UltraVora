// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { PublicVideoView } from "@/components/plaza/public-video-view";
import { renderWithQuery } from "../helpers/render-with-query";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  getPublicVideo: vi.fn(async () => ({
    sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 3, createdAt: "2026-01-01T00:00:00.000Z", likedByMe: false,
  })),
  publicVideoUrl: (sid: string) => `http://x/${sid}.mp4`,
}));

beforeEach(() => vi.clearAllMocks());

describe("<PublicVideoView>", () => {
  it("renders the video title + product link", async () => {
    renderWithQuery(<PublicVideoView sid="a" />);
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /visit product/i })).toHaveAttribute("href", "https://a.com");
  });

  it("shows the author and publish date", async () => {
    renderWithQuery(<PublicVideoView sid="a" />);
    expect(await screen.findByText("Ann")).toBeInTheDocument();
    expect(screen.getByText("Jan 1, 2026")).toBeInTheDocument();
  });

  it("shows a skeleton while loading", () => {
    // The query hasn't resolved on first render, so the skeleton is synchronous.
    renderWithQuery(<PublicVideoView sid="a" />);
    expect(screen.getByRole("status", { name: /loading video/i })).toBeInTheDocument();
  });

  it("renders a server-fetched initialVideo synchronously — no skeleton (SEO)", () => {
    renderWithQuery(
      <PublicVideoView
        sid="a"
        initialVideo={{ sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: null, likeCount: 3, createdAt: "2026-01-01T00:00:00.000Z", likedByMe: false }}
      />,
    );
    expect(screen.queryByRole("status", { name: /loading video/i })).toBeNull();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("shows a not-found message for a missing video", async () => {
    const { getPublicVideo } = await import("@/lib/api-client");
    (getPublicVideo as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(null);
    renderWithQuery(<PublicVideoView sid="missing" />);
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
  });
});
