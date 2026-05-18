/**
 * Per-org / per-env brand CSS generator.
 *
 * Takes an `OrgTheme` (or env-var equivalent) and returns the small `<style>`
 * block that overrides the brand-color tokens in `globals.css:170-250`.
 * The output is injected into `<head>` as `<style id="ctx-org-theme-override">`
 * by `<OrgThemeProvider>` for the in-session change, and persisted to
 * `localStorage.ctx-org-theme-css` so #16's pre-hydration script can apply
 * the same overrides on the next page load before paint.
 *
 * Scope: we only override the 4 brand-color tokens (primary, accent, and
 * their sidebar-primary / sidebar-accent mirrors). Structural tokens
 * (background, foreground, border, etc.) stay as cortextOS defaults so
 * per-org branding never breaks contrast / readability silently.
 */

import { getBrandColors, type BrandColors } from '@/lib/branding';
import type { OrgTheme } from '@/lib/data/organization';

/** Compose a `BrandColors` from a per-org theme (no env-var input here —
 *  env-var defaults are #10's concern). Falls back to cortextOS defaults
 *  for any unset field. */
export function resolveOrgBrandColors(theme?: OrgTheme): BrandColors {
  return getBrandColors({
    orgContext: theme
      ? {
          theme: {
            primaryColorLight: theme.primaryColorLight,
            primaryColorDark: theme.primaryColorDark,
            accentColorLight: theme.accentColorLight,
            accentColorDark: theme.accentColorDark,
          },
        }
      : undefined,
  });
}

/**
 * Produce the CSS string injected into `<style id="ctx-org-theme-override">`.
 * Returns an empty string when the theme is effectively the cortextOS
 * default (so we never inject a no-op `<style>` block). The caller is
 * responsible for clearing any existing override when this returns ''.
 */
export function generateThemeCss(theme?: OrgTheme): string {
  // No color overrides → no CSS. (Brand name / logo are handled separately
  // by `<OrgThemeProvider>` via React context, not via CSS.)
  if (
    !theme ||
    (!theme.primaryColorLight &&
      !theme.primaryColorDark &&
      !theme.accentColorLight &&
      !theme.accentColorDark)
  ) {
    return '';
  }
  const colors = resolveOrgBrandColors(theme);
  // Match the variables declared in dashboard/src/app/globals.css:170-250.
  // Sidebar-primary / sidebar-accent are kept in lock-step with primary /
  // accent so the sidebar accent never diverges from the brand color.
  return [
    ':root {',
    `  --primary: ${colors.primaryLight};`,
    `  --accent: ${colors.accentLight};`,
    `  --sidebar-primary: ${colors.primaryLight};`,
    `  --sidebar-accent: ${colors.accentLight};`,
    `  --ring: ${colors.primaryLight};`,
    `  --sidebar-ring: ${colors.primaryLight};`,
    '}',
    '.dark {',
    `  --primary: ${colors.primaryDark};`,
    `  --accent: ${colors.accentDark};`,
    `  --sidebar-primary: ${colors.primaryDark};`,
    `  --sidebar-accent: ${colors.accentDark};`,
    `  --ring: ${colors.primaryDark};`,
    `  --sidebar-ring: ${colors.primaryDark};`,
    '}',
  ].join('\n');
}
