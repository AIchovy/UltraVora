// apps/web/test/lib/detail-loading.test.ts
import { describe, it, expect } from "vitest";
import { isChatLoading } from "@/lib/detail-loading";

describe("isChatLoading", () => {
  it("is false the moment any message exists, regardless of other state", () => {
    expect(
      isChatLoading({ chatEmpty: false, sessionLoading: true, streaming: false, streamErrored: false }),
    ).toBe(false);
  });

  it("is true while the session metadata query is still loading", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: true, streaming: false, streamErrored: false }),
    ).toBe(true);
  });

  it("is true while the stream is still connecting (not open, no error)", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: false, streaming: false, streamErrored: false }),
    ).toBe(true);
  });

  it("is false once the stream is open with an empty log (genuinely empty)", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: false, streaming: true, streamErrored: false }),
    ).toBe(false);
  });

  it("is false when the stream errored before opening (falls through, never stuck)", () => {
    expect(
      isChatLoading({ chatEmpty: true, sessionLoading: false, streaming: false, streamErrored: true }),
    ).toBe(false);
  });
});
