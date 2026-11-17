import { describe, it, expect } from "vitest";
import { InMemoryArtifactRepository } from "../helpers/in-memory-artifact-repository.js";
import type { ArtifactRow } from "../../src/artifacts/artifact-repository.js";

const row = (kind: ArtifactRow["kind"], version: number, extra: Partial<ArtifactRow> = {}): ArtifactRow => ({
  kind,
  version,
  createdAt: new Date(version * 1000).toISOString(),
  derivedFrom: null,
  stale: false,
  data: { v: version },
  ...extra,
});

describe("InMemoryArtifactRepository", () => {
  it("maxVersion is 0 when empty, then tracks the highest per kind", async () => {
    const repo = new InMemoryArtifactRepository();
    expect(await repo.maxVersion("s1", "brief")).toBe(0);
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("brief", 2));
    await repo.insert("s1", row("design", 1));
    expect(await repo.maxVersion("s1", "brief")).toBe(2);
    expect(await repo.maxVersion("s1", "design")).toBe(1);
  });

  it("getLatest returns the highest version; getVersion is exact", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("brief", 1, { data: { a: 1 } }));
    await repo.insert("s1", row("brief", 2, { data: { a: 2 } }));
    expect((await repo.getLatest("s1", "brief"))?.data).toEqual({ a: 2 });
    expect((await repo.getVersion("s1", "brief", 1))?.data).toEqual({ a: 1 });
    expect(await repo.getVersion("s1", "brief", 9)).toBeNull();
    expect(await repo.getLatest("s1", "design")).toBeNull();
  });

  it("list returns every row; scoped per session", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("brief", 1));
    await repo.insert("s1", row("design", 1));
    await repo.insert("s2", row("brief", 1));
    expect((await repo.list("s1")).map((r) => r.kind).sort()).toEqual(["brief", "design"]);
    expect((await repo.list("s2")).map((r) => r.kind)).toEqual(["brief"]);
  });

  it("markStale flips the flag and returns false for a missing row", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("brief", 1));
    expect(await repo.markStale("s1", "brief", 1)).toBe(true);
    expect((await repo.getVersion("s1", "brief", 1))?.stale).toBe(true);
    expect(await repo.markStale("s1", "brief", 2)).toBe(false);
  });

  it("preserves derivedFrom", async () => {
    const repo = new InMemoryArtifactRepository();
    await repo.insert("s1", row("design", 1, { derivedFrom: [{ kind: "brief", version: 1 }] }));
    expect((await repo.getLatest("s1", "design"))?.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });
});
