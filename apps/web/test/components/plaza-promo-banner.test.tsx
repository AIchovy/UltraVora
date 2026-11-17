// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlazaPromoBanner } from "@/components/plaza-promo-banner";

beforeEach(() => {
  localStorage.clear();
});

describe("<PlazaPromoBanner>", () => {
  it("shows the limited-time free publish pitch by default", () => {
    render(<PlazaPromoBanner />);
    expect(screen.getByText(/limited-time offer/i)).toBeInTheDocument();
    expect(screen.getByText(/product plaza/i)).toBeInTheDocument();
  });

  it("dismisses on ✕ and persists the choice", async () => {
    const user = userEvent.setup();
    render(<PlazaPromoBanner />);
    await user.click(screen.getByRole("button", { name: /dismiss plaza promo/i }));
    expect(screen.queryByText(/limited-time offer/i)).toBeNull();
    expect(localStorage.getItem("uc.plazaPromoDismissed")).toBe("true");
  });

  it("stays hidden when previously dismissed", async () => {
    localStorage.setItem("uc.plazaPromoDismissed", "true");
    render(<PlazaPromoBanner />);
    // usePersistentState hydrates in a mount effect, so disappearance is async.
    await waitFor(() => expect(screen.queryByText(/limited-time offer/i)).toBeNull());
  });
});
