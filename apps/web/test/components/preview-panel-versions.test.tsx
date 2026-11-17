// @vitest-environment jsdom
// mp4 version history in the Video pane: strip, older-version playback, restore.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { PreviewPanel } from "@/components/preview-panel";
import { renderWithQuery } from "../helpers/render-with-query";
import { mockFetch } from "../helpers/api-mocks";
import type { ArtifactDescriptor } from "@ultracreator/shared";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function mp4Descriptor(version: number): ArtifactDescriptor {
  return { kind: "mp4", version, createdAt: `t${version}`, derivedFrom: null, stale: false };
}

function mp4Envelope(version: number): Response {
  return new Response(
    JSON.stringify({
      kind: "mp4",
      version,
      createdAt: `t${version}`,
      derivedFrom: null,
      data: { path: `/work/sessions/s1/output/v${version}-uuid.mp4` },
    }),
    { status: 200 },
  );
}

/** Latest mp4 is v2; v1 stays fetchable via ?version=1. Subtitles absent. */
function mockArtifactRoutes(opts: { latest?: number; restore?: (url: string) => Response } = {}) {
  const latest = opts.latest ?? 2;
  return mockFetch(async (url, init) => {
    const restoreMatch = /\/artifacts\/mp4\/\d+\/restore$/.test(url);
    if (restoreMatch && init?.method === "POST") {
      return opts.restore
        ? opts.restore(url)
        : new Response(JSON.stringify({ restored: true, version: latest + 1 }), { status: 200 });
    }
    const versioned = url.match(/\/artifacts\/mp4\?version=(\d+)$/);
    if (versioned) return mp4Envelope(Number(versioned[1]));
    if (url.endsWith("/artifacts/mp4")) return mp4Envelope(latest);
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_API_URL = "http://127.0.0.1:3001";
  // jsdom lacks createObjectURL (VideoPreview builds a VTT blob when subtitled).
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:vtt";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("<PreviewPanel> mp4 version history", () => {
  it("renders a version strip with the latest selected as Current when there are 2+ mp4 versions", async () => {
    mockArtifactRoutes();
    renderWithQuery(<PreviewPanel sid="s1" artifacts={[mp4Descriptor(1), mp4Descriptor(2)]} />);
    const current = await screen.findByRole("button", { name: /v2 · current/i });
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^v1$/i })).toHaveAttribute("aria-pressed", "false");
    // Latest view: no older-version notice.
    expect(screen.queryByText(/older version/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /use this version/i })).toBeNull();
  });

  it("shows no strip when there is a single mp4 version", async () => {
    mockArtifactRoutes({ latest: 1 });
    const { container } = renderWithQuery(<PreviewPanel sid="s1" artifacts={[mp4Descriptor(1)]} />);
    await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^v1/i })).toBeNull();
    expect(screen.queryByText(/current/i)).toBeNull();
  });

  it("clicking an older version fetches ?version=N and plays that version's file", async () => {
    const user = userEvent.setup();
    const spy = mockArtifactRoutes();
    const { container } = renderWithQuery(
      <PreviewPanel sid="s1" artifacts={[mp4Descriptor(1), mp4Descriptor(2)]} />,
    );
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toContain("output/v2-uuid.mp4"),
    );
    await user.click(screen.getByRole("button", { name: /^v1$/i }));
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toContain("output/v1-uuid.mp4"),
    );
    const versionedCall = spy.mock.calls.find(([url]) => String(url).includes("/artifacts/mp4?version=1"));
    expect(versionedCall).toBeTruthy();
    expect(screen.getByText(/viewing v1 \(older version\)/i)).toBeInTheDocument();
  });

  it("restores an older version via POST .../artifacts/mp4/:version/restore", async () => {
    const user = userEvent.setup();
    const spy = mockArtifactRoutes();
    renderWithQuery(<PreviewPanel sid="s1" artifacts={[mp4Descriptor(1), mp4Descriptor(2)]} />);
    await user.click(await screen.findByRole("button", { name: /^v1$/i }));
    const restoreBtn = await screen.findByRole("button", { name: /use this version/i });
    await user.click(restoreBtn);
    await waitFor(() => {
      const call = spy.mock.calls.find(
        ([url, init]) => String(url).endsWith("/artifacts/mp4/1/restore") && init?.method === "POST",
      );
      expect(call).toBeTruthy();
    });
    // Selection snaps back to the latest view (notice row gone).
    await waitFor(() => expect(screen.queryByText(/older version/i)).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows a toast and keeps the UI alive when restore is rejected with 409 (run in flight)", async () => {
    const user = userEvent.setup();
    mockArtifactRoutes({ restore: () => new Response("busy", { status: 409 }) });
    renderWithQuery(<PreviewPanel sid="s1" artifacts={[mp4Descriptor(1), mp4Descriptor(2)]} />);
    await user.click(await screen.findByRole("button", { name: /^v1$/i }));
    await user.click(await screen.findByRole("button", { name: /use this version/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/run is in progress/i)));
    // Still on the older-version view, button enabled again — no crash.
    expect(screen.getByText(/viewing v1 \(older version\)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /use this version/i })).toBeEnabled();
  });

  it("snaps back to the new latest when a fresh mp4 version lands while viewing an old one", async () => {
    const user = userEvent.setup();
    mockArtifactRoutes({ latest: 3 });
    const { container, rerender } = renderWithQuery(
      <PreviewPanel sid="s1" artifacts={[mp4Descriptor(1), mp4Descriptor(2)]} />,
    );
    await user.click(await screen.findByRole("button", { name: /^v1$/i }));
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toContain("output/v1-uuid.mp4"),
    );
    // artifact.created refreshed the descriptor list → v3 exists now.
    rerender(<PreviewPanel sid="s1" artifacts={[mp4Descriptor(1), mp4Descriptor(2), mp4Descriptor(3)]} />);
    await waitFor(() =>
      expect(container.querySelector("video")?.getAttribute("src")).toContain("output/v3-uuid.mp4"),
    );
    expect(screen.queryByText(/older version/i)).toBeNull();
  });

  it("shows the regenerating overlay only on the latest version's view", async () => {
    const user = userEvent.setup();
    mockArtifactRoutes();
    renderWithQuery(
      <PreviewPanel
        sid="s1"
        artifacts={[mp4Descriptor(1), mp4Descriptor(2)]}
        regenerating={{ phase: "compose", renderPercent: 0 }}
      />,
    );
    expect(await screen.findByText(/updating video/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^v1$/i }));
    await waitFor(() => expect(screen.queryByText(/updating video/i)).toBeNull());
  });
});
