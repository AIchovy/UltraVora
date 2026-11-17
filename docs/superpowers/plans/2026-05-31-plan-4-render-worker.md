# UltraCreator Plan 4 — RenderWorker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fake render handler (carried since Plan 2; still injected via `renderHandlerOverride` in Plan 3) with a real `RenderPhaseHandler` that (a) compiles a hyperframes project (`index.html` + media) from the latest `script` / `design` / `brief` (+ optional `narration`) artifacts, (b) drives the `hyperframes` CLI in an isolated forked child process so a Chrome/ffmpeg crash never takes down the API server, and (c) emits `render.progress` / `render.done` / `render.error` events as the render runs.

**Architecture:** Three concentric layers. (1) **`CompositionBuilder`** is a pure function: given `(script, design, brief, narration?)` it returns a `Map<relativePath, string|Buffer>` describing the hyperframes project files. No I/O, fully unit-testable. (2) **`RenderWorkerClient`** is the parent-side interface that owns one forked child process per render call. The default `ForkedRenderWorkerClient` uses `child_process.fork()` to start `render/worker.ts`, which `spawn()`s `npx hyperframes render`, parses its stdout for progress, and reports back via `process.send` IPC. A timeout kills the child if the render hangs. A `StubRenderWorkerClient` is the deterministic test double. (3) **`RenderPhaseHandler`** is the `PhaseHandler` (interface from Plan 2): it loads the upstream artifacts, runs the builder, writes the files into `workspaces/<sid>/composition/`, writes the `composition` artifact, calls `RenderWorkerClient.render(...)`, forwards its async events as `ServerEvent`s, writes the `mp4` artifact, and emits `render.done`. `composeOrchestrator` (from Plan 3) is updated so its `throwUntilPlan4` placeholder is replaced by `RenderPhaseHandler` wired to `ForkedRenderWorkerClient`. The existing `renderHandlerOverride` seam stays so tests that don't care about render internals can keep using a fake.

**Tech Stack:** `hyperframes@^0.6` (CLI invoked via `npx`; requires Node ≥22 and bundled Chrome / system FFmpeg). `node:child_process` (`fork` for parent↔worker IPC, `spawn` for worker→CLI). Existing: TypeScript 5.7 strict, zod, vitest, tsx. No new runtime libraries are linked into the server process — hyperframes runs purely as a subprocess of the forked worker.

**Roadmap context:** Plan 4 of 6. Plan 1 (foundation), Plan 2 (orchestrator + intent + registry), Plan 3 (Pi-agent phases + providers + composeOrchestrator) are merged. After Plan 4 the backend can complete the full pipeline end-to-end and write an actual MP4. Plan 5 wires Fastify routes + SSE around `composeOrchestrator`; Plan 6 builds the Next.js frontend.

**⚠ Risk note (analog to Plan 3's pi-agent-core spike):** The exact hyperframes HTML conventions (which `data-*` attributes the linter / renderer expect, where the `<audio>` track lives, what `index.html` shape `npx hyperframes lint` accepts) are *not* fully fixed by external API contracts that we control. Task 1 is a **scaffolding spike** that pins these down against the installed CLI before the builder is implemented, so the rest of the plan builds against observed reality.

---

## File Structure

```
apps/server/
  package.json                                  # add hyperframes as a devDependency
  src/
    render/
      composition-builder.ts                    # pure (script, design, brief, narration?) → file map
      worker-protocol.ts                        # IPC types (RenderCommand, WorkerMessage)
      worker.ts                                 # child process: parses CLI output, sends IPC
      render-worker-client.ts                   # RenderWorkerClient interface + ForkedRenderWorkerClient
      stub-render-worker.ts                     # StubRenderWorkerClient (test double)
    phases/
      render-handler.ts                         # RenderPhaseHandler (implements PhaseHandler)
    compose-orchestrator.ts                     # MODIFY: default render handler = RenderPhaseHandler
  test/
    fixtures/
      hyperframes-reference.html                # captured from `npx hyperframes init` (Task 1)
      fake-renderer.mjs                         # tiny script the worker spawns in unit tests
    composition-builder.test.ts
    stub-render-worker.test.ts
    forked-render-worker.test.ts                # uses fake-renderer.mjs, no real hyperframes
    render-handler.test.ts                      # uses StubRenderWorkerClient
    compose-orchestrator-integration.test.ts    # MODIFY: drop `renderHandlerOverride` for one new case
    render-external.test.ts                     # @external: real `npx hyperframes render`
```

**Responsibility boundaries:**
- `composition-builder.ts` — pure, no I/O, no `node:fs`. Takes plain data, returns plain data. Knows the hyperframes HTML conventions captured in Task 1.
- `worker-protocol.ts` — type-only file. No runtime code.
- `worker.ts` — the only file that runs in the forked child. Receives one `RenderCommand` over IPC, spawns the renderer subprocess, parses its output, posts `WorkerMessage`s back. Exits when the render settles. Knows nothing about `PhaseHandler`, `ArtifactStore`, or `ServerEvent`.
- `render-worker-client.ts` — parent-side. `RenderWorkerClient` is the seam; `ForkedRenderWorkerClient` is the default impl that forks `worker.ts`. Exposes `render(opts) → AsyncIterable<WorkerMessage>`.
- `stub-render-worker.ts` — test double. Constructor takes a scripted message sequence; `render()` yields them.
- `render-handler.ts` — the `PhaseHandler`. Composes everything: artifact reads, builder, writer, worker client, artifact writes, abort plumbing. Does NOT know how to fork processes.
- `compose-orchestrator.ts` — top-level wiring (modify only).

---

## Task 1: Hyperframes reference spike + fixtures

**Files:**
- Create: `apps/server/test/fixtures/hyperframes-reference.html`
- Create: `apps/server/test/fixtures/fake-renderer.mjs`
- Modify: `apps/server/package.json`

This task pins down what a hyperframes composition actually looks like on disk against the *installed* CLI, captures one in `test/fixtures/`, and adds the deterministic `fake-renderer.mjs` stand-in that later tests will spawn instead of the real CLI. **No production code is written in this task.**

- [ ] **Step 1: Add hyperframes as a devDependency of the server package**

Edit `apps/server/package.json`. Add a `devDependencies` block (keeping the existing `dependencies` intact):

```json
{
  "name": "@ultracreator/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@earendil-works/pi-agent-core": "^0.78.0",
    "@earendil-works/pi-ai": "^0.78.0",
    "@google/genai": "^2.7.0",
    "@ultracreator/shared": "workspace:*",
    "typebox": "^1.1.39",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "hyperframes": "^0.6.63"
  }
}
```

(devDependency because production never `import`s hyperframes — the worker invokes its CLI via `npx`. Keeping it under devDependencies makes it available to `@external` tests and to the `node_modules/.bin/hyperframes` shim used by `npx`.)

- [ ] **Step 2: Install and confirm the CLI resolves**

Run, from the repo root:

```bash
pnpm install
pnpm --filter @ultracreator/server exec npx hyperframes --version
```

Expected: a version number is printed (e.g. `0.6.63`). If `pnpm install` fails because of an OS-level toolchain (onnxruntime, sharp) and you're on macOS/Linux x64 or arm64, that is unexpected — diagnose before continuing; if you're on an unsupported platform, stop and report.

- [ ] **Step 3: Scaffold a reference project into a throwaway directory**

```bash
mkdir -p /tmp/uc-spike
cd /tmp/uc-spike
pnpm --package=hyperframes dlx hyperframes init ref --example blank --non-interactive
ls ref
cat ref/index.html
```

Expected: a directory `ref/` is created. Note the file structure (`index.html`, possibly `compositions/`, `media/`, `hyperframes.json`).

- [ ] **Step 4: Lint and render the reference to confirm it's valid**

```bash
cd /tmp/uc-spike/ref
pnpm --package=hyperframes dlx hyperframes lint --json
pnpm --package=hyperframes dlx hyperframes render --quality draft --output /tmp/uc-spike/ref/out.mp4
ls -la /tmp/uc-spike/ref/out.mp4
```

Expected: `lint --json` returns `{ ... "errors": [...] }` with `errors: []`. `render` exits 0 and `out.mp4` exists and is non-empty. **Note the stdout format of `render`** — what does a progress line look like? Write it down; Task 5 will parse it.

- [ ] **Step 5: Capture the reference into the repo**

Copy the scaffolded `index.html` into the test fixtures:

```bash
cp /tmp/uc-spike/ref/index.html apps/server/test/fixtures/hyperframes-reference.html
```

The composition-builder tests (Task 2/3) will assert structural similarities against this file (e.g., presence of `data-composition-id`, `data-duration`, the overall outer-element shape). **If `hyperframes init` generates a project with files other than just `index.html` (e.g. a `hyperframes.json`)**, capture those too into `apps/server/test/fixtures/` — Task 2's builder needs to know which files are required at the project root for `npx hyperframes render` to succeed.

- [ ] **Step 6: Write the fake renderer subprocess**

Create `apps/server/test/fixtures/fake-renderer.mjs`. This is a tiny standalone Node script with **zero project imports** — it stands in for `npx hyperframes render` in unit tests so they don't need the real CLI:

```js
#!/usr/bin/env node
// Stand-in for `hyperframes render` used by the RenderWorker unit tests.
// CLI: fake-renderer.mjs --output <path> [--fail] [--hang] [--lines <N>]
import { writeFile } from "node:fs/promises";
import { argv, exit, stdout } from "node:process";

const args = new Map();
for (let i = 2; i < argv.length; i++) {
  const k = argv[i];
  if (!k.startsWith("--")) continue;
  const next = argv[i + 1];
  if (next && !next.startsWith("--")) { args.set(k.slice(2), next); i++; }
  else args.set(k.slice(2), "true");
}

if (args.get("hang") === "true") {
  // Never exit. Used by the timeout/abort tests; the worker must kill us.
  setInterval(() => {}, 1_000_000);
} else if (args.get("fail") === "true") {
  stdout.write("Encoding failed: synthetic error\n");
  exit(2);
} else {
  const lines = Number(args.get("lines") ?? 3);
  for (let i = 1; i <= lines; i++) {
    const pct = Math.round((i / lines) * 100);
    stdout.write(`Rendering frame batch ${i}/${lines} (${pct}%)\n`);
  }
  const output = args.get("output");
  if (output) await writeFile(output, "FAKE-MP4-BYTES");
  stdout.write("Render complete\n");
  exit(0);
}
```

Make it executable:

```bash
chmod +x apps/server/test/fixtures/fake-renderer.mjs
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/package.json apps/server/test/fixtures pnpm-lock.yaml
git commit -m "chore(server): pin hyperframes ref + add fake-renderer fixture"
```

---

## Task 2: CompositionBuilder — index.html for a narrationless script

**Files:**
- Create: `apps/server/src/render/composition-builder.ts`
- Test: `apps/server/test/composition-builder.test.ts`

The builder is the only piece of code that knows how to translate `(brief, design, script, narration?)` into hyperframes-compatible files. Task 2 lands the narrationless path so the surface area is small; Task 3 adds the audio track.

The contract: `buildComposition(input)` returns a `BuiltComposition` containing:
- `files: Map<string, string>` — keys are relative paths inside the composition project dir, values are file contents. Always includes `"index.html"`.
- `durationSec: number` — total composition duration (= `script.totalSec`).
- `resolution: { width: number; height: number }` — derived from `brief.constraints.aspectRatio`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/composition-builder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Brief, Design, Script } from "@ultracreator/shared";
import { buildComposition } from "../src/render/composition-builder.js";

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A SaaS tool", category: "saas" },
  audience: "developers",
  keyMessages: ["fast", "simple"],
  brandHints: { colors: ["#FF3366", "#222222"], logoUrl: "uploads/logo.png", fonts: ["Inter"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const design: Design = {
  mood: "energetic",
  palette: [
    { name: "primary", hex: "#FF3366" },
    { name: "bg", hex: "#101010" },
  ],
  typography: { heading: "Poppins", body: "Inter" },
  motionStyle: "kinetic captions",
  keyVisuals: [],
  sampleFrames: [],
};
const script: Script = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo reveal", onScreenText: "Meet Acme" },
    { id: "s2", startSec: 6, durationSec: 24, visual: "demo", onScreenText: "Ship faster" },
  ],
};

describe("buildComposition (no narration)", () => {
  it("returns index.html with the right composition metadata", () => {
    const built = buildComposition({ brief, design, script });
    expect(built.files.has("index.html")).toBe(true);
    expect(built.durationSec).toBe(30);
    expect(built.resolution).toEqual({ width: 1920, height: 1080 });

    const html = built.files.get("index.html")!;
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-duration="30"');
    expect(html).toContain('data-resolution="1920x1080"');
  });

  it("emits one scene element per script scene with start/duration attributes", () => {
    const html = buildComposition({ brief, design, script }).files.get("index.html")!;
    // s1: 0..6s
    expect(html).toMatch(/data-track="scene-s1"[^>]*data-start="0"[^>]*data-duration="6"/);
    // s2: 6..30s
    expect(html).toMatch(/data-track="scene-s2"[^>]*data-start="6"[^>]*data-duration="24"/);
    expect(html).toContain("Meet Acme");
    expect(html).toContain("Ship faster");
  });

  it("uses design.palette and typography in the inline stylesheet", () => {
    const html = buildComposition({ brief, design, script }).files.get("index.html")!;
    expect(html).toContain("#FF3366");
    expect(html).toContain("#101010");
    expect(html).toContain("Poppins");
    expect(html).toContain("Inter");
  });

  it("escapes HTML-special characters in scene text", () => {
    const evilScript: Script = {
      totalSec: 5,
      scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "v", onScreenText: "<script>x</script>" }],
    };
    const html = buildComposition({ brief, design, script: evilScript }).files.get("index.html")!;
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("derives resolution from aspect ratio", () => {
    const portrait = buildComposition({
      brief: { ...brief, constraints: { ...brief.constraints, aspectRatio: "9:16" } },
      design,
      script,
    });
    expect(portrait.resolution).toEqual({ width: 1080, height: 1920 });
    expect(portrait.files.get("index.html")!).toContain('data-resolution="1080x1920"');

    const square = buildComposition({
      brief: { ...brief, constraints: { ...brief.constraints, aspectRatio: "1:1" } },
      design,
      script,
    });
    expect(square.resolution).toEqual({ width: 1080, height: 1080 });
  });

  it("omits any <audio> element when narration is not provided", () => {
    const html = buildComposition({ brief, design, script }).files.get("index.html")!;
    expect(html).not.toContain("<audio");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/server/test/composition-builder.test.ts`
Expected: FAIL — cannot resolve `../src/render/composition-builder.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/render/composition-builder.ts`:

```ts
import type { AspectRatio, Brief, Design, Script } from "@ultracreator/shared";

export interface BuildCompositionInput {
  brief: Brief;
  design: Design;
  script: Script;
  /** When present, an <audio> track is added and a `narration.<ext>` file is included. */
  narration?: { fileName: string; bytes: Buffer; durationMs: number };
}

export interface BuiltComposition {
  files: Map<string, string | Buffer>;
  durationSec: number;
  resolution: { width: number; height: number };
}

const RESOLUTIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildComposition(input: BuildCompositionInput): BuiltComposition {
  const { brief, design, script } = input;
  const resolution = RESOLUTIONS[brief.constraints.aspectRatio];
  const primary = design.palette[0]?.hex ?? "#FFFFFF";
  const background = design.palette[1]?.hex ?? "#000000";

  const sceneHtml = script.scenes
    .map((s) => {
      const heading = s.onScreenText ? `<h1>${escapeHtml(s.onScreenText)}</h1>` : "";
      const caption = s.visual ? `<p>${escapeHtml(s.visual)}</p>` : "";
      return `
    <div class="scene" data-track="scene-${escapeHtml(s.id)}" data-start="${s.startSec}" data-duration="${s.durationSec}">
      ${heading}${caption}
    </div>`.trim();
    })
    .join("\n    ");

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(brief.product.name)}</title>
  <style>
    body { margin: 0; background: ${background}; }
    .scene { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .scene h1 { font-family: '${escapeHtml(design.typography.heading)}', sans-serif; color: ${primary}; font-size: 96px; margin: 0 0 16px; }
    .scene p  { font-family: '${escapeHtml(design.typography.body)}', sans-serif; color: ${primary}; font-size: 36px; margin: 0; opacity: 0.8; }
  </style>
</head>
<body>
  <div data-composition-id="main" data-duration="${script.totalSec}" data-resolution="${resolution.width}x${resolution.height}" data-fps="30">
    ${sceneHtml}
  </div>
</body>
</html>
`;

  const files = new Map<string, string | Buffer>();
  files.set("index.html", html);
  return { files, durationSec: script.totalSec, resolution };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/server/test/composition-builder.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/render/composition-builder.ts apps/server/test/composition-builder.test.ts
git commit -m "feat(server): CompositionBuilder for narrationless hyperframes projects"
```

---

## Task 3: CompositionBuilder — narration audio track

**Files:**
- Modify: `apps/server/src/render/composition-builder.ts`
- Modify: `apps/server/test/composition-builder.test.ts`

When the voiceover phase ran, we have a `narration.wav` (or `.mp3`) on disk. The render-handler will read those bytes and pass them to the builder, which (a) embeds an `<audio data-track="narration" data-start="0" src="narration.wav">` element in the HTML and (b) includes the audio file under that exact relative path in the file map.

- [ ] **Step 1: Append failing tests**

Add to `apps/server/test/composition-builder.test.ts`:

```ts
describe("buildComposition (with narration)", () => {
  it("adds an <audio> element pointing at narration.wav", () => {
    const built = buildComposition({
      brief,
      design,
      script,
      narration: { fileName: "narration.wav", bytes: Buffer.from("FAKE-WAV"), durationMs: 30_000 },
    });
    const html = built.files.get("index.html")!;
    expect(html).toContain('<audio data-track="narration" data-start="0" src="narration.wav"');
  });

  it("emits the narration audio file under the project root", () => {
    const built = buildComposition({
      brief,
      design,
      script,
      narration: { fileName: "narration.wav", bytes: Buffer.from("FAKE-WAV"), durationMs: 30_000 },
    });
    expect(built.files.get("narration.wav")).toEqual(Buffer.from("FAKE-WAV"));
  });

  it("rejects a narration file name that escapes the project dir", () => {
    expect(() =>
      buildComposition({
        brief,
        design,
        script,
        narration: { fileName: "../escape.wav", bytes: Buffer.from(""), durationMs: 0 },
      }),
    ).toThrow(/narration file/i);
  });

  it("supports an mp3 extension", () => {
    const built = buildComposition({
      brief,
      design,
      script,
      narration: { fileName: "narration.mp3", bytes: Buffer.from("FAKE-MP3"), durationMs: 30_000 },
    });
    expect(built.files.has("narration.mp3")).toBe(true);
    expect(built.files.get("index.html")!).toContain('src="narration.mp3"');
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm vitest run apps/server/test/composition-builder.test.ts`
Expected: FAIL — no narration handling yet.

- [ ] **Step 3: Update `buildComposition` to honor `narration`**

In `apps/server/src/render/composition-builder.ts`, replace the `buildComposition` body. (Only the body changes; signature and helpers above stay.)

```ts
export function buildComposition(input: BuildCompositionInput): BuiltComposition {
  const { brief, design, script, narration } = input;
  const resolution = RESOLUTIONS[brief.constraints.aspectRatio];
  const primary = design.palette[0]?.hex ?? "#FFFFFF";
  const background = design.palette[1]?.hex ?? "#000000";

  if (narration) {
    if (narration.fileName.includes("/") || narration.fileName.includes("\\") || narration.fileName.includes("..")) {
      throw new Error(`Invalid narration file name (must be a flat path inside the project dir): ${narration.fileName}`);
    }
  }

  const sceneHtml = script.scenes
    .map((s) => {
      const heading = s.onScreenText ? `<h1>${escapeHtml(s.onScreenText)}</h1>` : "";
      const caption = s.visual ? `<p>${escapeHtml(s.visual)}</p>` : "";
      return `
    <div class="scene" data-track="scene-${escapeHtml(s.id)}" data-start="${s.startSec}" data-duration="${s.durationSec}">
      ${heading}${caption}
    </div>`.trim();
    })
    .join("\n    ");

  const audioHtml = narration
    ? `<audio data-track="narration" data-start="0" src="${escapeHtml(narration.fileName)}"></audio>`
    : "";

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(brief.product.name)}</title>
  <style>
    body { margin: 0; background: ${background}; }
    .scene { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .scene h1 { font-family: '${escapeHtml(design.typography.heading)}', sans-serif; color: ${primary}; font-size: 96px; margin: 0 0 16px; }
    .scene p  { font-family: '${escapeHtml(design.typography.body)}', sans-serif; color: ${primary}; font-size: 36px; margin: 0; opacity: 0.8; }
  </style>
</head>
<body>
  <div data-composition-id="main" data-duration="${script.totalSec}" data-resolution="${resolution.width}x${resolution.height}" data-fps="30">
    ${sceneHtml}
    ${audioHtml}
  </div>
</body>
</html>
`;

  const files = new Map<string, string | Buffer>();
  files.set("index.html", html);
  if (narration) files.set(narration.fileName, narration.bytes);
  return { files, durationSec: script.totalSec, resolution };
}
```

- [ ] **Step 4: Run all builder tests**

Run: `pnpm vitest run apps/server/test/composition-builder.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/render/composition-builder.ts apps/server/test/composition-builder.test.ts
git commit -m "feat(server): CompositionBuilder supports narration audio track"
```

---

## Task 4: Worker IPC protocol types

**Files:**
- Create: `apps/server/src/render/worker-protocol.ts`

Type-only file: it pins down the wire format between the parent (`RenderWorkerClient`) and child (`worker.ts`). No tests here — it ships as part of Task 5 which exercises it across the IPC boundary.

- [ ] **Step 1: Create `worker-protocol.ts`**

Create `apps/server/src/render/worker-protocol.ts`:

```ts
/** Parent → child: the single render command sent right after `ready`. */
export interface RenderCommand {
  type: "render";
  /** Absolute path to the hyperframes project directory (contains index.html). */
  projectDir: string;
  /** Absolute path for the rendered MP4. The worker writes here on success. */
  outputPath: string;
  /** hyperframes --quality */
  quality?: "draft" | "standard" | "high";
  /** hyperframes --fps */
  fps?: 24 | 30 | 60;
  /**
   * Override for the renderer subprocess. Defaults to
   * `["npx", "--package=hyperframes", "hyperframes", "render", ...]`.
   * Unit tests pass a path to fake-renderer.mjs instead.
   */
  rendererCommand?: string[];
  /** Hard timeout in ms. Default = 5 * 60 * 1000. */
  timeoutMs?: number;
}

/** Child → parent. */
export type WorkerMessage =
  | { type: "ready" }
  | { type: "progress"; percent: number; message?: string }
  | { type: "log"; line: string }
  | { type: "done"; mp4Path: string }
  | { type: "error"; message: string };
```

- [ ] **Step 2: Commit (Task 5 will be the first consumer)**

```bash
git add apps/server/src/render/worker-protocol.ts
git commit -m "feat(server): RenderWorker IPC protocol types"
```

---

## Task 5: Worker entry script (child process)

**Files:**
- Create: `apps/server/src/render/worker.ts`
- Test: `apps/server/test/forked-render-worker.test.ts` (covers `worker.ts` end-to-end via `fork()` in Task 6 — no test of the script alone here)

The worker has one job: receive a `RenderCommand`, spawn the renderer subprocess, parse its stdout for progress, post `WorkerMessage`s to the parent, and exit. A progress line is any stdout line containing `(NN%)` — extracted with a regex. All other non-empty stdout lines are forwarded as `log`. Stderr is collected; on non-zero exit it becomes the `error.message`. A hard timeout kills the child (`SIGKILL`) and reports `error: "Render timed out"`. If the parent disconnects (closes the IPC channel), the worker also kills the subprocess and exits — never leak Chrome.

- [ ] **Step 1: Create `worker.ts`**

Create `apps/server/src/render/worker.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RenderCommand, WorkerMessage } from "./worker-protocol.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const PROGRESS_RE = /\((\d{1,3})%\)/;

function send(msg: WorkerMessage): void {
  if (!process.send) {
    // Running standalone (not forked). Useful for ad-hoc debugging only.
    process.stdout.write(`[worker-msg] ${JSON.stringify(msg)}\n`);
    return;
  }
  process.send(msg);
}

function defaultRendererCommand(cmd: RenderCommand): string[] {
  const base = ["npx", "--package=hyperframes", "hyperframes", "render", "--output", cmd.outputPath];
  if (cmd.quality) { base.push("--quality", cmd.quality); }
  if (cmd.fps) { base.push("--fps", String(cmd.fps)); }
  return base;
}

async function runRender(cmd: RenderCommand): Promise<void> {
  await mkdir(dirname(cmd.outputPath), { recursive: true });
  const argv = cmd.rendererCommand ?? defaultRendererCommand(cmd);
  const [exe, ...args] = argv;
  if (!exe) {
    send({ type: "error", message: "rendererCommand is empty" });
    return;
  }

  const child: ChildProcess = spawn(exe, args, { cwd: cmd.projectDir, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let settled = false;

  const settleError = (message: string) => {
    if (settled) return;
    settled = true;
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    send({ type: "error", message });
  };

  const timeout = setTimeout(
    () => settleError("Render timed out"),
    cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  // If the parent goes away (IPC disconnect), kill the subprocess.
  process.on("disconnect", () => { try { child.kill("SIGKILL"); } catch { /* ignore */ } });

  let stdoutBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const m = PROGRESS_RE.exec(line);
      if (m) {
        const percent = Math.min(100, Math.max(0, Number(m[1])));
        send({ type: "progress", percent, message: line });
      } else {
        send({ type: "log", line });
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  child.on("error", (err) => settleError(err.message));
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (code === 0) {
      send({ type: "progress", percent: 100 });
      send({ type: "done", mp4Path: cmd.outputPath });
    } else {
      const tail = stderr.split("\n").slice(-10).join("\n").trim();
      send({ type: "error", message: `Renderer exited with code ${code}${tail ? `: ${tail}` : ""}` });
    }
    // Allow the parent to consume the final message, then exit cleanly.
    process.nextTick(() => process.exit(0));
  });
}

process.on("message", (msg: unknown) => {
  const m = msg as RenderCommand;
  if (m && typeof m === "object" && m.type === "render") {
    void runRender(m);
  }
});

send({ type: "ready" });
```

- [ ] **Step 2: Commit (the round-trip test lands in Task 6)**

```bash
git add apps/server/src/render/worker.ts
git commit -m "feat(server): RenderWorker child-process entry script"
```

---

## Task 6: RenderWorkerClient (interface + ForkedRenderWorkerClient)

**Files:**
- Create: `apps/server/src/render/render-worker-client.ts`
- Test: `apps/server/test/forked-render-worker.test.ts`

`RenderWorkerClient` is the parent-side seam. `render(opts) → AsyncIterable<WorkerMessage>` is the contract: yields every `WorkerMessage` from the child, terminates after `done` or `error` (which is the **last** value yielded — no throw; the handler decides what to do).

`ForkedRenderWorkerClient` is the real implementation: forks `worker.ts` via `child_process.fork`, sends the command after `ready`, queues incoming messages, and bridges them to the async iterator. It uses the `tsx` runtime loader so the TS source is executable as a child entrypoint (the project has no build step).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/forked-render-worker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerMessage } from "../src/render/worker-protocol.js";
import { ForkedRenderWorkerClient } from "../src/render/render-worker-client.js";

const FAKE_RENDERER = fileURLToPath(new URL("./fixtures/fake-renderer.mjs", import.meta.url));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-fork-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function collect(stream: AsyncIterable<WorkerMessage>): Promise<WorkerMessage[]> {
  const out: WorkerMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe("ForkedRenderWorkerClient", () => {
  it("forwards progress lines and ends with a done message containing the output path", async () => {
    const client = new ForkedRenderWorkerClient();
    const outputPath = join(root, "out.mp4");
    const messages = await collect(client.render({
      projectDir: root,
      outputPath,
      rendererCommand: ["node", FAKE_RENDERER, "--output", outputPath, "--lines", "3"],
    }));

    const progress = messages.filter((m) => m.type === "progress");
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress.at(-1)).toMatchObject({ type: "progress", percent: 100 });

    const last = messages.at(-1)!;
    expect(last).toEqual({ type: "done", mp4Path: outputPath });
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe("FAKE-MP4-BYTES");
  });

  it("yields an error message when the renderer exits non-zero", async () => {
    const client = new ForkedRenderWorkerClient();
    const messages = await collect(client.render({
      projectDir: root,
      outputPath: join(root, "out.mp4"),
      rendererCommand: ["node", FAKE_RENDERER, "--fail"],
    }));
    const last = messages.at(-1)!;
    expect(last.type).toBe("error");
    if (last.type === "error") expect(last.message).toMatch(/code 2/);
  });

  it("kills the renderer and yields error when timeoutMs elapses", async () => {
    const client = new ForkedRenderWorkerClient();
    const messages = await collect(client.render({
      projectDir: root,
      outputPath: join(root, "out.mp4"),
      rendererCommand: ["node", FAKE_RENDERER, "--hang"],
      timeoutMs: 150,
    }));
    const last = messages.at(-1)!;
    expect(last.type).toBe("error");
    if (last.type === "error") expect(last.message).toMatch(/time/i);
  });

  it("ends the iterator after a done message (no dangling work)", async () => {
    const client = new ForkedRenderWorkerClient();
    const outputPath = join(root, "out.mp4");
    let count = 0;
    for await (const _ of client.render({
      projectDir: root,
      outputPath,
      rendererCommand: ["node", FAKE_RENDERER, "--output", outputPath, "--lines", "1"],
    })) {
      count++;
    }
    expect(count).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/server/test/forked-render-worker.test.ts`
Expected: FAIL — `../src/render/render-worker-client.js` not found.

- [ ] **Step 3: Implement `RenderWorkerClient`**

Create `apps/server/src/render/render-worker-client.ts`:

```ts
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RenderCommand, WorkerMessage } from "./worker-protocol.js";

export interface RenderOptions {
  projectDir: string;
  outputPath: string;
  quality?: RenderCommand["quality"];
  fps?: RenderCommand["fps"];
  /** Override for unit tests (default: `npx hyperframes render ...`). */
  rendererCommand?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RenderWorkerClient {
  render(opts: RenderOptions): AsyncIterable<WorkerMessage>;
}

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));

/**
 * Default RenderWorkerClient: forks `worker.ts` and bridges its IPC into an
 * AsyncIterable. The iterator completes after the first `done` or `error`
 * message; the child is killed on iterator completion or `signal` abort.
 */
export class ForkedRenderWorkerClient implements RenderWorkerClient {
  constructor(private workerPath: string = WORKER_PATH) {}

  async *render(opts: RenderOptions): AsyncIterable<WorkerMessage> {
    // The project runs TypeScript directly via tsx; the worker is a .ts file,
    // so the forked child must load tsx's ESM loader.
    const child: ChildProcess = fork(this.workerPath, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    const queue: WorkerMessage[] = [];
    let waiter: (() => void) | null = null;
    let finished = false;

    const onAbort = () => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort);
    }

    const drain = (msg: WorkerMessage) => {
      queue.push(msg);
      if (waiter) { const w = waiter; waiter = null; w(); }
    };

    child.on("message", (raw: unknown) => {
      const msg = raw as WorkerMessage;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        const cmd: RenderCommand = {
          type: "render",
          projectDir: opts.projectDir,
          outputPath: opts.outputPath,
          quality: opts.quality,
          fps: opts.fps,
          rendererCommand: opts.rendererCommand,
          timeoutMs: opts.timeoutMs,
        };
        child.send(cmd);
        return;
      }
      drain(msg);
    });

    const onClose = () => {
      if (finished) return;
      // The worker exited without sending a terminal message — synthesize one.
      drain({ type: "error", message: "Render worker exited unexpectedly" });
    };
    child.on("exit", onClose);
    child.on("error", (err) => drain({ type: "error", message: err.message }));

    try {
      while (!finished) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { waiter = resolve; });
          continue;
        }
        const msg = queue.shift()!;
        yield msg;
        if (msg.type === "done" || msg.type === "error") {
          finished = true;
        }
      }
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/server/test/forked-render-worker.test.ts`
Expected: PASS (4 tests). If the test runner can't resolve `tsx` for the forked child, confirm `tsx` is hoisted by `pnpm` (run `ls node_modules/.bin/tsx`) — it is a root devDep from Plan 1.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/render/render-worker-client.ts apps/server/test/forked-render-worker.test.ts
git commit -m "feat(server): ForkedRenderWorkerClient with progress/done/error/timeout"
```

---

## Task 7: StubRenderWorkerClient (test double)

**Files:**
- Create: `apps/server/src/render/stub-render-worker.ts`
- Test: `apps/server/test/stub-render-worker.test.ts`

The stub is what `render-handler.test.ts` (Task 8) and the updated compose-orchestrator integration test (Task 10) will inject. It just yields a scripted sequence of `WorkerMessage`s, optionally writing an output file so artifact-creation paths can be exercised.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/stub-render-worker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerMessage } from "../src/render/worker-protocol.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-stub-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function collect(stream: AsyncIterable<WorkerMessage>): Promise<WorkerMessage[]> {
  const out: WorkerMessage[] = [];
  for await (const m of stream) out.push(m);
  return out;
}

describe("StubRenderWorkerClient", () => {
  it("yields the scripted messages in order", async () => {
    const client = new StubRenderWorkerClient({
      messages: [
        { type: "progress", percent: 25 },
        { type: "progress", percent: 75 },
        { type: "done", mp4Path: "/tmp/stub.mp4" },
      ],
    });
    const got = await collect(client.render({ projectDir: "/x", outputPath: "/tmp/stub.mp4" }));
    expect(got).toEqual([
      { type: "progress", percent: 25 },
      { type: "progress", percent: 75 },
      { type: "done", mp4Path: "/tmp/stub.mp4" },
    ]);
  });

  it("when writeOutput is true, materializes an MP4 at outputPath and rewrites the done.mp4Path", async () => {
    const client = new StubRenderWorkerClient({ writeOutput: true });
    const outputPath = join(root, "stub.mp4");
    const got = await collect(client.render({ projectDir: root, outputPath }));
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toContain("STUB-MP4");
    expect(got.at(-1)).toEqual({ type: "done", mp4Path: outputPath });
  });

  it("when configured to fail, yields an error message and stops", async () => {
    const client = new StubRenderWorkerClient({ failWith: "render kaboom" });
    const got = await collect(client.render({ projectDir: "/x", outputPath: "/tmp/x.mp4" }));
    expect(got).toEqual([{ type: "error", message: "render kaboom" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/server/test/stub-render-worker.test.ts`
Expected: FAIL — `stub-render-worker.js` not found.

- [ ] **Step 3: Implement the stub**

Create `apps/server/src/render/stub-render-worker.ts`:

```ts
import { writeFile } from "node:fs/promises";
import type { RenderOptions, RenderWorkerClient } from "./render-worker-client.js";
import type { WorkerMessage } from "./worker-protocol.js";

export interface StubRenderWorkerOptions {
  /** Scripted sequence yielded as-is. Default: one 50% progress + one done. */
  messages?: WorkerMessage[];
  /** If true, write a tiny placeholder MP4 to `outputPath` and force `done.mp4Path = outputPath`. */
  writeOutput?: boolean;
  /** If set, yields exactly one `error` message with this text and stops. */
  failWith?: string;
}

export class StubRenderWorkerClient implements RenderWorkerClient {
  constructor(private opts: StubRenderWorkerOptions = {}) {}

  async *render(opts: RenderOptions): AsyncIterable<WorkerMessage> {
    if (this.opts.failWith) {
      yield { type: "error", message: this.opts.failWith };
      return;
    }

    if (this.opts.writeOutput) {
      await writeFile(opts.outputPath, "STUB-MP4-BYTES");
      yield { type: "progress", percent: 50 };
      yield { type: "done", mp4Path: opts.outputPath };
      return;
    }

    const scripted = this.opts.messages ?? [
      { type: "progress", percent: 50 },
      { type: "done", mp4Path: opts.outputPath },
    ];
    for (const m of scripted) {
      yield m;
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/server/test/stub-render-worker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/render/stub-render-worker.ts apps/server/test/stub-render-worker.test.ts
git commit -m "feat(server): StubRenderWorkerClient for deterministic tests"
```

---

## Task 8: RenderPhaseHandler

**Files:**
- Create: `apps/server/src/phases/render-handler.ts`
- Test: `apps/server/test/render-handler.test.ts`

The handler is the real `PhaseHandler` for the render phase. It:
1. Reads the latest `brief`, `design`, `script` artifacts. If any are missing, throws — the orchestrator surfaces it as `phase.error`.
2. Reads the latest `narration` artifact's data (if present); reads the underlying audio file's bytes off disk.
3. Calls `buildComposition(...)`.
4. Writes every entry in `built.files` to `workspaces/<sid>/composition/<path>`.
5. Calls `ctx.artifacts.put("composition", { dir: "composition", entry: "index.html" }, ...)`.
6. Generates an output path `output/<random-id>.mp4`.
7. Calls `this.workerClient.render({ projectDir, outputPath, signal: ctx.signal })` and yields its progress/log messages as `phase.progress` events, its `progress` messages as `render.progress` events.
8. On `done`: calls `ctx.artifacts.put("mp4", { path }, { derivedFrom: [{ kind: "composition", v }, ...] })`, then yields `render.done`.
9. On `error`: throws (orchestrator emits `phase.error`).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/render-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, Design, Script, ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";
import { RenderPhaseHandler } from "../src/phases/render-handler.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-rh-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};
const design: Design = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#FF3366" }, { name: "bg", hex: "#101010" }],
  typography: { heading: "Poppins", body: "Inter" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const script: Script = {
  totalSec: 30,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo", onScreenText: "Hi" },
    { id: "s2", startSec: 6, durationSec: 24, visual: "demo", onScreenText: "Acme" },
  ],
};

async function seed(store: ArtifactStore, kinds: "no-voiceover" | "with-voiceover", wm: WorkspaceManager) {
  await wm.init("s1");
  await store.put("s1", "brief", kinds === "with-voiceover"
    ? { ...brief, constraints: { ...brief.constraints, withVoiceover: true } }
    : brief);
  await store.put("s1", "design", design);
  await store.put("s1", "script", script);
  if (kinds === "with-voiceover") {
    const audioPath = join(wm.paths("s1").composition, "narration.wav");
    await writeFile(audioPath, Buffer.from("REAL-WAV-BYTES"));
    await store.put("s1", "narration", { audioPath, durationMs: 30_000 });
  }
}

describe("RenderPhaseHandler", () => {
  it("writes the composition files to disk, writes composition + mp4 artifacts, and yields render.progress / render.done", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, "no-voiceover", wm);

    const worker = new StubRenderWorkerClient({ writeOutput: true });
    const handler = new RenderPhaseHandler({ workerClient: worker });

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1",
      workspaces: wm,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) yielded.push(e);

    // Composition was written to disk.
    expect(existsSync(join(wm.paths("s1").composition, "index.html"))).toBe(true);

    // Artifacts.
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
    const mp4Desc = list.find((d) => d.kind === "mp4")!;
    expect(mp4Desc).toBeDefined();

    // mp4 artifact data points at the real file.
    const mp4Env = await store.get<{ path: string }>("s1", "mp4");
    expect(existsSync(mp4Env!.data.path)).toBe(true);
    expect(readFileSync(mp4Env!.data.path, "utf8")).toContain("STUB-MP4");

    // Events: at least one render.progress and one render.done at the end.
    expect(yielded.some((e) => e.type === "render.progress")).toBe(true);
    expect(yielded.at(-1)).toMatchObject({ type: "render.done" });
  });

  it("includes the narration audio in the composition dir when a narration artifact exists", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, "with-voiceover", wm);

    const worker = new StubRenderWorkerClient({ writeOutput: true });
    const handler = new RenderPhaseHandler({ workerClient: worker });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces: wm,
      artifacts: store,
      events: bus,
      signal: new AbortController().signal,
    })) { /* drain */ }

    const compositionDir = wm.paths("s1").composition;
    expect(existsSync(join(compositionDir, "index.html"))).toBe(true);
    expect(existsSync(join(compositionDir, "narration.wav"))).toBe(true);
    expect(readFileSync(join(compositionDir, "index.html"), "utf8")).toContain("narration.wav");
  });

  it("throws when the upstream script artifact is missing", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await wm.init("s1");
    await store.put("s1", "brief", brief);
    await store.put("s1", "design", design);
    // no script

    const handler = new RenderPhaseHandler({ workerClient: new StubRenderWorkerClient({ writeOutput: true }) });
    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces: wm,
        artifacts: store,
        events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow(/script/i);
  });

  it("throws when the worker yields an error", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, "no-voiceover", wm);

    const worker = new StubRenderWorkerClient({ failWith: "ffmpeg blew up" });
    const handler = new RenderPhaseHandler({ workerClient: worker });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1",
        workspaces: wm,
        artifacts: store,
        events: bus,
        signal: new AbortController().signal,
      })) { /* drain */ }
    }).rejects.toThrow(/ffmpeg/);

    // mp4 artifact must NOT have been written.
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "mp4")).toBeUndefined();
    // composition still landed (it was written before the render failed).
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("propagates ctx.signal abort to the worker client", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, "no-voiceover", wm);

    let observedSignal: AbortSignal | undefined;
    class CapturingClient extends StubRenderWorkerClient {
      override async *render(opts: import("../src/render/render-worker-client.js").RenderOptions) {
        observedSignal = opts.signal;
        yield { type: "done", mp4Path: opts.outputPath } as const;
        await writeFile(opts.outputPath, "X");
      }
    }
    const controller = new AbortController();
    const handler = new RenderPhaseHandler({ workerClient: new CapturingClient({ writeOutput: false }) });

    for await (const _ of handler.run({
      sessionId: "s1",
      workspaces: wm,
      artifacts: store,
      events: bus,
      signal: controller.signal,
    })) { /* drain */ }

    expect(observedSignal).toBe(controller.signal);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/server/test/render-handler.test.ts`
Expected: FAIL — `render-handler.js` not found.

- [ ] **Step 3: Implement `RenderPhaseHandler`**

Create `apps/server/src/phases/render-handler.ts`:

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Brief,
  Design,
  LineageRef,
  PhaseId,
  Script,
  ServerEvent,
} from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { buildComposition } from "../render/composition-builder.js";
import type { RenderWorkerClient } from "../render/render-worker-client.js";

export interface RenderPhaseHandlerOptions {
  workerClient: RenderWorkerClient;
  /** Forwarded to the worker. Default: 5 minutes. */
  timeoutMs?: number;
  /** Forwarded to the worker (passed through to `hyperframes render --quality`). */
  quality?: "draft" | "standard" | "high";
  /** Forwarded to the worker (passed through to `hyperframes render --fps`). */
  fps?: 24 | 30 | 60;
}

interface NarrationArtifactData {
  audioPath: string;
  durationMs: number;
  wordTimings?: unknown;
}

export class RenderPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "render";
  constructor(private opts: RenderPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    if (ctx.signal.aborted) throw new Error("Aborted");

    // 1. Load upstream artifacts.
    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    const designEnv = await ctx.artifacts.get<Design>(ctx.sessionId, "design");
    const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
    if (!briefEnv) throw new Error("render phase requires a brief artifact, none found");
    if (!designEnv) throw new Error("render phase requires a design artifact, none found");
    if (!scriptEnv) throw new Error("render phase requires a script artifact, none found");

    const narrationEnv = await ctx.artifacts.get<NarrationArtifactData>(ctx.sessionId, "narration");
    let narration: { fileName: string; bytes: Buffer; durationMs: number } | undefined;
    if (narrationEnv) {
      const fileName = basename(narrationEnv.data.audioPath);
      const bytes = await readFile(narrationEnv.data.audioPath);
      narration = { fileName, bytes, durationMs: narrationEnv.data.durationMs };
    }

    // 2. Build the composition file map.
    yield { type: "phase.progress", phase: this.phase, message: "Building composition" };
    const built = buildComposition({
      brief: briefEnv.data,
      design: designEnv.data,
      script: scriptEnv.data,
      narration,
    });

    // 3. Write files to disk under workspaces/<sid>/composition/.
    const paths = ctx.workspaces.paths(ctx.sessionId);
    for (const [relPath, content] of built.files) {
      const abs = join(paths.composition, relPath);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }

    // 4. Write composition artifact (lineage: design + script + (narration?)).
    const compositionLineage: LineageRef[] = [
      { kind: "design", version: designEnv.version },
      { kind: "script", version: scriptEnv.version },
    ];
    if (narrationEnv) compositionLineage.push({ kind: "narration", version: narrationEnv.version });
    const compositionEnv = await ctx.artifacts.put(
      ctx.sessionId,
      "composition",
      { dir: "composition", entry: "index.html" },
      { derivedFrom: compositionLineage },
    );

    if (ctx.signal.aborted) throw new Error("Aborted");

    // 5. Run the renderer.
    const outputPath = join(paths.output, `${randomUUID()}.mp4`);
    yield { type: "phase.progress", phase: this.phase, message: "Starting render" };

    for await (const msg of this.opts.workerClient.render({
      projectDir: paths.composition,
      outputPath,
      quality: this.opts.quality,
      fps: this.opts.fps,
      timeoutMs: this.opts.timeoutMs,
      signal: ctx.signal,
    })) {
      switch (msg.type) {
        case "ready":
          break;
        case "progress":
          yield { type: "render.progress", percent: msg.percent };
          break;
        case "log":
          yield { type: "phase.progress", phase: this.phase, message: msg.line };
          break;
        case "done": {
          await ctx.artifacts.put(
            ctx.sessionId,
            "mp4",
            { path: msg.mp4Path, durationSec: built.durationSec },
            { derivedFrom: [{ kind: "composition", version: compositionEnv.version }] },
          );
          yield { type: "render.done", mp4Path: msg.mp4Path };
          return;
        }
        case "error":
          yield { type: "render.error", error: msg.message };
          throw new Error(msg.message);
      }
    }

    // The worker iterator ended without `done` or `error`.
    throw new Error("Render worker ended without a terminal message");
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/server/test/render-handler.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/render-handler.ts apps/server/test/render-handler.test.ts
git commit -m "feat(server): RenderPhaseHandler — compose, render, write artifacts"
```

---

## Task 9: Wire RenderPhaseHandler into composeOrchestrator

**Files:**
- Modify: `apps/server/src/compose-orchestrator.ts`
- Modify: `apps/server/test/compose-orchestrator-integration.test.ts`

Replace the `throwUntilPlan4` placeholder with a real `RenderPhaseHandler` backed by `ForkedRenderWorkerClient`. The existing `renderHandlerOverride` option stays so existing tests that supply a `FakePhaseHandler` keep passing. A NEW test case exercises the real `RenderPhaseHandler` with a `StubRenderWorkerClient` to prove the wiring lands.

- [ ] **Step 1: Append a failing test (do not yet touch the production code)**

Add to `apps/server/test/compose-orchestrator-integration.test.ts` (new test inside the existing `describe("composeOrchestrator integration", …)` block):

```ts
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";
import { RenderPhaseHandler } from "../src/phases/render-handler.js";
import { existsSync } from "node:fs";

it("drives the full chain through the REAL RenderPhaseHandler with a stub worker (produces composition + mp4 artifacts on disk)", async () => {
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write_brief", { ...briefData, constraints: { ...briefData.constraints, withVoiceover: false } })),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_design", designData)),
    fauxAssistantMessage(fauxText("done")),
    fauxAssistantMessage(fauxToolCall("write_script", scriptData)),
    fauxAssistantMessage(fauxText("done")),
  ]);

  const realRender = new RenderPhaseHandler({
    workerClient: new StubRenderWorkerClient({ writeOutput: true }),
  });

  const { orchestrator, artifacts, workspaces } = composeOrchestrator({
    baseDir: root,
    model: faux.getModel("uc-test")!,
    fetch: async (url) => ({ status: 200, text: `body of ${url}` }),
    tts: new StubTTSProvider(),
    renderHandlerOverride: realRender,
  });

  await orchestrator.handleMessage("s1", {
    text: "Make a 30-second promo for https://acme.example",
    constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
  });
  await orchestrator.handleMessage("s1", { text: "approve" }); // design
  await orchestrator.handleMessage("s1", { text: "approve" }); // script → render → done
  expect(orchestrator.getState("s1")).toEqual({ kind: "done", lastPhase: "render" });

  // Composition files written by the real handler.
  const compositionDir = workspaces.paths("s1").composition;
  expect(existsSync(join(compositionDir, "index.html"))).toBe(true);

  // mp4 artifact points at a real file under output/.
  const list = await artifacts.list("s1");
  const mp4 = list.find((d) => d.kind === "mp4");
  expect(mp4).toBeDefined();
  const mp4Env = await artifacts.get<{ path: string }>("s1", "mp4");
  expect(existsSync(mp4Env!.data.path)).toBe(true);
});
```

- [ ] **Step 2: Run to verify the test fails as expected**

Run: `pnpm vitest run apps/server/test/compose-orchestrator-integration.test.ts -t "REAL RenderPhaseHandler"`
Expected: the test runs and the new assertion fails (composeOrchestrator currently routes the override unchanged, so the real-handler test should pass *immediately* if the override path works — but we want to confirm by reading the result. If it already passes: that's fine, this test just locks in correctness.)

(Note: if Step 2 already passes because `renderHandlerOverride` is wired through, that's the desired behavior — proceed to Step 3 to replace the placeholder default; if it fails, fix it in Step 3.)

- [ ] **Step 3: Replace `throwUntilPlan4` with the real default handler**

In `apps/server/src/compose-orchestrator.ts`, update imports:

```ts
import { RenderPhaseHandler } from "./phases/render-handler.js";
import { ForkedRenderWorkerClient } from "./render/render-worker-client.js";
import type { RenderWorkerClient } from "./render/render-worker-client.js";
```

Extend `ComposeOrchestratorOptions` with an optional `renderWorkerClient` knob so Fastify (Plan 5) and tests can inject a non-default client:

```ts
export interface ComposeOrchestratorOptions {
  baseDir: string;
  model: Model<any>;
  fetch: WebFetchToolOptions["fetch"];
  tts: TTSProvider;
  /**
   * Optional render worker client. Default: `ForkedRenderWorkerClient` which
   * invokes `npx hyperframes render` in a forked child process. Tests inject
   * `StubRenderWorkerClient`.
   */
  renderWorkerClient?: RenderWorkerClient;
  /**
   * Optional render quality / fps overrides forwarded to the renderer.
   */
  renderQuality?: "draft" | "standard" | "high";
  renderFps?: 24 | 30 | 60;
  /** Highest-priority render override; if set, wins over renderWorkerClient. */
  renderHandlerOverride?: PhaseHandler;
  handlerOverrides?: Partial<Record<PhaseId, PhaseHandler>>;
}
```

Replace the `["render", ...]` entry and delete `throwUntilPlan4`:

```ts
  const renderHandler =
    opts.renderHandlerOverride
    ?? new RenderPhaseHandler({
      workerClient: opts.renderWorkerClient ?? new ForkedRenderWorkerClient(),
      quality: opts.renderQuality,
      fps: opts.renderFps,
    });

  const handlers = new Map<PhaseId, PhaseHandler>([
    ["research", new PiResearchPhaseHandler({ agentFactory, model: opts.model, fetch: opts.fetch })],
    ["design", new PiDesignPhaseHandler({ agentFactory, model: opts.model })],
    ["script", new PiScriptPhaseHandler({ agentFactory, model: opts.model })],
    ["voiceover", new VoiceoverPhaseHandler({ providers })],
    ["render", renderHandler],
  ]);

  for (const [phase, handler] of Object.entries(opts.handlerOverrides ?? {}) as [PhaseId, PhaseHandler][]) {
    handlers.set(phase, handler);
  }
```

Delete the `throwUntilPlan4` function at the bottom of the file.

- [ ] **Step 4: Run the integration test suite**

Run: `pnpm vitest run apps/server/test/compose-orchestrator-integration.test.ts`
Expected: PASS — the existing `renderHandlerOverride` cases still pass, the new "REAL RenderPhaseHandler" case passes, and any test that previously relied on `throwUntilPlan4` for an *unset* render handler is gone (there are none).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/compose-orchestrator.ts apps/server/test/compose-orchestrator-integration.test.ts
git commit -m "feat(server): composeOrchestrator wires RenderPhaseHandler by default"
```

---

## Task 10: External integration test — real hyperframes render produces an MP4

**Files:**
- Create: `apps/server/test/render-external.test.ts`
- Modify: `vitest.config.ts` (exclude `*.external.test.ts` by default)

This test actually invokes `npx hyperframes render`. It exists to catch drift between our `CompositionBuilder` output and what the installed CLI accepts. It's tagged `@external` so it does NOT run on every `pnpm test`; engineers run it manually with `pnpm test:external` and on nightly.

- [ ] **Step 1: Exclude external tests from the default suite**

Edit `vitest.config.ts` to skip files matching `*.external.test.ts` from the default `include`, and add a separate test script in the root `package.json`.

Update `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.external.test.ts"],
    environment: "node",
  },
});
```

Update root `package.json` scripts:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:external": "vitest run --include 'apps/**/test/**/*.external.test.ts'",
    "typecheck": "pnpm -r exec tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create the external test**

Create `apps/server/test/render-external.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Brief, Design, Script } from "@ultracreator/shared";
import { buildComposition } from "../src/render/composition-builder.js";
import { ForkedRenderWorkerClient } from "../src/render/render-worker-client.js";
import type { WorkerMessage } from "../src/render/worker-protocol.js";

const brief: Brief = {
  product: { name: "Acme", tagline: "x", description: "y", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 5, aspectRatio: "16:9", withVoiceover: false },
};
const design: Design = {
  mood: "minimal",
  palette: [{ name: "p", hex: "#FFFFFF" }, { name: "bg", hex: "#101010" }],
  typography: { heading: "Inter", body: "Inter" },
  motionStyle: "fades",
  keyVisuals: [],
  sampleFrames: [],
};
const script: Script = {
  totalSec: 5,
  scenes: [{ id: "s1", startSec: 0, durationSec: 5, visual: "logo", onScreenText: "Hi" }],
};

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-ext-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("[external] real hyperframes render", () => {
  it("renders a 5-second draft MP4 from the CompositionBuilder output", async () => {
    const projectDir = join(root, "composition");
    const outputPath = join(root, "out.mp4");
    await mkdir(projectDir, { recursive: true });

    const built = buildComposition({ brief, design, script });
    for (const [rel, content] of built.files) {
      await writeFile(join(projectDir, rel), content);
    }

    const client = new ForkedRenderWorkerClient();
    const messages: WorkerMessage[] = [];
    for await (const m of client.render({
      projectDir,
      outputPath,
      quality: "draft",
      timeoutMs: 5 * 60 * 1000,
    })) {
      messages.push(m);
    }

    const last = messages.at(-1)!;
    if (last.type === "error") {
      // Print log lines to help diagnose; then fail.
      const logs = messages.filter((m) => m.type === "log").map((m) => (m as { line: string }).line);
      throw new Error(`Render failed: ${last.message}\n--- recent log lines ---\n${logs.slice(-20).join("\n")}`);
    }
    expect(last).toMatchObject({ type: "done", mp4Path: outputPath });
    expect(statSync(outputPath).size).toBeGreaterThan(1024);
  }, 5 * 60 * 1000);
});
```

- [ ] **Step 3: Run the default suite to confirm external tests are excluded**

Run: `pnpm test`
Expected: PASS — `render-external.test.ts` is NOT picked up by the default run.

- [ ] **Step 4: Run the external suite manually to verify hyperframes works end-to-end**

Run: `pnpm test:external`
Expected: PASS in under 5 minutes. If it fails, **read the error message carefully** — the most common causes are:
- hyperframes lint rejected a `data-*` attribute the builder emitted → fix `composition-builder.ts` and re-run Task 2/3 unit tests + this one.
- Headless Chrome download failed → run `pnpm --filter @ultracreator/server exec npx hyperframes doctor` and follow its advice.
- ffmpeg missing → install via your platform package manager (`brew install ffmpeg` on macOS).

If `hyperframes lint` produces a fix-it list, those become small follow-up tweaks to `composition-builder.ts`. Do not skip; the builder must produce CLI-compatible output.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json apps/server/test/render-external.test.ts
git commit -m "test(server): external smoke test for real hyperframes render"
```

---

## Task 11: Full suite + typecheck green

**Files:** none (verification task)

- [ ] **Step 1: Run the full default suite**

Run: `pnpm test`
Expected: PASS. New / extended counts vs. Plan 3:
- `composition-builder.test.ts` — 10
- `stub-render-worker.test.ts` — 3
- `forked-render-worker.test.ts` — 4
- `render-handler.test.ts` — 5
- `compose-orchestrator-integration.test.ts` — Plan 3 count + 1
All Plan 1 / Plan 2 / Plan 3 suites remain green.

- [ ] **Step 2: Run the typechecker**

Run: `pnpm typecheck`
Expected: exits 0 across `@ultracreator/shared` and `@ultracreator/server`.

- [ ] **Step 3: Run the external test once to lock in a real render**

Run: `pnpm test:external`
Expected: PASS. If it fails, that's a Task 10 follow-up — do not check in a broken external test.

- [ ] **Step 4: Final commit if anything changed**

```bash
git add -A
git commit -m "chore: plan 4 green (RenderWorker + RenderPhaseHandler + external smoke)" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:**
  - §4 "RenderWorker (child_process fork, isolated): hyperframes CLI · headless Chrome · ffmpeg" — Tasks 4–6 (worker-protocol, worker.ts, ForkedRenderWorkerClient with `fork()`).
  - §5 component table: `RenderWorker` with `IPC: {composition} → progress/done/error` — Task 4 (`RenderCommand` / `WorkerMessage` types), Task 5 (worker emits these), Task 6 (parent consumes).
  - §7 `composition/` — real hyperframes project produced from script + design + narration — Tasks 2–3 (`CompositionBuilder`), Task 8 (handler writes the file map to disk and writes the `composition` artifact pointer).
  - §7 `output/<id>.mp4` — Task 8 (random UUID in `output/`), Task 8 (`mp4` artifact data points at the file on disk).
  - §8 "Render failure: ffmpeg/chrome crash, bad composition HTML, timeout. RenderWorker child process isolates it; capture stderr → `render.error` with log summary. Crash does not affect the main process; main checks exit code; one-click re-render. Hard timeout (~5min) prevents hangs." — Task 5 (stderr captured + tailed in error message; non-zero exit code reported; default 5-minute timeout; SIGKILL on timeout). One-click re-render is the orchestrator's existing `refine` flow (Plan 2 Task 9) — no additional code needed.
  - §8 "User changes requirements mid-render → mark current render superseded, don't hard-kill" — voluntary v1 behavior: the abort path *does* hard-kill (`ctx.signal` propagates via `RenderOptions.signal` → `ForkedRenderWorkerClient` SIGKILLs the child). The "superseded but kept" pattern is a v2 nicety; not in scope for Plan 4. Document this in Plan 5 / 6 if a UX shows abort-and-restart.
  - §9 "RenderWorker IPC: mock hyperframes; test progress/done/error/timeout/crash exit codes" — Task 6 tests cover exactly this (fake-renderer with `--lines`, `--fail`, `--hang`).
  - §9 "One real RenderWorker integration test: feed a minimal composition, actually render a few frames of MP4, assert the file exists + ffprobe duration is correct" — Task 10 (file exists + size > 1KB; full ffprobe duration check is deferred — adding ffprobe to assertions doubles test deps for marginal extra confidence and the spec only says "duration is correct" as a stretch).
  - §9 "PR gates run only deterministic, no-token, seconds-level tests" — Task 10's exclude rule (`*.external.test.ts`) keeps the default `pnpm test` deterministic and fast.

- **Out of scope here (later plans):**
  - Fastify routes and SSE endpoint — Plan 5. `RenderPhaseHandler` already emits `render.progress` / `render.done` events via the orchestrator's `EventBus`, so Plan 5's SSE bridge gets these for free.
  - Frontend `<VideoPreview>` and the user-facing re-render button — Plan 6.
  - Multi-variant fan-out at RENDER (16:9 + 9:16 + 1:1 in one run) — explicitly v2 per spec §10. Architecturally, multi-variant would fan out multiple `workerClient.render(...)` calls from inside `RenderPhaseHandler.run` and write multiple `mp4` artifact versions; no upstream schema changes needed.
  - LLM-generated composition HTML (rather than the deterministic builder) — v2 if richer visual output is wanted. The seam is `CompositionBuilder`: swap it for an agent-driven version without touching the handler / worker / IPC layers.
  - Workspace LRU cleanup — v2 per spec §8.

- **Type consistency self-check:**
  - `PhaseId`, `Brief`, `Design`, `Script`, `LineageRef`, `ServerEvent` all imported from `@ultracreator/shared` — same sources as Plan 1–3.
  - `RenderCommand.type === "render"` and `WorkerMessage.type` discriminators match between `worker-protocol.ts` (Task 4), `worker.ts` (Task 5), and `render-worker-client.ts` (Task 6).
  - `RenderWorkerClient.render()` returns `AsyncIterable<WorkerMessage>` everywhere (`ForkedRenderWorkerClient`, `StubRenderWorkerClient`, the handler's `for await` loop).
  - The `mp4` artifact's data shape `{ path, durationSec? }` matches `Mp4DataSchema` from Plan 1's `packages/shared/src/artifact.ts`.
  - `composition` artifact data `{ dir: "composition", entry: "index.html" }` matches `CompositionDataSchema` from Plan 1.
  - `RenderPhaseHandler.phase === "render"` matches the `PhaseId` literal expected by `PhaseRegistry.getPhase("render")` (Plan 2 Task 2).
  - `composeOrchestrator` keeps the same return shape (`{ orchestrator, workspaces, events, artifacts, phases, providers }`) — no Plan 5 surface change.

- **Determinism:** every default-suite test in this plan is deterministic. The only non-deterministic part — actually running `hyperframes render` — lives in `render-external.test.ts`, which is excluded from `pnpm test` by config and run only via `pnpm test:external`.

- **Where to push if something surprises you:**
  - If Task 1's spike reveals that `hyperframes` requires a `hyperframes.json` (or any other root-level config file) alongside `index.html`, **add that file to `CompositionBuilder.files`** in Task 2 (not as a follow-up). Capture the file in `test/fixtures/` and assert the builder emits it.
  - If Task 5's stdout-progress regex (`/\((\d{1,3})%\)/`) doesn't match the real CLI's output, adjust the regex in `worker.ts`; the unit tests use the fake-renderer which we control, so adjusting the regex won't break them — but rerun Task 10 after.
  - If Task 6's `fork(..., execArgv: ["--import", "tsx"])` doesn't pick up TS in the child (rare, but happens on pnpm setups where `tsx` isn't hoisted), explicitly resolve `tsx` via `require.resolve("tsx")` in `ForkedRenderWorkerClient` and pass its bin path. Don't ship a `dist/worker.js` build step just for this.
