import { describe, expect, test } from "vitest";
import { ServerEventSchema, SessionStatusSchema } from "../src/index.js";

describe("credit gating types", () => {
  test("awaiting-credits is a valid session status", () => {
    expect(SessionStatusSchema.parse("awaiting-credits")).toBe("awaiting-credits");
  });

  test("credits.required event validates (phase + needed + balance)", () => {
    const e = { type: "credits.required", phase: "compose", needed: 160, balance: 40 };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });

  test("credits.resumed event validates", () => {
    const e = { type: "credits.resumed", phase: "compose" };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });
});
