import { describe, it, expect } from "vitest";
import { checkPassword, passwordPolicyMessage, PASSWORD_MIN_LENGTH } from "../src/password.js";

describe("checkPassword", () => {
  it("accepts a 12+ char password with a letter, digit, and symbol", () => {
    const { ok, rules } = checkPassword("Abcdef12345!");
    expect(ok).toBe(true);
    expect(rules).toEqual({ minLength: true, hasLetter: true, hasDigit: true, hasSymbol: true });
  });
  it("rejects when shorter than 12", () => {
    const { ok, rules } = checkPassword("Ab1!xyz");
    expect(ok).toBe(false);
    expect(rules.minLength).toBe(false);
  });
  it("rejects when missing a letter", () => {
    expect(checkPassword("123456789012!").rules.hasLetter).toBe(false);
  });
  it("rejects when missing a digit", () => {
    expect(checkPassword("abcdefghij!!").rules.hasDigit).toBe(false);
  });
  it("rejects when missing a symbol", () => {
    expect(checkPassword("abcdef123456").rules.hasSymbol).toBe(false);
  });
  it("exposes the min length and a human message mentioning 12", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(passwordPolicyMessage()).toMatch(/12/);
  });
});
