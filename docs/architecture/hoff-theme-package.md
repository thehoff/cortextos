# Hoff Theme Package

`packages/hoff-ui/theme/` is the first myCortex brand package built on the
shared theming framework.

## Regeneration

```bash
# from the repo root
node scripts/build-theme.mjs packages/hoff-ui/theme --validate
# from packages/hoff-ui/
node generate.mjs
```

`theme/theme.json` is the source of truth and `theme/theme.css` is the
generated output.

## Creating Your Own Brand Package

Start with [the theming framework doc](./theming-framework.md). It explains the
contract, package format, resolution precedence, and dashboard bootstrap path
you should reuse for any new brand package in myCortex.
