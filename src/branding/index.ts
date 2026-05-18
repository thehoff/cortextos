/**
 * Branding resolution contract.
 *
 * Single source of truth for brand name, palette and logo across CLI surfaces.
 * Dashboard mirrors this module at `dashboard/src/lib/branding.ts` — the two
 * MUST stay in sync (see the header comment over there).
 *
 * Precedence (highest → lowest):
 *   1. Per-org override   (`BrandOrgContext.theme.*` — wired by #9)
 *   2. Env-var override   (`CORTEXTOS_BRAND_*` — wired by #10)
 *   3. Built-in defaults  (this file)
 *
 * #9 and #10 don't ship in this PR — they feed the same helpers. This module
 * delivers the API + defaults + env-var fallback so other PRs can plug in
 * without inventing competing entry points.
 *
 * Default palette mirrors `dashboard/src/app/globals.css:170-250` exactly so
 * the helper and the unhooked dashboard return identical colors today.
 */

export interface BrandColors {
  primaryLight: string;
  primaryDark: string;
  accentLight: string;
  accentDark: string;
}

export const DEFAULT_BRAND_NAME = 'cortextOS';

export const DEFAULT_BRAND_COLORS: BrandColors = {
  // From dashboard/src/app/globals.css :root { --primary } / --accent
  primaryLight: 'oklch(0.618 0.13 75)',
  accentLight: 'oklch(0.762 0.125 82)',
  // From dashboard/src/app/globals.css .dark { --primary } / --accent
  // Light + dark are deliberately asymmetric (different hue + chroma, not
  // a mechanical lightness flip) — #9 must require operators to supply both
  // variants explicitly. No auto-derivation.
  primaryDark: 'oklch(0.762 0.125 82)',
  accentDark: 'oklch(0.618 0.13 75)',
};

export interface BrandOrgContext {
  theme?: {
    brandName?: string;
    primaryColorLight?: string;
    primaryColorDark?: string;
    accentColorLight?: string;
    accentColorDark?: string;
    logoPath?: string;
  };
}

export interface BrandResolutionInput {
  orgContext?: BrandOrgContext;
  env?: NodeJS.ProcessEnv;
}

function envOf(input?: BrandResolutionInput): NodeJS.ProcessEnv {
  return input?.env ?? process.env;
}

export function getBrandName(input?: BrandResolutionInput): string {
  const orgName = input?.orgContext?.theme?.brandName?.trim();
  if (orgName) return orgName;
  const envName = envOf(input).CORTEXTOS_BRAND_NAME?.trim();
  if (envName) return envName;
  return DEFAULT_BRAND_NAME;
}

export function getBrandColors(input?: BrandResolutionInput): BrandColors {
  const orgTheme = input?.orgContext?.theme;
  const env = envOf(input);
  return {
    primaryLight: pickColor(orgTheme?.primaryColorLight, env.CORTEXTOS_BRAND_PRIMARY_LIGHT, DEFAULT_BRAND_COLORS.primaryLight),
    primaryDark: pickColor(orgTheme?.primaryColorDark, env.CORTEXTOS_BRAND_PRIMARY_DARK, DEFAULT_BRAND_COLORS.primaryDark),
    accentLight: pickColor(orgTheme?.accentColorLight, env.CORTEXTOS_BRAND_ACCENT_LIGHT, DEFAULT_BRAND_COLORS.accentLight),
    accentDark: pickColor(orgTheme?.accentColorDark, env.CORTEXTOS_BRAND_ACCENT_DARK, DEFAULT_BRAND_COLORS.accentDark),
  };
}

export function getBrandLogoPath(input?: BrandResolutionInput): string | null {
  const orgLogo = input?.orgContext?.theme?.logoPath?.trim();
  if (orgLogo) return orgLogo;
  const envLogo = envOf(input).CORTEXTOS_BRAND_LOGO_PATH?.trim();
  if (envLogo) return envLogo;
  return null;
}

/**
 * Pick the first valid color from (org → env → default). Invalid org/env
 * values fall through silently — strict validation lives in the loaders
 * (#9 validates `orgs/{org}/context.json`, #10 validates `branding.json`),
 * not here.
 */
function pickColor(orgValue: string | undefined, envValue: string | undefined, fallback: string): string {
  const org = orgValue?.trim();
  if (org && isValidBrandColor(org)) return org;
  const env = envValue?.trim();
  if (env && isValidBrandColor(env)) return env;
  return fallback;
}

/**
 * Permissive color validation — accept OKLCh and hex. Used by `pickColor`
 * for silent fallback. Loaders (#9/#10) should call these directly to emit
 * a friendly error at config-load when the operator supplies an invalid
 * value.
 */
export function isValidBrandColor(value: string): boolean {
  return validateOkLch(value) || validateHex(value);
}

// oklch(L C H) where L ∈ [0,1], C ≥ 0, H ∈ [0, 360). Whitespace tolerant.
const OKLCH_RE = /^oklch\(\s*([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s*\)$/i;

export function validateOkLch(value: string): boolean {
  const match = OKLCH_RE.exec(value.trim());
  if (!match) return false;
  const L = parseFloat(match[1]);
  const C = parseFloat(match[2]);
  const H = parseFloat(match[3]);
  return Number.isFinite(L) && L >= 0 && L <= 1
    && Number.isFinite(C) && C >= 0
    && Number.isFinite(H) && H >= 0 && H < 360;
}

// #rgb, #rrggbb, #rrggbbaa
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function validateHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}
