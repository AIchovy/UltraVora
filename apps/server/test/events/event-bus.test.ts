import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/events/event-bus.js";
import type { ServerEvent } from "@ultracreator/shared";

const evt = (msg: string): ServerEvent => ({ type: "phase.progress", phase: "render", message: msg });

describe("EventBus.subscribeAll", () => {
  it("receives every session's events with the session id", () => {
    const bus = new EventBus();
    const seen: Array<[string, ServerEvent]> = [];
    bus.subscribeAll((sid, e) => seen.push([sid, e]));
    bus.emit("a", evt("1"));
    bus.emit("b", evt("2"));
    expect(seen).toEqual([["a", evt("1")], ["b", evt("2")]]);
  });

  it("fires even when the session has no per-session listeners", () => {
    const bus = new EventBus();
    let count = 0;
    bus.subscribeAll(() => count++);
    bus.emit("nobody-listening", evt("x"));
    expect(count).toBe(1);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.subscribeAll(() => count++);
    bus.emit("a", evt("1"));
    off();
    bus.emit("a", evt("2"));
    expect(count).toBe(1);
  });

  it("does not disturb per-session listeners", () => {
    const bus = new EventBus();
    const perSession: ServerEvent[] = [];
    bus.subscribe("a", (e) => perSession.push(e));
    bus.subscribeAll(() => {});
    bus.emit("a", evt("1"));
    expect(perSession).toEqual([evt("1")]);
  });
});
