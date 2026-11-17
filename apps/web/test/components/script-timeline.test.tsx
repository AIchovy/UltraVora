// @vitest-environment jsdom
// apps/web/test/components/script-timeline.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ScriptTimeline } from "@/components/script-timeline";
import type { Script } from "@ultracreator/shared";

const script: Script = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 10, visual: "logo punch-in", narration: "Welcome" },
    { id: "s2", startSec: 10, durationSec: 12, visual: "feature trio", onScreenText: "FAST" },
    { id: "s3", startSec: 22, durationSec: 8, visual: "CTA card" },
  ],
};

describe("<ScriptTimeline>", () => {
  it("renders the total duration", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getByText(/30s/i)).toBeInTheDocument();
  });

  it("renders one row per scene", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("renders an overview strip with one segment per scene, sized by duration", () => {
    render(<ScriptTimeline script={script} />);
    const segments = screen.getAllByTestId("timeline-segment");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toHaveStyle({ flexGrow: "10" });
    expect(segments[1]).toHaveStyle({ flexGrow: "12" });
    expect(segments[2]).toHaveStyle({ flexGrow: "8" });
  });

  it("shows each scene's timestamp range and explicit duration", () => {
    render(<ScriptTimeline script={script} />);
    const rows = screen.getAllByRole("listitem");
    const first = within(rows[0]!);
    expect(first.getByText("0:00")).toBeInTheDocument();
    expect(first.getByText("0:10")).toBeInTheDocument();
    expect(first.getByText("10s")).toBeInTheDocument();
    const last = within(rows[2]!);
    expect(last.getByText("0:22")).toBeInTheDocument();
    expect(last.getByText("0:30")).toBeInTheDocument();
    expect(last.getByText("8s")).toBeInTheDocument();
  });

  it("numbers each scene", () => {
    render(<ScriptTimeline script={script} />);
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("1")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("3")).toBeInTheDocument();
  });

  it("does not render a half-filled progress-style bar per scene", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.queryByTestId("bar")).not.toBeInTheDocument();
  });

  it("shows narration text when present", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getByText(/welcome/i)).toBeInTheDocument();
  });

  it("shows on-screen text when present", () => {
    render(<ScriptTimeline script={script} />);
    expect(screen.getByText("FAST")).toBeInTheDocument();
  });

  it("renders stale badge", () => {
    render(<ScriptTimeline script={script} stale />);
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });
});
