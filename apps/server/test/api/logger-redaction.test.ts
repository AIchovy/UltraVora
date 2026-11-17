import { describe, it, expect } from "vitest";
import { redactAuthUrl } from "../../src/api/app.js";

describe("redactAuthUrl", () => {
  it("redacts query strings on /api/auth/ URLs", () => {
    expect(redactAuthUrl("/api/auth/callback/google?code=secret&state=xyz")).toBe(
      "/api/auth/callback/google?[redacted]",
    );
  });

  it("leaves non-auth URLs unchanged", () => {
    expect(redactAuthUrl("/api/sessions/x?y=1")).toBe("/api/sessions/x?y=1");
  });

  it("leaves /api/auth/ URL with no query string unchanged", () => {
    expect(redactAuthUrl("/api/auth/sign-in/social")).toBe("/api/auth/sign-in/social");
  });

  it("leaves an empty string unchanged", () => {
    expect(redactAuthUrl("")).toBe("");
  });
});
