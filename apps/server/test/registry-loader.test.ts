// apps/server/test/registry-loader.test.ts
import { describe, it, expect } from "vitest";
import { loadRegistryCatalog, formatRegistryCatalogForPrompt } from "../src/registry/registry-loader.js";

describe("loadRegistryCatalog", () => {
  it("loads installable blocks and components from the vendored registry", async () => {
    const catalog = await loadRegistryCatalog();

    const block = catalog.find((e) => e.name === "macos-notification");
    expect(block).toMatchObject({
      type: "block",
      title: "macOS Notification",
      dimensions: { width: 1920, height: 1080 },
      duration: 5,
    });
    expect(block!.tags).toContain("notification");

    const parameterized = catalog.find((entry) => entry.name === "logo-outro");
    expect(parameterized?.params).toContainEqual(expect.objectContaining({
      key: "--bg-color", type: "color", default: "#0a0a0f",
    }));

    const component = catalog.find((e) => e.name === "caption-clip-wipe");
    expect(component).toMatchObject({ type: "component", title: "Clip Wipe" });
    // Components carry no block-only fields.
    expect(component!.dimensions).toBeUndefined();
    expect(component!.duration).toBeUndefined();

    // No examples leak into the installable catalog.
    expect(catalog.some((e) => e.name === "warm-grain")).toBe(false);
    expect(catalog.filter((e) => e.type === "block").length).toBeGreaterThan(20);
    expect(catalog.filter((e) => e.type === "component").length).toBeGreaterThan(10);
  });

  it("formats a prompt block with both sections", async () => {
    const catalog = await loadRegistryCatalog();
    const text = formatRegistryCatalogForPrompt(catalog);
    expect(text).toContain("<registry_blocks>");
    expect(text).toContain("<registry_components>");
    expect(text).toContain("macos-notification");
    expect(text).toMatch(/macos-notification \[1920x1080, 5s\]/);
    expect(text).toContain("caption-clip-wipe");
  });

  it("drops blocks whose orientation mismatches the composition; components stay", async () => {
    const catalog = await loadRegistryCatalog();
    // Portrait 9:16 composition: the (mostly 1920×1080) landscape blocks vanish…
    const portrait = formatRegistryCatalogForPrompt(catalog, { width: 1080, height: 1920 });
    expect(portrait).not.toMatch(/\[1920x1080/);
    // …while dimension-less components are unaffected.
    expect(portrait).toContain("caption-clip-wipe");
    // Landscape keeps the landscape blocks.
    const landscape = formatRegistryCatalogForPrompt(catalog, { width: 1920, height: 1080 });
    expect(landscape).toMatch(/macos-notification \[1920x1080, 5s\]/);
  });

  it("labels showcase blocks as demos to study, not embed", async () => {
    const catalog = await loadRegistryCatalog();
    const text = formatRegistryCatalogForPrompt(catalog);
    const showcase = catalog.find((e) => e.tags.includes("showcase"));
    expect(showcase).toBeDefined(); // the transitions-* demo pages carry this tag
    const line = text.split("\n").find((l) => l.includes(`- ${showcase!.name}`));
    expect(line).toMatch(/showcase demo/i);
    expect(line).toMatch(/don't embed|do not embed/i);
  });
});
