import { describe, it, expect, vi, beforeEach } from "vitest";

let cookieValue: string | null = null;
vi.mock("next/headers", () => ({
  headers: async () => new Headers(cookieValue ? { cookie: cookieValue } : {}),
}));

import { getServerSession } from "@/lib/server-session";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  cookieValue = null;
});

describe("getServerSession", () => {
  it("returns null without a cookie and does not call the API", async () => {
    expect(await getServerSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null without an auth roundtrip when only unrelated cookies are present", async () => {
    cookieValue = "ga=1; theme=dark";
    expect(await getServerSession()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the session when the API recognizes the cookie", async () => {
    cookieValue = "better-auth.session_token=abc";
    const session = { user: { id: "u1", email: "a@x.com", name: "A", image: null } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(session), { status: 200 }));
    expect(await getServerSession()).toEqual(session);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/auth/get-session");
    expect((init as RequestInit).headers).toEqual({ cookie: cookieValue });
  });

  it("returns null when the API replies with JSON null (no session)", async () => {
    cookieValue = "better-auth.session_token=expired";
    fetchMock.mockResolvedValue(new Response("null", { status: 200 }));
    expect(await getServerSession()).toBeNull();
  });

  it("returns null when the API is unreachable", async () => {
    cookieValue = "better-auth.session_token=abc";
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await getServerSession()).toBeNull();
  });

  it("returns null when the API replies with a 5xx error", async () => {
    cookieValue = "better-auth.session_token=abc";
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    expect(await getServerSession()).toBeNull();
  });
});
