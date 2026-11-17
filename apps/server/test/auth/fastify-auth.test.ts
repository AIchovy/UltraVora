import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { AuthService } from "../../src/auth/auth-service.js";
import { registerAuthRoutes } from "../../src/auth/fastify-auth.js";

function captureService(): { service: AuthService; calls: Request[] } {
  const calls: Request[] = [];
  const service: AuthService = {
    getSession: async () => null,
    handler: async (req) => {
      calls.push(req);
      const res = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      res.headers.append("set-cookie", "a=1; Path=/");
      res.headers.append("set-cookie", "b=2; Path=/");
      return res;
    },
  };
  return { service, calls };
}

describe("registerAuthRoutes", () => {
  it("maps the fastify request to a web Request against the public origin", async () => {
    const app = Fastify();
    const { service, calls } = captureService();
    await registerAuthRoutes(app, service, { publicOrigin: "http://localhost:3000" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/ok",
      headers: { cookie: "x=y" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(calls[0]!.url).toBe("http://localhost:3000/api/auth/ok");
    expect(calls[0]!.headers.get("cookie")).toBe("x=y");
    await app.close();
  });

  it("passes through multiple set-cookie headers", async () => {
    const app = Fastify();
    const { service } = captureService();
    await registerAuthRoutes(app, service, { publicOrigin: "http://localhost:3000" });
    const res = await app.inject({ method: "GET", url: "/api/auth/ok" });
    expect(res.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    await app.close();
  });

  it("re-serializes parsed JSON bodies for POST", async () => {
    const app = Fastify();
    const { service, calls } = captureService();
    await registerAuthRoutes(app, service, { publicOrigin: "http://localhost:3000" });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      payload: { callbackURL: "/login" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.method).toBe("POST");
    expect(await calls[0]!.text()).toBe(JSON.stringify({ callbackURL: "/login" }));
    expect(calls[0]!.headers.get("content-length")).toBeNull();
    await app.close();
  });

  it("sends truly empty body and no content-type for null-body upstream responses (e.g. OAuth 302)", async () => {
    const app = Fastify();
    const redirectUrl = "https://accounts.google.com/o/oauth2/auth?x=1";
    const service: AuthService = {
      getSession: async () => null,
      handler: async () =>
        new Response(null, {
          status: 302,
          headers: { location: redirectUrl },
        }),
    };
    await registerAuthRoutes(app, service, { publicOrigin: "http://localhost:3000" });
    const res = await app.inject({ method: "GET", url: "/api/auth/sign-in/social" });
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe(redirectUrl);
    expect(res.body).toBe("");
    expect(res.headers["content-type"]).toBeUndefined();
    await app.close();
  });
});
