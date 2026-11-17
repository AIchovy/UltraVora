// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreditsGate } from "@/components/credits-gate";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: () => {} }),
  usePathname: () => "/s/sid1",
}));

const parked = { kind: "awaiting-credits", phase: "research" } as const;
const creditsBody = (balance: number) => ({
  balance,
  breakdown: { subscription: 0, bonus: 0, purchased: balance },
  subscription: null,
});

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});
afterEach(() => vi.restoreAllMocks());

describe("<CreditsGate>", () => {
  it("renders nothing unless the run is parked for credits", () => {
    renderWithQuery(<CreditsGate state={{ kind: "idle" }} sid="sid1" needed={60} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays neutral while the live balance is still loading (no red flash)", () => {
    // The balance fetch never resolves: the gate must not claim "out of
    // credits" it can't yet know — that painted red-then-green on page entry.
    mockFetch(() => new Promise<Response>(() => {}));
    renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={60} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/checking your credit balance/i)).toBeInTheDocument();
  });

  it("falls back to Buy when the balance fetch fails", async () => {
    mockFetch(async () => new Response("boom", { status: 500 }));
    renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={60} />);

    expect(await screen.findByRole("button", { name: /buy credits or upgrade/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("shows Buy (not Continue) while the balance can't cover the step", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(JSON.stringify(creditsBody(25)), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const { qc } = renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={60} />);
    qc.setQueryData(["credits"], creditsBody(25));

    expect(await screen.findByRole("button", { name: /buy credits or upgrade/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("falls back to Buy when the step cost is unknown", async () => {
    mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(JSON.stringify(creditsBody(9999)), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const { qc } = renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={null} />);
    qc.setQueryData(["credits"], creditsBody(9999));

    expect(await screen.findByRole("button", { name: /buy credits or upgrade/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
  });

  it("shows Continue once the balance covers the step, and resumes on click", async () => {
    const spy = mockFetch(async (url) => {
      if (url.endsWith("/api/credits")) return new Response(JSON.stringify(creditsBody(100)), { status: 200 });
      if (url.endsWith("/api/sessions/sid1/resume")) return new Response(null, { status: 202 });
      return new Response("not found", { status: 404 });
    });
    const { qc } = renderWithQuery(<CreditsGate state={parked} sid="sid1" needed={60} />);
    qc.setQueryData(["credits"], creditsBody(100));

    const btn = await screen.findByRole("button", { name: /continue/i });
    expect(screen.queryByRole("button", { name: /buy credits or upgrade/i })).toBeNull();

    await userEvent.click(btn);
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([u, i]) =>
            String(u).endsWith("/api/sessions/sid1/resume") &&
            (i as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
  });
});
