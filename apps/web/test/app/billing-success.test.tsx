// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import BillingSuccessPage from "@/app/billing/success/page";

const { getCredits } = vi.hoisted(() => ({ getCredits: vi.fn() }));
vi.mock("@/lib/api-client", () => ({ getCredits }));

let params = new URLSearchParams("kind=credits&credits=2000");
vi.mock("next/navigation", () => ({
  useSearchParams: () => params,
}));

const credits = (balance: number, tier: string | null = null) => ({
  balance,
  breakdown: { subscription: 0, bonus: 0, purchased: balance },
  subscription: tier
    ? { tier, status: "active", interval: "monthly", currentPeriodEnd: null, cancelAtPeriodEnd: false }
    : null,
  freePublicAvailable: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  getCredits.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("BillingSuccessPage", () => {
  it("shows pending copy, then success once the balance grows", async () => {
    params = new URLSearchParams("kind=credits&credits=2000");
    getCredits
      .mockResolvedValueOnce(credits(200)) // baseline
      .mockResolvedValueOnce(credits(200)) // still waiting
      .mockResolvedValue(credits(2200)); // webhook landed
    render(<BillingSuccessPage />);
    // The waiting state renders synchronously (findBy* would hang under fake timers).
    expect(screen.getByText(/payment received/i)).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2100));
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(screen.getByText(/2,000 credits added/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toBeInTheDocument();
  });

  it("resolves a subscription purchase when the tier appears", async () => {
    params = new URLSearchParams("kind=subscription&tier=pro");
    getCredits
      .mockResolvedValueOnce(credits(200))
      .mockResolvedValue(credits(3200, "pro"));
    render(<BillingSuccessPage />);
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(screen.getByText(/pro plan is active/i)).toBeInTheDocument();
  });

  it("times out to a reassuring state instead of spinning forever", async () => {
    params = new URLSearchParams("kind=credits&credits=2000");
    getCredits.mockResolvedValue(credits(200));
    render(<BillingSuccessPage />);
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(screen.getByText(/on their way/i)).toBeInTheDocument();
  });
});
