// @vitest-environment jsdom
// apps/web/test/lib/api-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createSession,
  patchSession,
  getSession,
  postMessage,
  uploadFiles,
  listArtifacts,
  getArtifact,
  deleteSession,
  resumeSession,
  restoreMp4Version,
  fileUrl,
  ApiError,
} from "@/lib/api-client";
import type { Brief } from "@ultracreator/shared";

const BASE = "http://127.0.0.1:3001";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE;
  // Re-import inside each test to pick up env? Not needed: api-base reads at call time.
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(impl: (input: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("api-client", () => {
  it("createSession POSTs /api/sessions and returns { sessionId }", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions`);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ sessionId: "abc" }), { status: 201 });
    });
    const out = await createSession();
    expect(out).toEqual({ sessionId: "abc" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("sends credentials so the session cookie rides cross-origin requests", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ sessionId: "x" }), { status: 201 }));
    await createSession();
    expect(spy.mock.calls[0]![1]?.credentials).toBe("include");
  });

  it("createSession throws ApiError on non-2xx", async () => {
    mockFetch(async () => new Response("nope", { status: 500 }));
    await expect(createSession()).rejects.toBeInstanceOf(ApiError);
  });

  it("getSession GETs /api/sessions/:sid", async () => {
    mockFetch(async (url) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1`);
      return new Response(
        JSON.stringify({ state: { kind: "idle" }, artifacts: [] }),
        { status: 200 },
      );
    });
    const out = await getSession("sid1");
    expect(out?.state.kind).toBe("idle");
    expect(out?.artifacts).toEqual([]);
  });

  it("getSession returns null on 404 (so React Query can treat it as not-found)", async () => {
    mockFetch(async () => new Response("", { status: 404 }));
    const out = await getSession("missing");
    expect(out).toBeNull();
  });

  it("postMessage POSTs JSON to /messages", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/messages`);
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({ text: "hi" });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });
    await postMessage("sid1", { text: "hi" });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("uploadFiles POSTs multipart and returns the file list", async () => {
    mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/uploads`);
      expect(init?.method).toBe("POST");
      // Browser sets multipart/form-data with boundary when body is FormData.
      // We just assert the body IS a FormData.
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ files: [{ name: "a.png", path: "uploads/a.png" }] }), { status: 201 });
    });
    const out = await uploadFiles("sid1", [new File(["x"], "a.png", { type: "image/png" })]);
    expect(out.files).toEqual([{ name: "a.png", path: "uploads/a.png" }]);
  });

  it("listArtifacts GETs /artifacts and returns descriptors", async () => {
    mockFetch(async (url) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/artifacts`);
      return new Response(JSON.stringify([{ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false, path: "p" }]), { status: 200 });
    });
    const out = await listArtifacts("sid1");
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("brief");
  });

  it("getArtifact returns the latest envelope by default and null on 404", async () => {
    const briefData: Brief = {
      product: { name: "Acme", tagline: "t", description: "d", category: "c" },
      audience: "a", keyMessages: ["k"],
      brandHints: { colors: ["#000"] },
      sourceAssets: { images: [], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    };
    mockFetch(async (url) => {
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: briefData }), { status: 200 });
      }
      return new Response("", { status: 404 });
    });
    const out = await getArtifact("sid1", "brief");
    expect(out?.data.product.name).toBe("Acme");
    const miss = await getArtifact("sid1", "design");
    expect(miss).toBeNull();
  });

  it("getArtifact passes ?version=N", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ kind: "brief", version: 2, createdAt: "t", derivedFrom: null, data: {} }), { status: 200 }));
    await getArtifact("sid1", "brief", 2);
    expect(spy.mock.calls[0]![0]).toBe(`${BASE}/api/sessions/sid1/artifacts/brief?version=2`);
  });

  it("deleteSession DELETEs and resolves on 204", async () => {
    mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1`);
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });
    await expect(deleteSession("sid1")).resolves.toBeUndefined();
  });

  it("fileUrl composes the path", () => {
    expect(fileUrl("sid1", "output/x.mp4")).toBe(`${BASE}/api/sessions/sid1/files/output/x.mp4`);
  });

  it("strips a leading slash from the relative path", () => {
    expect(fileUrl("s1", "/output/x.mp4")).toBe(fileUrl("s1", "output/x.mp4"));
  });

  it("createSession POSTs autoApprove in the body", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions`);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ autoApprove: false });
      return new Response(JSON.stringify({ sessionId: "abc" }), { status: 201 });
    });
    await createSession({ autoApprove: false });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("resumeSession POSTs /resume and resolves on an empty 202 body", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/resume`);
      expect(init?.method).toBe("POST");
      return new Response(null, { status: 202 }); // server sends 202 with no body
    });
    await expect(resumeSession("sid1")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("restoreMp4Version POSTs /artifacts/mp4/:version/restore and returns the payload", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/sid1/artifacts/mp4/2/restore`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ restored: true, version: 4 }), { status: 200 });
    });
    const out = await restoreMp4Version("sid1", 2);
    expect(out).toEqual({ restored: true, version: 4 });
    expect(spy.mock.calls[0]![1]?.credentials).toBe("include");
  });

  it("restoreMp4Version passes through restored:false when the version is already latest", async () => {
    mockFetch(async () => new Response(JSON.stringify({ restored: false, version: 3 }), { status: 200 }));
    const out = await restoreMp4Version("sid1", 3);
    expect(out).toEqual({ restored: false, version: 3 });
  });

  it("restoreMp4Version throws ApiError with the status on 409 (run in flight) and 404 (unknown version)", async () => {
    mockFetch(async () => new Response("busy", { status: 409 }));
    await expect(restoreMp4Version("sid1", 1)).rejects.toMatchObject({ name: "ApiError", status: 409 });
    mockFetch(async () => new Response("missing", { status: 404 }));
    await expect(restoreMp4Version("sid1", 99)).rejects.toMatchObject({ name: "ApiError", status: 404 });
  });

  it("patchSession PATCHes /api/sessions/:sid with the flag", async () => {
    const spy = mockFetch(async (url, init) => {
      expect(url).toBe(`${BASE}/api/sessions/s1`);
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({ autoApprove: true });
      return new Response(null, { status: 204 });
    });
    await patchSession("s1", { autoApprove: true });
    expect(spy).toHaveBeenCalledOnce();
  });
});
