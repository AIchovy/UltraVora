import { describe, it, expect } from "vitest";
import type { ServerEvent } from "@ultracreator/shared";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";

const ev = (i: number): ServerEvent => ({ type: "phase.progress", phase: "research", message: `m${i}` });
const entry = (seq: number) => ({ seq, at: new Date(seq * 1000).toISOString(), event: ev(seq) });

async function collect(it: AsyncIterable<{ seq: number }>): Promise<number[]> {
  const out: number[] = [];
  for await (const e of it) out.push(e.seq);
  return out;
}

describe("InMemoryEventStore", () => {
  it("maxSeq is 0 for an unknown session", async () => {
    expect(await new InMemoryEventStore().maxSeq("s1")).toBe(0);
  });

  it("append + maxSeq + readSince round-trips, scoped per session", async () => {
    const store = new InMemoryEventStore();
    await store.append("s1", [entry(1), entry(2)]);
    await store.append("s2", [entry(1)]);
    expect(await store.maxSeq("s1")).toBe(2);
    expect(await store.maxSeq("s2")).toBe(1);
    expect(await collect(store.readSince("s1", 0))).toEqual([1, 2]);
    expect(await collect(store.readSince("s1", 1))).toEqual([2]);
    expect(await collect(store.readSince("s2", 0))).toEqual([1]);
  });

  it("append of an empty batch is a no-op", async () => {
    const store = new InMemoryEventStore();
    await store.append("s1", []);
    expect(await store.maxSeq("s1")).toBe(0);
  });

  it("readSince yields ascending by seq even if appended out of order", async () => {
    const store = new InMemoryEventStore();
    await store.append("s1", [entry(3), entry(1), entry(2)]);
    expect(await collect(store.readSince("s1", 0))).toEqual([1, 2, 3]);
  });
});
