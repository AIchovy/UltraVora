import { describe, it, expect } from "vitest";
import type { Design } from "@ultracreator/shared";
import { findDesignFidelityViolations } from "../src/render/design-fidelity-check.js";

const design: Design = {
  mood: "confident",
  palette: [
    { name: "bg", hex: "#0B1020" }, // deep navy
    { name: "fg", hex: "#F5F2EC" }, // warm white
    { name: "accent", hex: "#FF3366" }, // coral-pink
  ],
  colorRoles: { background: "#0B1020", foreground: "#F5F2EC", accent: "#FF3366" },
  typography: { heading: "Space Grotesk", body: "Fraunces" },
  motionStyle: "confident",
  keyVisuals: [],
  sampleFrames: [],
};

function check(html: string, css = ""): string[] {
  return findDesignFidelityViolations(
    [
      { path: "index.html", text: html },
      ...(css ? [{ path: "styles.css", text: css }] : []),
    ],
    design,
  );
}

describe("findDesignFidelityViolations", () => {
  it("flags an invented saturated hue absent from the palette", () => {
    const violations = check(`<style>h1 { color: #4ECDC4; }</style>`);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("#4ECDC4".toLowerCase());
    expect(violations[0]).toContain("index.html");
  });

  it("allows tints/shades of a palette hue and all near-neutrals", () => {
    const violations = check(
      `<style>
        .pale { color: #ffccd9; }          /* pale tint of the coral hue */
        .dark { background: #660a1f; }     /* dark shade of the coral hue */
        .white { color: #ffffff; }
        .warm { color: #f8f5f0; }          /* tinted near-neutral */
        .overlay { background: rgba(0, 0, 0, 0.5); }
      </style>`,
    );
    expect(violations).toEqual([]);
  });

  it("flags off-palette rgb() literals in css files too", () => {
    const violations = check("", `.x { border-color: rgb(80, 200, 120); }`);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("styles.css");
  });

  it("flags a font family the design did not choose, allowing generics and vars", () => {
    const violations = check(
      `<style>
        h1 { font-family: "Space Grotesk", sans-serif; }
        p { font-family: Fraunces, serif; }
        .cap { font-family: var(--caption-font, inherit); }
        .bad { font-family: "Poppins", sans-serif; }
      </style>`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("Poppins");
  });

  it("returns [] for empty inputs and designs without saturated palette colors", () => {
    expect(check("")).toEqual([]);
    const grayDesign: Design = {
      ...design,
      palette: [{ name: "bg", hex: "#111111" }, { name: "fg", hex: "#eeeeee" }],
      colorRoles: undefined,
    };
    // A saturated color with an all-neutral palette is still a violation.
    const v = findDesignFidelityViolations(
      [{ path: "index.html", text: `<style>h1{color:#ff0000}</style>` }],
      grayDesign,
    );
    expect(v).toHaveLength(1);
  });
});
