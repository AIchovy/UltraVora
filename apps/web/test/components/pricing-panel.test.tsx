// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { PricingPanel } from "@/components/pricing/pricing-panel";

describe("PricingPanel", () => {
  it("renders all four tiers with monthly prices", () => {
    render(<PricingPanel mode="app" onPurchase={() => {}} />);
    expect(screen.getByText("Free")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Max")).toBeInTheDocument();
    expect(screen.getByText("Ultra")).toBeInTheDocument();
    expect(screen.getByText("$20")).toBeInTheDocument();
    expect(screen.getByText("$40")).toBeInTheDocument();
    expect(screen.getByText("$200")).toBeInTheDocument();
  });

  it("flipping any card's switch re-prices every paid card in sync (linked)", () => {
    render(<PricingPanel mode="app" onPurchase={() => {}} />);
    expect(screen.getByText("$20")).toBeInTheDocument();
    expect(screen.getByText("$40")).toBeInTheDocument();
    expect(screen.getByText("$200")).toBeInTheDocument();

    // Flip only the Pro card's switch...
    const pro = screen.getByTestId("plan-card-pro");
    fireEvent.click(within(pro).getByRole("switch", { name: /billing/i }));

    // ...and all paid cards drop to their 20%-off per-month price.
    expect(screen.getByText("$16")).toBeInTheDocument(); // 20*12*0.8/12
    expect(screen.getByText("$32")).toBeInTheDocument();
    expect(screen.getByText("$160")).toBeInTheDocument();
    // The Max card's switch flipped too (shared state).
    const max = screen.getByTestId("plan-card-max");
    expect(within(max).getByRole("switch", { name: /billing/i })).toBeChecked();
  });

  it("the Free card has no billing switch", () => {
    render(<PricingPanel mode="app" onPurchase={() => {}} />);
    const free = screen.getByTestId("plan-card-free");
    expect(within(free).queryByRole("switch")).not.toBeInTheDocument();
  });

  it("subscribing fires onPurchase with the tier and interval", () => {
    const onPurchase = vi.fn();
    render(<PricingPanel mode="app" onPurchase={onPurchase} />);
    const proCard = screen.getByTestId("plan-card-pro");
    fireEvent.click(within(proCard).getByRole("button", { name: /subscribe/i }));
    expect(onPurchase).toHaveBeenCalledWith({ kind: "subscription", tier: "pro", interval: "monthly" });
  });

  it("subscribing after flipping a switch passes the yearly interval", () => {
    const onPurchase = vi.fn();
    render(<PricingPanel mode="app" onPurchase={onPurchase} />);
    const proCard = screen.getByTestId("plan-card-pro");
    fireEvent.click(within(proCard).getByRole("switch", { name: /billing/i }));
    fireEvent.click(within(proCard).getByRole("button", { name: /subscribe/i }));
    expect(onPurchase).toHaveBeenCalledWith({ kind: "subscription", tier: "pro", interval: "yearly" });
  });

  it("the Credits tab lists packs and buying fires onPurchase with the USD amount", () => {
    const onPurchase = vi.fn();
    render(<PricingPanel mode="app" onPurchase={onPurchase} />);
    fireEvent.click(screen.getByRole("tab", { name: /credits/i }));
    expect(screen.getByText("2,000")).toBeInTheDocument();
    expect(screen.getByText("5,000")).toBeInTheDocument();
    expect(screen.getByText("10,000")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("pack-20"));
    expect(onPurchase).toHaveBeenCalledWith({ kind: "credits", usd: 20 });
  });
});
