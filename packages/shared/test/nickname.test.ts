import { describe, it, expect } from "vitest";
import { checkNickname, nicknamePolicyMessage, NICKNAME_MIN_LENGTH, NICKNAME_MAX_LENGTH } from "../src/nickname.js";

describe("checkNickname", () => {
  it("accepts 3–20 chars of letters, numbers, or underscores", () => {
    expect(checkNickname("alice_99")).toBe(true);
    expect(checkNickname("abc")).toBe(true);
    expect(checkNickname("a".repeat(20))).toBe(true);
    expect(checkNickname("A_1")).toBe(true);
  });
  it("rejects when shorter than 3 or longer than 20", () => {
    expect(checkNickname("ab")).toBe(false);
    expect(checkNickname("a".repeat(21))).toBe(false);
  });
  it("rejects spaces and other symbols", () => {
    expect(checkNickname("bad name")).toBe(false);
    expect(checkNickname("hi!there")).toBe(false);
    expect(checkNickname("dash-name")).toBe(false);
  });
  it("exposes the bounds and a message mentioning them", () => {
    expect(NICKNAME_MIN_LENGTH).toBe(3);
    expect(NICKNAME_MAX_LENGTH).toBe(20);
    expect(nicknamePolicyMessage()).toMatch(/3/);
    expect(nicknamePolicyMessage()).toMatch(/20/);
  });
});
