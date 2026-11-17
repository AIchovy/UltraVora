---
name: hyperframes-registry
description: Install and wire registry blocks and components into HyperFrames compositions. Use when installing a block or component with the add_registry_item tool, wiring an installed item into index.html, or working with hyperframes.json. Covers installing items, install locations, block sub-composition wiring, component snippet merging, and registry discovery.
---

# HyperFrames Registry

The registry provides reusable blocks and components installable with the **`add_registry_item` tool**.

- **Blocks** — standalone sub-compositions (own dimensions, duration, timeline). Included via `data-composition-src` in a host composition.
- **Components** — effect snippets (no own dimensions). Pasted directly into a host composition's HTML.

## When to use this skill

- You want to install a registry block or component, or work with `hyperframes.json`
- Output from `add_registry_item` appears in the session (file paths, wiring snippet)
- You need to wire an installed item into an existing composition
- You want to discover what's available in the registry

## Quick reference

The catalog of available items is listed in your system prompt (`<registry_blocks>` / `<registry_components>`). Install an item by calling the `add_registry_item` tool with its name (e.g. `data-chart`, `grain-overlay`, `shimmer-sweep`).

The tool writes the item's files into the project and returns wiring instructions plus a snippet for your host composition. The snippet is a starting point — you'll need to add `data-composition-id` (must match the block's internal composition ID), `data-start`, and `data-track-index` attributes when wiring blocks.

Note: `add_registry_item` only works for blocks and components listed in the system prompt catalog.

## Install locations

Blocks install to `compositions/<name>.html` by default.
Components install to `compositions/components/<name>.html` by default.

These paths are configurable in `hyperframes.json`:

```json
{
  "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
  "paths": {
    "blocks": "compositions",
    "components": "compositions/components",
    "assets": "assets"
  }
}
```

See [install-locations.md](./references/install-locations.md) for full details.

## Wiring blocks

Blocks are standalone compositions — include them via `data-composition-src` in your host `index.html`:

```html
<div
  data-composition-id="data-chart"
  data-composition-src="compositions/data-chart.html"
  data-start="2"
  data-duration="15"
  data-track-index="1"
  data-width="1920"
  data-height="1080"
></div>
```

Key attributes:

- `data-composition-src` — path to the block HTML file
- `data-composition-id` — must match the block's internal ID
- `data-start` — when the block appears in the host timeline (seconds)
- `data-duration` — how long the block plays
- `data-width` / `data-height` — block canvas dimensions
- `data-track-index` — track (lane) assignment for the clip; same-track clips cannot overlap in time, and audio belongs on its own track. It does **not** affect visual stacking — control front/back with CSS `z-index` (or DOM order)

See [wiring-blocks.md](./references/wiring-blocks.md) for full details.

## Wiring components

Components are snippets — paste their HTML into your composition's markup, their CSS into your style block, and their JS into your script (if any):

1. Read the installed file (e.g., `compositions/components/grain-overlay.html`)
2. Copy the HTML elements into your composition's `<div data-composition-id="...">`
3. Copy the `<style>` block into your composition's styles
4. Copy any `<script>` content into your composition's script (before your timeline code)
5. If the component exposes GSAP timeline integration (see the comment block in the snippet), add those calls to your timeline

See [wiring-components.md](./references/wiring-components.md) for full details.

## Discovery

The full catalog of available items is listed in your system prompt inside `<registry_blocks>` and `<registry_components>` — browse there. Each entry gives the item's name and description (plus dimensions/duration for blocks). Install with the `add_registry_item` tool, which returns wiring instructions.

See [discovery.md](./references/discovery.md) for the item manifest fields.
