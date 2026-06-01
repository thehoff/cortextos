# @mycortex/hoff-ui - Hoff theme package

The Hoff house brand as a cortextOS theme package. This is the first overlay
built on the shared theming framework in [docs/architecture/theming-framework.md](../../docs/architecture/theming-framework.md).

The package stays brand-only: it adds a theme package and does not modify the
framework or any base files.

## What ships

- `theme/theme.json` is the source of truth.
- `theme/theme.css` is generated from that manifest.
- `generate.mjs` validates the manifest and regenerates the CSS.
- The old `tokens/` and `dist/` outputs are gone because nothing in the repo
  consumes them anymore.

## Generate and validate

```bash
# from the repo root
node scripts/build-theme.mjs packages/hoff-ui/theme --validate
# from packages/hoff-ui/
node generate.mjs
```

`node generate.mjs` validates `theme/theme.json` against the shared framework
generator and rewrites `theme/theme.css`. Regeneration is deterministic; rerun
it and you should get no diff.

## Select it

At runtime, point cortextOS at the package path:

```bash
export CORTEXTOS_THEME=packages/hoff-ui/theme
```

Or in `~/.cortextos/<instance>/config/branding.json` (or
`CTX_ROOT/config/branding.json`):

```json
{
  "theme": "packages/hoff-ui/theme"
}
```

The framework resolver accepts either a theme package directory or a direct
`theme.json` path.

## Scribe alignment

Scribe copies the generated Hoff CSS directly from `packages/hoff-ui/theme/theme.css`
and publishes it under `assets/themes/hoff.css`, so there is no second
hand-edited Hoff theme file to drift.

## Relation to the framework

If you want to create another brand package in myCortex, start with the
framework doc above. It defines the contract, resolution order, and bootstrap
path for every theme package.
