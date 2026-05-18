/**
 * Dashboard-side branding resolution contract.
 *
 * MUST STAY IN SYNC with `src/branding/index.ts` (CLI side).
 * If you change one, change the other. The dashboard can't cleanly import
 * across the package boundary, so this file mirrors the CLI helper instead.
 *
 * Precedence (highest → lowest):
 *   1. Per-org override          (`BrandOrgContext.theme.*` — wired by #9)
 *   2. Instance white-label      (`BrandInstanceConfig` from `~/.cortextos/{instance}/config/branding.json` — #10)
 *   3. Env-var override          (`CORTEXTOS_BRAND_*` — also #10)
 *   4. Built-in defaults         (this file)
 *
 * Default palette mirrors `dashboard/src/app/globals.css:170-250` exactly.
 *
 * Server-side use: `process.env.CORTEXTOS_BRAND_*` reads work natively.
 * Client-side use: pass values via RSC props (avoid `NEXT_PUBLIC_*` baking
 * so per-org runtime overrides can still beat env-var defaults).
 */

export interface BrandColors {
  primaryLight: string;
  primaryDark: string;
  accentLight: string;
  accentDark: string;
}

export const DEFAULT_BRAND_NAME = 'cortextOS';

export const DEFAULT_BRAND_COLORS: BrandColors = {
  primaryLight: 'oklch(0.618 0.13 75)',
  accentLight: 'oklch(0.762 0.125 82)',
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

/**
 * Instance-level white-label config. Loaded from
 * `~/.cortextos/{instance}/config/branding.json` by
 * `dashboard/src/lib/data/branding-config.ts:readBrandingConfig`.
 * Higher precedence than env-vars; lower than per-org.
 */
export interface BrandInstanceConfig {
  brandName?: string;
  primaryColorLight?: string;
  primaryColorDark?: string;
  accentColorLight?: string;
  accentColorDark?: string;
  logoPath?: string;
}

export interface BrandResolutionInput {
  orgContext?: BrandOrgContext;
  instanceConfig?: BrandInstanceConfig;
  env?: NodeJS.ProcessEnv;
}

function envOf(input?: BrandResolutionInput): NodeJS.ProcessEnv {
  return input?.env ?? process.env;
}

export function getBrandName(input?: BrandResolutionInput): string {
  const orgName = input?.orgContext?.theme?.brandName?.trim();
  if (orgName) return orgName;
  const instanceName = input?.instanceConfig?.brandName?.trim();
  if (instanceName) return instanceName;
  const envName = envOf(input).CORTEXTOS_BRAND_NAME?.trim();
  if (envName) return envName;
  return DEFAULT_BRAND_NAME;
}

export function getBrandColors(input?: BrandResolutionInput): BrandColors {
  const orgTheme = input?.orgContext?.theme;
  const inst = input?.instanceConfig;
  const env = envOf(input);
  return {
    primaryLight: pickColor(orgTheme?.primaryColorLight, inst?.primaryColorLight, env.CORTEXTOS_BRAND_PRIMARY_LIGHT, DEFAULT_BRAND_COLORS.primaryLight),
    primaryDark: pickColor(orgTheme?.primaryColorDark, inst?.primaryColorDark, env.CORTEXTOS_BRAND_PRIMARY_DARK, DEFAULT_BRAND_COLORS.primaryDark),
    accentLight: pickColor(orgTheme?.accentColorLight, inst?.accentColorLight, env.CORTEXTOS_BRAND_ACCENT_LIGHT, DEFAULT_BRAND_COLORS.accentLight),
    accentDark: pickColor(orgTheme?.accentColorDark, inst?.accentColorDark, env.CORTEXTOS_BRAND_ACCENT_DARK, DEFAULT_BRAND_COLORS.accentDark),
  };
}

export function getBrandLogoPath(input?: BrandResolutionInput): string | null {
  const orgLogo = input?.orgContext?.theme?.logoPath?.trim();
  if (orgLogo) return orgLogo;
  const instanceLogo = input?.instanceConfig?.logoPath?.trim();
  if (instanceLogo) return instanceLogo;
  const envLogo = envOf(input).CORTEXTOS_BRAND_LOGO_PATH?.trim();
  if (envLogo) return envLogo;
  return null;
}

function pickColor(
  orgValue: string | undefined,
  instanceValue: string | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  const org = orgValue?.trim();
  if (org && isValidBrandColor(org)) return org;
  const inst = instanceValue?.trim();
  if (inst && isValidBrandColor(inst)) return inst;
  const env = envValue?.trim();
  if (env && isValidBrandColor(env)) return env;
  return fallback;
}

export function isValidBrandColor(value: string): boolean {
  return validateOkLch(value) || validateHex(value);
}

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

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function validateHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}
