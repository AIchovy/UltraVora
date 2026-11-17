# Agent-Authored Composition + Brand Asset Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder composition builder with a dedicated agentic `compose` phase that authors animated, on-brand hyperframes HTML using real downloaded brand assets, gated by a `hyperframes lint`/`validate` feedback loop.

**Architecture:** Add a new `compose` phase between `voiceover` and `render`. A Pi agent (mirroring the existing research/design/script handlers) writes composition files via a `write_composition_file` tool, following a distilled hyperframes authoring contract embedded in its system prompt. A quality loop runs `hyperframes lint`/`validate` (up to 3 rounds) and re-prompts the agent with diagnostics on failure. Separately, the research phase gains a `download_asset` tool that fetches brand images (logo, key shots) into a new `assets/` workspace dir. `render` is slimmed to read the pre-authored `composition` artifact and emit only `mp4`.

**Tech Stack:** TypeScript (tsx), Pi agents (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), typebox tool params, Zod shared schemas, vitest, hyperframes CLI (bun-based, invoked via `npx`).

**Conventions for every task:**
- Run all tests from the repo ROOT: `npx vitest run <name>`.
- The faux-model test pattern: `registerFauxProvider({ models: [{ id: "uc-test" }] })`, `faux.setResponses([...])`, `faux.getModel("uc-test")!`.
- Commit after each task's tests pass.

---

### Task 1: Add `compose` to the PhaseId enum and phase registry

**Files:**
- Modify: `packages/shared/src/events.ts:4-10` (add `"compose"`)
- Modify: `apps/server/src/phases/registry.ts:12-22` (insert compose, slim render)
- Test: `apps/server/test/registry.test.ts` (create if absent, else add cases)

- [ ] **Step 1: Write the failing test**

Create or extend `apps/server/test/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PHASE_IDS } from "@ultracreator/shared";
import { PhaseRegistry } from "../src/phases/registry.js";

describe("phase ordering with compose", () => {
  it("orders compose between voiceover and render", () => {
    expect([...PHASE_IDS]).toEqual([
      "research", "design", "script", "voiceover", "compose", "render",
    ]);
  });

  it("compose outputs composition; render outputs only mp4", () => {
    const reg = new PhaseRegistry();
    expect(reg.outputs("compose")).toEqual(["composition"]);
    expect(reg.outputs("render")).toEqual(["mp4"]);
  });

  it("next() skips voiceover when disabled and reaches compose", () => {
    const reg = new PhaseRegistry();
    const brief = { constraints: { withVoiceover: false } } as any;
    expect(reg.next("script", brief)?.id).toBe("compose");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry`
Expected: FAIL — `PHASE_IDS` lacks `"compose"`; `outputs("compose")` throws "Unknown phase".

- [ ] **Step 3: Add `compose` to the enum**

In `packages/shared/src/events.ts`, change the enum:

```ts
const PhaseIdSchema = z.enum([
  "research",
  "design",
  "script",
  "voiceover",
  "compose",
  "render",
]);
```

- [ ] **Step 4: Insert compose and slim render in the registry**

In `apps/server/src/phases/registry.ts`, replace the `PHASES` array (lines 12-22):

```ts
export const PHASES: readonly PhaseConfig[] = [
  { id: "research", outputs: ["brief"] },
  { id: "design", outputs: ["design"], gates: ["user-approve"] },
  { id: "script", outputs: ["script"], gates: ["user-approve"] },
  {
    id: "voiceover",
    outputs: ["narration"],
    enabled: (brief) => brief.constraints.withVoiceover,
  },
  { id: "compose", outputs: ["composition"] },
  { id: "render", outputs: ["mp4"] },
] as const;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run registry`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/events.ts apps/server/src/phases/registry.ts apps/server/test/registry.test.ts
git commit -m "feat(shared): add compose phase between voiceover and render"
```

---

### Task 2: Add `brandHints.logoFile` to the Brief schema and write_brief tool

**Files:**
- Modify: `packages/shared/src/brief.ts:13-17`
- Modify: `apps/server/src/tools/artifact-write-tools.ts:26-30`
- Test: `apps/server/test/artifact-write-tools.test.ts` (add a case; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/artifact-write-tools.test.ts` (create the file with this content if it does not exist):

```ts
import { describe, it, expect } from "vitest";
import { BriefSchema } from "@ultracreator/shared";

describe("BriefSchema brandHints.logoFile", () => {
  it("accepts an optional local logoFile path", () => {
    const parsed = BriefSchema.parse({
      product: { name: "A", tagline: "t", description: "d", category: "saas" },
      audience: "devs",
      keyMessages: ["m"],
      brandHints: { colors: ["#000"], logoFile: "assets/abc.png" },
      sourceAssets: { images: ["assets/x.png"], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(parsed.brandHints.logoFile).toBe("assets/abc.png");
  });

  it("still parses without logoFile", () => {
    const parsed = BriefSchema.parse({
      product: { name: "A", tagline: "t", description: "d", category: "saas" },
      audience: "devs",
      keyMessages: ["m"],
      brandHints: { colors: ["#000"] },
      sourceAssets: { images: [], videos: [], copy: [] },
      constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
    });
    expect(parsed.brandHints.logoFile).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run artifact-write-tools`
Expected: FAIL — `logoFile` is stripped (not in schema), so the first assertion is `undefined`.

- [ ] **Step 3: Add `logoFile` to the Brief schema**

In `packages/shared/src/brief.ts`, change the `brandHints` object:

```ts
  brandHints: z.object({
    colors: z.array(z.string()),
    logoUrl: z.string().optional(),
    logoFile: z.string().optional(),
    fonts: z.array(z.string()).optional(),
  }),
```

- [ ] **Step 4: Add `logoFile` to the write_brief tool params**

In `apps/server/src/tools/artifact-write-tools.ts`, change the `brandHints` typebox object:

```ts
  brandHints: Type.Object({
    colors: Type.Array(Type.String()),
    logoUrl: Type.Optional(Type.String()),
    logoFile: Type.Optional(Type.String()),
    fonts: Type.Optional(Type.Array(Type.String())),
  }),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run artifact-write-tools`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/brief.ts apps/server/src/tools/artifact-write-tools.ts apps/server/test/artifact-write-tools.test.ts
git commit -m "feat(shared): add brandHints.logoFile for downloaded brand logo"
```

---

### Task 3: Add an `assets/` directory to the WorkspaceManager

**Files:**
- Modify: `apps/server/src/workspace/workspace-manager.ts:4-11,42-59`
- Test: `apps/server/test/workspace-manager.test.ts` (add a case; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/workspace-manager.test.ts` (create if it does not exist):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-wm-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("WorkspaceManager assets dir", () => {
  it("exposes an assets path and creates it on init", async () => {
    const wm = new WorkspaceManager(root);
    const p = wm.paths("s1");
    expect(p.assets).toBe(join(root, "s1", "assets"));
    await wm.init("s1");
    expect(existsSync(p.assets)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run workspace-manager`
Expected: FAIL — `p.assets` is `undefined`.

- [ ] **Step 3: Add `assets` to `WorkspacePaths`, `paths()`, and `init()`**

In `apps/server/src/workspace/workspace-manager.ts`:

Add to the interface (after `composition`):

```ts
export interface WorkspacePaths {
  root: string;
  uploads: string;
  artifacts: string;
  assets: string;
  composition: string;
  output: string;
  logs: string;
}
```

In `paths()`, add the `assets` entry to the returned object (after `artifacts`):

```ts
    return {
      root,
      uploads: join(root, "uploads"),
      artifacts: join(root, "artifacts"),
      assets: join(root, "assets"),
      composition: join(root, "composition"),
      output: join(root, "output"),
      logs: join(root, "logs"),
    };
```

In `init()`, add `p.assets` to the dirs created:

```ts
    for (const dir of [p.uploads, p.artifacts, p.assets, p.composition, p.output, p.logs]) {
      await mkdir(dir, { recursive: true });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run workspace-manager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/workspace/workspace-manager.ts apps/server/test/workspace-manager.test.ts
git commit -m "feat(server): add assets/ workspace dir for downloaded brand assets"
```

---

### Task 4: Add a `fetchBinary` capability and `download_asset` tool

**Files:**
- Modify: `apps/server/src/tools/research-tools.ts` (add `FetchBinaryResponse`, `makeDownloadAssetTool`)
- Test: `apps/server/test/download-asset-tool.test.ts` (create)

The tool: validates `http(s)` scheme (same guard as `web_fetch`), fetches the binary, enforces a 10 MB cap and an image content-type allowlist, writes under `assets/<sha256-hash>.<ext>` (flat, sanitized), and returns the local relative path + detected type.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/download-asset-tool.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeDownloadAssetTool } from "../src/tools/research-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-da-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PNG = Buffer.from("89504e470d0a1a0a", "hex"); // PNG magic bytes
const signal = new AbortController().signal;

function setup(fetchBinary: any) {
  const wm = new WorkspaceManager(root);
  return { wm, tool: makeDownloadAssetTool({ sessionId: "s1", workspaces: wm, fetchBinary }) };
}

describe("makeDownloadAssetTool", () => {
  it("writes an allowed image under assets/ and returns its local path", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    const res = await tool.execute("c1", { url: "https://x.com/logo.png" }, signal);
    const text = res.content[0]!.text;
    expect(text).toMatch(/^assets\/[0-9a-f]+\.png$/);
    expect(existsSync(join(wm.paths("s1").assets, text.replace("assets/", "")))).toBe(true);
    expect(res.details).toMatchObject({ contentType: "image/png" });
  });

  it("rejects a disallowed content-type", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "text/html", bytes: PNG }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "https://x.com/page" }, signal)).rejects.toThrow(/content-type/i);
  });

  it("rejects an oversized body", async () => {
    const big = Buffer.alloc(11 * 1024 * 1024, 1);
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: big }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "https://x.com/big.png" }, signal)).rejects.toThrow(/size|large/i);
  });

  it("rejects a non-http(s) scheme", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "file:///etc/passwd" }, signal)).rejects.toThrow(/scheme/i);
  });

  it("rejects a non-2xx status", async () => {
    const { wm, tool } = setup(async () => ({ status: 404, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    await expect(tool.execute("c1", { url: "https://x.com/missing.png" }, signal)).rejects.toThrow(/404|failed/i);
  });

  it("does not write more than one file per identical download", async () => {
    const { wm, tool } = setup(async () => ({ status: 200, contentType: "image/png", bytes: PNG }));
    await wm.init("s1");
    await tool.execute("c1", { url: "https://x.com/logo.png" }, signal);
    await tool.execute("c2", { url: "https://x.com/logo.png" }, signal);
    expect(readdirSync(wm.paths("s1").assets).length).toBe(1); // same hash → same filename
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run download-asset-tool`
Expected: FAIL — `makeDownloadAssetTool` is not exported.

- [ ] **Step 3: Implement the tool**

In `apps/server/src/tools/research-tools.ts`, add at the top with the other imports:

```ts
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
```

(`readFile` is already imported on line 1; keep it. `join`/`basename` are already imported.)

Then append to the file:

```ts
export interface FetchBinaryResponse {
  status: number;
  contentType: string;
  bytes: Buffer;
}

export interface DownloadAssetToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
  fetchBinary: (url: string, signal?: AbortSignal) => Promise<FetchBinaryResponse>;
  /** Default 10 MB. */
  maxBytes?: number;
}

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const downloadAssetParameters = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL of an image to download." }),
});

export function makeDownloadAssetTool(
  opts: DownloadAssetToolOptions,
): AgentTool<typeof downloadAssetParameters> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  return {
    name: "download_asset",
    label: "Download Asset",
    description:
      "Download an image (logo, product shot) by URL into the session's assets/ dir. Returns the local relative path to reference later.",
    parameters: downloadAssetParameters,
    execute: async (_callId, params, signal) => {
      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        throw new Error(`Invalid URL: ${params.url}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Disallowed URL scheme: ${parsed.protocol}`);
      }

      const res = await opts.fetchBinary(params.url, signal);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Download failed (${res.status}) for ${params.url}`);
      }

      const baseType = res.contentType.split(";")[0]!.trim().toLowerCase();
      const ext = ALLOWED_IMAGE_TYPES[baseType];
      if (!ext) {
        throw new Error(`Disallowed content-type: ${res.contentType}`);
      }
      if (res.bytes.byteLength > maxBytes) {
        throw new Error(`Asset too large: ${res.bytes.byteLength} bytes (max ${maxBytes})`);
      }

      const hash = createHash("sha256").update(res.bytes).digest("hex").slice(0, 16);
      const fileName = `${hash}.${ext}`;
      const relPath = `assets/${fileName}`;
      const abs = join(opts.workspaces.paths(opts.sessionId).assets, fileName);
      await writeFile(abs, res.bytes);

      return {
        content: [{ type: "text", text: relPath }],
        details: { url: params.url, contentType: baseType, path: relPath, bytes: res.bytes.byteLength },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run download-asset-tool`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tools/research-tools.ts apps/server/test/download-asset-tool.test.ts
git commit -m "feat(server): add download_asset tool for brand image acquisition"
```

---

### Task 5: Add the `fetchBinary` adapter to the production bootstrap

**Files:**
- Modify: `apps/server/src/api/server.ts:42-55`
- Modify: `apps/server/src/compose-orchestrator.ts` (thread `fetchBinary` through to the research handler)

This is production wiring; it has no dedicated unit test (the bootstrap is exercised only end-to-end). Type-checking is the gate.

- [ ] **Step 1: Add the `fetchBinary` adapter in server.ts**

In `apps/server/src/api/server.ts`, after `fetchAdapter` (line 46), add:

```ts
// Binary fetch for download_asset: returns raw bytes + content-type.
async function fetchBinaryAdapter(url: string, signal?: AbortSignal) {
  const res = await globalThis.fetch(url, signal ? { signal } : undefined);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", bytes };
}
```

Then pass it into `composeOrchestrator`:

```ts
const composed = composeOrchestrator({
  baseDir: BASE_DIR,
  model,
  fetch: fetchAdapter,
  fetchBinary: fetchBinaryAdapter,
  tts: new GeminiTTSProvider({ apiKey: GEMINI_API_KEY }),
  anthropicApiKey: ANTHROPIC_API_KEY,
  geminiApiKey: GEMINI_API_KEY,
});
```

- [ ] **Step 2: Thread `fetchBinary` through compose-orchestrator**

In `apps/server/src/compose-orchestrator.ts`:

Add the import (next to the existing `WebFetchToolOptions` import):

```ts
import type { WebFetchToolOptions, DownloadAssetToolOptions } from "./tools/research-tools.js";
```

Add to `ComposeOrchestratorOptions` (after the `fetch` field, ~line 28):

```ts
  /** Binary fetcher injected into the research phase's download_asset tool. */
  fetchBinary: DownloadAssetToolOptions["fetchBinary"];
```

Pass it to the research handler (in the `handlers` map, ~line 103):

```ts
    ["research", new PiResearchPhaseHandler({
      agentFactory,
      model: opts.model,
      fetch: opts.fetch,
      fetchBinary: opts.fetchBinary,
    })],
```

(The research handler gains a `fetchBinary` option in Task 6; this wiring compiles only after that change, so do Task 6 in the same commit — see Task 6 Step 5.)

- [ ] **Step 3: Commit** — deferred; bundled with Task 6.

---

### Task 6: Wire `download_asset` into the research handler and update its prompt

**Files:**
- Modify: `apps/server/src/phases/pi-research-handler.ts`
- Test: `apps/server/test/pi-research-handler.test.ts` (add a case; create if absent)

- [ ] **Step 1: Write the failing test**

Add to `apps/server/test/pi-research-handler.test.ts` (create with this content if it does not exist):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall,
} from "@earendil-works/pi-ai";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiResearchPhaseHandler } from "../src/phases/pi-research-handler.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-rh6-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

describe("PiResearchPhaseHandler download_asset", () => {
  it("exposes download_asset; agent can save a logo into assets/", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("download_asset", { url: "https://x.com/logo.png" })),
      fauxAssistantMessage(fauxToolCall("write_brief", {
        product: { name: "X", tagline: "t", description: "d", category: "saas" },
        audience: "devs", keyMessages: ["m"],
        brandHints: { colors: ["#000"], logoFile: "assets/PLACEHOLDER" },
        sourceAssets: { images: [], videos: [], copy: [] },
        constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
      })),
      fauxAssistantMessage(fauxText("done")),
    ]);

    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await wm.init("s1");

    const handler = new PiResearchPhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      fetch: async () => ({ status: 200, text: "<html></html>" }),
      fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: PNG }),
    });

    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      initialMessage: { text: "Make a video for https://x.com" },
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    // The download landed in assets/.
    const assetFiles = existsSync(wm.paths("s1").assets);
    expect(assetFiles).toBe(true);
    // The brief artifact was written.
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run pi-research-handler`
Expected: FAIL — `PiResearchPhaseHandlerOptions` has no `fetchBinary`; `download_asset` tool not registered.

- [ ] **Step 3: Add `fetchBinary`, register the tool, update the prompt**

In `apps/server/src/phases/pi-research-handler.ts`:

Update the imports to pull in the new tool and type:

```ts
import {
  makeWebFetchTool,
  makeReadUploadTool,
  makeDownloadAssetTool,
  type WebFetchToolOptions,
  type DownloadAssetToolOptions,
} from "../tools/research-tools.js";
```

Replace the `SYSTEM_PROMPT` "Available tools" and "Rules" sections so the agent knows about asset download (replace the whole template literal):

```ts
const SYSTEM_PROMPT = `You are the RESEARCH phase of a promo-video pipeline.

Your job: given a user's product description (which may include a URL and uploaded
files), produce a structured brief that captures the product, its audience, key
selling points, brand cues, and any source assets you saw.

Available tools:
- web_fetch: fetch a URL and read its text/HTML.
- download_asset: download an image by URL into this session's assets/ dir. Returns a
  local relative path like "assets/<hash>.png".
- read_upload: read a file the user uploaded to this session.
- write_brief: persist the final brief. Call this EXACTLY ONCE when ready.

Rules:
- Use web_fetch on the user's URL, then scan the returned HTML for brand assets:
  the favicon, the og:image meta tag, and prominent <img> logos / product shots.
- Call download_asset for the LOGO plus up to ~5 key images. Downloads are
  best-effort: if one fails, continue without it.
- Put the downloaded logo's returned path in brandHints.logoFile, and the other
  downloaded image paths in sourceAssets.images (use the local "assets/..." paths,
  NOT remote URLs). Keep brandHints.logoUrl as the original URL for provenance.
- Keep keyMessages to at most 3 items.
- Pass through the durationSec / aspectRatio / withVoiceover constraints from the
  user message verbatim.
- Call write_brief with the complete brief object when finished. Do not call it more than once.`;
```

Add `fetchBinary` to the options interface:

```ts
export interface PiResearchPhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
  fetch: WebFetchToolOptions["fetch"];
  fetchBinary: DownloadAssetToolOptions["fetchBinary"];
}
```

Register the tool in `run()` (insert into the `tools` array, after `makeWebFetchTool`):

```ts
    const tools = [
      makeWebFetchTool({ fetch: this.opts.fetch }),
      makeDownloadAssetTool({
        sessionId: ctx.sessionId,
        workspaces: ctx.workspaces,
        fetchBinary: this.opts.fetchBinary,
      }),
      makeReadUploadTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
      makeWriteBriefTool({ sessionId: ctx.sessionId, artifacts: ctx.artifacts }),
    ];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run pi-research-handler`
Expected: PASS.

- [ ] **Step 5: Type-check the whole server, then commit (bundles Task 5 wiring)**

Run: `npx vitest run registry download-asset-tool pi-research-handler` and `npx tsc -p apps/server --noEmit` (or the repo's typecheck script).
Expected: PASS / no type errors. If any other call site of `composeOrchestrator` exists in tests, it now requires `fetchBinary` — grep `composeOrchestrator(` and add a stub `fetchBinary: async () => ({ status: 200, contentType: "image/png", bytes: Buffer.alloc(0) })` to each.

```bash
git add apps/server/src/api/server.ts apps/server/src/compose-orchestrator.ts apps/server/src/phases/pi-research-handler.ts apps/server/test/pi-research-handler.test.ts
git commit -m "feat(server): research agent downloads brand logo + key images"
```

---

### Task 7: Extract a shared composition util (resolution + CSS-safety validators)

**Files:**
- Create: `apps/server/src/render/composition-util.ts`
- Test: `apps/server/test/composition-util.test.ts` (create)

This holds the `RESOLUTIONS` map and the hex/font validators that currently live in the soon-to-be-deleted `composition-builder.ts`. The compose handler uses `RESOLUTIONS` to compute the root `data-width`/`data-height`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/composition-util.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RESOLUTIONS, assertHexColor, assertCssFontFamily } from "../src/render/composition-util.js";

describe("composition-util", () => {
  it("maps aspect ratios to pixel resolutions", () => {
    expect(RESOLUTIONS["16:9"]).toEqual({ width: 1920, height: 1080 });
    expect(RESOLUTIONS["9:16"]).toEqual({ width: 1080, height: 1920 });
    expect(RESOLUTIONS["1:1"]).toEqual({ width: 1080, height: 1080 });
  });

  it("accepts valid hex colors and rejects junk", () => {
    expect(assertHexColor("#FF3366")).toBe("#FF3366");
    expect(() => assertHexColor("red; }")).toThrow(/hex/i);
  });

  it("accepts safe font names and rejects injection", () => {
    expect(assertCssFontFamily("Poppins")).toBe("Poppins");
    expect(() => assertCssFontFamily("Foo'; }")).toThrow(/font/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run composition-util`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the util**

Create `apps/server/src/render/composition-util.ts`:

```ts
import type { AspectRatio } from "@ultracreator/shared";

export const RESOLUTIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/**
 * Validate a hex color literal for safe interpolation into a CSS context.
 * Accepts exactly `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`.
 */
export function assertHexColor(hex: string): string {
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return hex;
}

/**
 * Validate a font-family name for safe interpolation inside a CSS `font-family`
 * literal. Allows only letters, digits, spaces, hyphens, and underscores.
 */
export function assertCssFontFamily(font: string): string {
  if (!/^[A-Za-z0-9 _-]+$/.test(font)) {
    throw new Error(`Invalid font name: ${font}`);
  }
  return font;
}
```

(Note: `AspectRatio` is exported from `@ultracreator/shared` via `constraints.js`. If the import fails, confirm the export name with `grep "AspectRatio" packages/shared/src/constraints.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run composition-util`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/render/composition-util.ts apps/server/test/composition-util.test.ts
git commit -m "refactor(server): extract composition-util (resolutions + CSS validators)"
```

---

### Task 8: Add the `write_composition_file` tool

**Files:**
- Create: `apps/server/src/tools/composition-tools.ts`
- Test: `apps/server/test/write-composition-file-tool.test.ts` (create)

Writes a file at a relative path inside the session's `composition/` dir, creating parent dirs. Rejects absolute paths, `..` escapes, and paths that resolve outside `composition/`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/write-composition-file-tool.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { makeWriteCompositionFileTool } from "../src/tools/composition-tools.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-wcf-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const signal = new AbortController().signal;

function setup() {
  const wm = new WorkspaceManager(root);
  return { wm, tool: makeWriteCompositionFileTool({ sessionId: "s1", workspaces: wm }) };
}

describe("makeWriteCompositionFileTool", () => {
  it("writes index.html into composition/", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await tool.execute("c1", { path: "index.html", content: "<html>hi</html>" }, signal);
    const abs = join(wm.paths("s1").composition, "index.html");
    expect(readFileSync(abs, "utf8")).toBe("<html>hi</html>");
  });

  it("creates parent dirs for a shallow subpath", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await tool.execute("c1", { path: "scenes/s1.html", content: "x" }, signal);
    expect(existsSync(join(wm.paths("s1").composition, "scenes", "s1.html"))).toBe(true);
  });

  it("rejects an absolute path", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await expect(tool.execute("c1", { path: "/etc/passwd", content: "x" }, signal)).rejects.toThrow(/path/i);
  });

  it("rejects a parent-escape path", async () => {
    const { wm, tool } = setup();
    await wm.init("s1");
    await expect(tool.execute("c1", { path: "../artifacts/x.json", content: "x" }, signal)).rejects.toThrow(/path/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run write-composition-file-tool`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the tool**

Create `apps/server/src/tools/composition-tools.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface WriteCompositionFileToolOptions {
  sessionId: string;
  workspaces: WorkspaceManager;
}

const writeCompositionFileParameters = Type.Object({
  path: Type.String({
    description: "Relative path inside the composition dir, e.g. 'index.html' or 'scenes/intro.html'.",
  }),
  content: Type.String({ description: "Full file contents to write." }),
});

export function makeWriteCompositionFileTool(
  opts: WriteCompositionFileToolOptions,
): AgentTool<typeof writeCompositionFileParameters> {
  return {
    name: "write_composition_file",
    label: "Write Composition File",
    description:
      "Write a file into the composition project dir (index.html, sub-compositions, CSS). Paths must stay inside the composition dir.",
    parameters: writeCompositionFileParameters,
    execute: async (_callId, params) => {
      const rel = params.path;
      if (isAbsolute(rel)) {
        throw new Error(`Invalid composition path (must be relative): ${rel}`);
      }
      const compositionDir = opts.workspaces.paths(opts.sessionId).composition;
      const abs = normalize(join(compositionDir, rel));
      const within = relative(compositionDir, abs);
      if (within.startsWith("..") || isAbsolute(within)) {
        throw new Error(`Invalid composition path (escapes composition dir): ${rel}`);
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, params.content, "utf8");
      return {
        content: [{ type: "text", text: `Wrote ${within}.` }],
        details: { path: within, bytes: Buffer.byteLength(params.content, "utf8") },
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run write-composition-file-tool`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/tools/composition-tools.ts apps/server/test/write-composition-file-tool.test.ts
git commit -m "feat(server): add write_composition_file tool"
```

---

### Task 9: Add the hyperframes lint/validate quality runner

**Files:**
- Create: `apps/server/src/render/quality-runner.ts`
- Test: `apps/server/test/quality-runner.test.ts` (create)

A `QualityRunner` interface `{ check(dir, signal) => Promise<{ ok, diagnostics }> }`. The default `HyperframesQualityRunner` spawns `npx --package=hyperframes hyperframes lint --json <dir>` then `... validate --json <dir>`, capturing stdout/stderr/exit code. `ok` is true only if both exit 0. The compose handler accepts an injectable runner so unit tests stub it (mirrors `RenderWorkerClient` injection).

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/quality-runner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HyperframesQualityRunner } from "../src/render/quality-runner.js";

describe("HyperframesQualityRunner.runCommand", () => {
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run quality-runner`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the runner**

Create `apps/server/src/render/quality-runner.ts`:

```ts
import { spawn } from "node:child_process";

export interface QualityResult {
  ok: boolean;
  /** Combined human-readable diagnostics to feed back to the agent. */
  diagnostics: string;
}

export interface QualityRunner {
  check(projectDir: string, signal: AbortSignal): Promise<QualityResult>;
}

export type QualityCheckKind = "lint" | "validate";

export interface HyperframesQualityRunnerOptions {
  /** Override the argv for a given check (used by tests). */
  commandFor?: (kind: QualityCheckKind, dir: string) => string[];
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

function defaultCommand(kind: QualityCheckKind, dir: string): string[] {
  return ["npx", "--package=hyperframes", "hyperframes", kind, "--json", dir];
}

interface RunOutcome { code: number; stdout: string; stderr: string; }

function runProcess(argv: string[], signal: AbortSignal, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const [exe, ...args] = argv;
    const child = spawn(exe!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} finish(124); }, timeoutMs);
    const onAbort = () => { try { child.kill("SIGKILL"); } catch {} finish(130); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", (err) => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

export class HyperframesQualityRunner implements QualityRunner {
  private commandFor: (kind: QualityCheckKind, dir: string) => string[];
  private timeoutMs: number;

  constructor(opts: HyperframesQualityRunnerOptions = {}) {
    this.commandFor = opts.commandFor ?? defaultCommand;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async check(projectDir: string, signal: AbortSignal): Promise<QualityResult> {
    const parts: string[] = [];
    let ok = true;
    for (const kind of ["lint", "validate"] as const) {
      const out = await runProcess(this.commandFor(kind, projectDir), signal, this.timeoutMs);
      if (out.code !== 0) {
        ok = false;
        parts.push(`[${kind}] exited ${out.code}\n${out.stdout}\n${out.stderr}`.trim());
      }
    }
    return { ok, diagnostics: parts.join("\n\n") };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run quality-runner`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/render/quality-runner.ts apps/server/test/quality-runner.test.ts
git commit -m "feat(server): add hyperframes lint/validate quality runner"
```

---

### Task 10: Implement `PiComposePhaseHandler` (prompt + quality loop)

**Files:**
- Create: `apps/server/src/phases/pi-compose-handler.ts`
- Test: `apps/server/test/pi-compose-handler.test.ts` (create)

The handler loads `brief`/`design`/`script`/`narration`, copies referenced assets (logo, images, narration audio) flat into `composition/`, runs the compose agent with the `write_composition_file` tool, then runs the quality loop (default 3 fix rounds) before writing the `composition` artifact.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/pi-compose-handler.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall,
} from "@earendil-works/pi-ai";
import type { Brief, Design, Script, ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { PiAgentFactory } from "../src/phases/pi-agent-factory.js";
import { PiComposePhaseHandler } from "../src/phases/pi-compose-handler.js";
import type { QualityRunner } from "../src/render/quality-runner.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-comp-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const brief: Brief = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs", keyMessages: ["fast"],
  brandHints: { colors: ["#FF3366"], logoFile: "assets/logo.png" },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 12, aspectRatio: "16:9", withVoiceover: false },
};
const design: Design = {
  mood: "energetic",
  palette: [{ name: "p", hex: "#FF3366" }, { name: "bg", hex: "#101010" }],
  typography: { heading: "Poppins", body: "Inter" },
  motionStyle: "kinetic", keyVisuals: [], sampleFrames: [],
};
const script: Script = {
  totalSec: 12,
  scenes: [
    { id: "s1", startSec: 0, durationSec: 6, visual: "logo reveal", onScreenText: "Acme" },
    { id: "s2", startSec: 6, durationSec: 6, visual: "feature grid", onScreenText: "Fast" },
  ],
};

// A minimal but structurally-valid composition the faux agent "authors".
const VALID_HTML = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>.scene-content{width:100%;height:100%;display:flex}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="12" data-width="1920" data-height="1080">
  <div id="s1" class="clip" data-start="0" data-duration="6" data-track-index="1"><h1 class="t1">Acme</h1></div>
  <div id="s2" class="clip" data-start="6" data-duration="6" data-track-index="1"><h1 class="t2">Fast</h1></div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from(".t1", { duration: 0.6, opacity: 0, y: 40 }, 0.1);
tl.from(".t2", { duration: 0.6, opacity: 0, y: 40 }, 6.1);
window.__timelines["main"] = tl;
</script></body></html>`;

function seedAssets(wm: WorkspaceManager) {
  return writeFile(join(wm.paths("s1").assets, "logo.png"), Buffer.from("89504e47", "hex"));
}

async function seed(store: ArtifactStore, wm: WorkspaceManager) {
  await wm.init("s1");
  await seedAssets(wm);
  await store.put("s1", "brief", brief);
  await store.put("s1", "design", design);
  await store.put("s1", "script", script);
}

const passRunner: QualityRunner = { check: async () => ({ ok: true, diagnostics: "" }) };

function fauxAuthoring() {
  const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
    fauxAssistantMessage(fauxText("done")),
  ]);
  return faux;
}

describe("PiComposePhaseHandler", () => {
  it("authors a composition, copies assets, writes the composition artifact", async () => {
    const faux = fauxAuthoring();
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, wm);

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    // Composition artifact written.
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();

    // index.html written, with structural markers.
    const htmlPath = join(wm.paths("s1").composition, "index.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toMatch(/data-composition-id="main"/);
    expect(html).toMatch(/data-width="1920"[\s\S]*data-height="1080"[\s\S]*data-duration="12"|data-duration="12"[\s\S]*data-width="1920"/);
    expect(html).toMatch(/data-start="0"[\s\S]*data-duration="6"/); // scene clip
    expect(html).toMatch(/window\.__timelines\["main"\]/);
    const tweenCount = (html.match(/tl\.from\(/g) ?? []).length;
    expect(tweenCount).toBeGreaterThanOrEqual(script.scenes.length); // ≥1 tween/scene

    // Logo asset copied next to index.html.
    expect(existsSync(join(wm.paths("s1").composition, "logo.png"))).toBe(true);
  });

  it("re-prompts the agent with diagnostics on failure, then converges", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    // Round 1: writes a (pretend) bad file. Round 2 (after diagnostics): writes the good one.
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: "<html>bad</html>" })),
      fauxAssistantMessage(fauxText("done")),
      fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: VALID_HTML })),
      fauxAssistantMessage(fauxText("fixed")),
    ]);
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, wm);

    let calls = 0;
    const flakyRunner: QualityRunner = {
      check: async () => (++calls === 1 ? { ok: false, diagnostics: "missing data-composition-id" } : { ok: true, diagnostics: "" }),
    };

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: flakyRunner,
    });

    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(calls).toBe(2); // checked twice
    const html = readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8");
    expect(html).toMatch(/data-composition-id="main"/); // converged on the good file
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeDefined();
  });

  it("emits phase.error and throws after exhausting the round budget", async () => {
    const faux = registerFauxProvider({ models: [{ id: "uc-test" }] });
    faux.setResponses(
      Array.from({ length: 12 }, () =>
        fauxAssistantMessage(fauxToolCall("write_composition_file", { path: "index.html", content: "<html>bad</html>" })),
      ),
    );
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seed(store, wm);

    const failRunner: QualityRunner = { check: async () => ({ ok: false, diagnostics: "still broken" }) };
    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: failRunner,
      maxRounds: 3,
    });

    const yielded: ServerEvent[] = [];
    await expect(async () => {
      for await (const e of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) yielded.push(e);
    }).rejects.toThrow(/quality|validation/i);

    expect(yielded.some((e) => e.type === "phase.error")).toBe(true);
    // No composition artifact when it never passed.
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "composition")).toBeUndefined();
  });

  it("throws when the upstream design artifact is missing", async () => {
    const faux = fauxAuthoring();
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await wm.init("s1");
    await store.put("s1", "brief", brief);
    await store.put("s1", "script", script);
    // no design

    const handler = new PiComposePhaseHandler({
      agentFactory: new PiAgentFactory({}),
      model: faux.getModel("uc-test")!,
      qualityRunner: passRunner,
    });
    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) { /* drain */ }
    }).rejects.toThrow(/design/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run pi-compose-handler`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the handler**

Create `apps/server/src/phases/pi-compose-handler.ts`:

```ts
import { copyFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
  Brief, Design, LineageRef, NarrationData, PhaseId, Script, ServerEvent,
} from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
import { PiAgentFactory } from "./pi-agent-factory.js";
import { runAgentToCompletion } from "./pi-handler-helpers.js";
import { makeWriteCompositionFileTool } from "../tools/composition-tools.js";
import { RESOLUTIONS } from "../render/composition-util.js";
import {
  HyperframesQualityRunner, type QualityRunner,
} from "../render/quality-runner.js";

const SYSTEM_PROMPT = `You are the COMPOSE phase of a promo-video pipeline. You author a
hyperframes composition: a standalone index.html that renders to an animated, on-brand
video. You CANNOT run shell commands or skills — follow this contract exactly.

Write files with the write_composition_file tool. Author index.html (and optional CSS /
sub-composition files). Reference media assets by their bare filename (they sit next to
index.html).

TIMELINE CONTRACT (non-negotiable):
- Load GSAP from a CDN <script>.
- Create exactly one timeline per composition: gsap.timeline({ paused: true }).
- Register it: window.__timelines["main"] = tl;  (id must match data-composition-id)
- The composition duration comes from the root's data-duration, NOT from GSAP length.
- Never leave the timeline empty.

STRUCTURE:
- The root element carries data-composition-id="main", data-start="0",
  data-duration="<totalSec>", data-width="<W>", data-height="<H>", placed directly in
  <body> (no <template> for a standalone file).
- Each scene is a clip element with a unique id, data-start, data-duration, and
  data-track-index. Audio (if any) is a clip with data-track-index="0".

LAYOUT BEFORE ANIMATION:
- Position every element at its final (hero-frame) state in static CSS.
- Use .scene-content { width:100%; height:100%; padding; display:flex; ... }.
- Use position:absolute only for decoratives.

MOTION (non-negotiable):
- Every visible element animates IN via gsap.from().
- Scene transitions are MANDATORY — no jump cuts between scenes.
- No exit animations except on the final scene.
- Offset the first tween of each scene by 0.1–0.3s; vary the eases.

DETERMINISM:
- No Math.random(), no Date.now(), no repeat:-1. Construct the timeline synchronously.

BRAND FIDELITY:
- Use the FULL design palette, typography, mood, and motionStyle.
- Treat each scene's "visual" field as a DIRECTIVE to realize with CSS/SVG/GSAP — it is
  NOT literal on-screen text. The on-screen text is the scene's onScreenText field.
- Embed the logo asset. Honor accent intent (e.g. a highlighted word).

SIZING (for rendered video):
- Headlines 60px+, body text 20px+.

When the composition is complete, stop. The system will validate it and send you any
errors to fix.`;

export interface PiComposePhaseHandlerOptions {
  agentFactory: PiAgentFactory;
  model: Model<any>;
  /** Default: HyperframesQualityRunner (spawns the real CLI). Tests inject a stub. */
  qualityRunner?: QualityRunner;
  /** Max fix rounds after the initial authoring pass. Default 3. */
  maxRounds?: number;
}

export class PiComposePhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "compose";
  constructor(private opts: PiComposePhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    if (ctx.signal.aborted) throw new Error("Aborted");

    const briefEnv = await ctx.artifacts.get<Brief>(ctx.sessionId, "brief");
    const designEnv = await ctx.artifacts.get<Design>(ctx.sessionId, "design");
    const scriptEnv = await ctx.artifacts.get<Script>(ctx.sessionId, "script");
    if (!briefEnv) throw new Error("compose phase requires a brief artifact, none found");
    if (!designEnv) throw new Error("compose phase requires a design artifact, none found");
    if (!scriptEnv) throw new Error("compose phase requires a script artifact, none found");

    const narrationEnv = await ctx.artifacts.get<NarrationData>(ctx.sessionId, "narration");

    const paths = ctx.workspaces.paths(ctx.sessionId);
    const resolution = RESOLUTIONS[briefEnv.data.constraints.aspectRatio];

    // Copy referenced assets (logo + images) flat into composition/, and tell the
    // agent their bare filenames.
    const assetRefs = new Set<string>();
    if (briefEnv.data.brandHints.logoFile) assetRefs.add(briefEnv.data.brandHints.logoFile);
    for (const img of briefEnv.data.sourceAssets.images) assetRefs.add(img);

    const availableAssets: { name: string; role: string }[] = [];
    for (const rel of assetRefs) {
      const name = basename(rel);
      const src = join(paths.root, rel); // rel is workspace-root-relative, e.g. assets/<f>
      try {
        await copyFile(src, join(paths.composition, name));
        availableAssets.push({
          name,
          role: rel === briefEnv.data.brandHints.logoFile ? "logo" : "image",
        });
      } catch {
        // Best-effort: a missing asset is not fatal.
      }
    }

    let narrationLine = "";
    if (narrationEnv) {
      const name = basename(narrationEnv.data.audioPath);
      try {
        await copyFile(narrationEnv.data.audioPath, join(paths.composition, name));
        const durSec = Math.max(1, Math.ceil(narrationEnv.data.durationMs / 1000));
        narrationLine = `\n\nNarration audio: "${name}" (duration ${durSec}s). Add it as an audio clip with data-track-index="0", data-start="0", data-duration="${durSec}".`;
      } catch {
        // ignore
      }
    }

    const tools = [
      makeWriteCompositionFileTool({ sessionId: ctx.sessionId, workspaces: ctx.workspaces }),
    ];
    const agent = this.opts.agentFactory.create({
      systemPrompt: SYSTEM_PROMPT,
      tools,
      model: this.opts.model,
      signal: ctx.signal,
    });

    const assetsBlock = availableAssets.length
      ? availableAssets.map((a) => `- ${a.name} (${a.role})`).join("\n")
      : "(none downloaded — render brand marks with CSS/SVG)";

    const prompt = [
      `Resolution: ${resolution.width}x${resolution.height} (aspectRatio ${briefEnv.data.constraints.aspectRatio}).`,
      `Total duration: ${scriptEnv.data.totalSec}s.`,
      `Design: ${JSON.stringify(designEnv.data, null, 2)}`,
      `Script scenes (each "visual" is a directive to realize, NOT literal text): ${JSON.stringify(scriptEnv.data.scenes, null, 2)}`,
      `Available asset files (reference by bare filename, next to index.html):\n${assetsBlock}${narrationLine}`,
      `Author index.html now via write_composition_file.`,
    ].join("\n\n");

    yield* runAgentToCompletion({ phase: this.phase, agent, prompt });

    // Quality loop.
    const runner = this.opts.qualityRunner ?? new HyperframesQualityRunner();
    const maxRounds = this.opts.maxRounds ?? 3;
    let round = 0;
    while (true) {
      if (ctx.signal.aborted) throw new Error("Aborted");
      yield { type: "phase.progress", phase: this.phase, message: "Validating composition" };
      const result = await runner.check(paths.composition, ctx.signal);
      if (result.ok) break;
      round++;
      if (round > maxRounds) {
        const error = `Composition failed validation after ${maxRounds} rounds:\n${result.diagnostics}`;
        yield { type: "phase.error", phase: this.phase, error };
        throw new Error(error);
      }
      yield {
        type: "phase.progress",
        phase: this.phase,
        message: `Composition validation failed (round ${round}); re-authoring`,
      };
      yield* runAgentToCompletion({
        phase: this.phase,
        agent,
        prompt: `The composition failed validation. Fix the files using write_composition_file.\n\nDiagnostics:\n${result.diagnostics}`,
      });
    }

    // Write the composition artifact (lineage: design + script (+ narration)).
    const lineage: LineageRef[] = [
      { kind: "design", version: designEnv.version },
      { kind: "script", version: scriptEnv.version },
    ];
    if (narrationEnv) lineage.push({ kind: "narration", version: narrationEnv.version });
    await ctx.artifacts.put(
      ctx.sessionId,
      "composition",
      { dir: "composition", entry: "index.html" },
      { derivedFrom: lineage },
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run pi-compose-handler`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/pi-compose-handler.ts apps/server/test/pi-compose-handler.test.ts
git commit -m "feat(server): add PiComposePhaseHandler with hyperframes quality loop"
```

---

### Task 11: Wire the compose handler into the orchestrator

**Files:**
- Modify: `apps/server/src/compose-orchestrator.ts`
- Test: covered by the end-to-end test in Task 14; verify the existing orchestrator/intent tests still pass.

- [ ] **Step 1: Import and register the handler**

In `apps/server/src/compose-orchestrator.ts`:

Add the import (next to the other handler imports):

```ts
import { PiComposePhaseHandler } from "./phases/pi-compose-handler.js";
```

Add an optional override field to `ComposeOrchestratorOptions` (so tests can stub the quality runner / handler) — after `renderFps` (~line 51):

```ts
  /** Optional compose handler override (e.g. with a stubbed quality runner in tests). */
  composeHandlerOverride?: PhaseHandler;
```

Register it in the `handlers` map (between `voiceover` and `render`):

```ts
    ["voiceover", new VoiceoverPhaseHandler({ providers })],
    ["compose",
      opts.composeHandlerOverride
      ?? new PiComposePhaseHandler({ agentFactory, model: opts.model })],
    ["render", renderHandler],
```

(The default `PiComposePhaseHandler` uses the real `HyperframesQualityRunner`. Production renders go through the real CLI; tests inject `composeHandlerOverride` or `handlerOverrides.compose`.)

- [ ] **Step 2: Type-check and run the orchestrator/intent tests**

Run: `npx tsc -p apps/server --noEmit` then `npx vitest run intent orchestrator`
Expected: no type errors; existing tests pass (ordering now traverses `compose` automatically via `PHASE_IDS`).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/compose-orchestrator.ts
git commit -m "feat(server): register compose phase in the orchestrator graph"
```

---

### Task 12: Rewrite the render handler to read the composition artifact

**Files:**
- Modify: `apps/server/src/phases/render-handler.ts` (full rewrite)
- Modify: `apps/server/test/render-handler.test.ts` (full rewrite)

`render` no longer builds anything. It reads the `composition` artifact (written by `compose`), confirms `composition/index.html` exists on disk, renders it, and writes only the `mp4` artifact.

- [ ] **Step 1: Rewrite the test first**

Replace the entire contents of `apps/server/test/render-handler.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, basename, resolve } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";
import { StubRenderWorkerClient } from "../src/render/stub-render-worker.js";
import type { RenderOptions } from "../src/render/render-worker-client.js";
import { RenderPhaseHandler } from "../src/phases/render-handler.js";
import type { ServerEvent } from "@ultracreator/shared";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "uc-rh-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Seed a composition artifact + an index.html on disk (as the compose phase would).
async function seedComposition(store: ArtifactStore, wm: WorkspaceManager) {
  await wm.init("s1");
  await store.put("s1", "composition", { dir: "composition", entry: "index.html" });
  await writeFile(join(wm.paths("s1").composition, "index.html"), "<html>composed</html>");
}

describe("RenderPhaseHandler", () => {
  it("reads the composition artifact, renders it, and writes the mp4 artifact", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seedComposition(store, wm);

    const worker = new StubRenderWorkerClient({ writeOutput: true });
    const handler = new RenderPhaseHandler({ workerClient: worker });

    const yielded: ServerEvent[] = [];
    for await (const e of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) yielded.push(e);

    const mp4Env = await store.get<{ path: string }>("s1", "mp4");
    expect(mp4Env).not.toBeNull();
    expect(existsSync(mp4Env!.data.path)).toBe(true);
    expect(readFileSync(mp4Env!.data.path, "utf8")).toContain("STUB-MP4");
    expect(yielded.some((e) => e.type === "render.progress")).toBe(true);
    expect(yielded.at(-1)).toMatchObject({ type: "render.done" });
  });

  it("throws when the upstream composition artifact is missing", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await wm.init("s1");
    // no composition artifact

    const handler = new RenderPhaseHandler({ workerClient: new StubRenderWorkerClient({ writeOutput: true }) });
    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) { /* drain */ }
    }).rejects.toThrow(/composition/i);
  });

  it("throws when the worker yields an error and writes no mp4 artifact", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seedComposition(store, wm);

    const worker = new StubRenderWorkerClient({ failWith: "ffmpeg blew up" });
    const handler = new RenderPhaseHandler({ workerClient: worker });

    await expect(async () => {
      for await (const _ of handler.run({
        sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
        signal: new AbortController().signal,
      } as any)) { /* drain */ }
    }).rejects.toThrow(/ffmpeg/);

    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "mp4")).toBeUndefined();
  });

  it("passes an absolute outputPath even when the workspace baseDir is relative", async () => {
    const relBase = relative(process.cwd(), root);
    expect(isAbsolute(relBase)).toBe(false);
    const wm = new WorkspaceManager(relBase);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seedComposition(store, wm);

    let captured: string | undefined;
    class CapturingClient extends StubRenderWorkerClient {
      override async *render(opts: RenderOptions) {
        captured = opts.outputPath;
        yield { type: "done", mp4Path: opts.outputPath } as const;
      }
    }
    const handler = new RenderPhaseHandler({ workerClient: new CapturingClient({ writeOutput: false }) });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: new AbortController().signal,
    } as any)) { /* drain */ }

    expect(captured).toBeDefined();
    expect(isAbsolute(captured!)).toBe(true);
    expect(captured).toBe(join(resolve(wm.paths("s1").output), basename(captured!)));
  });

  it("propagates ctx.signal abort to the worker client", async () => {
    const wm = new WorkspaceManager(root);
    const bus = new EventBus();
    const store = new ArtifactStore(wm, bus);
    await seedComposition(store, wm);

    let observedSignal: AbortSignal | undefined;
    class CapturingClient extends StubRenderWorkerClient {
      override async *render(opts: RenderOptions) {
        observedSignal = opts.signal;
        yield { type: "done", mp4Path: opts.outputPath } as const;
      }
    }
    const controller = new AbortController();
    const handler = new RenderPhaseHandler({ workerClient: new CapturingClient({ writeOutput: false }) });
    for await (const _ of handler.run({
      sessionId: "s1", workspaces: wm, artifacts: store, events: bus,
      signal: controller.signal,
    } as any)) { /* drain */ }

    expect(observedSignal).toBe(controller.signal);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run render-handler`
Expected: FAIL — the current handler loads brief/design/script and calls `buildComposition`; it never reads a `composition` artifact, so the "missing composition" test fails and the happy path errors on missing brief.

- [ ] **Step 3: Rewrite the handler**

Replace the entire contents of `apps/server/src/phases/render-handler.ts` with:

```ts
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { CompositionData, PhaseId, ServerEvent } from "@ultracreator/shared";
import type { PhaseContext, PhaseHandler } from "./types.js";
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

export class RenderPhaseHandler implements PhaseHandler {
  readonly phase: PhaseId = "render";
  constructor(private opts: RenderPhaseHandlerOptions) {}

  async *run(ctx: PhaseContext): AsyncIterable<ServerEvent> {
    if (ctx.signal.aborted) throw new Error("Aborted");

    // 1. Load the composition authored by the compose phase.
    const compEnv = await ctx.artifacts.get<CompositionData>(ctx.sessionId, "composition");
    if (!compEnv) throw new Error("render phase requires a composition artifact, none found");

    const paths = ctx.workspaces.paths(ctx.sessionId);
    const entryPath = join(paths.composition, compEnv.data.entry);
    if (!existsSync(entryPath)) {
      throw new Error(`composition entry not found on disk: ${entryPath}`);
    }

    // 2. Run the renderer. The worker runs with cwd=projectDir, so a relative output
    // path would land inside the composition dir; resolve to absolute.
    const outputPath = resolve(paths.output, `${randomUUID()}.mp4`);
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
            { path: msg.mp4Path },
            { derivedFrom: [{ kind: "composition", version: compEnv.version }] },
          );
          yield { type: "render.done", mp4Path: msg.mp4Path };
          return;
        }
        case "error":
          yield { type: "render.error", error: msg.message };
          throw new Error(msg.message);
      }
    }

    throw new Error("Render worker ended without a terminal message");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run render-handler`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/phases/render-handler.ts apps/server/test/render-handler.test.ts
git commit -m "refactor(server): render reads composition artifact, emits only mp4"
```

---

### Task 13: Remove the composition-builder stub

**Files:**
- Delete: `apps/server/src/render/composition-builder.ts`
- Delete: `apps/server/test/composition-builder.test.ts`
- Modify: `apps/server/test/render.external.test.ts:7,42-45` (inline a valid composition)

- [ ] **Step 1: Confirm nothing in src still imports it**

Run: `grep -rn "composition-builder\|buildComposition" apps/server/src`
Expected: no output (Task 12 removed the last `src` import).

- [ ] **Step 2: Replace the external test's use of buildComposition**

In `apps/server/test/render.external.test.ts`, remove the import on line 7
(`import { buildComposition } ...`) and replace lines 42-45 with an inline,
known-good composition (this is what the compose agent is expected to produce):

```ts
    const html = `<!doctype html><html><head>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:#101010}
.clip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.clip h1{font-family:Inter,sans-serif;color:#fff;font-size:96px}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080">
  <div id="s1" class="clip" data-start="0" data-duration="5" data-track-index="1"><h1 class="t1">Hi</h1></div>
</div>
<script>
window.__timelines = window.__timelines || {};
const tl = gsap.timeline({ paused: true });
tl.from(".t1", { duration: 0.6, opacity: 0, y: 40 }, 0.1);
window.__timelines["main"] = tl;
</script></body></html>`;
    await writeFile(join(projectDir, "index.html"), html);
```

(The `brief`/`design`/`script` fixtures at the top of the file are now unused — delete
them and their `Brief, Design, Script` type import on line 6 to keep the file clean.)

- [ ] **Step 3: Delete the stub and its test**

```bash
git rm apps/server/src/render/composition-builder.ts apps/server/test/composition-builder.test.ts
```

- [ ] **Step 4: Verify the suite is green**

Run: `npx vitest run` (full server suite) and `npx tsc -p apps/server --noEmit`
Expected: all pass; no dangling imports of `composition-builder`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/test/render.external.test.ts
git commit -m "refactor(server): remove placeholder composition-builder stub"
```

---

### Task 14: End-to-end test through the compose phase

**Files:**
- Create or extend: `apps/server/test/pipeline-e2e.test.ts` (mirror the existing pipeline/orchestrator e2e test if one exists; otherwise create)

Drives research → design → script → (voiceover) → compose → render with the
fake-renderer and a faux model, asserting the generated `composition/index.html` passes a
structural contract and the mp4 lands at the workspace output path.

- [ ] **Step 1: Locate an existing e2e/orchestrator test to mirror**

Run: `ls apps/server/test | grep -iE "e2e|orchestrator|pipeline"`
Read the closest match to reuse its harness (how it builds the orchestrator, drives
phases, and supplies a faux model). If none exists, build the orchestrator directly via
`composeOrchestrator(...)` with: a faux model whose responses cover every phase's tool
calls, `fetch`/`fetchBinary` stubs, a fake TTS provider, `renderWorkerClient: new StubRenderWorkerClient({ writeOutput: true })`, and `composeHandlerOverride: new PiComposePhaseHandler({ agentFactory, model, qualityRunner: { check: async () => ({ ok: true, diagnostics: "" }) } })`.

- [ ] **Step 2: Write the failing test**

Add a test that runs the full pipeline for a no-voiceover brief and asserts:

```ts
// After driving all phases to completion for session "s1":
const compEnv = await store.get("s1", "composition");
expect(compEnv).not.toBeNull();

const html = readFileSync(join(wm.paths("s1").composition, "index.html"), "utf8");
expect(html).toMatch(/data-composition-id="main"/);
expect(html).toMatch(/window\.__timelines\["main"\]/);
expect(html).toMatch(/gsap\.timeline\(\s*\{\s*paused:\s*true/);

const mp4Env = await store.get<{ path: string }>("s1", "mp4");
expect(mp4Env).not.toBeNull();
expect(existsSync(mp4Env!.data.path)).toBe(true);
expect(mp4Env!.data.path.startsWith(resolve(wm.paths("s1").output))).toBe(true);
```

The faux model's response queue must, in order: (research) call `write_brief`; (design)
call `write_design`; (script) call `write_script`; (compose) call
`write_composition_file` with a structurally-valid `index.html` (reuse `VALID_HTML` from
the compose handler test); each phase ends with a `fauxText("done")`.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run pipeline-e2e`
Expected: FAIL initially (composition/mp4 assertions) until the full chain is wired — which it now is after Tasks 1-13, so this primarily guards against regressions.

- [ ] **Step 4: Make it pass**

If the harness is correct, it should pass given Tasks 1-13. Fix any wiring gaps the test
surfaces (e.g. a faux response missing for a phase, or a stub missing `fetchBinary`).

- [ ] **Step 5: Optional real-validate guard (skipped by default)**

Add an `[external]`-tagged variant that runs the real `HyperframesQualityRunner.check`
against the generated `composition/` and asserts `ok === true`. Gate it the same way
`render.external.test.ts` is gated so CI without Chrome/bun does not run it by default.

- [ ] **Step 6: Commit**

```bash
git add apps/server/test/pipeline-e2e.test.ts
git commit -m "test(server): e2e pipeline through compose phase to mp4"
```

---

## Frontend note (no code change expected)

`apps/web` renders phase events generically (confirmed: `artifact-viewer.tsx` derives the
mp4 URL robustly and there is no hardcoded phase list). After Task 1 the `compose` phase
will appear automatically in progress UIs. **Verify in the browser** once the server runs
end-to-end: start the dev server, create a session, and confirm the `compose` phase shows
progress and the final video plays. If any component hardcodes the phase list, add
`compose` there.

## Self-Review Checklist (run before handing off)

1. **Spec coverage:** download_asset (T4/5), assets dir (T3), logoFile (T2), compose phase
   + prompt + quality loop (T1/10), write_composition_file (T8), lint/validate runner (T9),
   render rewrite (T12), stub removal (T13), shared util (T7), e2e (T14). ✓
2. **Type consistency:** `QualityRunner.check(dir, signal) => {ok, diagnostics}` used
   identically in T9, T10, T11, T14. `makeDownloadAssetTool`/`makeWriteCompositionFileTool`
   signatures match their call sites. `CompositionData` import in render-handler matches
   `apps/server` shared export. ✓
3. **No placeholders:** every code step has complete code. ✓
