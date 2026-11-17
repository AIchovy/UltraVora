import { describe, it, expect } from "vitest";
import {
  buildAuthConfig,
  deriveCookieDomain,
  passwordFromAuthBody,
  nicknameFromAuthBody,
  assertVerificationOtpType,
} from "../../src/auth/better-auth.js";

const base = {
  baseURL: "http://localhost:3000",
  secret: "test-secret",
  google: { clientId: "id", clientSecret: "secret" },
  email: { sendVerificationCode: async () => {} },
};

describe("buildAuthConfig", () => {
  it("trusts the baseURL + loopback variant and sets no cross-subdomain cookies by default", () => {
    const cfg = buildAuthConfig(base);
    expect(cfg.trustedOrigins).toEqual([
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]);
    expect(cfg).not.toHaveProperty("advanced");
  });

  it("adds WEB_ORIGIN to trustedOrigins and scopes the cookie to the parent domain when configured", () => {
    const cfg = buildAuthConfig({
      ...base,
      baseURL: "https://api.example.com",
      webOrigin: "https://app.example.com",
      cookieDomain: ".example.com",
    });
    expect(cfg.trustedOrigins).toContain("https://app.example.com");
    expect(cfg).toMatchObject({
      advanced: { crossSubDomainCookies: { enabled: true, domain: ".example.com" } },
    });
  });
});

describe("buildAuthConfig email/password", () => {
  it("enables email+password with the 12-char minimum and required verification", () => {
    const cfg = buildAuthConfig(base);
    expect(cfg.emailAndPassword).toMatchObject({
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
    });
  });
  it("registers the emailOTP plugin", () => {
    const cfg = buildAuthConfig(base);
    expect(Array.isArray(cfg.plugins)).toBe(true);
    expect((cfg.plugins ?? []).length).toBeGreaterThan(0);
  });
  it("keeps google as a trusted linking provider", () => {
    const cfg = buildAuthConfig(base);
    expect(cfg.account?.accountLinking?.trustedProviders).toContain("google");
  });
});

describe("deriveCookieDomain", () => {
  it("returns the shared parent domain of the web and api subdomains", () => {
    expect(deriveCookieDomain("https://app.example.com", "https://api.example.com")).toBe(".example.com");
    expect(deriveCookieDomain("https://app.example.co.uk", "https://api.example.co.uk")).toBe(".example.co.uk");
  });

  it("returns undefined when the hosts share no multi-label parent (cross-site or dev)", () => {
    expect(deriveCookieDomain("https://app.foo.com", "https://api.bar.com")).toBeUndefined();
    expect(deriveCookieDomain("http://localhost:3000", "http://127.0.0.1:3001")).toBeUndefined();
  });

  it("returns undefined when both origins are the same host (no sharing needed)", () => {
    expect(deriveCookieDomain("https://x.example.com", "https://x.example.com")).toBeUndefined();
  });
});

describe("passwordFromAuthBody", () => {
  it("returns null for non-password-setting paths", () => {
    expect(passwordFromAuthBody("/sign-in/email", { password: "x" })).toBeNull();
  });
  it("reads `password` on sign-up", () => {
    expect(passwordFromAuthBody("/sign-up/email", { password: "Abcdef12345!" })).toBe("Abcdef12345!");
  });
  it("reads `newPassword` on change-password, set-password, and reset-password", () => {
    expect(passwordFromAuthBody("/change-password", { newPassword: "Abcdef12345!" })).toBe("Abcdef12345!");
    expect(passwordFromAuthBody("/set-password", { newPassword: "Abcdef12345!" })).toBe("Abcdef12345!");
    expect(passwordFromAuthBody("/reset-password", { newPassword: "Abcdef12345!" })).toBe("Abcdef12345!");
  });
  it("reads `password` on the emailOTP reset-password path", () => {
    expect(passwordFromAuthBody("/email-otp/reset-password", { password: "Abcdef12345!" })).toBe("Abcdef12345!");
  });
  it("returns '' (fails closed) when the field is missing or not a string", () => {
    expect(passwordFromAuthBody("/sign-up/email", {})).toBe("");
    expect(passwordFromAuthBody("/sign-up/email", { password: 123 })).toBe("");
    expect(passwordFromAuthBody("/sign-up/email", undefined)).toBe("");
  });
});

describe("nicknameFromAuthBody", () => {
  it("returns null off the sign-up path", () => {
    expect(nicknameFromAuthBody("/sign-in/email", { name: "alice" })).toBeNull();
    expect(nicknameFromAuthBody("/change-password", { name: "alice" })).toBeNull();
  });
  it("reads `name` on sign-up", () => {
    expect(nicknameFromAuthBody("/sign-up/email", { name: "alice_99" })).toBe("alice_99");
  });
  it("returns '' (fails closed) when name is missing or not a string", () => {
    expect(nicknameFromAuthBody("/sign-up/email", {})).toBe("");
    expect(nicknameFromAuthBody("/sign-up/email", { name: 123 })).toBe("");
    expect(nicknameFromAuthBody("/sign-up/email", undefined)).toBe("");
  });
});

describe("assertVerificationOtpType", () => {
  it("allows email-verification", () => {
    expect(() => assertVerificationOtpType("email-verification")).not.toThrow();
  });
  it("rejects sign-in and forget-password OTP types", () => {
    expect(() => assertVerificationOtpType("sign-in")).toThrow();
    expect(() => assertVerificationOtpType("forget-password")).toThrow();
  });
});
