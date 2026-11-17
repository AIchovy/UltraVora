// apps/web/test/lib/public-videos-client.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { listPublicVideos, likeVideo, publicVideoUrl } from "@/lib/api-client";
import { mockFetch } from "../helpers/api-mocks";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});
afterEach(() => vi.restoreAllMocks());

describe("public videos client", () => {
  it("listPublicVideos hits the sort endpoint", async () => {
    const calls: string[] = [];
    mockFetch(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await listPublicVideos("likes");
    expect(calls[0]).toContain("/api/public/videos?sort=likes");
  });

  it("likeVideo POSTs and returns the toggle result", async () => {
    mockFetch(async () => new Response(JSON.stringify({ likeCount: 3, liked: true }), { status: 200 }));
    expect(await likeVideo("a")).toEqual({ likeCount: 3, liked: true });
  });

  it("publicVideoUrl builds the playback URL", () => {
    expect(publicVideoUrl("a")).toBe("http://127.0.0.1:3001/api/public/videos/a/video");
  });
});
