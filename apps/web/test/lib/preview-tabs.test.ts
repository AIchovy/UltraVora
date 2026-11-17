import { describe, it, expect } from "vitest";
import type { ArtifactDescriptor } from "@ultracreator/shared";
import { resolvePreviewTabs } from "@/lib/preview-tabs";

const d = (kind: ArtifactDescriptor["kind"], version = 1, stale = false): ArtifactDescriptor => ({
  kind,
  version,
  stale,
  createdAt: "2026-06-10T00:00:00.000Z",
  derivedFrom: null,
});

describe("resolvePreviewTabs", () => {
  it("returns tabs in pipeline order for present artifacts", () => {
    const tabs = resolvePreviewTabs([d("script"), d("brief")]);
    expect(tabs.map((t) => t.kind)).toEqual(["brief", "script"]);
  });

  it("shows the voiceover tab for narration", () => {
    expect(resolvePreviewTabs([d("narration")]).map((t) => t.kind)).toEqual(["narration"]);
  });

  it("shows the voiceover tab for music-only sessions", () => {
    expect(resolvePreviewTabs([d("music")]).map((t) => t.kind)).toEqual(["narration"]);
  });

  it("marks the voiceover tab stale when either source is stale", () => {
    const tabs = resolvePreviewTabs([d("narration", 1, false), d("music", 1, true)]);
    expect(tabs).toEqual([{ kind: "narration", stale: true }]);
  });

  it("uses the latest version per kind for staleness", () => {
    const tabs = resolvePreviewTabs([d("brief", 1, true), d("brief", 2, false)]);
    expect(tabs).toEqual([{ kind: "brief", stale: false }]);
  });
});
