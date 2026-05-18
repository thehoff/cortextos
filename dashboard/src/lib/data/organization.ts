// cortextOS Dashboard - Organization metadata reader
// Reads context.json and brand-voice.md from the framework root org directory.

import fs from 'fs';
import { getOrgContextPath, getOrgBrandVoicePath, getOrgs } from '@/lib/config';
import { isValidBrandColor } from '@/lib/branding';

/**
 * Per-org theme overrides — operator-supplied palette + brand name + logo
 * path. All fields optional; missing/invalid values fall back to cortextOS
 * defaults via the branding resolution contract (see `dashboard/src/lib/branding.ts`).
 *
 * Light and dark color variants must both be provided when overriding a
 * color; we deliberately don't auto-derive (see #15 — cortextOS's own
 * defaults are asymmetric in hue + chroma).
 */
export interface OrgTheme {
  brandName?: string;
  primaryColorLight?: string;
  primaryColorDark?: string;
  accentColorLight?: string;
  accentColorDark?: string;
  logoPath?: string;
}

export interface OrgContext {
  name: string;
  description: string;
  industry: string;
  icp: string;
  value_prop: string;
  /** Optional per-org branding override. Absent for legacy / unbranded orgs. */
  theme?: OrgTheme;
}

const DEFAULT_CONTEXT: OrgContext = {
  name: '',
  description: '',
  industry: '',
  icp: '',
  value_prop: '',
};

/**
 * Validate + sanitize a theme block from raw context.json input. Invalid
 * color values are silently dropped so a typo never bricks the dashboard;
 * the fallback path uses the cortextOS default for that token.
 */
function parseTheme(raw: unknown): OrgTheme | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const out: OrgTheme = {};
  if (typeof t.brandName === 'string' && t.brandName.trim().length > 0) {
    out.brandName = t.brandName.trim();
  }
  if (typeof t.logoPath === 'string' && t.logoPath.trim().length > 0) {
    out.logoPath = t.logoPath.trim();
  }
  // Color fields: only kept if they pass OKLCh / hex validation.
  for (const k of ['primaryColorLight', 'primaryColorDark', 'accentColorLight', 'accentColorDark'] as const) {
    const v = t[k];
    if (typeof v === 'string' && isValidBrandColor(v)) {
      out[k] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read context.json for an org. Returns defaults if file missing.
 */
export function getOrganizationContext(org: string): OrgContext {
  const filePath = getOrgContextPath(org);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_CONTEXT };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      name: data.name ?? '',
      description: data.description ?? '',
      industry: data.industry ?? '',
      icp: data.icp ?? '',
      value_prop: data.value_prop ?? '',
      theme: parseTheme(data.theme),
    };
  } catch {
    return { ...DEFAULT_CONTEXT };
  }
}

/**
 * Read theme blocks for every org in one pass. Returns a flat map keyed by
 * org name; orgs without a theme block are omitted. Used by the dashboard
 * layout to seed `<OrgThemeProvider>` so org switching is flash-free without
 * an extra HTTP round-trip per switch.
 */
export function getAllOrgThemes(): Record<string, OrgTheme> {
  const out: Record<string, OrgTheme> = {};
  for (const org of getOrgs()) {
    const ctx = getOrganizationContext(org);
    if (ctx.theme) out[org] = ctx.theme;
  }
  return out;
}

/**
 * Read brand-voice.md for an org. Returns empty string if missing.
 */
export function getBrandVoice(org: string): string {
  const filePath = getOrgBrandVoicePath(org);
  if (!fs.existsSync(filePath)) {
    return '';
  }
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}
