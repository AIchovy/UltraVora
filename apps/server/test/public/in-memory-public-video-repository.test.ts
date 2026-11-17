// apps/server/test/public/in-memory-public-video-repository.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryPublicVideoRepository } from "../helpers/in-memory-public-video-repository.js";

function seed(repo: InMemoryPublicVideoRepository) {
  repo.seed({ sid: "a", title: "Alpha", author: { name: "Ann", image: null }, productUrl: "https://a.com", likeCount: 1, createdAt: "2026-01-01T00:00:00.000Z" });
  repo.seed({ sid: "b", title: "Beta", author: { name: "Bob", image: null }, productUrl: null, likeCount: 5, createdAt: "2026-02-01T00:00:00.000Z" });
}

describe("InMemoryPublicVideoRepository", () => {
  it("sorts by recent (createdAt desc)", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    const list = await repo.list({ sort: "recent", limit: 10 });
    expect(list.map((v) => v.sid)).toEqual(["b", "a"]);
  });

  it("sorts by likes (likeCount desc)", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    const list = await repo.list({ sort: "likes", limit: 10 });
    expect(list.map((v) => v.sid)).toEqual(["b", "a"]);
  });

  it("respects limit", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    expect(await repo.list({ sort: "recent", limit: 1 })).toHaveLength(1);
  });

  it("computes likedByMe for the viewer", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    await repo.like("a", "u1");
    const asU1 = await repo.list({ sort: "recent", limit: 10, viewerId: "u1" });
    expect(asU1.find((v) => v.sid === "a")?.likedByMe).toBe(true);
    const anon = await repo.list({ sort: "recent", limit: 10 });
    expect(anon.every((v) => v.likedByMe === false)).toBe(true);
  });

  it("like is idempotent per user and toggles back with unlike", async () => {
    const repo = new InMemoryPublicVideoRepository();
    seed(repo);
    expect(await repo.like("b", "u1")).toEqual({ likeCount: 6, liked: true });
    expect(await repo.like("b", "u1")).toEqual({ likeCount: 6, liked: true });
    expect(await repo.unlike("b", "u1")).toEqual({ likeCount: 5, liked: false });
    expect(await repo.unlike("b", "u1")).toEqual({ likeCount: 5, liked: false });
  });

  it("returns null for a non-public video", async () => {
    const repo = new InMemoryPublicVideoRepository();
    expect(await repo.get("missing")).toBeNull();
    expect(await repo.like("missing", "u1")).toBeNull();
  });
});
