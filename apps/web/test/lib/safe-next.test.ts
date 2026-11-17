import { describe, it, expect } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("returns a normal relative path unchanged", () => {
    expect(safeNext("/s/abc")).toBe("/s/abc");
  });

  it("returns '/' for undefined", () => {
    expect(safeNext(undefined)).toBe("/");
  });

  it("returns '/' for an absolute URL (open-redirect guard)", () => {
    expect(safeNext("https://evil.com")).toBe("/");
  });

  it("returns '/' for a protocol-relative URL (open-redirect guard)", () => {
    expect(safeNext("//evil.com")).toBe("/");
  });
});
