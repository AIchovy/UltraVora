import { describe, it, expect } from "vitest";
import { SessionQueue } from "../src/orchestrator/session-queue.js";

describe("SessionQueue", () => {
  it("runs tasks for the same session in FIFO order", async () => {
    const q = new SessionQueue();
    const order: number[] = [];
    const t1 = q.enqueue("s1", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
    });
    const t2 = q.enqueue("s1", async () => {
      order.push(2);
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual([1, 2]);
  });

  it("runs tasks for different sessions concurrently", async () => {
    const q = new SessionQueue();
    const order: string[] = [];
    const t1 = q.enqueue("a", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    });
    const t2 = q.enqueue("b", async () => {
      order.push("b");
    });
    await Promise.all([t1, t2]);
    expect(order).toEqual(["b", "a"]);
  });

  it("propagates the task's resolved value to enqueue's caller", async () => {
    const q = new SessionQueue();
    const v = await q.enqueue("s1", async () => 42);
    expect(v).toBe(42);
  });

  it("propagates task errors to enqueue's caller and keeps the queue alive", async () => {
    const q = new SessionQueue();
    const order: string[] = [];
    const t1 = q.enqueue("s1", async () => { throw new Error("boom"); });
    const t2 = q.enqueue("s1", async () => { order.push("ran"); });
    await expect(t1).rejects.toThrow("boom");
    await t2;
    expect(order).toEqual(["ran"]);
  });
});
