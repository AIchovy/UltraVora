// @vitest-environment jsdom
// apps/web/test/components/brief-card.test.tsx
import { describe, it, expect, beforeAll, vi } from "vitest";
import { screen } from "@testing-library/react";
import { BriefCard } from "@/components/brief-card";
import type { Brief } from "@ultracreator/shared";
import { renderWithQuery } from "../helpers/render-with-query";

// BriefCard embeds the editable AssetManager (the research gate is where the
// user curates captured assets), which talks to the api-client.
vi.mock("@/lib/api-client", () => ({
  fileUrl: (sid: string, path: string) => `http://127.0.0.1:3001/api/sessions/${sid}/files/${path}`,
  patchBriefAssets: vi.fn(async () => ({ version: 2, data: {} })),
  uploadFiles: vi.fn(async () => ({ files: [] })),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
});

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A widget", category: "saas" },
  audience: "developers",
  keyMessages: ["fast", "simple", "fun"],
  brandHints: { colors: ["#ff0066", "#000000"], logoUrl: "https://acme.example/logo.png", logoFile: "assets/logo.png", fonts: ["Inter"] },
  sourceAssets: { images: ["assets/a.png"], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "9:16", withVoiceover: true },
};

describe("<BriefCard>", () => {
  it("renders product name + tagline + audience", () => {
    renderWithQuery(<BriefCard sid="s1" brief={brief} />);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText(/do more/i)).toBeInTheDocument();
    expect(screen.getByText(/developers/i)).toBeInTheDocument();
  });

  it("renders each keyMessage as its own item", () => {
    renderWithQuery(<BriefCard sid="s1" brief={brief} />);
    for (const m of brief.keyMessages) {
      expect(screen.getByText(m)).toBeInTheDocument();
    }
  });

  it("renders the constraints (duration / aspect / voiceover)", () => {
    renderWithQuery(<BriefCard sid="s1" brief={brief} />);
    expect(screen.getByText(/30s/i)).toBeInTheDocument();
    expect(screen.getByText(/9:16/i)).toBeInTheDocument();
    expect(screen.getByText(/voiceover/i)).toBeInTheDocument();
  });

  it("renders color swatches via inline backgroundColor", () => {
    renderWithQuery(<BriefCard sid="s1" brief={brief} />);
    const pink = screen.getByTestId("swatch-#ff0066");
    expect(pink).toHaveStyle({ backgroundColor: "rgb(255, 0, 102)" });
  });

  it("renders 'stale' badge when stale=true", () => {
    renderWithQuery(<BriefCard sid="s1" brief={brief} stale />);
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it("renders the downloaded logo + source assets as images served from the session", () => {
    renderWithQuery(<BriefCard sid="s1" brief={brief} />);
    const logo = screen.getByAltText(/brand logo/i) as HTMLImageElement;
    expect(logo.src).toContain("/api/sessions/s1/files/assets/logo.png");
    const asset = screen.getByAltText(/source asset/i) as HTMLImageElement;
    expect(asset.src).toContain("/api/sessions/s1/files/assets/a.png");
  });

  it("exposes asset curation (remove / add) right on the brief", () => {
    renderWithQuery(<BriefCard sid="s1" brief={brief} />);
    expect(screen.getByRole("button", { name: "Remove assets/a.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add images/i })).toBeInTheDocument();
    expect(screen.getByText(/remove low-quality captures/i)).toBeInTheDocument();
  });
});
