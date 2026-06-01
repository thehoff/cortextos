# Scribe — markdown → branded HTML (manual tier)

Deterministic Node tool (Law 5, no AI) that renders our markdown into the
hoff-ui brand: a served static site with two roots —

- **`/documentation/`** — narrative theme (reading): specs, reports, notes.
- **`/dashboard/`** — dashboard theme (ops): stat cards + an inline SVG chart.

Runs standalone (no cortextOS daemon). Structured to later wrap as a cortextOS
bus worker without a rewrite (Law 3a modular).

## Usage

```bash
npm install                                   # markdown-it, markdown-it-anchor, highlight.js
node cli.mjs build <srcDir> --out ./public    # render a markdown tree
node cli.mjs serve ./public --port 4321       # serve it
```

A `dashboard.json` in the source dir (or `examples/dashboard.json`) drives the
dashboard page. Schema: `{ title, subtitle, chartTitle, stats:[{label,value,
delta,tone}], series:[{label,value}] }` (`tone` ∈ good|warn|bad).

## How it stays branded

Brand comes only from the **`@mycortex/hoff-ui` BrandPack** — Scribe imports the
generated `brand.css` (never the raw tokens). Switching theme = setting
`data-theme="narrative|dashboard"` on `<html>`. To restyle, edit the BrandPack,
not Scribe.

## Pipeline

```
markdown ──▶ render.mjs (markdown-it + highlight.js, mermaid fences)
                 │
                 ▼
            page.mjs (themed shell + sidebar nav)  ◀── hoff-ui brand.css
                 │
   build.mjs ────┼──▶ /documentation/*.html   (narrative)
                 └──▶ /dashboard/index.html    (dashboard, via dashboard.mjs)
            serve.mjs (zero-dep static server)
```

## Notes

- Mermaid: ` ```mermaid ` fences render client-side from a vendored
  `assets/mermaid.min.js` (fetched once at build; degrades to preformatted text
  offline). No CDN at runtime.
- Fonts use the hoff-ui stacks with system fallbacks; webfont vendoring is a
  follow-up.
- `public/` is build output and git-ignored.
