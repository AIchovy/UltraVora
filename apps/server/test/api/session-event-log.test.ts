// apps/server/test/api/session-event-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ServerEvent } from "@ultracreator/shared";
import { EventBus } from "../../src/events/event-bus.js";
import { SessionEventLog } from "../../src/events/session-event-log.js";
import { InMemoryEventStore } from "../helpers/in-memory-event-store.js";

let events: EventBus;
let store: InMemoryEventStore;
let log: SessionEventLog;

beforeEach(() => {
  events = new EventBus();
  store = new InMemoryEventStore();
  // batchMs: 0 keeps tests fast; flush() still forces a synchronous drain.
  log = new SessionEventLog({ events, store, batchMs: 0 });
});

afterEach(async () => {
  await log.closeAll();
});

const ev = (i: number): ServerEvent => ({ type: "phase.progress", phase: "research", message: `msg-${i}` });

async function readAll(sid: string): Promise<{ seq: number; event: ServerEvent }[]> {
  const out: { seq: number; event: ServerEvent }[] = [];
  for await (const e of log.readSince(sid, 0)) out.push({ seq: e.seq, event: e.event });
  return out;
}

describe("SessionEventLog", () => {
  it("attach() subscribes to the EventBus and persists one entry per event", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    await log.flush("s1");
    const rows = await readAll("s1");
    expect(rows).toEqual([
      { seq: 1, event: ev(1) },
      { seq: 2, event: ev(2) },
    ]);
  });

  it("re-broadcasts sequenced envelopes to subscribers synchronously, in order", async () => {
    await log.attach("s1");
    const seen: Array<{ seq: number; event: ServerEvent }> = [];
    log.subscribe("s1", (entry) => seen.push({ seq: entry.seq, event: entry.event }));
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    expect(seen).toEqual([
      { seq: 1, event: ev(1) },
      { seq: 2, event: ev(2) },
    ]);
  });

  it("attach() resumes sequence numbering from the store", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    await log.closeAll();
    // New SessionEventLog over the SAME store — seq must continue at 3.
    log = new SessionEventLog({ events, store, batchMs: 0 });
    await log.attach("s1");
    events.emit("s1", ev(3));
    await log.flush("s1");
    const rows = await readAll("s1");
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("readSince(sid, sinceSeq) yields only events with seq > sinceSeq", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    events.emit("s1", ev(2));
    events.emit("s1", ev(3));
    await log.flush("s1");
    const collected: number[] = [];
    for await (const entry of log.readSince("s1", 1)) collected.push(entry.seq);
    expect(collected).toEqual([2, 3]);
  });

  it("readSince returns an empty iterator for a session with no events", async () => {
    const seen: number[] = [];
    for await (const e of log.readSince("s2", 0)) seen.push(e.seq);
    expect(seen).toEqual([]);
  });

  it("closeAll() stops further appends and broadcasts", async () => {
    await log.attach("s1");
    events.emit("s1", ev(1));
    await log.closeAll();
    const seen: number[] = [];
    log.subscribe("s1", (e) => seen.push(e.seq));
    events.emit("s1", ev(2));
    expect(seen).toEqual([]);
    expect((await readAll("s1")).map((r) => r.seq)).toEqual([1]);
  });

  it("flush persists events buffered before flush even with a long batch window", async () => {
    log = new SessionEventLog({ events, store, batchMs: 10_000 });
    await log.attach("s1");
    events.emit("s1", ev(1));
    // Not yet persisted (timer hasn't fired); flush forces it.
    await log.flush("s1");
    expect((await readAll("s1")).map((r) => r.seq)).toEqual([1]);
  });

  it("subscribe() unsub stops only that listener", async () => {
    await log.attach("s1");
    const a: number[] = [];
    const b: number[] = [];
    const offA = log.subscribe("s1", (e) => a.push(e.seq));
    log.subscribe("s1", (e) => b.push(e.seq));
    events.emit("s1", ev(1));
    offA();
    events.emit("s1", ev(2));
    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});
