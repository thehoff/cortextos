# Theming Framework

This document defines the cortextOS theming contract, the theme package format, and the dashboard bootstrap path.

## Contract

The shadcn CSS variable set is the theming contract. A theme package is a manifest plus generated CSS that defines the contract for both light and dark mode.

The current contract is:

```css
--font-sans
--font-mono
--font-heading
--background
--foreground
--card
--card-foreground
--popover
--popover-foreground
--primary
--primary-foreground
--secondary
--secondary-foreground
--muted
--muted-foreground
--accent
--accent-foreground
--destructive
--destructive-foreground
--success
--success-foreground
--warning
--warning-foreground
--border
--input
--ring
--chart-1
--chart-2
--chart-3
--chart-4
--chart-5
--radius
--sidebar
--sidebar-foreground
--sidebar-primary
--sidebar-primary-foreground
--sidebar-accent
--sidebar-accent-foreground
--sidebar-border
--sidebar-ring
```

The dashboard still ships the default values in `dashboard/src/app/globals.css` as a fallback. When no theme is configured, the UI looks exactly the same as before.

## Package Format

Each theme lives under `themes/<id>/`.

Required files:

- `themes/<id>/theme.json`
- `themes/<id>/theme.css` generated from the manifest

Recommended manifest shape:

```json
{
  "id": "cortex",
  "name": "Cortex",
  "description": "Default cortextOS theme matching the current gold dashboard look.",
  "fonts": {
    "sans": "var(--font-sora), system-ui, sans-serif",
    "mono": "var(--font-jetbrains), \"JetBrains Mono\", monospace",
    "heading": "var(--font-sora), system-ui, sans-serif"
  },
  "chartPalette": [
    "oklch(0.762 0.125 82)",
    "oklch(0.546 0.2 262)",
    "oklch(0.507 0.22 293)",
    "oklch(0.543 0.22 340)",
    "oklch(0.555 0.17 160)"
  ],
  "light": {
    "--background": "oklch(1 0 0)"
  },
  "dark": {
    "--background": "oklch(0.145 0 0)"
  }
}
```

Notes:

- `id`, `name`, and `description` are required.
- `light` and `dark` must declare the contract values.
- `fonts` is optional. If present, the generator emits the font vars once in `:root`.
- `--radius` is treated the same way: it is emitted in `:root` and omitted from `.dark`.
- `chartPalette` is optional. If present, it can fill missing `--chart-1..5` values.
- Token values may not contain `;`, `{`, `}`, or newlines — the validator rejects them.
  This keeps a theme value from breaking out of its CSS declaration.

## Resolution

Theme selection precedence:

1. Explicit config from `branding.json`
2. `CORTEXTOS_THEME=<id-or-path>`
3. Built-in default theme package

The config file lives under the instance config directory:

- `~/.cortextos/<instance>/config/branding.json`
- or the equivalent path under `CTX_ROOT`

The resolver treats the theme value as either:

- a theme id such as `cortex`
- a direct path to a theme package directory
- a direct path to `theme.json`

Invalid or missing values fall back silently to the default theme. The code never crashes because a theme is missing.

## Bootstrap

The dashboard uses `next-themes` for the `.dark` class and does not replace it.

The boot sequence is:

1. `dashboard/src/app/layout.tsx` resolves the active theme package on the server.
2. The resolved CSS is serialized into a small JSON bootstrap blob.
3. `dashboard/src/lib/pre-hydration-script.ts` runs before hydration and inserts a `<style id="ctx-theme-package-css">` element into `document.head`.
4. `next-themes` still owns the light/dark class on `<html>`.

This avoids a flash of the default look because the theme CSS is injected before React hydrates.

## Generator

The generator script is:

```bash
node scripts/build-theme.mjs themes/cortex
```

It reads `themes/cortex/theme.json`, validates the manifest, and writes `themes/cortex/theme.css`.

Validation mode:

```bash
node scripts/build-theme.mjs themes/cortex --validate
```

That mode checks the manifest without rewriting the CSS file.

The generated CSS is deterministic. Running the generator twice against the same manifest must produce byte-identical output.

## Creating A New Theme Package

1. Copy `themes/cortex/` to a new directory under `themes/`.
2. Rename the manifest id, name, and description.
3. Edit the `light` and `dark` values to match the new palette.
4. If needed, adjust the font names and chart palette.
5. Run:

   ```bash
   node scripts/build-theme.mjs themes/<new-theme>
   ```

6. Set the theme in the instance config:

   ```json
   {
     "theme": "<new-theme>"
   }
   ```

   Save that as `~/.cortextos/<instance>/config/branding.json` or the matching `CTX_ROOT/config/branding.json`.

7. Or set the environment variable:

   ```bash
   export CORTEXTOS_THEME=<new-theme>
   ```

8. Restart the dashboard. The new package will be injected before hydration.
