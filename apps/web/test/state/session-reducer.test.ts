import { describe, it, expect } from "vitest";
import { initialUiState, reduce, type UiState } from "@/state/session-reducer";
import type { ServerEvent } from "@ultracreator/shared";

const at = "2026-06-01T00:00:00.000Z";

describe("session-reducer", () => {
  it("initialUiState is idle with empty chat + no current phase + 0% render", () => {
    expect(initialUiState).toEqual({
      status: { kind: "idle" },
      chat: [],
      currentPhase: null,
      renderPercent: 0,
      mp4Path: null,
      lastError: null,
      latestArtifacts: {},
      creditsRequired: null,
    });
  });

  it("credits.required parks the run and records what the gate needs", () => {
    const s = reduce(initialUiState, { type: "credits.required", phase: "script", needed: 10, balance: 5 });
    expect(s.status).toEqual({ kind: "awaiting-credits", phase: "script" });
    expect(s.creditsRequired).toEqual({ phase: "script", needed: 10, balance: 5 });
  });

  it("credits.resumed flips back to running and clears the gate (no out-of-credits flash)", () => {
    const parked = reduce(initialUiState, { type: "credits.required", phase: "script", needed: 10, balance: 5 });
    const resumed = reduce(parked, { type: "credits.resumed", phase: "script" });
    // The run is resuming the parked phase — NOT still awaiting-credits, or the
    // gate would paint the red "out of credits" banner for a frame.
    expect(resumed.status).toEqual({ kind: "running", phase: "script" });
    expect(resumed.currentPhase).toBe("script");
    expect(resumed.creditsRequired).toBeNull();
    expect(resumed.chat.at(-1)).toEqual({ kind: "notice", message: "Resuming…" });
  });

  it("phase.started sets currentPhase + status=running and appends a chat row", () => {
    const ev: ServerEvent = { type: "phase.started", phase: "research", at };
    const next = reduce(initialUiState, ev);
    expect(next.status).toEqual({ kind: "running", phase: "research" });
    expect(next.currentPhase).toBe("research");
    expect(next.chat).toEqual([{ kind: "phase-start", phase: "research", at }]);
  });

  it("phase.started resets renderPercent so a prior run's 100% doesn't leak into the new run", () => {
    // A finished run leaves renderPercent at 100. When the user asks for an
    // adjustment, the new run's phase.started must zero it or the video pane's
    // "Re-rendering… {n}%" label would open at a stale 100%.
    const done = reduce(initialUiState, { type: "render.done", mp4Path: "output/x.mp4" });
    expect(done.renderPercent).toBe(100);
    const next = reduce(done, { type: "phase.started", phase: "compose", at });
    expect(next.renderPercent).toBe(0);
  });

  it("phase.progress appends a progress row", () => {
    const a = reduce(initialUiState, { type: "phase.started", phase: "research", at });
    const b = reduce(a, { type: "phase.progress", phase: "research", message: "fetched" });
    expect(b.chat[b.chat.length - 1]).toEqual({ kind: "progress", phase: "research", message: "fetched" });
  });

  it("phase.error sets status=error and records lastError", () => {
    const a = reduce(initialUiState, { type: "phase.started", phase: "design", at });
    const b = reduce(a, { type: "phase.error", phase: "design", error: "boom" });
    expect(b.status).toEqual({ kind: "error", phase: "design", error: "boom" });
    expect(b.lastError).toEqual({ phase: "design", error: "boom" });
  });

  it("gate.awaiting flips status to awaiting-gate", () => {
    const a = reduce(initialUiState, { type: "phase.started", phase: "design", at });
    const b = reduce(a, { type: "gate.awaiting", phase: "design" });
    expect(b.status).toEqual({ kind: "awaiting-gate", phase: "design" });
    expect(b.chat[b.chat.length - 1]).toEqual({ kind: "gate", phase: "design" });
  });

  it("artifact.created updates latestArtifacts[kind]=version", () => {
    const a = reduce(initialUiState, { type: "artifact.created", kind: "brief", version: 1 });
    const b = reduce(a, { type: "artifact.created", kind: "brief", version: 2 });
    expect(b.latestArtifacts.brief).toBe(2);
  });

  it("artifact.stale does not delete latestArtifacts entries (UI uses staleness from descriptor)", () => {
    const a = reduce(initialUiState, { type: "artifact.created", kind: "design", version: 1 });
    const b = reduce(a, { type: "artifact.stale", kind: "design", version: 1 });
    expect(b.latestArtifacts.design).toBe(1);
  });

  it("render.progress updates renderPercent (clamped 0..100)", () => {
    const a = reduce(initialUiState, { type: "render.progress", percent: 35 });
    expect(a.renderPercent).toBe(35);
    const b = reduce(a, { type: "render.progress", percent: 999 });
    expect(b.renderPercent).toBe(100);
  });

  it("render.done sets mp4Path and status=done", () => {
    const a = reduce(initialUiState, { type: "render.done", mp4Path: "output/x.mp4" });
    expect(a.mp4Path).toBe("output/x.mp4");
    expect(a.status).toEqual({ kind: "done" });
    expect(a.renderPercent).toBe(100);
  });

  it("render.error sets status=error and records lastError", () => {
    const a = reduce(initialUiState, { type: "render.error", error: "ffmpeg died" });
    expect(a.status.kind).toBe("error");
    expect(a.lastError).toEqual({ phase: "render", error: "ffmpeg died" });
  });

  it("reduce is pure: input state is not mutated", () => {
    const a: UiState = initialUiState;
    reduce(a, { type: "phase.started", phase: "research", at });
    expect(a).toBe(initialUiState);
    expect(a.chat).toEqual([]);
  });
});

describe("session-reducer: user.message", () => {
  it("appends a user-message chat row carrying text, files, clientId, and a numeric at", () => {
    const ev: ServerEvent = {
      type: "user.message",
      text: "make me a promo",
      files: ["logo.png"],
      clientId: "c-1",
      at,
    };
    const next = reduce(initialUiState, ev);
    expect(next.chat).toEqual([
      { kind: "user-message", text: "make me a promo", files: ["logo.png"], clientId: "c-1", at: Date.parse(at) },
    ]);
  });

  it("dedupes against an existing optimistic echo with the same clientId", () => {
    // Optimistic echo already in chat (as use-session-stream would add it).
    const seeded: UiState = {
      ...initialUiState,
      chat: [{ kind: "user-message", text: "hi", clientId: "c-9", at: 111 }],
    };
    const next = reduce(seeded, { type: "user.message", text: "hi", clientId: "c-9", at });
    expect(next.chat).toHaveLength(1);
    expect(next).toBe(seeded); // unchanged reference — no duplicate appended
  });

  it("appends when there is no matching clientId (e.g. on reload, no optimistic echo)", () => {
    const next = reduce(initialUiState, { type: "user.message", text: "first prompt", clientId: "c-2", at });
    expect(next.chat).toHaveLength(1);
    expect(next.chat[0]).toMatchObject({ kind: "user-message", text: "first prompt", clientId: "c-2" });
  });
});

describe("session-reducer: intent.unhandled", () => {
  it("appends a notice chat row without touching status", () => {
    const ev: ServerEvent = { type: "intent.unhandled", message: "I can't act on that message yet." };
    const next = reduce(initialUiState, ev);
    expect(next.status).toEqual({ kind: "idle" });
    expect(next.chat).toEqual([{ kind: "notice", message: "I can't act on that message yet." }]);
  });
});
