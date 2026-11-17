# UltraCreator — Pi-Agent Promo Video Generator (Design)

**Date:** 2026-05-29
**Status:** Approved design, pending implementation plan
**Scope:** v1 = single-user demo that proves the end-to-end flow

## 1. Summary

UltraCreator is a web app where a user drops in a product (a URL and/or
uploaded assets), picks a duration and aspect ratio, and a Pi agent
(pi-mono) drives skills — primarily HeyGen's **hyperframes** and
**gsap** — to produce a promo video.

Generation is **not** one-shot. The agent walks the user through staged,
human-confirmed checkpoints:

```
RESEARCH → DESIGN → SCRIPT → [VOICEOVER] → RENDER
              ⏸ approve   ⏸ approve
```

The UI is ChatGPT/Claude-style: a left sidebar of sessions, a main panel
showing the agent's working process plus an artifact viewer (brief card,
Claude-Design-style design board, script timeline, video preview). At
each gate the user can approve, refine in place, or revise back.

v1 deliberately excludes templates, auth, project history, and billing.
It targets a single-user demo that walks the full pipeline. The
architecture is built so those are additive, not rewrites.

## 2. Goals & Non-Goals

### Goals
- End-to-end: product input → confirmed design → confirmed script →
  rendered MP4.
- Staged flow with real human-approval gates and free-form refinement
  within each stage.
- Agent generates the video from scratch (no templates in v1).
- Users can interject at any time (refine, change requirements, go back)
  without the system losing state.
- Extensibility is a first-class constraint: new phases, new skills, new
  external providers (TTS, music, stock) are config/registration changes,
  not flow rewrites.

### Non-Goals (v1)
- No templates (planned v2; design board phase is where they'd plug in).
- No auth / accounts / multi-user.
- No project history persistence beyond the on-disk workspace.
- No usage quota / billing.
- No multi-variant fan-out (e.g. simultaneous 16:9 + 9:16); architecture
  leaves room at the RENDER phase.

## 3. Tech Stack

- **Frontend:** Next.js (App Router, frontend-only) + React, shadcn/ui,
  Motion (motion/framer-motion), react-icons, TanStack React Query.
- **Backend:** independent Fastify (Node) process. pi-mono SDK for the
  agent loop. SSE for the event stream. A forked child process for
  rendering.
- **Rendering:** hyperframes CLI + headless Chrome + ffmpeg.
- **Skills (driven by the agent):** hyperframes, hyperframes-cli,
  hyperframes-media, website-to-hyperframes, gsap, plus writing-clearly
  for script copy.
- **TTS:** Gemini TTS (`gemini-2.5-*-preview-tts`) via a provider
  abstraction.

Frontend and backend are split because agent loops and video rendering
are long-running tasks that should not block SSR or a serverless runtime.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                 Frontend (Next.js + React)                    │
│  Sidebar (sessions) │ Main Panel                              │
│                      │  ChatStream (agent thinking/tool calls)│
│                      │  ArtifactViewer:                       │
│                      │    BriefCard / DesignBoard /           │
│                      │    ScriptTimeline / VideoPreview       │
│                      │  Composer (text + files + duration +   │
│                      │            aspect ratio + voiceover)   │
└──────────────────────────────────────────────────────────────┘
        │  HTTP (REST)              │  SSE (event stream)
        ▼                           ▼
┌──────────────────────────────────────────────────────────────┐
│            Backend (Fastify, single Node process)             │
│  Routes: /sessions /messages /upload /artifacts/* /stream/:sid│
│                                                                │
│  SessionOrchestrator                                           │
│    IntentRouter → PhaseRegistry → PhaseHandler (Pi agent loop) │
│    ArtifactStore (versioned)      PiAgentFactory (pi-mono SDK) │
│    EventBus → SSE                 ProviderRegistry (TTS, …)    │
│                                                                │
│  RenderWorker (child_process fork, isolated)                  │
│    hyperframes CLI · headless Chrome · ffmpeg                 │
└──────────────────────────────────────────────────────────────┘

workspaces/<session-id>/
  ├─ uploads/
  ├─ artifacts/  brief.v1.json  design.v1.json  script.v1.json  index.json
  ├─ composition/   (hyperframes project: index.html + media/ + narration.mp3)
  ├─ output/<id>.mp4
  └─ logs/  <phase>.v<n>.jsonl   events.jsonl
```

### Invariants
- Backend is a single process plus one forked render worker. No Redis,
  BullMQ, or Docker in v1.
- Each session owns a workspace directory; zipping it yields a fully
  reproducible state.
- The frontend holds only UI state; all business state changes happen on
  the backend and are pushed via SSE.
- The agent never writes the filesystem directly — all writes go through
  ArtifactStore, which guarantees versioning, schema validation, and
  event broadcast.

## 5. Components

### Backend

| Component | Responsibility | Key interface |
|---|---|---|
| `SessionOrchestrator` | Owns the session state machine; receives user messages; schedules phases | `handleMessage(sid, msg)`, `getState(sid)` |
| `IntentRouter` | Classify a user message into `approve / refine / update-brief / revise-back / branch / abort / ask` | `classify(msg, state) → Intent` |
| `PhaseRegistry` | Config-driven phase table; each phase declares skills/outputs/gates/model/enabled | `getPhase(id)`, `next(id)` |
| `PhaseHandler` (interface) | One stage's agent loop. Implemented by research/design/script/voiceover/render | `run(ctx) → AsyncIterable<Event>` |
| `PiAgentFactory` | Build a pi-mono agent with the phase's system prompt + skill subset + workspace path | `create(phaseConfig, workspace) → PiAgent` |
| `ArtifactStore` | Versioned, immutable read/write of brief/design/script/composition; zod-validates; broadcasts on write | `put(sid, kind, data) → version`, `get`, `list` |
| `EventBus` | Per-session event bus that the SSE endpoint subscribes to | `emit(sid, event)`, `subscribe(sid)` |
| `RenderWorker` | Forked child process running hyperframes CLI → MP4, reporting progress | IPC: `{composition} → progress/done/error` |
| `WorkspaceManager` | Create/clean `workspaces/<sid>/`; validate and persist uploads | `init(sid)`, `saveUpload`, `paths(sid)` |
| `ProviderRegistry` | Register/resolve external-capability providers by type; central key mgmt & fallback | `register(type, p)`, `get(type, id?)` |
| `GeminiTTSProvider` | v1 `TTSProvider` implementation | `synthesize()` |

### Frontend

| Component | Responsibility |
|---|---|
| `<Composer>` | Text input + file upload + duration chips (15/30/45/60s) + aspect ratio chips (16:9 / 9:16 / 1:1) + voiceover toggle |
| `<ChatStream>` | Render agent thinking / tool calls / skill invocations, SSE-driven |
| `<ArtifactViewer>` | Switch on artifact kind: `<BriefCard>` / `<DesignBoard>` / `<ScriptTimeline>` / `<VideoPreview>` |
| `<DesignBoard>` | Claude-Design-style canvas: palette swatches, typography, keyframe thumbnails, style keywords, approve/refine buttons |
| `<ApprovalGate>` | Stage-confirm UI (approve → advance; refine → stay) |
| `<Sidebar>` | Session list + new (v1: in-memory + local disk) |
| `useSessionStream` | React Query + SSE hook; reduces events into UI state |

## 6. Phases & Extensibility

The orchestrator is a **config-driven router**, not a hard-coded switch.

```ts
const phases: PhaseConfig[] = [
  { id: 'research',  skills: ['web-fetch', 'scrape'],            outputs: ['brief'] },
  { id: 'design',    skills: ['hyperframes-design', 'palette'],  outputs: ['design'], gates: ['user-approve'] },
  { id: 'script',    skills: ['writing-clearly'],                outputs: ['script'], gates: ['user-approve'] },
  { id: 'voiceover', skills: [], provider: 'tts', outputs: ['narration'], enabled: 'brief.constraints.withVoiceover' },
  { id: 'render',    skills: ['hyperframes-cli'],                outputs: ['mp4'] },
]
```

> Note: the `skills` values above are **illustrative capability labels**.
> The exact mapping to installed skills (`hyperframes`,
> `website-to-hyperframes`, `hyperframes-cli`, `hyperframes-media`,
> `gsap`, `writing-clearly`, etc.) is resolved during planning.

Extension points (each leaves the main flow untouched):
- **Add a phase** (music, captions QA): insert a row.
- **Change a phase's skills** (e.g. logo extraction in DESIGN): edit `skills`.
- **Add templates:** insert a `template-pick` phase before DESIGN, or add
  a `template-library` skill to DESIGN.
- **Multi-variant output:** fan out sub-agents at RENDER.
- **New input types (PDF/Notion):** add skills to RESEARCH; downstream
  phases unchanged.
- **Per-phase model choice:** add a `model` field to `PhaseConfig`.

### Provider abstraction

All external AI capabilities go through one interface + registry, so
adding a vendor is a registration, not a flow change.

```ts
interface TTSProvider {
  id: string
  synthesize(input: {
    text: string
    voice?: string
    language?: string
    speakers?: SpeakerSpec[]      // multi-speaker dialog (Gemini supports)
  }): Promise<{ audioPath: string; durationMs: number; wordTimings?: WordTiming[] }>
}

class GeminiTTSProvider implements TTSProvider { id = 'gemini' /* gemini-2.5-*-preview-tts */ }
providerRegistry.register('tts', new GeminiTTSProvider())
```

| Provider type | v1 implementation | Later (no main-flow change) |
|---|---|---|
| `LLMProvider` (per-phase model) | pi-mono default (Claude) | mix Gemini/GPT per phase |
| `TTSProvider` (voiceover) | **Gemini TTS** | ElevenLabs, OpenAI, hyperframes built-in |
| `MusicProvider` | v1: static library track | Suno, Mubert |
| `StockProvider` (B-roll) | v1: user uploads | Pexels, generative video |
| `ImageGenProvider` | v1: scraped/uploaded | Imagen, Flux |

Bonus: Gemini TTS word-level timings feed hyperframes captions, so
narration and subtitles auto-align — a benefit of making voiceover its
own phase rather than folding it into render.

## 7. Data Flow & Artifact Schemas

Artifacts are the **contract** between phases. Adding fields is fine;
changing them is an architectural change. All artifacts are versioned and
immutable.

```
Composer submit: { text, files[], durationSec, aspectRatio, withVoiceover }
  → POST /api/messages
  → Orchestrator → IntentRouter.classify → "new-project"
  → RESEARCH  (web-fetch + scrape)      → brief.v1.json
  → DESIGN    (hyperframes-design)      → design.v1.json   ⏸ approve
  → SCRIPT    (writing-clearly)         → script.v1.json   ⏸ approve
  → VOICEOVER (GeminiTTSProvider)       → narration.mp3 + wordTimings
  → RENDER    (hyperframes-cli)         → composition/ → output/<id>.mp4
Each step: EventBus → SSE → matching artifact view.
```

```ts
// brief.json — RESEARCH output ("what we understand the product to be")
{
  product: { name, tagline, description, category },
  audience: string,
  keyMessages: string[],                 // 1-3 selling points
  brandHints: { colors: string[], logoUrl?, fonts?: string[] },
  sourceAssets: { images: string[], videos: string[], copy: string[] },
  constraints: { durationSec: number, aspectRatio: '16:9'|'9:16'|'1:1', withVoiceover: boolean }
}

// design.json — DESIGN output (rendered by the Design Board)
{
  mood: string,                          // "energetic / minimal / premium…"
  palette: { name, hex }[],
  typography: { heading, body },
  motionStyle: string,                   // "kinetic captions / smooth fades…"
  keyVisuals: { description, refAssetId? }[],
  sampleFrames: { caption, layoutHint, thumbnailUrl? }[]
}

// script.json — SCRIPT output (rendered by the Script Timeline)
{
  totalSec: number,
  scenes: {
    id, startSec, durationSec,
    visual: string,
    onScreenText?: string,
    narration?: string,                  // → TTS
    assetRefs?: string[]
  }[]
}

// composition/ — RENDER stage; real hyperframes project produced by hyperframes-cli
//   index.html + media/ + narration.mp3  →  output/<id>.mp4
```

### Stale propagation (pairs with "interject anytime")
- Refine design while in SCRIPT → `revise-back` to DESIGN → script.v1 is
  marked `stale` but kept; after re-approval, SCRIPT edits incrementally
  rather than from scratch.
- Change `durationSec` in brief → all downstream artifacts marked stale;
  UI prompts "duration changed, re-run the script?"
- `index.json` records each version's `derivedFrom`; revert and branch
  both follow this lineage chain.

## 8. Error Handling & Edge Cases

Principle: failures always land on an artifact version boundary; no
half-written state.

| Failure | Scenario | Handling |
|---|---|---|
| Phase agent failure | Agent runs off the rails / tool error / off-schema output | Don't persist the artifact (validate before write); state machine stays in the phase; emit `phase.error`; UI offers retry / adjust. Retry re-runs only this phase (upstream artifacts intact). |
| Schema validation failure | Agent output missing fields / wrong types | ArtifactStore validates with zod; on failure, feed the validation error back to the same agent for self-correction (max N); after N, degrade to `phase.error`. |
| Render failure | ffmpeg/chrome crash, bad composition HTML, timeout | RenderWorker child process isolates it; capture stderr → `render.error` with log summary. Crash does not affect the main process; main checks exit code; one-click re-render. Hard timeout (~5min) prevents hangs. |
| External provider failure | Gemini TTS rate-limit/timeout, URL fetch 403 | ProviderRegistry centralizes try/catch + backoff. TTS fail → offer retry or render without voiceover; fetch fail → RESEARCH agent asks the user for an upload or another link. |

Concurrency & interjection:

| Edge case | Handling |
|---|---|
| User sends a message while the agent is running | One logical lock per session. New message queued; `refine/approve` waits for the current turn; explicit `abort` cancels the current run (pi-mono abort signal). |
| Same session in multiple browser tabs | SSE broadcasts; all tabs get the same events; writes only on backend → consistent. |
| User changes requirements mid-render | Allowed: mark current render `superseded` (don't hard-kill; let it finish and keep it); start a new render from the new artifact. |
| Oversized/illegal upload | WorkspaceManager validates type + size limit; reject with an event. |
| Workspace disk cleanup | v1: not auto-deleted on exit; `DELETE /api/sessions/:id` for manual cleanup. LRU/scheduled cleanup is v2. |

### Observability
- One structured log per phase run: `{ sid, phase, version, durationMs, tokenUsage, status }`.
- Full agent transcript at `workspaces/<sid>/logs/<phase>.v<n>.jsonl` for replay.
- SSE events double as the frontend progress feed and are persisted to `events.jsonl`.

## 9. Testing Strategy

Split the system into a deterministic skeleton (strict TDD) and a
non-deterministic creative layer (contracts + evals).

```
   E2E (few, happy path): URL → 4 phases → MP4
   Integration (medium): orchestrator + real ArtifactStore + mock PiAgent
   Unit (many, fast, deterministic): state machine / router / schema / provider / IPC
```

**Unit (deterministic, TDD, tests first):**

| Under test | How (no real LLM) |
|---|---|
| `SessionOrchestrator` state machine | Feed Intent sequences; assert transitions & stale propagation. PhaseHandlers are fakes returning fixed artifacts. |
| `IntentRouter` | Contract test: fixed (message → expected class) sample set; run a real LLM but assert output is in-enum + key-sample accuracy threshold (e.g. ≥95%). CI uses recorded fixtures for replay. |
| `ArtifactStore` | Versioning / immutability / lineage / zod-fail paths against a temp dir. |
| `ProviderRegistry` / `GeminiTTSProvider` | Mock HTTP; test retry/backoff/fallback. Real API calls tagged `@external`, run manually. |
| `RenderWorker` IPC | Mock hyperframes; test progress/done/error/timeout/crash exit codes. |

**Integration:** Orchestrator with real ArtifactStore + EventBus, but
`PiAgentFactory` injected with a mock agent (emits pre-recorded valid
artifacts) → verify full phase flow, SSE event sequence, stale rules,
with zero token spend and full determinism. Plus one real RenderWorker
integration test: feed a minimal composition, actually render a few
frames of MP4, assert the file exists + ffprobe duration is correct.

**E2E (few, slow/non-deterministic allowed):** one happy path, real URL →
real agent → real render → MP4. Don't assert content quality; assert each
phase produced a valid artifact, a playable MP4 exists, and the SSE event
stream is complete. Tagged `@slow`; local/nightly, not a PR gate.

**Creative quality (non-deterministic, not auto-asserted):** an `eval/`
script over 5-10 fixed product samples runs the full flow; humans or a
judge model rate design/script quality. This is a prompt-tuning feedback
tool, not a CI gate.

**Frontend:** components tested against mock SSE event streams (React
Testing Library); `useSessionStream` reducer unit-tested as a pure
function; Design Board / Script Timeline snapshot-tested with fixed
artifacts.

**Key principle:** PR gates run only deterministic, no-token,
seconds-level tests. Token-burning tests (real IntentRouter calls, E2E,
eval) are isolated to manual/nightly runs.

## 10. Open Questions / Deferred to v2

- Templates (plug into a `template-pick` phase or DESIGN skill).
- Auth, project history persistence, usage quotas/billing.
- Multi-variant fan-out (16:9 + 9:16 + 1:1 in one run).
- Music and stock-footage providers (interfaces reserved).
- Workspace LRU/scheduled cleanup.
