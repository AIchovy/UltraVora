// @vitest-environment jsdom
// apps/web/test/components/session-page.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionPage } from "@/components/session-page";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";
import { FakeEventSource, installFakeEventSource } from "../helpers/fake-event-source";
import type { ArtifactDescriptor, Brief } from "@ultracreator/shared";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/s/sid1",
}));

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A widget", category: "saas" },
  audience: "developers",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  localStorage.clear();
  sessionStorage.clear();
  FakeEventSource.reset();
  installFakeEventSource();
});

afterEach(() => vi.restoreAllMocks());

describe("<SessionPage> integration", () => {
  it("shows the simplified follow-up composer (attach only, no constraint buttons)", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [], title: null }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(screen.getByPlaceholderText(/refine|ask|instruct/i)).toBeInTheDocument());
    // The session composer no longer carries duration/aspect/voiceover controls.
    expect(screen.queryByRole("button", { name: "30s" })).toBeNull();
    expect(screen.queryByRole("switch", { name: /voiceover/i })).toBeNull();
    expect(screen.getByLabelText(/attach files/i)).toBeInTheDocument();
  });

  it("renders the BriefCard when an artifact descriptor is returned and the envelope loads", async () => {
    const descriptor: ArtifactDescriptor = {
      kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false,
    };
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [descriptor], title: null }), { status: 200 });
      }
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: brief }), { status: 200 });
      }
      if (url.endsWith("/artifacts")) {
        return new Response(JSON.stringify([descriptor]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());

    // The ApprovalGate renders based on the SSE stream's uiState, not the REST
    // response. Emit a gate.awaiting event to drive the stream into awaiting-gate.
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit(
        "gate.awaiting",
        JSON.stringify({ seq: 1, at: "t", event: { type: "gate.awaiting", phase: "design" } }),
        "1",
      );
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /approve design/i })).toBeInTheDocument());
  });

  it("approving from the gate POSTs /messages", async () => {
    const descriptor: ArtifactDescriptor = {
      kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false,
    };
    const spy = mockFetch(async (url, init) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [descriptor], title: null }), { status: 200 });
      }
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: brief }), { status: 200 });
      }
      if (url.endsWith("/artifacts")) {
        return new Response(JSON.stringify([descriptor]), { status: 200 });
      }
      if (url.endsWith("/messages")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      }
      return new Response("not found", { status: 404 });
    });
    const user = userEvent.setup();
    renderWithQuery(<SessionPage sid="sid1" />);

    // Drive the stream into awaiting-gate so the ApprovalGate renders.
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit(
        "gate.awaiting",
        JSON.stringify({ seq: 1, at: "t", event: { type: "gate.awaiting", phase: "design" } }),
        "1",
      );
    });

    const approve = await screen.findByRole("button", { name: /approve design/i });
    await user.click(approve);
    await waitFor(() =>
      expect(spy.mock.calls.some(([url]) => String(url).endsWith("/messages"))).toBe(true),
    );
  });

  it("shows loading skeletons before data arrives, then real content", async () => {
    const descriptor: ArtifactDescriptor = {
      kind: "brief", version: 1, createdAt: "t", derivedFrom: null, stale: false,
    };
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [descriptor], title: "My promo" }), { status: 200 });
      }
      if (url.endsWith("/artifacts/brief")) {
        return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: brief }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    const { container } = renderWithQuery(<SessionPage sid="sid1" />);

    // Initial synchronous render: metadata query pending, stream not yet open.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/nothing to preview yet/i)).toBeNull();

    // Once metadata + artifact resolve, the title shows and skeletons clear.
    await waitFor(() => expect(screen.getByText("My promo")).toBeInTheDocument());
    await waitFor(() => expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0));
  });

  it("drops the conversation skeleton once connected with an empty log", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [], title: "Empty" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    // After metadata loads and the (fake) stream opens, the conversation shows
    // its genuine empty state rather than staying on the skeleton.
    await waitFor(() => expect(screen.getByText(/waiting for the agent/i)).toBeInTheDocument());
  });

  it("renders the out-of-credits gate when a credits.required frame arrives", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [], title: "Promo" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());

    // The server parked at research (e.g. 25 credits < 60). This is a *named*
    // SSE frame — the stream must listen for "credits.required" or the gate
    // never renders and the UI is stuck on "Ready".
    await act(async () => {
      FakeEventSource.instances[0]!.emit(
        "credits.required",
        JSON.stringify({
          seq: 1,
          at: "t",
          event: { type: "credits.required", phase: "research", needed: 60, balance: 25 },
        }),
        "1",
      );
    });

    expect(
      await screen.findByRole("button", { name: /buy credits or upgrade/i }),
    ).toBeInTheDocument();
  });

  it("shows Continue (not Buy) when the live balance already covers the parked step", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "idle" }, artifacts: [], title: "Promo" }), { status: 200 });
      }
      if (url.endsWith("/api/credits")) {
        return new Response(
          JSON.stringify({ balance: 100, breakdown: { subscription: 0, bonus: 0, purchased: 100 }, subscription: null }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());

    // Server parked at research (needs 60). The wallet already holds 100, so the
    // gate must offer Continue rather than Buy.
    await act(async () => {
      FakeEventSource.instances[0]!.emit(
        "credits.required",
        JSON.stringify({ seq: 1, at: "t", event: { type: "credits.required", phase: "research", needed: 60, balance: 25 } }),
        "1",
      );
    });

    expect(await screen.findByRole("button", { name: /continue/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy credits or upgrade/i })).toBeNull();
  });

  it("overlays 'Updating video…' on the video pane when an adjustment run starts after an mp4 exists", async () => {
    const mp4: ArtifactDescriptor = { kind: "mp4", version: 1, createdAt: "t", derivedFrom: null, stale: false };
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(JSON.stringify({ state: { kind: "done" }, artifacts: [mp4], title: "Promo" }), { status: 200 });
      }
      if (url.endsWith("/artifacts/mp4")) {
        return new Response(
          JSON.stringify({ kind: "mp4", version: 1, createdAt: "t", derivedFrom: null, data: { path: "output/x.mp4", durationSec: 30 } }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);

    // The finished video renders quietly — no overlay while nothing runs.
    await waitFor(() => expect(screen.getByRole("link", { name: /download/i })).toBeInTheDocument());
    expect(screen.queryByText(/updating video/i)).toBeNull();

    // The user chats an adjustment → the server re-runs compose.
    await act(async () => {
      FakeEventSource.instances[0]!.emit(
        "phase.started",
        JSON.stringify({ seq: 1, at: "t", event: { type: "phase.started", phase: "compose", at: "t" } }),
        "1",
      );
    });
    expect(await screen.findByText(/updating video/i)).toBeInTheDocument();

    // Render progress upgrades the label to a live percentage.
    await act(async () => {
      FakeEventSource.instances[0]!.emit(
        "render.progress",
        JSON.stringify({ seq: 2, at: "t", event: { type: "render.progress", percent: 55 } }),
        "2",
      );
    });
    expect(await screen.findByText(/re-rendering… 55%/i)).toBeInTheDocument();

    // The re-render completes → the overlay goes away.
    await act(async () => {
      FakeEventSource.instances[0]!.emit(
        "render.done",
        JSON.stringify({ seq: 3, at: "t", event: { type: "render.done", mp4Path: "output/y.mp4" } }),
        "3",
      );
    });
    await waitFor(() => expect(screen.queryByText(/re-rendering|updating video/i)).toBeNull());
  });

  it("falls back to the REST status (and flags reconnecting) when the SSE stream errors", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/sessions/sid1")) {
        return new Response(
          JSON.stringify({ state: { kind: "awaiting-credits", phase: "research" }, artifacts: [], title: "Promo" }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    renderWithQuery(<SessionPage sid="sid1" />);
    await waitFor(() => expect(FakeEventSource.instances[0]).toBeDefined());

    // The live stream drops without delivering anything. The durable REST status
    // says the run is parked for credits, so the gate must still render rather
    // than the page reading as "Ready".
    await act(async () => {
      FakeEventSource.instances[0]!.fail();
    });

    expect(
      await screen.findByRole("button", { name: /buy credits or upgrade/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
