// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LikeButton } from "@/components/plaza/like-button";
import { renderWithQuery } from "../helpers/render-with-query";
import { likeVideo, unlikeVideo } from "@/lib/api-client";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

// Mutable holder so individual tests can flip the login state.
let session: { user: { id: string } } | null = { user: { id: "u1" } };
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: session }) }));

vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  likeVideo: vi.fn(async () => ({ likeCount: 4, liked: true })),
  unlikeVideo: vi.fn(async () => ({ likeCount: 3, liked: false })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  session = { user: { id: "u1" } };
});

describe("<LikeButton>", () => {
  it("shows the count and likes on click", async () => {
    const user = userEvent.setup();
    renderWithQuery(<LikeButton sid="a" likeCount={3} liked={false} variant="page" />);
    const btn = screen.getByRole("button", { name: "like (3)" });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("3")).toBeInTheDocument();
    await user.click(btn);
    await waitFor(() => expect(likeVideo).toHaveBeenCalledWith("a"));
  });

  it("unlikes when already liked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<LikeButton sid="a" likeCount={3} liked variant="overlay" />);
    // The accessible name stays constant; only aria-pressed flips.
    const btn = screen.getByRole("button", { name: "like (3)" });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    await user.click(btn);
    await waitFor(() => expect(unlikeVideo).toHaveBeenCalledWith("a"));
  });

  it("routes logged-out viewers to /login instead of liking", async () => {
    session = null;
    const user = userEvent.setup();
    renderWithQuery(<LikeButton sid="a" likeCount={0} liked={false} variant="overlay" />);
    await user.click(screen.getByRole("button", { name: "like (0)" }));
    expect(pushMock).toHaveBeenCalledWith("/login");
    expect(likeVideo).not.toHaveBeenCalled();
  });
});
