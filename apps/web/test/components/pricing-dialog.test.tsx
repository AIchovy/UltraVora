// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PricingDialog } from "@/components/pricing/pricing-dialog";

const { createCheckout } = vi.hoisted(() => ({ createCheckout: vi.fn() }));
vi.mock("@/lib/api-client", () => ({
  createCheckout,
  getCredits: vi.fn(), // use-credits imports it from the same module
  ApiError: class extends Error {
    constructor(public status: number) {
      super("api");
    }
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PricingDialog open onOpenChange={() => {}} mode="app" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createCheckout.mockReset();
  // window.location.assign is not writable in jsdom; stub the whole location.
  Object.defineProperty(window, "location", {
    value: { ...window.location, assign: vi.fn() },
    writable: true,
  });
});

describe("PricingDialog purchase flow", () => {
  it("redirects to the Creem checkout URL for a subscription", async () => {
    createCheckout.mockResolvedValue({ url: "https://creem.io/checkout/x" });
    renderDialog();
    await userEvent.click(screen.getAllByRole("button", { name: /subscribe/i })[0]!);
    await waitFor(() =>
      expect(window.location.assign).toHaveBeenCalledWith("https://creem.io/checkout/x"));
    expect(createCheckout).toHaveBeenCalledWith({ kind: "subscription", tier: "pro", interval: "monthly" });
  });

  it("stays in-app on the stub fallback (balance, no url)", async () => {
    createCheckout.mockResolvedValue({ url: null, balance: 2200 });
    renderDialog();
    await userEvent.click(screen.getByRole("tab", { name: /credits/i }));
    await userEvent.click(await screen.findByTestId("pack-20"));
    await waitFor(() => expect(createCheckout).toHaveBeenCalledWith({ kind: "credits", usd: 20 }));
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});
