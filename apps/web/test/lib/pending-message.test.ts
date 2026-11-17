// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { setPendingMessage, takePendingMessage } from "@/lib/pending-message";

beforeEach(() => sessionStorage.clear());

describe("pending-message", () => {
  it("returns null when nothing is stashed", () => {
    expect(takePendingMessage("s1")).toBeNull();
  });

  it("round-trips a stashed message then clears it (one-shot)", () => {
    setPendingMessage("s1", { text: "make a teaser", files: ["uploads/a.png"] });
    expect(takePendingMessage("s1")).toEqual({ text: "make a teaser", files: ["uploads/a.png"] });
    // Second read is empty — the handoff is consumed.
    expect(takePendingMessage("s1")).toBeNull();
  });

  it("scopes messages per session id", () => {
    setPendingMessage("a", { text: "alpha" });
    setPendingMessage("b", { text: "beta" });
    expect(takePendingMessage("b")?.text).toBe("beta");
    expect(takePendingMessage("a")?.text).toBe("alpha");
  });
});
