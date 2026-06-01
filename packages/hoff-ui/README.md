# @mycortex/hoff-ui — the BrandPack

The Hoff's house brand as a **modular theme pack**. This is the Law 3a overlay:
it adds files, edits no cortextOS base code, and is consumed identically by the
Scribe, the dashboard, and (later) the workflow visualiser.

## The contract

`branding.json` is the single source of truth (the **BrandPack** manifest). It
declares *semantic slots only* — never component styling:

| Field | Meaning |
|---|---|
| `id`, `name` | brand identity |
| `defaultTheme` | `narrative` (reading) or `dashboard` (ops) |
| `tokens` | the neutral spine CSS (type, spacing, radius, motion) |
| `themes.<t>.css` | the signal-palette override for theme `t` |
| `themes.<t>.palette` | the same palette as data (for charts, JS, non-CSS surfaces) |
| `chartPalette` | ordered colours for graphs |
| `typography`, `assets` | fonts, logo/favicon |

## Generated artifacts (what consumers ingest)

Run the generator (`node generate.mjs` / `npm run build`) to emit `dist/`:

- `brand.css` — one stylesheet: spine + **both** themes. Switch brand by setting
  `data-theme="narrative|dashboard"` on `<html>`. No clash — both themes redefine
  the same `--accent`/`--secondary`/… tokens under their own selector.
- `brand.mjs` — `{ brand, themes, chartPalette, defaultTheme }` for JS consumers.
- `brand.manifest.json` — the resolved manifest.
- `chart-palette.json` — ordered chart colours.

**Consumers import these artifacts, never the raw `tokens/` files.** That keeps
every surface decoupled from the brand internals.

## Relationship to the base theming framework

The base cortextOS dashboard uses `next-themes` (class-based `.dark`) + shadcn
tokens. The framework PR (separate, base-touching, documented) provides the
`resolveBrandPack()` seam + maps these `brand.css` variables onto the shadcn
CSS-var contract and layers on top of next-themes' light/dark. This pack stays
brand-only and base-agnostic, so it ships as the default brand if upstream takes
it — or stays a fork overlay if it doesn't.

Tokens are vendored from `~/Personas/thehoff/code/hoff-ui` (no CDN, per its rule).
