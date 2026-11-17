import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HyperframesQualityRunner } from "../src/render/quality-runner.js";

const PASS = ["node", "-e", "process.exit(0)"] as const;

async function projectWith(indexHtml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qr-"));
  await writeFile(join(dir, "index.html"), indexHtml, "utf8");
  return dir;
}

describe("HyperframesQualityRunner.check", () => {
  it("returns an actionable emoji repair before spending time on browser checks", async () => {
    const dir = await projectWith('<body><span>🎯</span> Product benefits</body>');
    let calls = 0;
    const runner = new HyperframesQualityRunner({ commandFor: () => { calls++; return [...PASS]; } });
    const res = await runner.check(dir, new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.diagnostics).toContain("[iconography]");
    expect(res.diagnostics).toContain("index.html");
    expect(res.diagnostics).toContain("SVG paths");
    expect(calls).toBe(0);
  });

  it("reports ok=true when the command exits 0", async () => {
    const runner = new HyperframesQualityRunner({
      commandFor: (kind, dir) => ["node", "-e", "process.exit(0)"],
    });
    const res = await runner.check("/tmp/whatever", new AbortController().signal);
    expect(res.ok).toBe(true);
  });

  it("reports ok=false and captures output when a command exits non-zero", async () => {
    const runner = new HyperframesQualityRunner({
      commandFor: (kind, _dir) =>
        kind === "lint"
          ? ["node", "-e", "process.exit(0)"]
          : ["node", "-e", "console.log('BOOM'); process.exit(1)"],
    });
    const res = await runner.check("/tmp/whatever", new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.diagnostics).toMatch(/BOOM/);
    expect(res.diagnostics).toMatch(/validate/i);
  });

  it("runs inspect after lint and validate", async () => {
    const kinds: string[] = [];
    const runner = new HyperframesQualityRunner({
      commandFor: (kind, _dir) => {
        kinds.push(kind);
        return ["node", "-e", "process.exit(0)"];
      },
    });
    const res = await runner.check("/tmp/whatever", new AbortController().signal);
    expect(res.ok).toBe(true);
    expect(kinds).toEqual(["lint", "validate", "inspect"]);
  });

  it("reports ok=false and captures output when inspect exits non-zero", async () => {
    const runner = new HyperframesQualityRunner({
      commandFor: (kind, _dir) =>
        kind === "inspect"
          ? ["node", "-e", "console.log('OVERFLOW at t=5.3s'); process.exit(1)"]
          : ["node", "-e", "process.exit(0)"],
    });
    const res = await runner.check("/tmp/whatever", new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.diagnostics).toMatch(/OVERFLOW/);
    expect(res.diagnostics).toMatch(/inspect/i);
  });

  it("fails (even when the CLI checks pass) on a scene-container opacity from() that renders blank", async () => {
    const dir = await projectWith(
      `<body><div id="scene_4" class="scene clip"></div>
       <script>gsap.set(".scene",{autoAlpha:0});
       tl.from("#scene_4", { opacity: 0, scale: 0.95, duration: 1.5 }, 26.93);</script></body>`,
    );
    const runner = new HyperframesQualityRunner({ commandFor: () => [...PASS] });
    const res = await runner.check(dir, new AbortController().signal);
    expect(res.ok).toBe(false);
    expect(res.diagnostics).toMatch(/scene/i);
    expect(res.diagnostics).toMatch(/#scene_4/);
  });

  it("passes a composition whose scenes reveal via transform / child fades", async () => {
    const dir = await projectWith(
      `<body><div id="scene_1" class="scene clip"><img class="logo"></div>
       <div id="scene_2" class="scene clip"></div>
       <script>gsap.set(".scene",{autoAlpha:0});
       tl.from("#scene_1 .logo", { opacity: 0, duration: 1 });
       tl.from("#scene_2", { y: "100%", duration: 1.2 });</script></body>`,
    );
    const runner = new HyperframesQualityRunner({ commandFor: () => [...PASS] });
    const res = await runner.check(dir, new AbortController().signal);
    expect(res.ok).toBe(true);
  });

  // Regression: prod compose 2026-07-09 burned all 4 fix rounds on a
  // clipped_text error blamed on "#scene_3" itself — a decorative bleeding
  // past the scene edge inflates scrollWidth mid scene-wipe, and the CLI's
  // own fixHint ("widen the text box") sends the LLM the wrong way. The
  // runner must append the clip-layer hint alongside the raw diagnostics.
  it("appends a scene-bleed hint when inspect fails with clipped_text on a scene container", async () => {
    const sceneClipJson = JSON.stringify({
      ok: false,
      errorCount: 1,
      issues: [
        {
          code: "clipped_text",
          severity: "error",
          time: 19.18,
          selector: "#scene_3",
          text: "Interactive storybooks, games, and nursery rhymes",
          message: "Text content is clipped by its own box.",
          rect: { left: 216.21, top: 0, right: 2136.21, bottom: 1080, width: 1920, height: 1080 },
          overflow: { right: 354 },
          fixHint: "widen the text box to at least ~2274px",
        },
      ],
    });
    const dir = await projectWith(`<body><div id="scene_3" class="scene"></div></body>`);
    const runner = new HyperframesQualityRunner({
      commandFor: (kind) =>
        kind === "inspect"
          ? ["node", "-e", `console.log(${JSON.stringify(sceneClipJson)}); process.exit(1)`]
          : ["node", "-e", "process.exit(0)"],
    });
    const res = await runner.check(dir, new AbortController().signal);
    expect(res.ok).toBe(false);
    // Raw CLI output still present …
    expect(res.diagnostics).toContain("clipped_text");
    // … plus the targeted root-cause hint.
    expect(res.diagnostics).toMatch(/overflow:\s*hidden/);
    expect(res.diagnostics).toMatch(/inset:\s*0/);
    expect(res.diagnostics).toContain("#scene_3");
  });

  // The CLI's contrast audit reports WCAG failures as warnings and exits 0 —
  // but the compose system prompt promises the system validates contrast, so
  // the gate must promote them to failures.
  describe("validate contrast warning promotion", () => {
    const failingValidateJson = JSON.stringify({
      ok: true,
      errors: [],
      warnings: [],
      contrast: [
        {
          time: 2.5,
          selector: "#scene_1 .subtitle",
          text: "muddy text",
          ratio: 2.71,
          wcagAA: false,
          large: false,
          fg: "rgb(140,140,150)",
          bg: "rgb(90,90,110)",
        },
      ],
      contrastFailures: 1,
    });

    it("fails when validate exits 0 but reports a WCAG contrast failure", async () => {
      process.env.QR_TEST_CONTRAST_JSON = failingValidateJson;
      try {
        const dir = await projectWith(`<body></body>`);
        const runner = new HyperframesQualityRunner({
          commandFor: (kind) =>
            kind === "validate"
              ? ["node", "-e", `console.log(process.env.QR_TEST_CONTRAST_JSON ?? "")`]
              : [...PASS],
        });
        const res = await runner.check(dir, new AbortController().signal);
        expect(res.ok).toBe(false);
        expect(res.diagnostics).toContain("#scene_1 .subtitle");
        expect(res.diagnostics).toContain("2.71");
        expect(res.diagnostics).toMatch(/contrast/i);
      } finally {
        delete process.env.QR_TEST_CONTRAST_JSON;
      }
    });

    it("passes when every contrast entry meets WCAG AA", async () => {
      process.env.QR_TEST_CONTRAST_OK_JSON = JSON.stringify({
        ok: true,
        errors: [],
        warnings: [],
        contrast: [
          { selector: "h1", ratio: 12, wcagAA: true, large: false },
        ],
        contrastFailures: 0,
      });
      try {
        const dir = await projectWith(`<body></body>`);
        const runner = new HyperframesQualityRunner({
          commandFor: (kind) =>
            kind === "validate"
              ? ["node", "-e", `console.log(process.env.QR_TEST_CONTRAST_OK_JSON ?? "")`]
              : [...PASS],
        });
        const res = await runner.check(dir, new AbortController().signal);
        expect(res.ok).toBe(true);
      } finally {
        delete process.env.QR_TEST_CONTRAST_OK_JSON;
      }
    });
  });

  // Regression: session e871ba4d shipped a logo 587px wider than the canvas.
  // inspect reported it as container_overflow WARNINGS and exited 0, so the
  // exit-code-only gate passed. The runner must read inspect's JSON and fail
  // on severe element overflow even when the process exits 0.
  describe("inspect JSON warning promotion", () => {
    const severeInspectJson = JSON.stringify({
      ok: true,
      errorCount: 0,
      warningCount: 1,
      infoCount: 0,
      issues: [
        {
          code: "container_overflow",
          severity: "warning",
          time: 38.401,
          selector: "#logo-s5",
          containerSelector: "#scene_5",
          message: "Element extends outside a clipping layout container.",
          rect: { left: -293.56, top: 183, right: 2213.58, bottom: 633, width: 2507.14, height: 450 },
          containerRect: { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 },
          overflow: { left: 293.56, right: 293.58 },
          fixHint:
            "Resize/reposition the child or container, or mark intentional overflow with data-layout-allow-overflow.",
        },
      ],
    });

    const benignInspectJson = JSON.stringify({
      ok: true,
      errorCount: 0,
      warningCount: 1,
      infoCount: 0,
      issues: [
        {
          code: "container_overflow",
          severity: "warning",
          selector: ".shadow",
          containerSelector: "#scene_2",
          containerRect: { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 },
          overflow: { right: 6 },
        },
      ],
    });

    function inspectPrinting(envVar: string) {
      return (kind: string) =>
        kind === "inspect"
          ? ["node", "-e", `console.log(process.env.${envVar} ?? "")`]
          : [...PASS];
    }

    it("fails when inspect exits 0 but reports a severe container overflow", async () => {
      process.env.QR_TEST_SEVERE_JSON = severeInspectJson;
      try {
        const runner = new HyperframesQualityRunner({
          commandFor: inspectPrinting("QR_TEST_SEVERE_JSON"),
        });
        const res = await runner.check("/tmp/whatever", new AbortController().signal);
        expect(res.ok).toBe(false);
        expect(res.diagnostics).toMatch(/inspect/i);
        expect(res.diagnostics).toContain("#logo-s5");
        expect(res.diagnostics).toContain("data-layout-allow-overflow");
      } finally {
        delete process.env.QR_TEST_SEVERE_JSON;
      }
    });

    it("passes when inspect exits 0 with only sub-threshold overflow warnings", async () => {
      process.env.QR_TEST_BENIGN_JSON = benignInspectJson;
      try {
        const runner = new HyperframesQualityRunner({
          commandFor: inspectPrinting("QR_TEST_BENIGN_JSON"),
        });
        const res = await runner.check("/tmp/whatever", new AbortController().signal);
        expect(res.ok).toBe(true);
      } finally {
        delete process.env.QR_TEST_BENIGN_JSON;
      }
    });

    it("passes when inspect exits 0 with non-JSON stdout", async () => {
      const runner = new HyperframesQualityRunner({
        commandFor: (kind) =>
          kind === "inspect" ? ["node", "-e", "console.log('all good, no json')"] : [...PASS],
      });
      const res = await runner.check("/tmp/whatever", new AbortController().signal);
      expect(res.ok).toBe(true);
    });
  });
});
