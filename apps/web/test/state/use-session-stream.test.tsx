// @vitest-environment jsdom
// apps/web/test/state/use-session-stream.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSessionStream } from "@/state/use-session-stream";
import { FakeEventSource, installFakeEventSource } from "../helpers/fake-event-source";
import type { ServerEvent } from "@ultracreator/shared";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  sessionStorage.clear();
  FakeEventSource.reset();
  installFakeEventSource();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

function envelope(seq: number, event: ServerEvent) {
  return { seq, at: "t", event };
}

describe("useSessionStream", () => {
  it("opens an EventSource with lastEventId=0 on first connect", async () => {
    renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 0));
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("http://127.0.0.1:3001/api/sessions/sid1/stream?lastEventId=0");
  });

  it("opens the stream with credentials so the auth cookie rides cross-origin", () => {
    renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    const es = FakeEventSource.instances[0]!;
    expect(es.withCredentials).toBe(true);
  });

  it("always connects with lastEventId=0 even when sessionStorage has a prior value", () => {
    // Since commit 0bd26f0 the hook always replays the full event log on mount
    // and dedupes via in-memory seenSeq — sessionStorage is intentionally ignored.
    sessionStorage.setItem("uc.lastEventId.sid1", "17");
    renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    const es = FakeEventSource.instances[0]!;
    expect(es.url).toBe("http://127.0.0.1:3001/api/sessions/sid1/stream?lastEventId=0");
  });

  it("reduces incoming events into uiState", async () => {
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("phase.started", JSON.stringify(envelope(1, { type: "phase.started", phase: "research", at: "t" })), "1");
      es.emit("phase.progress", JSON.stringify(envelope(2, { type: "phase.progress", phase: "research", message: "x" })), "2");
    });
    expect(result.current.uiState.status).toEqual({ kind: "running", phase: "research" });
    expect(result.current.uiState.chat).toHaveLength(2);
  });

  it("does NOT write lastEventId to sessionStorage (full-replay strategy)", async () => {
    // Since commit 0bd26f0 the hook deduplicates via in-memory seenSeq and never
    // persists lastEventId to sessionStorage — sessionStorage stays empty.
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("phase.progress", JSON.stringify(envelope(5, { type: "phase.progress", phase: "research", message: "x" })), "5");
    });
    expect(sessionStorage.getItem("uc.lastEventId.sid1")).toBeNull();
    expect(result.current.uiState.chat).toHaveLength(1);
  });

  it("ignores duplicates by seq (in case the server replays past the cutover)", async () => {
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      const ev: ServerEvent = { type: "phase.progress", phase: "research", message: "x" };
      es.emit("phase.progress", JSON.stringify(envelope(1, ev)), "1");
      es.emit("phase.progress", JSON.stringify(envelope(1, ev)), "1"); // dupe
    });
    expect(result.current.uiState.chat).toHaveLength(1);
  });

  it("invalidates the artifact query on artifact.created", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const W = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useSessionStream("sid1"), { wrapper: W });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("artifact.created", JSON.stringify(envelope(1, { type: "artifact.created", kind: "brief", version: 1 })), "1");
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["artifact", "sid1", "brief"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["artifacts", "sid1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["session", "sid1"] });
  });

  it("invalidates the artifact queries on artifact.stale so stale badges refresh promptly", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const W = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useSessionStream("sid1"), { wrapper: W });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("artifact.stale", JSON.stringify(envelope(1, { type: "artifact.stale", kind: "script", version: 2 })), "1");
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["artifact", "sid1", "script"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["artifacts", "sid1"] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["session", "sid1"] });
  });

  it("patches the cached credits balance from a credits.required event (gate sees the true balance)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Stale-high cache (what the badge last saw). The event's balance is the truth.
    qc.setQueryData(["credits"], { balance: 20, breakdown: { subscription: 0, bonus: 0, purchased: 20 }, subscription: null });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const W = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useSessionStream("sid1"), { wrapper: W });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("credits.required", JSON.stringify(envelope(1, { type: "credits.required", phase: "script", needed: 10, balance: 5 })), "1");
    });
    expect((qc.getQueryData(["credits"]) as { balance: number }).balance).toBe(5);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["credits"] });
  });

  it("refreshes the credits balance when a phase starts (a charge just happened)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const W = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    renderHook(() => useSessionStream("sid1"), { wrapper: W });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit("phase.started", JSON.stringify(envelope(1, { type: "phase.started", phase: "script", at: "t" })), "1");
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["credits"] });
  });

  it("dedupes an optimistic user message against the replayed user.message event by clientId", async () => {
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    // Optimistic echo first, as the composer does on send.
    act(() => result.current.addUserMessage("make a promo", undefined, "c-7"));
    // Server replays the same message back as a persisted event.
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit(
        "user.message",
        JSON.stringify(envelope(1, { type: "user.message", text: "make a promo", clientId: "c-7", at: "t" })),
        "1",
      );
    });
    const userMsgs = result.current.uiState.chat.filter((c) => c.kind === "user-message");
    expect(userMsgs).toHaveLength(1);
  });

  it("renders a user.message event with no prior optimistic echo (the reload case)", async () => {
    const { result } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await act(async () => {
      const es = FakeEventSource.instances[0]!;
      es.emit(
        "user.message",
        JSON.stringify(envelope(1, { type: "user.message", text: "first prompt", clientId: "c-8", at: "t" })),
        "1",
      );
    });
    const userMsgs = result.current.uiState.chat.filter((c) => c.kind === "user-message");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]).toMatchObject({ kind: "user-message", text: "first prompt" });
  });

  it("closes the EventSource on unmount", async () => {
    const { unmount } = renderHook(() => useSessionStream("sid1"), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 0));
    const es = FakeEventSource.instances[0]!;
    expect(es.readyState).toBe(1);
    unmount();
    expect(es.readyState).toBe(2);
  });
});
