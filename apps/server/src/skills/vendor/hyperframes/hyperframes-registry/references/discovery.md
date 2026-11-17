# Registry Discovery

## Browsing the catalog

The catalog of available items is listed in your system prompt inside `<registry_blocks>` and `<registry_components>`. Install items with the `add_registry_item` tool, which returns wiring instructions.

Each entry has `name` and `type` (`hyperframes:example`, `hyperframes:block`, or `hyperframes:component`).

## Reading an item's manifest

Each item has a `registry-item.json` with full metadata:

```
<base>/<type-dir>/<name>/registry-item.json
```

Where `<type-dir>` is `examples`, `blocks`, or `components`.

## Item manifest fields

| Field                  | Type     | Required | Description                                    |
| ---------------------- | -------- | -------- | ---------------------------------------------- |
| `name`                 | string   | yes      | Kebab-case identifier                          |
| `type`                 | string   | yes      | `hyperframes:block` or `hyperframes:component` |
| `title`                | string   | yes      | Human-readable title                           |
| `description`          | string   | yes      | One-line description                           |
| `tags`                 | string[] | no       | Filter tags (e.g., `["data", "chart"]`)        |
| `dimensions`           | object   | blocks   | `{ width, height }` — blocks only              |
| `duration`             | number   | blocks   | Duration in seconds — blocks only              |
| `files`                | array    | yes      | Files to install (`path`, `target`, `type`)    |
| `registryDependencies` | string[] | no       | Other registry items this depends on           |

## Available items

The tables below are a sample — the authoritative, up-to-date catalog is the `<registry_blocks>` / `<registry_components>` listing in your system prompt.

### Blocks

| Name         | Description                                     | Tags                            |
| ------------ | ----------------------------------------------- | ------------------------------- |
| `data-chart` | Animated bar + line chart with staggered reveal | data, chart, statistics         |
| `flowchart`  | Decision tree with SVG connectors and cursor    | diagram, flowchart, interactive |
| `logo-outro` | Cinematic logo reveal with tagline              | branding, outro, logo           |

### Components

| Name                 | Description                             | Tags                             |
| -------------------- | --------------------------------------- | -------------------------------- |
| `grain-overlay`      | Animated film grain texture overlay     | texture, grain, overlay, film    |
| `shimmer-sweep`      | CSS gradient light sweep for AI accents | text, shimmer, highlight, effect |
| `grid-pixelate-wipe` | Grid dissolve transition between scenes | transition, wipe, grid, pixelate |
