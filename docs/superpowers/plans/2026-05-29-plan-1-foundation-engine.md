# UltraCreator Plan 1 — Foundation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic backend foundation — a pnpm monorepo, a `shared` package of zod-validated artifact/event/intent schemas, and three server primitives (EventBus, WorkspaceManager, ArtifactStore) that everything else builds on.

**Architecture:** A pnpm-workspaces monorepo. `packages/shared` holds zod schemas + derived TS types, consumed directly as TypeScript source (no build step for dev/test). `apps/server` holds the runtime primitives. ArtifactStore writes versioned, immutable artifact files into a per-session workspace directory and broadcasts changes through EventBus; "stale" is tracked in an index file so artifact data stays immutable while its lifecycle metadata can change.

**Tech Stack:** Node 24, pnpm 10, TypeScript, zod (validation), vitest (testing), tsx (TS execution). No external services.

**Roadmap context:** This is Plan 1 of 6 (Foundation → Orchestrator → Pi-agent phases → Render worker → Fastify API → Frontend). It produces a fully tested, importable foundation library with zero external dependencies.

---

## File Structure

```
UltraCreator/
  package.json                      # workspace root, scripts
  pnpm-workspace.yaml
  tsconfig.base.json                # shared compiler options
  vitest.config.ts                  # root vitest (workspace projects)
  packages/
    shared/
      package.json
      tsconfig.json
      src/
        index.ts                    # re-exports all schemas/types
        constraints.ts              # AspectRatio, Duration, Constraints
        brief.ts                    # BriefSchema + Brief
        design.ts                   # DesignSchema + Design
        script.ts                   # ScriptSchema + Script
        artifact.ts                 # ArtifactKind, envelope, index descriptor
        events.ts                   # ServerEvent union
        intent.ts                   # Intent enum
      test/
        schemas.test.ts
  apps/
    server/
      package.json
      tsconfig.json
      src/
        events/event-bus.ts         # in-memory per-session pub/sub
        workspace/workspace-manager.ts  # session dirs + upload persistence
        artifacts/artifact-store.ts # versioned immutable artifact I/O
      test/
        event-bus.test.ts
        workspace-manager.test.ts
        artifact-store.test.ts
```

**Responsibility boundaries:**
- `packages/shared` — pure data contracts. No I/O, no Node APIs. Importable by both server and (later) the Next.js frontend.
- `EventBus` — in-memory pub/sub keyed by session id. No persistence, no knowledge of artifacts.
- `WorkspaceManager` — owns the on-disk layout for a session and validates uploads. No knowledge of artifact semantics.
- `ArtifactStore` — the only writer of artifact files; enforces zod validation, versioning, immutability, lineage, and emits events. Depends on WorkspaceManager (for paths) and EventBus (to broadcast).

---

## Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`

- [ ] **Step 1: Create the workspace root `package.json`**

```json
{
  "name": "ultracreator",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r exec tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8",
    "tsx": "^4.19.2"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "verbatimModuleSyntax": true
  }
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Create `packages/shared/package.json`**

```json
{
  "name": "@ultracreator/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "^3.24.1"
  }
}
```

- [ ] **Step 6: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

(No `rootDir`/`outDir`: this is a no-build package consumed as TS source via `exports`, so `tsc` is only ever run with `--noEmit`. Including `test` under a `rootDir` of `src` would error TS6059.)

- [ ] **Step 7: Create a placeholder `packages/shared/src/index.ts`**

```ts
// Re-exports are added by later tasks.
export {};
```

- [ ] **Step 8: Create `apps/server/package.json`**

```json
{
  "name": "@ultracreator/server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ultracreator/shared": "workspace:*",
    "zod": "^3.24.1"
  }
}
```

- [ ] **Step 9: Create `apps/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

(Same rationale as the shared package: no build step, so no `rootDir`/`outDir`.)

- [ ] **Step 10: Install dependencies**

Run: `pnpm install`
Expected: completes, creates `pnpm-lock.yaml` and `node_modules/`. `@ultracreator/shared` is linked into `apps/server`.

- [ ] **Step 11: Verify vitest runs with no tests yet**

Run: `pnpm test`
Expected: vitest exits 0 with "No test files found" (this is fine — it confirms the runner works).

- [ ] **Step 12: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json vitest.config.ts packages apps pnpm-lock.yaml
git commit -m "chore: scaffold pnpm monorepo (shared + server, vitest)"
```

---

## Task 2: Constraints schema (AspectRatio, Duration, Constraints)

**Files:**
- Create: `packages/shared/src/constraints.ts`
- Test: `packages/shared/test/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ConstraintsSchema, ALLOWED_DURATIONS, ALLOWED_ASPECT_RATIOS } from "../src/constraints.js";

describe("ConstraintsSchema", () => {
  it("accepts a valid constraints object", () => {
    const value = { durationSec: 30, aspectRatio: "16:9", withVoiceover: true };
    expect(ConstraintsSchema.parse(value)).toEqual(value);
  });

  it("rejects a duration not in the allowed set", () => {
    const value = { durationSec: 25, aspectRatio: "16:9", withVoiceover: false };
    expect(() => ConstraintsSchema.parse(value)).toThrow();
  });

  it("rejects an unknown aspect ratio", () => {
    const value = { durationSec: 30, aspectRatio: "4:3", withVoiceover: false };
    expect(() => ConstraintsSchema.parse(value)).toThrow();
  });

  it("exposes the allowed sets for the UI", () => {
    expect(ALLOWED_DURATIONS).toEqual([15, 30, 45, 60]);
    expect(ALLOWED_ASPECT_RATIOS).toEqual(["16:9", "9:16", "1:1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/constraints.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/constraints.ts`:

```ts
import { z } from "zod";

export const ALLOWED_DURATIONS = [15, 30, 45, 60] as const;
export const ALLOWED_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;

export const DurationSchema = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(45),
  z.literal(60),
]);

export const AspectRatioSchema = z.enum(ALLOWED_ASPECT_RATIOS);

export const ConstraintsSchema = z.object({
  durationSec: DurationSchema,
  aspectRatio: AspectRatioSchema,
  withVoiceover: z.boolean(),
});

export type Duration = z.infer<typeof DurationSchema>;
export type AspectRatio = z.infer<typeof AspectRatioSchema>;
export type Constraints = z.infer<typeof ConstraintsSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constraints.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add constraints schema (duration, aspect ratio)"
```

---

## Task 3: Brief schema

**Files:**
- Create: `packages/shared/src/brief.ts`
- Test: `packages/shared/test/schemas.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to schemas.test.ts)**

Add to `packages/shared/test/schemas.test.ts`:

```ts
import { BriefSchema } from "../src/brief.js";

describe("BriefSchema", () => {
  const valid = {
    product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
    audience: "developers",
    keyMessages: ["fast", "simple"],
    brandHints: { colors: ["#FF0000"], logoUrl: "https://x/logo.png", fonts: ["Inter"] },
    sourceAssets: { images: ["a.png"], videos: [], copy: ["hero text"] },
    constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: true },
  };

  it("accepts a complete brief", () => {
    expect(BriefSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a brief without optional brand hints", () => {
    const { logoUrl, fonts, ...colorsOnly } = valid.brandHints;
    const v = { ...valid, brandHints: { colors: colorsOnly.colors } };
    expect(BriefSchema.parse(v).brandHints.fonts).toBeUndefined();
  });

  it("rejects a brief missing keyMessages", () => {
    const { keyMessages, ...rest } = valid;
    expect(() => BriefSchema.parse(rest)).toThrow();
  });

  it("rejects more than 3 key messages", () => {
    expect(() => BriefSchema.parse({ ...valid, keyMessages: ["a", "b", "c", "d"] })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/brief.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/brief.ts`:

```ts
import { z } from "zod";
import { ConstraintsSchema } from "./constraints.js";

export const BriefSchema = z.object({
  product: z.object({
    name: z.string().min(1),
    tagline: z.string(),
    description: z.string(),
    category: z.string(),
  }),
  audience: z.string(),
  keyMessages: z.array(z.string()).min(1).max(3),
  brandHints: z.object({
    colors: z.array(z.string()),
    logoUrl: z.string().optional(),
    fonts: z.array(z.string()).optional(),
  }),
  sourceAssets: z.object({
    images: z.array(z.string()),
    videos: z.array(z.string()),
    copy: z.array(z.string()),
  }),
  constraints: ConstraintsSchema,
});

export type Brief = z.infer<typeof BriefSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/brief.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add brief schema"
```

---

## Task 4: Design schema

**Files:**
- Create: `packages/shared/src/design.ts`
- Test: `packages/shared/test/schemas.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

Add to `packages/shared/test/schemas.test.ts`:

```ts
import { DesignSchema } from "../src/design.js";

describe("DesignSchema", () => {
  const valid = {
    mood: "energetic",
    palette: [{ name: "primary", hex: "#FF3366" }],
    typography: { heading: "Poppins", body: "Inter" },
    motionStyle: "kinetic captions",
    keyVisuals: [{ description: "product hero", refAssetId: "img-1" }],
    sampleFrames: [{ caption: "Meet Acme", layoutHint: "centered", thumbnailUrl: "t.png" }],
  };

  it("accepts a complete design", () => {
    expect(DesignSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a palette entry missing hex", () => {
    const v = { ...valid, palette: [{ name: "primary" }] };
    expect(() => DesignSchema.parse(v)).toThrow();
  });

  it("allows sample frames without thumbnails", () => {
    const v = { ...valid, sampleFrames: [{ caption: "x", layoutHint: "left" }] };
    expect(DesignSchema.parse(v).sampleFrames[0]!.thumbnailUrl).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/design.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/design.ts`:

```ts
import { z } from "zod";

export const DesignSchema = z.object({
  mood: z.string(),
  palette: z.array(z.object({ name: z.string(), hex: z.string() })).min(1),
  typography: z.object({ heading: z.string(), body: z.string() }),
  motionStyle: z.string(),
  keyVisuals: z.array(
    z.object({ description: z.string(), refAssetId: z.string().optional() }),
  ),
  sampleFrames: z.array(
    z.object({
      caption: z.string(),
      layoutHint: z.string(),
      thumbnailUrl: z.string().optional(),
    }),
  ),
});

export type Design = z.infer<typeof DesignSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/design.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add design schema"
```

---

## Task 5: Script schema

**Files:**
- Create: `packages/shared/src/script.ts`
- Test: `packages/shared/test/schemas.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

Add to `packages/shared/test/schemas.test.ts`:

```ts
import { ScriptSchema } from "../src/script.js";

describe("ScriptSchema", () => {
  const valid = {
    totalSec: 30,
    scenes: [
      {
        id: "s1",
        startSec: 0,
        durationSec: 5,
        visual: "logo reveal",
        onScreenText: "Acme",
        narration: "Meet Acme.",
        assetRefs: ["img-1"],
      },
    ],
  };

  it("accepts a complete script", () => {
    expect(ScriptSchema.parse(valid)).toEqual(valid);
  });

  it("requires at least one scene", () => {
    expect(() => ScriptSchema.parse({ totalSec: 30, scenes: [] })).toThrow();
  });

  it("allows scenes without optional narration/onScreenText/assetRefs", () => {
    const v = {
      totalSec: 10,
      scenes: [{ id: "s1", startSec: 0, durationSec: 10, visual: "shot" }],
    };
    expect(ScriptSchema.parse(v).scenes[0]!.narration).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/script.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/script.ts`:

```ts
import { z } from "zod";

export const SceneSchema = z.object({
  id: z.string(),
  startSec: z.number().min(0),
  durationSec: z.number().positive(),
  visual: z.string(),
  onScreenText: z.string().optional(),
  narration: z.string().optional(),
  assetRefs: z.array(z.string()).optional(),
});

export const ScriptSchema = z.object({
  totalSec: z.number().positive(),
  scenes: z.array(SceneSchema).min(1),
});

export type Scene = z.infer<typeof SceneSchema>;
export type Script = z.infer<typeof ScriptSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (14 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/script.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add script schema"
```

---

## Task 6: Artifact envelope, kinds, and index descriptor

**Files:**
- Create: `packages/shared/src/artifact.ts`
- Test: `packages/shared/test/schemas.test.ts` (append)

This defines the versioning contract. `ARTIFACT_DATA_SCHEMAS` maps each kind to its data schema — ArtifactStore (Task 9) uses this map to validate. `narration`, `composition`, and `mp4` are file-pointer artifacts (no rich data schema yet), so their data schema is a small descriptor.

- [ ] **Step 1: Write the failing test (append)**

Add to `packages/shared/test/schemas.test.ts`:

```ts
import {
  ARTIFACT_KINDS,
  ARTIFACT_DATA_SCHEMAS,
  ArtifactDescriptorSchema,
} from "../src/artifact.js";

describe("artifact contract", () => {
  it("lists all artifact kinds", () => {
    expect(ARTIFACT_KINDS).toEqual([
      "brief",
      "design",
      "script",
      "narration",
      "composition",
      "mp4",
    ]);
  });

  it("has a data schema for every kind", () => {
    for (const kind of ARTIFACT_KINDS) {
      expect(ARTIFACT_DATA_SCHEMAS[kind]).toBeDefined();
    }
  });

  it("validates a narration data pointer", () => {
    const ok = ARTIFACT_DATA_SCHEMAS.narration.parse({
      audioPath: "narration.mp3",
      durationMs: 12000,
    });
    expect(ok.audioPath).toBe("narration.mp3");
  });

  it("validates an artifact descriptor with lineage and stale flag", () => {
    const desc = {
      kind: "script",
      version: 2,
      createdAt: "2026-05-29T00:00:00.000Z",
      derivedFrom: [{ kind: "design", version: 1 }],
      stale: false,
      path: "artifacts/script.v2.json",
    };
    expect(ArtifactDescriptorSchema.parse(desc)).toEqual(desc);
  });

  it("allows a null lineage for root artifacts", () => {
    const desc = {
      kind: "brief",
      version: 1,
      createdAt: "2026-05-29T00:00:00.000Z",
      derivedFrom: null,
      stale: false,
      path: "artifacts/brief.v1.json",
    };
    expect(ArtifactDescriptorSchema.parse(desc).derivedFrom).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/artifact.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/shared/src/artifact.ts`:

```ts
import { z } from "zod";
import { BriefSchema } from "./brief.js";
import { DesignSchema } from "./design.js";
import { ScriptSchema } from "./script.js";

export const ARTIFACT_KINDS = [
  "brief",
  "design",
  "script",
  "narration",
  "composition",
  "mp4",
] as const;

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

// File-pointer artifacts: data is a small descriptor, the real payload is on disk.
export const NarrationDataSchema = z.object({
  audioPath: z.string(),
  durationMs: z.number().nonnegative(),
  wordTimings: z
    .array(z.object({ word: z.string(), startMs: z.number(), endMs: z.number() }))
    .optional(),
});

export const CompositionDataSchema = z.object({
  dir: z.string(), // relative path to the hyperframes project dir
  entry: z.string().default("index.html"),
});

export const Mp4DataSchema = z.object({
  path: z.string(),
  durationSec: z.number().nonnegative().optional(),
});

export const ARTIFACT_DATA_SCHEMAS = {
  brief: BriefSchema,
  design: DesignSchema,
  script: ScriptSchema,
  narration: NarrationDataSchema,
  composition: CompositionDataSchema,
  mp4: Mp4DataSchema,
} as const;

export const LineageRefSchema = z.object({
  kind: ArtifactKindSchema,
  version: z.number().int().positive(),
});

export const ArtifactDescriptorSchema = z.object({
  kind: ArtifactKindSchema,
  version: z.number().int().positive(),
  createdAt: z.string(),
  derivedFrom: z.array(LineageRefSchema).nullable(),
  stale: z.boolean(),
  path: z.string(),
});

export type LineageRef = z.infer<typeof LineageRefSchema>;
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

// The on-disk envelope written for each artifact version.
export interface ArtifactEnvelope<T = unknown> {
  kind: ArtifactKind;
  version: number;
  createdAt: string;
  derivedFrom: LineageRef[] | null;
  data: T;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (19 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/artifact.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add artifact kinds, data schemas, and index descriptor"
```

---

## Task 7: Event union and Intent enum

**Files:**
- Create: `packages/shared/src/events.ts`
- Create: `packages/shared/src/intent.ts`
- Test: `packages/shared/test/schemas.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

Add to `packages/shared/test/schemas.test.ts`:

```ts
import { ServerEventSchema } from "../src/events.js";
import { INTENTS, IntentSchema } from "../src/intent.js";

describe("ServerEventSchema", () => {
  it("validates an artifact.created event", () => {
    const e = { type: "artifact.created", kind: "brief", version: 1 };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });

  it("validates a phase.error event", () => {
    const e = { type: "phase.error", phase: "design", error: "boom" };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });

  it("validates a render.progress event", () => {
    const e = { type: "render.progress", percent: 42 };
    expect(ServerEventSchema.parse(e)).toEqual(e);
  });

  it("rejects an unknown event type", () => {
    expect(() => ServerEventSchema.parse({ type: "nope" })).toThrow();
  });
});

describe("Intent", () => {
  it("lists all intents", () => {
    expect(INTENTS).toEqual([
      "new-project",
      "approve",
      "refine",
      "update-brief",
      "revise-back",
      "branch",
      "abort",
      "ask",
    ]);
  });

  it("validates an intent value", () => {
    expect(IntentSchema.parse("approve")).toBe("approve");
    expect(() => IntentSchema.parse("frobnicate")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — cannot resolve `../src/events.js` / `../src/intent.js`.

- [ ] **Step 3: Write minimal implementations**

Create `packages/shared/src/intent.ts`:

```ts
import { z } from "zod";

export const INTENTS = [
  "new-project",
  "approve",
  "refine",
  "update-brief",
  "revise-back",
  "branch",
  "abort",
  "ask",
] as const;

export const IntentSchema = z.enum(INTENTS);
export type Intent = z.infer<typeof IntentSchema>;
```

Create `packages/shared/src/events.ts`:

```ts
import { z } from "zod";
import { ArtifactKindSchema } from "./artifact.js";

const PhaseIdSchema = z.enum([
  "research",
  "design",
  "script",
  "voiceover",
  "render",
]);

export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase.started"), phase: PhaseIdSchema, at: z.string() }),
  z.object({ type: z.literal("phase.progress"), phase: PhaseIdSchema, message: z.string() }),
  z.object({ type: z.literal("phase.error"), phase: PhaseIdSchema, error: z.string() }),
  z.object({ type: z.literal("gate.awaiting"), phase: PhaseIdSchema }),
  z.object({ type: z.literal("artifact.created"), kind: ArtifactKindSchema, version: z.number().int().positive() }),
  z.object({ type: z.literal("artifact.stale"), kind: ArtifactKindSchema, version: z.number().int().positive() }),
  z.object({ type: z.literal("render.progress"), percent: z.number().min(0).max(100) }),
  z.object({ type: z.literal("render.done"), mp4Path: z.string() }),
  z.object({ type: z.literal("render.error"), error: z.string() }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export const PHASE_IDS = PhaseIdSchema.options; // readonly ["research","design","script","voiceover","render"]
export type PhaseId = z.infer<typeof PhaseIdSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (25 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/events.ts packages/shared/src/intent.ts packages/shared/test/schemas.test.ts
git commit -m "feat(shared): add server event union and intent enum"
```

---

## Task 8: Wire shared package barrel export

**Files:**
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/schemas.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

Add to `packages/shared/test/schemas.test.ts`:

```ts
import * as shared from "../src/index.js";

describe("barrel export", () => {
  it("re-exports the public schemas and types", () => {
    expect(shared.BriefSchema).toBeDefined();
    expect(shared.DesignSchema).toBeDefined();
    expect(shared.ScriptSchema).toBeDefined();
    expect(shared.ConstraintsSchema).toBeDefined();
    expect(shared.ServerEventSchema).toBeDefined();
    expect(shared.IntentSchema).toBeDefined();
    expect(shared.ARTIFACT_DATA_SCHEMAS).toBeDefined();
    expect(shared.ArtifactDescriptorSchema).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: FAIL — `shared.BriefSchema` is undefined.

- [ ] **Step 3: Write the barrel export**

Replace `packages/shared/src/index.ts` with:

```ts
export * from "./constraints.js";
export * from "./brief.js";
export * from "./design.js";
export * from "./script.js";
export * from "./artifact.js";
export * from "./events.js";
export * from "./intent.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/shared/test/schemas.test.ts`
Expected: PASS (26 tests total).

- [ ] **Step 5: Verify the server package can import shared**

Create a temporary check file `apps/server/test/import-shared.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BriefSchema } from "@ultracreator/shared";

describe("server imports shared", () => {
  it("resolves the workspace package", () => {
    expect(BriefSchema).toBeDefined();
  });
});
```

Run: `pnpm vitest run apps/server/test/import-shared.test.ts`
Expected: PASS — confirms the `workspace:*` link + `exports` resolve from server.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/test/schemas.test.ts apps/server/test/import-shared.test.ts
git commit -m "feat(shared): barrel export + verify cross-package import"
```

---

## Task 9: EventBus (in-memory per-session pub/sub)

**Files:**
- Create: `apps/server/src/events/event-bus.ts`
- Test: `apps/server/test/event-bus.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/event-bus.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/events/event-bus.js";
import type { ServerEvent } from "@ultracreator/shared";

const ev: ServerEvent = { type: "artifact.created", kind: "brief", version: 1 };

describe("EventBus", () => {
  it("delivers events to subscribers of the same session", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe("s1", (e) => seen.push(e));
    bus.emit("s1", ev);
    expect(seen).toEqual([ev]);
  });

  it("does not deliver events across sessions", () => {
    const bus = new EventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe("s1", (e) => seen.push(e));
    bus.emit("s2", ev);
    expect(seen).toEqual([]);
  });

  it("stops delivering after unsubscribe", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribe("s1", fn);
    off();
    bus.emit("s1", ev);
    expect(fn).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers", () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe("s1", a);
    bus.subscribe("s1", b);
    bus.emit("s1", ev);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/event-bus.test.ts`
Expected: FAIL — cannot resolve `../src/events/event-bus.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/events/event-bus.ts`:

```ts
import type { ServerEvent } from "@ultracreator/shared";

export type EventListener = (event: ServerEvent) => void;

export class EventBus {
  private listeners = new Map<string, Set<EventListener>>();

  subscribe(sessionId: string, listener: EventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }

  emit(sessionId: string, event: ServerEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const listener of [...set]) listener(event);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/event-bus.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/events/event-bus.ts apps/server/test/event-bus.test.ts
git commit -m "feat(server): add in-memory per-session EventBus"
```

---

## Task 10: WorkspaceManager (session dirs + upload persistence)

**Files:**
- Create: `apps/server/src/workspace/workspace-manager.ts`
- Test: `apps/server/test/workspace-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/workspace-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-ws-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceManager", () => {
  it("init creates the full session directory layout", async () => {
    const wm = new WorkspaceManager(root);
    const paths = await wm.init("s1");
    expect(existsSync(paths.uploads)).toBe(true);
    expect(existsSync(paths.artifacts)).toBe(true);
    expect(existsSync(paths.composition)).toBe(true);
    expect(existsSync(paths.output)).toBe(true);
    expect(existsSync(paths.logs)).toBe(true);
  });

  it("paths returns deterministic locations under the session root", () => {
    const wm = new WorkspaceManager(root);
    const paths = wm.paths("s1");
    expect(paths.root).toBe(join(root, "s1"));
    expect(paths.artifacts).toBe(join(root, "s1", "artifacts"));
  });

  it("saveUpload writes a valid file and returns its stored path", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const stored = await wm.saveUpload("s1", "logo.png", Buffer.from("PNGDATA"));
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored, "utf8")).toBe("PNGDATA");
    expect(stored.startsWith(join(root, "s1", "uploads"))).toBe(true);
  });

  it("saveUpload rejects a disallowed extension", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    await expect(wm.saveUpload("s1", "evil.exe", Buffer.from("x"))).rejects.toThrow(/extension/i);
  });

  it("saveUpload rejects a file over the size limit", async () => {
    const wm = new WorkspaceManager(root, { maxUploadBytes: 4 });
    await wm.init("s1");
    await expect(wm.saveUpload("s1", "big.png", Buffer.from("12345"))).rejects.toThrow(/size/i);
  });

  it("saveUpload sanitizes path-traversal filenames", async () => {
    const wm = new WorkspaceManager(root);
    await wm.init("s1");
    const stored = await wm.saveUpload("s1", "../../etc/passwd.png", Buffer.from("x"));
    expect(stored.startsWith(join(root, "s1", "uploads"))).toBe(true);
    expect(stored).not.toContain("..");
    // the file physically lands inside uploads as a flat, sanitized name
    expect(existsSync(join(root, "s1", "uploads", "passwd.png"))).toBe(true);
  });

  it("rejects a path-traversal session id", () => {
    const wm = new WorkspaceManager(root);
    expect(() => wm.paths("../../etc")).toThrow(/invalid session id/i);
  });

  it("rejects an empty or dotted session id", () => {
    const wm = new WorkspaceManager(root);
    expect(() => wm.paths("")).toThrow(/invalid session id/i);
    expect(() => wm.paths("..")).toThrow(/invalid session id/i);
    expect(() => wm.paths("a/b")).toThrow(/invalid session id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/workspace-manager.test.ts`
Expected: FAIL — cannot resolve `../src/workspace/workspace-manager.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/workspace/workspace-manager.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, extname } from "node:path";

export interface WorkspacePaths {
  root: string;
  uploads: string;
  artifacts: string;
  composition: string;
  output: string;
  logs: string;
}

export interface WorkspaceOptions {
  maxUploadBytes?: number;
  allowedExtensions?: string[];
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

const DEFAULT_ALLOWED = [
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
  ".mp4", ".mov", ".webm",
  ".mp3", ".wav", ".m4a",
  ".pdf", ".txt", ".md",
];

export class WorkspaceManager {
  private maxUploadBytes: number;
  private allowedExtensions: Set<string>;

  constructor(private baseDir: string, opts: WorkspaceOptions = {}) {
    this.maxUploadBytes = opts.maxUploadBytes ?? 50 * 1024 * 1024;
    this.allowedExtensions = new Set(
      (opts.allowedExtensions ?? DEFAULT_ALLOWED).map((e) => e.toLowerCase()),
    );
  }

  paths(sessionId: string): WorkspacePaths {
    // Validate at this chokepoint: init/saveUpload (and ArtifactStore) all route
    // through paths(), so this prevents a malicious sessionId like "../../etc"
    // from escaping baseDir.
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
    }
    const root = join(this.baseDir, sessionId);
    return {
      root,
      uploads: join(root, "uploads"),
      artifacts: join(root, "artifacts"),
      composition: join(root, "composition"),
      output: join(root, "output"),
      logs: join(root, "logs"),
    };
  }

  async init(sessionId: string): Promise<WorkspacePaths> {
    const p = this.paths(sessionId);
    for (const dir of [p.uploads, p.artifacts, p.composition, p.output, p.logs]) {
      await mkdir(dir, { recursive: true });
    }
    return p;
  }

  async saveUpload(sessionId: string, filename: string, data: Buffer): Promise<string> {
    if (data.byteLength > this.maxUploadBytes) {
      throw new Error(`Upload exceeds max size of ${this.maxUploadBytes} bytes`);
    }
    const safeName = basename(filename);
    const ext = extname(safeName).toLowerCase();
    if (!this.allowedExtensions.has(ext)) {
      throw new Error(`Disallowed file extension: ${ext || "(none)"}`);
    }
    const dest = join(this.paths(sessionId).uploads, safeName);
    await writeFile(dest, data);
    return dest;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/workspace-manager.test.ts`
Expected: PASS (8 tests — includes the sessionId path-traversal rejection cases).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/workspace/workspace-manager.ts apps/server/test/workspace-manager.test.ts
git commit -m "feat(server): add WorkspaceManager with validated uploads"
```

---

## Task 11: ArtifactStore (versioned, immutable, lineage, event broadcast)

**Files:**
- Create: `apps/server/src/artifacts/artifact-store.ts`
- Test: `apps/server/test/artifact-store.test.ts`

ArtifactStore is the only writer of artifact files. `put` validates `data` against `ARTIFACT_DATA_SCHEMAS[kind]`, assigns the next version, writes `artifacts/<kind>.v<n>.json`, appends a descriptor to `artifacts/index.json`, and emits `artifact.created`. `markStale` flips the descriptor's `stale` flag in the index (artifact files stay immutable) and emits `artifact.stale`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/test/artifact-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "@ultracreator/shared";
import { WorkspaceManager } from "../src/workspace/workspace-manager.js";
import { EventBus } from "../src/events/event-bus.js";
import { ArtifactStore } from "../src/artifacts/artifact-store.js";

let root: string;
const briefData = {
  product: { name: "Acme", tagline: "Do more", description: "A tool", category: "saas" },
  audience: "devs",
  keyMessages: ["fast"],
  brandHints: { colors: ["#000"] },
  sourceAssets: { images: [], videos: [], copy: [] },
  constraints: { durationSec: 30, aspectRatio: "16:9", withVoiceover: false },
};

function makeStore() {
  const wm = new WorkspaceManager(root);
  const bus = new EventBus();
  const store = new ArtifactStore(wm, bus);
  return { wm, bus, store };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uc-as-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ArtifactStore", () => {
  it("put validates data and writes a v1 envelope", async () => {
    const { wm, store } = makeStore();
    await wm.init("s1");
    const env = await store.put("s1", "brief", briefData);
    expect(env.version).toBe(1);
    expect(env.kind).toBe("brief");
    const file = join(wm.paths("s1").artifacts, "brief.v1.json");
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    expect(onDisk.data.product.name).toBe("Acme");
  });

  it("put rejects data that fails the kind schema", async () => {
    const { wm, store } = makeStore();
    await wm.init("s1");
    await expect(store.put("s1", "brief", { product: {} })).rejects.toThrow();
  });

  it("put assigns incrementing versions per kind", async () => {
    const { wm, store } = makeStore();
    await wm.init("s1");
    const v1 = await store.put("s1", "brief", briefData);
    const v2 = await store.put("s1", "brief", briefData);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
  });

  it("get returns the latest version by default", async () => {
    const { wm, store } = makeStore();
    await wm.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "brief", { ...briefData, audience: "marketers" });
    const latest = await store.get("s1", "brief");
    expect(latest!.version).toBe(2);
    expect((latest!.data as typeof briefData).audience).toBe("marketers");
  });

  it("get returns a specific version when asked", async () => {
    const { wm, store } = makeStore();
    await wm.init("s1");
    await store.put("s1", "brief", briefData);
    await store.put("s1", "brief", { ...briefData, audience: "marketers" });
    const v1 = await store.get("s1", "brief", 1);
    expect((v1!.data as typeof briefData).audience).toBe("devs");
  });

  it("records lineage via derivedFrom", async () => {
    const { wm, store } = makeStore();
    await wm.init("s1");
    await store.put("s1", "brief", briefData);
    const design = await store.put(
      "s1",
      "design",
      {
        mood: "energetic",
        palette: [{ name: "p", hex: "#000" }],
        typography: { heading: "A", body: "B" },
        motionStyle: "fades",
        keyVisuals: [],
        sampleFrames: [],
      },
      { derivedFrom: [{ kind: "brief", version: 1 }] },
    );
    expect(design.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
    const list = await store.list("s1");
    const designDesc = list.find((d) => d.kind === "design")!;
    expect(designDesc.derivedFrom).toEqual([{ kind: "brief", version: 1 }]);
  });

  it("emits artifact.created on put", async () => {
    const { wm, bus, store } = makeStore();
    await wm.init("s1");
    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    await store.put("s1", "brief", briefData);
    expect(events).toContainEqual({ type: "artifact.created", kind: "brief", version: 1 });
  });

  it("markStale flips the index flag and emits artifact.stale, leaving the file immutable", async () => {
    const { wm, bus, store } = makeStore();
    await wm.init("s1");
    await store.put("s1", "brief", briefData);
    const events: ServerEvent[] = [];
    bus.subscribe("s1", (e) => events.push(e));
    await store.markStale("s1", "brief", 1);
    const list = await store.list("s1");
    expect(list.find((d) => d.kind === "brief")!.stale).toBe(true);
    expect(events).toContainEqual({ type: "artifact.stale", kind: "brief", version: 1 });
    // file content unchanged (no `stale` inside the envelope)
    const onDisk = JSON.parse(
      await readFile(join(wm.paths("s1").artifacts, "brief.v1.json"), "utf8"),
    );
    expect(onDisk.stale).toBeUndefined();
  });

  it("list returns descriptors for all written artifacts", async () => {
    const { wm, store } = makeStore();
    await wm.init("s1");
    await store.put("s1", "brief", briefData);
    const list = await store.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "brief", version: 1, stale: false, path: "artifacts/brief.v1.json" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/test/artifact-store.test.ts`
Expected: FAIL — cannot resolve `../src/artifacts/artifact-store.js`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/server/src/artifacts/artifact-store.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_DATA_SCHEMAS,
  ArtifactDescriptorSchema,
  type ArtifactDescriptor,
  type ArtifactEnvelope,
  type ArtifactKind,
  type LineageRef,
} from "@ultracreator/shared";
import type { EventBus } from "../events/event-bus.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

export interface PutOptions {
  derivedFrom?: LineageRef[];
}

export class ArtifactStore {
  constructor(
    private workspaces: WorkspaceManager,
    private events: EventBus,
  ) {}

  private indexPath(sessionId: string): string {
    return join(this.workspaces.paths(sessionId).artifacts, "index.json");
  }

  private async readIndex(sessionId: string): Promise<ArtifactDescriptor[]> {
    const path = this.indexPath(sessionId);
    if (!existsSync(path)) return [];
    const raw = JSON.parse(await readFile(path, "utf8"));
    return ArtifactDescriptorSchema.array().parse(raw);
  }

  private async writeIndex(sessionId: string, index: ArtifactDescriptor[]): Promise<void> {
    await writeFile(this.indexPath(sessionId), JSON.stringify(index, null, 2));
  }

  async put<T>(
    sessionId: string,
    kind: ArtifactKind,
    data: T,
    opts: PutOptions = {},
  ): Promise<ArtifactEnvelope<T>> {
    const schema = ARTIFACT_DATA_SCHEMAS[kind];
    const validated = schema.parse(data) as T;

    const index = await this.readIndex(sessionId);
    const version = index.filter((d) => d.kind === kind).length + 1;
    const createdAt = new Date().toISOString();
    const derivedFrom = opts.derivedFrom ?? null;
    const relPath = `artifacts/${kind}.v${version}.json`;

    const envelope: ArtifactEnvelope<T> = { kind, version, createdAt, derivedFrom, data: validated };
    const absPath = join(this.workspaces.paths(sessionId).artifacts, `${kind}.v${version}.json`);
    await writeFile(absPath, JSON.stringify(envelope, null, 2));

    index.push({ kind, version, createdAt, derivedFrom, stale: false, path: relPath });
    await this.writeIndex(sessionId, index);

    this.events.emit(sessionId, { type: "artifact.created", kind, version });
    return envelope;
  }

  async get<T = unknown>(
    sessionId: string,
    kind: ArtifactKind,
    version?: number,
  ): Promise<ArtifactEnvelope<T> | null> {
    const index = await this.readIndex(sessionId);
    const candidates = index.filter((d) => d.kind === kind);
    if (candidates.length === 0) return null;
    const target = version
      ? candidates.find((d) => d.version === version)
      : candidates.reduce((a, b) => (b.version > a.version ? b : a));
    if (!target) return null;
    const abs = join(this.workspaces.paths(sessionId).root, target.path);
    return JSON.parse(await readFile(abs, "utf8")) as ArtifactEnvelope<T>;
  }

  async list(sessionId: string): Promise<ArtifactDescriptor[]> {
    return this.readIndex(sessionId);
  }

  async markStale(sessionId: string, kind: ArtifactKind, version: number): Promise<void> {
    const index = await this.readIndex(sessionId);
    const desc = index.find((d) => d.kind === kind && d.version === version);
    if (!desc) throw new Error(`No ${kind} v${version} to mark stale`);
    desc.stale = true;
    await this.writeIndex(sessionId, index);
    this.events.emit(sessionId, { type: "artifact.stale", kind, version });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run apps/server/test/artifact-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/artifacts/artifact-store.ts apps/server/test/artifact-store.test.ts
git commit -m "feat(server): add versioned ArtifactStore with lineage and events"
```

---

## Task 12: Full suite + typecheck green

**Files:** none (verification task)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all suites (schemas 26, event-bus 4, workspace-manager 6, artifact-store 9, import-shared 1).

- [ ] **Step 2: Run the typechecker**

Run: `pnpm typecheck`
Expected: exits 0 with no errors across both `@ultracreator/shared` and `@ultracreator/server`. (This runs `tsc --noEmit` per workspace package using each package's own tsconfig.)

- [ ] **Step 3: Final commit if anything changed**

```bash
git add -A
git commit -m "chore: foundation engine green (tests + typecheck)" || echo "nothing to commit"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** This plan implements the spec's §7 artifact schemas (brief/design/script + narration/composition/mp4 pointers), the versioned/immutable/lineage rules and stale-in-index design from §7, the SSE event union from §4/§8, and the deterministic `ArtifactStore`/`EventBus`/`WorkspaceManager` primitives from §5. The Intent enum (§6) is defined here so the orchestrator (Plan 2) can consume it.
- **Out of scope here (later plans):** orchestrator/state machine (Plan 2), Pi-agent phases + providers (Plan 3), render worker (Plan 4), Fastify/SSE endpoints (Plan 5), frontend (Plan 6). `events.jsonl`/transcript persistence is wired when the orchestrator exists (Plan 2/5).
- **Determinism:** every test here is deterministic and uses temp dirs; no network, no LLM, no token spend.
