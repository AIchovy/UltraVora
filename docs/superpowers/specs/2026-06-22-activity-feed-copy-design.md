# Activity-feed copy: friendly rewrite

**Date:** 2026-06-22
**Status:** approved (design)

## Problem

The session activity feed (the live timeline of the agent's work) shows
internal, developer-facing copy to end users. Concretely, in a real session:

- Tool rows read **`Read Skill File`** followed by the **raw file contents**
  of the skill (`--- name: hyperframes description: Create video compositions…`).
  The label is an auto-title-cased internal tool name, and the "summary" is the
  first 80 chars of whatever the tool returned — for a read tool that is the
  file's markdown frontmatter.
- The `render-done` row prints the **full absolute path** of the output file:
  `/path/to/UltraVora/apps/server/workspaces/<id>/output/<uuid>.mp4`.
  The user has no use for the path.
- The expandable phase group lists redundant technical steps generated per tool
  call — `Running tool: read_skill_file`, `Tool read_skill_file completed.`,
  `Turn complete.` — which both duplicate the tool feed and leak raw tool names.

The user wants a full, consistent, friendly rewrite of this copy (English).

## Current data flow (verified)

- Server `runAgentToCompletion` / `runHarnessToCompletion`
  ([apps/server/src/phases/pi-handler-helpers.ts](../../../apps/server/src/phases/pi-handler-helpers.ts))
  emit `agent.tool_start` / `agent.tool_end` events carrying a server-computed
  `toolLabel` (from `toolLabel()`), plus `argsSummary` (from `summarizeArgs`)
  and `resultSummary` (from `summarizeResult`). They ALSO emit `phase.progress`
  strings per tool and per turn.
- The web reducer turns these into `tool-start` / `tool-end` / `progress`
  chat items; `group-conversation.ts` folds them into a flat tool feed plus an
  expandable per-phase group (steps = the `phase.progress` messages).
- `chat-stream.tsx` renders each tool row as `[icon] [toolLabel] [summary] [status]`.
  A tool block carries BOTH `argsSummary` and `resultSummary`; the row shows
  `argsSummary` while running and `resultSummary` once done.
- `render.done` carries `mp4Path` (absolute); the `render-done` row renders it raw.

## Design

### 1. Friendly tool labels — client-side map

Add `TOOL_LABELS: Record<string, string>` next to `TOOL_ICONS` in
`chat-stream.tsx`. `ToolCallRow` uses `TOOL_LABELS[tool.toolName] ?? tool.toolLabel`
(server title-case remains the fallback for any tool not in the map).

| tool name | label |
|---|---|
| `read_skill_file` | Reading guidelines |
| `read_upload` | Reading your upload |
| `web_fetch` | Browsing the web |
| `download_asset` | Downloading media |
| `generate_image` | Generating an image |
| `generate_music` | Composing music |
| `write_brief` | Writing the brief |
| `write_design` | Designing the look |
| `write_script` | Writing the script |
| `write_composition_file` | Building the video |
| `add_registry_item` | Adding a component |

Rationale for client-side: presentation already lives here (icons); copy tweaks
need no server redeploy.

### 2. Friendly tool summaries — server-side

Redesign `summarizeArgs` / `summarizeResult` in `pi-handler-helpers.ts` so the
summary is ONE friendly "subject", never file contents, never an absolute path:

- **path-valued fields** (`path`, `filePath`, `file`, `src`) → friendly
  basename. Special case: a basename of `SKILL.md` / `SKILL.markdown` uses the
  parent directory name instead (`…/skills/hyperframes/SKILL.md` → `hyperframes`).
- **URL fields** (`url`) → hostname only (`https://example.com/a/b` → `example.com`).
- **prompt-like fields** (`prompt`, `query`, `description`, `text`) → trimmed,
  newline-collapsed snippet (truncate ~50 chars + `…`). KEPT — tells the user
  what is being generated.
- Otherwise pick the first meaningful string value (`name`/`id`/first string),
  prettified if it looks like a path.

`summarizeArgs(toolName, args)` returns this single subject string (no
`key: value` noise). `summarizeResult(toolName, result, isError)`:
- on error → a short reason snippet (first ~60 chars of the error text), else `Failed`.
- on success → `undefined` (no content dump).

Because the subject lives in `argsSummary`, the client must keep showing it after
the tool finishes. Update `ToolCallRow`: when done/error,
`summary = tool.resultSummary ?? tool.argsSummary` (prefer a result-side
reason/produced-name when present, else keep the subject). Running state still
shows `argsSummary`. The existing "result starts with `<`" HTML guard is preserved.

Net effect: `read_skill_file` reads `📖 Reading guidelines · hyperframes ✓`.

### 3. Remove redundant phase-progress noise — server-side

In both `runAgentToCompletion` and `runHarnessToCompletion`, drop the three
`phase.progress` pushes that duplicate the tool feed:
- `Running tool: <name>` (on `tool_execution_start`)
- `Tool <name> completed.` / `Tool <name> failed.` (on `tool_execution_end`)
- `Turn complete.` (on `turn_end`)

The tool rows already convey running/done/error; gates, errors and artifacts are
unaffected. The `runAgentForArtifact` nudge progress string is de-jargoned (drop
the raw tool name from the user-visible text; the re-prompt sent to the model is
unchanged).

### 4. mp4 path — client-side basename

In the `render-done` case of `chat-stream.tsx`, render `basename(block.mp4Path)`
instead of the full path. (User chose to keep the filename for traceability; only
this chat row changes — `mp4Path` data and the preview/playback path are untouched.)

## Out of scope

- Artifact chips (`brief v1` etc.) — already friendly enough.
- `notice` / `intent.unhandled` messages — server-authored domain text.
- `STATUS_TEXT` / `PHASE_LABEL` — already friendly.

## Testing

- Unit-test the server helpers (`toolLabel` fallback, `summarizeArgs` path/url/
  prompt/skill-file cases, `summarizeResult` success→undefined / error→snippet).
- Unit-test (or component-test) `ToolCallRow`'s label lookup + summary fallback,
  and the `render-done` basename.
- Update/remove existing tests that assert the old `phase.progress` strings.
- `pnpm lint` + `pnpm test` in both `apps/server` and `apps/web`.
