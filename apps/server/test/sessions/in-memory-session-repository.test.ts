import { describe, it, expect } from "vitest";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";

describe("InMemorySessionRepository", () => {
  it("create + get returns an idle, untitled record owned by the user", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    const row = await repo.get("s1");
    expect(row).toMatchObject({ id: "s1", userId: "u1", title: null, status: "idle", currentPhase: null });
  });

  it("get returns null for an unknown id", async () => {
    expect(await new InMemorySessionRepository().get("nope")).toBeNull();
  });

  it("listByUser is scoped to the user and ordered by updatedAt desc", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "a", userId: "u1" });
    await repo.create({ id: "b", userId: "u1" });
    await repo.create({ id: "c", userId: "u2" });
    await repo.updateStatus("a", { status: "running", currentPhase: "research", error: null });
    const list = await repo.listByUser("u1");
    // Robust: assert set membership only (ordering can tie within the same millisecond)
    expect(list.map((r) => r.id).sort()).toEqual(["a", "b"]);
    // The intent — a was touched most recently — is proven by the status change:
    expect(list.find((r) => r.id === "a")!.status).toBe("running");
    expect((await repo.listByUser("u2")).map((r) => r.id)).toEqual(["c"]);
  });

  it("updateStatus is a no-op when the row is absent", async () => {
    const repo = new InMemorySessionRepository();
    await repo.updateStatus("ghost", { status: "running", currentPhase: "research", error: null });
    expect(await repo.get("ghost")).toBeNull();
  });

  it("setTitleIfEmpty only sets the first time", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    await repo.setTitleIfEmpty("s1", "First");
    await repo.setTitleIfEmpty("s1", "Second");
    expect((await repo.get("s1"))?.title).toBe("First");
  });

  it("delete removes the row", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    await repo.delete("s1");
    expect(await repo.get("s1")).toBeNull();
  });
});

describe("free public grant", () => {
  it("grants the first public session and refuses a second for the same user", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "a", userId: "u1", isPublic: true });
    await repo.create({ id: "b", userId: "u1", isPublic: true });

    expect(await repo.hasFreePublicGrant("u1")).toBe(false);
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.hasFreePublicGrant("u1")).toBe(true);
    // Second distinct session for the same user loses.
    expect(await repo.claimFreePublicGrant("b", "u1")).toBe(false);
    // Re-claiming the holding session is idempotent.
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
  });

  it("is per-user", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "a", userId: "u1", isPublic: true });
    await repo.create({ id: "c", userId: "u2", isPublic: true });
    expect(await repo.claimFreePublicGrant("a", "u1")).toBe(true);
    expect(await repo.claimFreePublicGrant("c", "u2")).toBe(true);
  });
});

describe("public-video fields", () => {
  it("defaults publicity fields on a plain create", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s1", userId: "u1" });
    const row = await repo.get("s1");
    expect(row).toMatchObject({
      isPublic: false,
      productUrl: null,
      freeGrant: false,
      likeCount: 0,
    });
  });

  it("stores isPublic + productUrl from create", async () => {
    const repo = new InMemorySessionRepository();
    await repo.create({ id: "s2", userId: "u1", isPublic: true, productUrl: "https://acme.com" });
    const row = await repo.get("s2");
    expect(row).toMatchObject({ isPublic: true, productUrl: "https://acme.com" });
  });
});
