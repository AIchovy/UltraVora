// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VideoPreview } from "@/components/video-preview";

vi.mock("@/lib/api-client", async (orig) => {
  const actual = await orig<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    fileUrl: (sid: string, rel: string) => `https://test/${sid}/${rel}`,
    getArtifact: vi.fn(),
  };
});
import { getArtifact } from "@/lib/api-client";

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom lacks createObjectURL
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:vtt";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  global.fetch = vi.fn(async () => ({ ok: true, text: async () => "1\n00:00:00,000 --> 00:00:01,000\nHi\n" })) as never;
});

describe("VideoPreview", () => {
  it("renders the video and download link with no caption controls when there is no subtitles artifact", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    renderWithClient(<VideoPreview sid="s1" mp4Path="output/x.mp4" />);
    await waitFor(() => expect(getArtifact).toHaveBeenCalledWith("s1", "subtitles"));
    expect(screen.queryByRole("button", { name: /captions|cc/i })).toBeNull();
  });

  it("shows a CC toggle and SRT download link when a subtitles artifact exists", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "subtitles", version: 1, createdAt: "", derivedFrom: null,
      data: { language: "en", srtPath: "output/x.srt", segments: [{ sceneId: "s1", text: "Hi", startMs: 0, endMs: 1000 }] },
    });
    renderWithClient(<VideoPreview sid="s1" mp4Path="output/x.mp4" />);
    const toggle = await screen.findByRole("button", { name: /captions|cc/i });
    expect(toggle).toBeTruthy();
    const dl = screen.getByRole("link", { name: /\.srt/i });
    expect(dl.getAttribute("href")).toBe("https://test/s1/output/x.srt");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("shows no regeneration overlay when no run is in progress", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    renderWithClient(<VideoPreview sid="s1" mp4Path="output/x.mp4" />);
    await waitFor(() => expect(getArtifact).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/updating video/i)).toBeNull();
  });

  it("overlays 'Updating video…' while a non-render phase re-runs", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    renderWithClient(
      <VideoPreview sid="s1" mp4Path="output/x.mp4" regenerating={{ phase: "compose", renderPercent: 0 }} />,
    );
    expect(await screen.findByText(/updating video/i)).toBeInTheDocument();
  });

  it("overlays the render percentage while the render phase reports progress", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    renderWithClient(
      <VideoPreview sid="s1" mp4Path="output/x.mp4" regenerating={{ phase: "render", renderPercent: 42 }} />,
    );
    expect(await screen.findByText(/re-rendering… 42%/i)).toBeInTheDocument();
  });

  it("falls back to 'Updating video…' when the render phase has no progress yet", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    renderWithClient(
      <VideoPreview sid="s1" mp4Path="output/x.mp4" regenerating={{ phase: "render", renderPercent: 0 }} />,
    );
    expect(await screen.findByText(/updating video/i)).toBeInTheDocument();
  });

  it("keeps the old video visible and the overlay pill out of the pointer path", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { container } = renderWithClient(
      <VideoPreview sid="s1" mp4Path="output/x.mp4" regenerating={{ phase: "compose", renderPercent: 0 }} />,
    );
    // The previous cut stays playable underneath…
    expect(container.querySelector("video")).toBeTruthy();
    // …and the floating pill must not intercept clicks meant for the video.
    const pill = await screen.findByRole("status");
    expect(pill.className).toContain("pointer-events-none");
  });

  it("shows the CC toggle from artifact segments even when fetching the .srt is blocked (archived → cross-origin GCS, no CORS)", async () => {
    (getArtifact as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "subtitles", version: 1, createdAt: "", derivedFrom: null,
      data: { language: "en", srtPath: "output/x.srt", segments: [{ sceneId: "s1", text: "Hi", startMs: 0, endMs: 1000 }] },
    });
    // The archived-file path: the browser fetch() of the .srt 302s to a
    // cross-origin GCS URL and is rejected by CORS. Captions must not depend on it.
    global.fetch = vi.fn(async () => { throw new TypeError("Failed to fetch"); }) as never;
    renderWithClient(<VideoPreview sid="s1" mp4Path="output/x.mp4" />);
    const toggle = await screen.findByRole("button", { name: /captions|cc/i });
    expect(toggle).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
