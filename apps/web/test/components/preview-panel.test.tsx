// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreviewPanel } from "@/components/preview-panel";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";
import type { ArtifactDescriptor, Brief, Design } from "@ultracreator/shared";

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A widget", category: "saas" },
  audience: "developers",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

const design: Design = {
  mood: "energetic and minimal",
  palette: [{ name: "Primary", hex: "#ff0066" }],
  typography: { heading: "Geist", body: "Geist" },
  motionStyle: "kinetic captions",
  keyVisuals: [],
  sampleFrames: [{ caption: "Open with logo", layoutHint: "centered" }],
};

function descriptor(kind: ArtifactDescriptor["kind"]): ArtifactDescriptor {
  return { kind, version: 1, createdAt: "t", derivedFrom: null, stale: false };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  mockFetch(async (url) => {
    if (url.endsWith("/artifacts/brief")) {
      return new Response(JSON.stringify({ kind: "brief", version: 1, createdAt: "t", derivedFrom: null, data: brief }), { status: 200 });
    }
    if (url.endsWith("/artifacts/design")) {
      return new Response(JSON.stringify({ kind: "design", version: 1, createdAt: "t", derivedFrom: null, data: design }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("<PreviewPanel>", () => {
  it("shows an empty state when there are no artifacts", () => {
    renderWithQuery(<PreviewPanel sid="s1" artifacts={[]} />);
    expect(screen.getByText(/nothing to preview yet/i)).toBeInTheDocument();
  });

  it("renders one tab per available artifact and auto-selects the newest stage", async () => {
    renderWithQuery(<PreviewPanel sid="s1" artifacts={[descriptor("brief"), descriptor("design")]} />);
    expect(screen.getByRole("button", { name: /brief/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /design/i })).toBeInTheDocument();
    // Newest stage (design) is selected by default.
    await waitFor(() => expect(screen.getByText(/energetic and minimal/i)).toBeInTheDocument());
  });

  it("switches the preview when a tab is clicked", async () => {
    const user = userEvent.setup();
    renderWithQuery(<PreviewPanel sid="s1" artifacts={[descriptor("brief"), descriptor("design")]} />);
    await waitFor(() => expect(screen.getByText(/energetic and minimal/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /brief/i }));
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
  });

  it("shows a skeleton (not the empty state) while loading with no artifacts", () => {
    const { container } = renderWithQuery(<PreviewPanel sid="s1" artifacts={[]} loading />);
    expect(screen.getByRole("status", { name: /loading preview/i })).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/nothing to preview yet/i)).toBeNull();
  });
});
