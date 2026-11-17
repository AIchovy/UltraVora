// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProductPlaza } from "@/components/plaza/product-plaza";
import { renderWithQuery } from "../helpers/render-with-query";
import { listPublicVideos, likeVideo } from "@/lib/api-client";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "u1" } } }) }));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  listPublicVideos: vi.fn(async () => [
    { sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 1, createdAt: "2026-01-01T00:00:00.000Z", likedByMe: false },
  ]),
  likeVideo: vi.fn(async () => ({ likeCount: 2, liked: true })),
  unlikeVideo: vi.fn(async () => ({ likeCount: 1, liked: false })),
  publicVideoUrl: (sid: string) => `http://x/${sid}.mp4`,
}));

beforeEach(() => vi.clearAllMocks());

describe("<ProductPlaza>", () => {
  it("renders cards from the API", async () => {
    renderWithQuery(<ProductPlaza loggedIn />);
    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /visit product/i })).toHaveAttribute("href", "https://a.com");
  });

  it("switches sort via the segmented control", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ProductPlaza loggedIn />);
    await screen.findByText("Alpha");
    const recent = screen.getByRole("button", { name: "Recent" });
    const likes = screen.getByRole("button", { name: "Most liked" });
    expect(recent).toHaveAttribute("aria-pressed", "true");
    expect(likes).toHaveAttribute("aria-pressed", "false");
    await user.click(likes);
    await waitFor(() => expect(listPublicVideos).toHaveBeenCalledWith("likes"));
    expect(likes).toHaveAttribute("aria-pressed", "true");
  });

  it("likes a video from the cover overlay", async () => {
    const user = userEvent.setup();
    renderWithQuery(<ProductPlaza loggedIn />);
    await screen.findByText("Alpha");
    // Anchored: must not match the "Most liked" sort pill.
    await user.click(screen.getByRole("button", { name: /^like \(1\)$/ }));
    await waitFor(() => expect(likeVideo).toHaveBeenCalledWith("a"));
  });

  it("shows skeleton cards while the list loads", () => {
    (listPublicVideos as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));
    renderWithQuery(<ProductPlaza loggedIn />);
    expect(screen.getByRole("status", { name: /loading videos/i })).toBeInTheDocument();
  });

  it("renders server-fetched initialVideos synchronously — no skeleton, real /v/ links (SEO)", () => {
    // Even with the client fetch hanging, the SSR-passed list paints immediately.
    (listPublicVideos as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => {}));
    renderWithQuery(
      <ProductPlaza
        loggedIn={false}
        initialVideos={[
          { sid: "ssr1", title: "Server Card", author: { name: "Ann", image: null }, productUrl: null, likeCount: 0, createdAt: "2026-01-01T00:00:00.000Z", likedByMe: false },
        ]}
      />,
    );
    expect(screen.queryByRole("status", { name: /loading videos/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Server Card" })).toHaveAttribute("href", "/v/ssr1");
  });
});
