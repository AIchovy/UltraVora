// @vitest-environment jsdom
// apps/web/test/components/approval-gate.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalGate } from "@/components/approval-gate";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

const BASE = "http://127.0.0.1:3001";

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE;
});
afterEach(() => vi.restoreAllMocks());

describe("<ApprovalGate>", () => {
  it("returns null when state is not awaiting-gate", () => {
    const { container } = renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "idle" }} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 'approve design' label when phase=design", () => {
    renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "design" }} />);
    expect(screen.getByRole("button", { name: /approve design/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refine/i })).toBeInTheDocument();
  });

  it("tells the user what to actually DO at the research and voiceover gates", () => {
    // "Review the research." says nothing actionable — the research gate exists
    // for curating source assets, the voiceover gate for auditioning audio.
    const r1 = renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "research" }} />);
    expect(screen.getByText(/source images|assets/i)).toBeInTheDocument();
    r1.unmount();
    renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "voiceover" }} />);
    expect(screen.getByText(/listen|audio/i)).toBeInTheDocument();
  });

  it("approve POSTs /messages with text='/approve'", async () => {
    const spy = mockFetch(async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const user = userEvent.setup();
    renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "design" }} />);
    await user.click(screen.getByRole("button", { name: /approve design/i }));
    expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(spy.mock.calls[0]![1]!.body as string)).toEqual({ text: "/approve" });
  });

  it("Refine calls onRefineRequested and does NOT POST", async () => {
    const spy = mockFetch(async () => new Response("", { status: 200 }));
    const cb = vi.fn();
    const user = userEvent.setup();
    renderWithQuery(<ApprovalGate sid="sid1" state={{ kind: "awaiting-gate", phase: "script" }} onRefineRequested={cb} />);
    await user.click(screen.getByRole("button", { name: /refine/i }));
    expect(cb).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
  });
});
