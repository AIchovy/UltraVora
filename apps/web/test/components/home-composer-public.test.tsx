// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HomeComposer } from "@/components/home-composer";
import { renderWithQuery } from "../helpers/render-with-query";
import { createSession } from "@/lib/api-client";
import type { CreditsResponse } from "@/lib/api-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/api-client", () => ({
  createSession: vi.fn(async () => ({ sessionId: "sess-1" })),
  uploadFiles: vi.fn(async () => ({ files: [] })),
  postMessage: vi.fn(async () => {}),
  // Never resolves: the cache seeded via qc.setQueryData stays authoritative
  // instead of being clobbered by a mount refetch.
  getCredits: vi.fn(() => new Promise<never>(() => {})),
}));

function Harness() {
  const [text, setText] = useState("Promo for Acme");
  return (
    <HomeComposer
      text={text} onTextChange={setText}
      duration={30} onDurationChange={() => {}}
      aspect="16:9" onAspectChange={() => {}}
      placeholder="describe…"
    />
  );
}

const credits = (over: Partial<CreditsResponse> = {}): CreditsResponse => ({
  balance: 500, breakdown: { subscription: 0, bonus: 500, purchased: 0 }, subscription: null, freePublicAvailable: true, ...over,
});

/** Open video settings, flip the plaza switch on, and close the dialog. */
async function enablePublic(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /video settings/i }));
  await user.click(await screen.findByRole("switch", { name: /public to plaza/i }));
  await user.click(screen.getByRole("button", { name: "Done" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("<HomeComposer> public toggle (in video settings)", () => {
  it("keeps the plaza switch out of the toolbar", () => {
    renderWithQuery(<Harness />);
    expect(screen.queryByRole("switch", { name: /public to plaza/i })).toBeNull();
  });

  it("defaults the toggle OFF inside the dialog", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    expect(await screen.findByRole("switch", { name: /public to plaza/i })).not.toBeChecked();
  });

  it("shows the Free pill in the dialog whenever the grant is available", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits());
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    // Visible before the switch is even flipped — it advertises the incentive.
    expect(await screen.findByText("Free")).toBeInTheDocument();
  });

  it("hides the Free pill when the grant is used up", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits({ freePublicAvailable: false }));
    await user.click(screen.getByRole("button", { name: /video settings/i }));
    await screen.findByRole("switch", { name: /public to plaza/i });
    expect(screen.queryByText("Free")).toBeNull();
  });

  it("marks the settings trigger active while public is on", async () => {
    const user = userEvent.setup();
    renderWithQuery(<Harness />);
    const trigger = screen.getByRole("button", { name: /video settings/i });
    expect(trigger).not.toHaveAttribute("data-active");
    await enablePublic(user);
    expect(trigger).toHaveAttribute("data-active", "true");
  });

  it("passes isPublic + productUrl to createSession", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits());
    await enablePublic(user);
    await user.click(screen.getByRole("button", { name: /url/i }));
    await user.type(screen.getByLabelText("product url"), "https://acme.com");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() =>
      expect(createSession).toHaveBeenCalledWith(
        expect.objectContaining({ isPublic: true, productUrl: "https://acme.com" }),
      ),
    );
  });

  it("bypasses the out-of-credits block when public + free", async () => {
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<Harness />);
    qc.setQueryData(["credits"], credits({ balance: 0, freePublicAvailable: true }));
    await enablePublic(user);
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(createSession).toHaveBeenCalled());
  });
});
