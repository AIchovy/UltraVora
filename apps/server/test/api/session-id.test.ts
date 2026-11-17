import { describe, it, expect } from "vitest";
import { newSessionId, isValidSessionId } from "../../src/api/session-id.js";

describe("session-id", () => {
  it("newSessionId returns a 36-char UUID v4", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("newSessionId is unique across calls", () => {
    const a = newSessionId();
    const b = newSessionId();
    expect(a).not.toBe(b);
  });

  it("isValidSessionId accepts alphanumeric + hyphen + underscore", () => {
    expect(isValidSessionId(newSessionId())).toBe(true);
    expect(isValidSessionId("abc_123-XYZ")).toBe(true);
  });

  it("isValidSessionId rejects empty / slashes / dots / spaces", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("../foo")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("a b")).toBe(false);
    expect(isValidSessionId("a.b")).toBe(false);
  });
});
