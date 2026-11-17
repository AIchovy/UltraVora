import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/events/event-bus.js";
import type { ServerEvent } from "@ultracreator/shared";

const ev: ServerEvent = { type: "artifact.created", kind: "brief", version: 1 };

describe("EventBus", () => {
  it("delivers events to subscribers of the same session", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe("s1", (e) => seen.push(e));
    bus.emit("s1", ev);
    expect(seen).toEqual([ev]);
  });

  it("does not deliver events across sessions", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe("s1", (e) => seen.push(e));
    bus.emit("s2", ev);
    expect(seen).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribe("s1", fn);
    off();
    bus.emit("s1", ev);
    expect(fn).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("s1", a);
    bus.subscribe("s1", b);
    bus.emit("s1", ev);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("emitting to a session with no subscribers is a safe no-op", () => {
    const bus = new EventBus();
    expect(() => bus.emit("nobody", ev)).not.toThrow();
  });

  it("a listener unsubscribing itself mid-emit does not skip other listeners", () => {
    const bus = new EventBus();
    const b = vi.fn();
    // `a` removes itself during delivery; `b` must still fire because emit
    // iterates over a copy of the listener set.
    const offA = bus.subscribe("s1", () => offA());
    bus.subscribe("s1", b);
    bus.emit("s1", ev);
    expect(b).toHaveBeenCalledTimes(1);
    // After a removed itself, a second emit still reaches b only.
    bus.emit("s1", ev);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
