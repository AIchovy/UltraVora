// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { patchBriefAssets, uploadFiles } from "@/lib/api-client";
import { AssetManager } from "@/components/asset-manager";
import { renderWithQuery } from "../helpers/render-with-query";

vi.mock("@/lib/api-client", () => ({
  fileUrl: (sid: string, path: string) => `http://files/${sid}/${path}`,
  patchBriefAssets: vi.fn(async () => ({ version: 2, data: {} })),
  uploadFiles: vi.fn(async () => ({ files: [{ name: "new.png", path: "uploads/new.png" }] })),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<AssetManager>", () => {
  it("shows the curation hint so users know assets are editable here", () => {
    renderWithQuery(<AssetManager sid="s1" images={["capture/a.png"]} />);
    expect(screen.getByText(/remove low-quality captures and upload better/i)).toBeInTheDocument();
  });

  it("renders the gallery (excluding the logo) with a remove button per image", () => {
    renderWithQuery(
      <AssetManager sid="s1" logoFile="capture/logo.svg" images={["capture/logo.svg", "capture/a.png", "uploads/b.png"]} />,
    );
    expect(screen.getAllByAltText("Source asset")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove capture/a.png" })).toBeInTheDocument();
  });

  it("removing an image PATCHes the brief assets", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssetManager sid="s1" images={["capture/a.png"]} />);
    await user.click(screen.getByRole("button", { name: "Remove capture/a.png" }));
    await waitFor(() =>
      expect(patchBriefAssets).toHaveBeenCalledWith("s1", { remove: ["capture/a.png"] }),
    );
  });

  it("adding files uploads them, then PATCHes the returned paths into the brief", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssetManager sid="s1" images={[]} />);
    const file = new File(["png"], "new.png", { type: "image/png" });
    await user.upload(screen.getByLabelText("add images"), file);
    await waitFor(() => expect(uploadFiles).toHaveBeenCalled());
    await waitFor(() =>
      expect(patchBriefAssets).toHaveBeenCalledWith("s1", { add: ["uploads/new.png"] }),
    );
  });

  it("shows an upload prompt instead of an empty grid when there are no images", () => {
    renderWithQuery(<AssetManager sid="s1" images={[]} />);
    expect(screen.getByText(/no source images/i)).toBeInTheDocument();
  });

  it("clicking a thumbnail opens the uncropped lightbox (captures are croppy in the grid)", async () => {
    const user = userEvent.setup();
    renderWithQuery(<AssetManager sid="s1" images={["capture/a.png"]} />);
    await user.click(screen.getByRole("button", { name: "Enlarge capture/a.png" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // Both the enlarged copy and its caption are visible.
    expect(screen.getAllByAltText("Source asset").length).toBe(2);
    expect(screen.getAllByText("capture/a.png").length).toBeGreaterThanOrEqual(1);
  });
});
