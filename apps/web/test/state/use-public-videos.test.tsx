// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { usePublicVideos, useLikeVideo } from "@/state/use-public-videos";

vi.mock("@/lib/api-client", () => ({
  listPublicVideos: vi.fn(async () => [
    { sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: null, likeCount: 1, createdAt: "t", likedByMe: false },
  ]),
  likeVideo: vi.fn(async () => ({ likeCount: 2, liked: true })),
  unlikeVideo: vi.fn(async () => ({ likeCount: 1, liked: false })),
  getPublicVideo: vi.fn(async () => null),
}));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("use-public-videos", () => {
  it("fetches the list for a sort", async () => {
    const { result } = renderHook(() => usePublicVideos("recent"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data?.[0]?.sid).toBe("a");
  });

  it("useLikeVideo calls likeVideo when not yet liked", async () => {
    const { likeVideo } = await import("@/lib/api-client");
    const { result } = renderHook(() => useLikeVideo(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync({ sid: "a", liked: false });
    });
    expect(likeVideo).toHaveBeenCalledWith("a");
  });
});
