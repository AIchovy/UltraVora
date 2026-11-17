import { describe, it, expect } from "vitest";
import { describeError, isTransientNetworkError } from "../src/errors.js";

function undiciFetchFailed(): Error {
  // Shape of what undici's fetch throws on a connect timeout: the useful
  // detail lives on err.cause, not err.message.
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    }),
  });
}

describe("describeError", () => {
  it("returns the message unchanged for a plain Error", () => {
    expect(describeError(new Error("scrape failed"))).toBe("scrape failed");
  });

  it("appends the cause chain including error codes", () => {
    const s = describeError(undiciFetchFailed());
    expect(s).toContain("fetch failed");
    expect(s).toContain("Connect Timeout Error");
    expect(s).toContain("UND_ERR_CONNECT_TIMEOUT");
  });

  it("walks nested causes", () => {
    const inner = new Error("dns lookup failed");
    const mid = new Error("connect failed", { cause: inner });
    const outer = new Error("fetch failed", { cause: mid });
    const s = describeError(outer);
    expect(s).toContain("connect failed");
    expect(s).toContain("dns lookup failed");
  });

  it("stringifies non-Error values", () => {
    expect(describeError("boom")).toBe("boom");
  });
});

describe("isTransientNetworkError", () => {
  it("classifies undici fetch failures as transient", () => {
    expect(isTransientNetworkError(undiciFetchFailed())).toBe(true);
  });

  it("classifies node socket errors by code on the cause", () => {
    const err = new Error("request failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it("classifies 429/5xx provider status errors as transient", () => {
    expect(isTransientNetworkError(new Error("got status: 503 Service Unavailable"))).toBe(true);
    expect(isTransientNetworkError(new Error("got status: 429 Too Many Requests"))).toBe(true);
  });

  it("classifies a prematurely terminated provider stream as transient", () => {
    // Google/undici can discard the original socket cause and surface only
    // this message after a long streaming response.
    expect(isTransientNetworkError(new TypeError("terminated"))).toBe(true);
    expect(isTransientNetworkError(new Error("stream terminated"))).toBe(true);
  });

  it("does not classify provider response-shape errors as transient", () => {
    expect(isTransientNetworkError(new Error("Gemini TTS returned no audio inline data"))).toBe(false);
  });

  it("does not classify aborts as transient", () => {
    expect(isTransientNetworkError(new Error("Aborted"))).toBe(false);
    expect(isTransientNetworkError(new Error("This operation was aborted"))).toBe(false);
  });

  it("does not classify non-Error values as transient", () => {
    expect(isTransientNetworkError("fetch failed?")).toBe(false);
  });
});
