import { describe, it, expect } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { requireOwnedSession } from "../../src/api/route-helpers.js";
import { InMemorySessionRepository } from "../helpers/in-memory-session-repository.js";

function fakeReply() {
  const state = { statusCode: 0, body: undefined as unknown };
  const reply = {
    code(c: number) { state.statusCode = c; return reply; },
    send(b: unknown) { state.body = b; return reply; },
    _state: state,
  };
  return reply as unknown as FastifyReply & { _state: { statusCode: number; body: unknown } };
}

function reqFor(sid: string, userId: string | undefined) {
  return {
    params: { sid },
    authUser: userId ? { id: userId, email: "e", name: "n", image: null } : undefined,
  } as unknown as FastifyRequest<{ Params: { sid: string } }>;
}

const VALID = "11111111-1111-4111-8111-111111111111";

describe("requireOwnedSession", () => {
  it("returns the sid when the caller owns the session", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: VALID, userId: "u1" });
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor(VALID, "u1"), reply, sessions);
    expect(sid).toBe(VALID);
    expect(reply._state.statusCode).toBe(0);
  });

  it("400 on a malformed id", async () => {
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor("has..slash", "u1"), reply, new InMemorySessionRepository());
    expect(sid).toBeNull();
    expect(reply._state.statusCode).toBe(400);
  });

  it("404 when the session does not exist", async () => {
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor("22222222-2222-4222-8222-222222222222", "u1"), reply, new InMemorySessionRepository());
    expect(sid).toBeNull();
    expect(reply._state.statusCode).toBe(404);
  });

  it("404 (not 403) when another user owns the session", async () => {
    const sessions = new InMemorySessionRepository();
    await sessions.create({ id: VALID, userId: "owner" });
    const reply = fakeReply();
    const sid = await requireOwnedSession(reqFor(VALID, "intruder"), reply, sessions);
    expect(sid).toBeNull();
    expect(reply._state.statusCode).toBe(404);
  });
});
