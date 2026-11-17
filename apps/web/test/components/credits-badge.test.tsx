// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CreditsResponse } from "@/lib/api-types";
import { CreditsBadge } from "@/components/credits-badge";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createPortalSession: vi.fn(async () => ({ url: "https://creem.io/portal/x" })),
  createCheckout: vi.fn(),
  getCredits: vi.fn(),
  ApiError: class extends Error {
    constructor(public status: number) {
      super("api");
    }
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderBadge(data: Partial<CreditsResponse> & { balance: number }) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(["credits"], {
    breakdown: { subscription: 0, bonus: 0, purchased: 0 },
    subscription: null,
    ...data,
  });
  return render(
    <QueryClientProvider client={qc}>
      <CreditsBadge />
    </QueryClientProvider>,
  );
}

describe("CreditsBadge", () => {
  it("shows the formatted credit balance", () => {
    renderBadge({ balance: 1234 });
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("renders an account/credits trigger button", () => {
    renderBadge({ balance: 200 });
    expect(screen.getByRole("button", { name: /credits/i })).toBeInTheDocument();
  });

  it("dropdown offers Upgrade plan and Buy credits", async () => {
    renderBadge({ balance: 200 });
    await userEvent.click(screen.getByRole("button", { name: /credits/i }));
    expect(await screen.findByText(/upgrade plan/i)).toBeInTheDocument();
    expect(screen.getByText(/buy credits/i)).toBeInTheDocument();
    // No subscription → no portal entry.
    expect(screen.queryByText(/manage subscription/i)).toBeNull();
  });

  it("shows Manage subscription for an active subscription", async () => {
    renderBadge({
      balance: 3000,
      subscription: { tier: "pro", status: "active", interval: "monthly", currentPeriodEnd: null, cancelAtPeriodEnd: false },
    });
    await userEvent.click(screen.getByRole("button", { name: /credits/i }));
    expect(await screen.findByText(/manage subscription/i)).toBeInTheDocument();
  });

  it("dropdown breaks the balance down by type (subscription / bonus / purchased)", async () => {
    renderBadge({
      balance: 3700,
      breakdown: { subscription: 3000, bonus: 200, purchased: 500 },
      subscription: { tier: "pro", status: "active", interval: "monthly", currentPeriodEnd: null, cancelAtPeriodEnd: false },
    });
    await userEvent.click(screen.getByRole("button", { name: /credits/i }));
    expect(await screen.findByText(/^Subscription/)).toBeInTheDocument();
    expect(screen.getByText(/^Bonus/)).toBeInTheDocument();
    expect(screen.getByText(/^Purchased/)).toBeInTheDocument();
    expect(screen.getByText(/resets monthly/)).toBeInTheDocument();
    // Amounts now render as a CreditMark icon next to the number (no ✦ glyph).
    expect(screen.getByText("3,000")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
  });
});
