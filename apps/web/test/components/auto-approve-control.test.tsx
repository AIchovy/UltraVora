// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { patchSession } from "@/lib/api-client";
import { AutoApproveControl } from "@/components/auto-approve-control";
import { renderWithQuery } from "../helpers/render-with-query";

vi.mock("@/lib/api-client", () => ({ patchSession: vi.fn(async () => {}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<AutoApproveControl>", () => {
  it("toggling off PATCHes autoApprove=false", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AutoApproveControl sid="s1" autoApprove currentPhase="design" />);
    await user.click(screen.getByRole("switch", { name: "auto-pilot" }));
    expect(patchSession).toHaveBeenCalledWith("s1", { autoApprove: false });
  });

  it("shows the no-gates hint once the run is past the script gate", () => {
    renderWithQuery(<AutoApproveControl sid="s1" autoApprove currentPhase="compose" />);
    expect(screen.getByText("No review points left; use Stop to halt.")).toBeInTheDocument();
  });

  it("rolls back the optimistic flip and toasts when the PATCH fails", async () => {
    vi.mocked(patchSession).mockRejectedValueOnce(new Error("nope"));
    const user = userEvent.setup();
    const { qc } = renderWithQuery(<AutoApproveControl sid="s1" autoApprove currentPhase="design" />);
    qc.setQueryData(["session", "s1"], {
      state: { kind: "running", phase: "design" },
      artifacts: [],
      title: null,
      autoApprove: true,
    });
    await user.click(screen.getByRole("switch", { name: "auto-pilot" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((qc.getQueryData(["session", "s1"]) as { autoApprove: boolean }).autoApprove).toBe(true);
  });

  it("shows the running hint when auto-pilot is on (before the last gate)", () => {
    renderWithQuery(<AutoApproveControl sid="s1" autoApprove currentPhase="design" />);
    expect(screen.getByText("Running straight to the video.")).toBeInTheDocument();
  });

  it("shows the pausing hint when auto-pilot is off", () => {
    renderWithQuery(<AutoApproveControl sid="s1" autoApprove={false} currentPhase="design" />);
    expect(screen.getByText("Pausing at the next review point.")).toBeInTheDocument();
  });

  it("disables the switch once past the last gate", () => {
    renderWithQuery(<AutoApproveControl sid="s1" autoApprove currentPhase="compose" />);
    expect(screen.getByRole("switch", { name: "auto-pilot" })).toBeDisabled();
  });
});
