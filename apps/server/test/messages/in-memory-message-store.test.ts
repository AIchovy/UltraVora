import { describe, it, expect } from "vitest";
import { InMemoryMessageStore } from "../helpers/in-memory-message-store.js";

describe("InMemoryMessageStore", () => {
  it("insert returns increasing ids and rows start pending with null timestamps", async () => {
    const store = new InMemoryMessageStore();
    const a = await store.insert("s1", { text: "one" });
    const b = await store.insert("s1", { text: "two" });
    expect(b).toBeGreaterThan(a);
    const rows = store.all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: a, sessionId: "s1", status: "pending", startedAt: null, finishedAt: null });
    expect(rows[0]!.payload).toEqual({ text: "one" });
    expect(typeof rows[0]!.createdAt).toBe("string");
  });

  it("markProcessing/markDone/markError advance status and stamp timestamps", async () => {
    const store = new InMemoryMessageStore();
    const id = await store.insert("s1", { text: "x" });
    await store.markProcessing(id);
    expect(store.all()[0]).toMatchObject({ status: "processing" });
    expect(store.all()[0]!.startedAt).not.toBeNull();
    await store.markDone(id);
    expect(store.all()[0]).toMatchObject({ status: "done" });
    expect(store.all()[0]!.finishedAt).not.toBeNull();

    const id2 = await store.insert("s1", { text: "y" });
    await store.markError(id2);
    expect(store.all()[1]).toMatchObject({ status: "error" });
    expect(store.all()[1]!.finishedAt).not.toBeNull();
  });

  it("mark* on an absent id is a silent no-op", async () => {
    const store = new InMemoryMessageStore();
    await expect(store.markProcessing(99)).resolves.toBeUndefined();
    await expect(store.markDone(99)).resolves.toBeUndefined();
    await expect(store.markError(99)).resolves.toBeUndefined();
  });

  it("listIncomplete returns pending+processing in id order and excludes done/error", async () => {
    const store = new InMemoryMessageStore();
    const a = await store.insert("s1", { text: "a" });
    const b = await store.insert("s2", { text: "b" });
    const c = await store.insert("s1", { text: "c" });
    const d = await store.insert("s1", { text: "d" });
    await store.markProcessing(b);
    await store.markDone(c);
    await store.markError(d);
    const rows = await store.listIncomplete();
    expect(rows.map((r) => r.id)).toEqual([a, b]);
    expect(rows.map((r) => r.status)).toEqual(["pending", "processing"]);
  });

  it("returned rows are copies — mutating them does not corrupt the store", async () => {
    const store = new InMemoryMessageStore();
    await store.insert("s1", { text: "a" });
    const rows = await store.listIncomplete();
    rows[0]!.payload.text = "EVIL";
    (rows[0] as { status: string }).status = "done";
    expect((await store.listIncomplete())[0]!.payload.text).toBe("a");
  });

  it("seed inserts a row with the given status for recovery scenarios", async () => {
    const store = new InMemoryMessageStore();
    const id = store.seed({
      sessionId: "s1",
      payload: { text: "interrupted" },
      status: "processing",
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    expect((await store.listIncomplete())[0]).toMatchObject({ id, status: "processing" });
  });
});
