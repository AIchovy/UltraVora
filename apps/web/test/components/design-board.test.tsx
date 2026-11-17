// @vitest-environment jsdom
// apps/web/test/components/design-board.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DesignBoard } from "@/components/design-board";
import type { Design } from "@ultracreator/shared";

const design: Design = {
  mood: "energetic and minimal",
  palette: [
    { name: "Primary", hex: "#ff0066" },
    { name: "Ink", hex: "#0a0a0a" },
  ],
  typography: { heading: "Inter", body: "Source Sans" },
  motionStyle: "kinetic captions",
  keyVisuals: [{ description: "wordmark on grid" }],
  sampleFrames: [
    { caption: "Open with logo punch-in", layoutHint: "centered" },
    { caption: "Feature trio", layoutHint: "split-thirds" },
  ],
};

describe("<DesignBoard>", () => {
  it("renders the mood + motion + typography", () => {
    render(<DesignBoard design={design} />);
    expect(screen.getByText(/energetic and minimal/i)).toBeInTheDocument();
    expect(screen.getByText(/kinetic captions/i)).toBeInTheDocument();
    expect(screen.getByText(/inter/i)).toBeInTheDocument();
    expect(screen.getByText(/source sans/i)).toBeInTheDocument();
  });

  it("renders each palette entry with the hex value", () => {
    render(<DesignBoard design={design} />);
    expect(screen.getByText("#ff0066")).toBeInTheDocument();
    expect(screen.getByText("#0a0a0a")).toBeInTheDocument();
  });

  it("renders one tile per sample frame", () => {
    render(<DesignBoard design={design} />);
    expect(screen.getByText(/open with logo punch-in/i)).toBeInTheDocument();
    expect(screen.getByText(/feature trio/i)).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("shows 'stale' badge when stale=true", () => {
    render(<DesignBoard design={design} stale />);
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  // The user can delete source assets at the design gate; the design artifact
  // keeps referencing them. Tiles for brief-tracked refs (capture/, uploads/)
  // that are no longer in presentAssets must hide — matching what compose can
  // actually use. Design-generated assets/ refs stay (their deletion 404s and
  // the img error handler hides them at load time).
  it("hides keyVisuals and sample-frame thumbnails whose brief-tracked ref was removed", () => {
    const withRefs: Design = {
      ...design,
      keyVisuals: [
        { description: "kept shot", refAssetId: "capture/assets/kept.png" },
        { description: "deleted shot", refAssetId: "capture/assets/gone.png" },
        { description: "generated visual", refAssetId: "assets/gen.png" },
      ],
      sampleFrames: [
        { caption: "kept frame", layoutHint: "center", thumbnailUrl: "capture/assets/kept.png" },
        { caption: "frame with deleted thumb", layoutHint: "split", thumbnailUrl: "uploads/gone2.png" },
      ],
    };
    render(
      <DesignBoard
        design={withRefs}
        sid="s1"
        presentAssets={["capture/assets/kept.png"]}
      />,
    );
    expect(screen.getByText("kept shot")).toBeInTheDocument();
    expect(screen.queryByText("deleted shot")).not.toBeInTheDocument();
    expect(screen.getByText("generated visual")).toBeInTheDocument();
    // The frame survives but its dead thumbnail does not render.
    expect(screen.getByText("frame with deleted thumb")).toBeInTheDocument();
    expect(screen.queryByAltText("frame with deleted thumb")).not.toBeInTheDocument();
    expect(screen.getByAltText("kept frame")).toBeInTheDocument();
  });

  it("keeps everything when presentAssets is not provided (other callers)", () => {
    const withRefs: Design = {
      ...design,
      keyVisuals: [{ description: "shot", refAssetId: "capture/assets/a.png" }],
    };
    render(<DesignBoard design={withRefs} sid="s1" />);
    expect(screen.getByText("shot")).toBeInTheDocument();
  });
});
