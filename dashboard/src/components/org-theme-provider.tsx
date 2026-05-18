'use client';

/**
 * OrgThemeProvider — applies the active org's theme overrides for the current
 * session AND persists them to localStorage so #16's pre-hydration script can
 * re-apply them before paint on the next page load.
 *
 * Responsibilities:
 *   1. Watch `currentOrg` (from the surrounding org context).
 *   2. For the active org's theme block (looked up in `orgThemes` seeded
 *      server-side), compute the CSS override and update / clear the
 *      `<style id="ctx-org-theme-override">` element in `<head>`.
 *   3. Mirror the same CSS to `localStorage.ctx-org-theme-css` so the next
 *      reload's pre-hydration script applies it before paint.
 *   4. Expose the active brand name via React context so the sidebar (and
 *      other surfaces) can render the per-org name instead of "cortextOS".
 *
 * Today: per-org colors + per-org brand name. Per-org logo path is read
 * but not yet wired into a sidebar component — that's a #11 follow-up.
 */

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { generateThemeCss } from '@/lib/branding-css';
import { DEFAULT_BRAND_NAME } from '@/lib/branding';
import type { OrgTheme } from '@/lib/data/organization';

const STYLE_ID = 'ctx-org-theme-override';
const STORAGE_KEY = 'ctx-org-theme-css';

interface OrgBranding {
  /** Display name for the active org. Falls back to cortextOS default. */
  brandName: string;
  /** Optional logo path for the active org. */
  logoPath?: string;
  /** Whether the active org has any theme block at all. */
  hasOverride: boolean;
}

const DEFAULT_BRANDING: OrgBranding = {
  brandName: DEFAULT_BRAND_NAME,
  hasOverride: false,
};

const OrgBrandingContext = createContext<OrgBranding>(DEFAULT_BRANDING);

export function useOrgBranding(): OrgBranding {
  return useContext(OrgBrandingContext);
}

interface OrgThemeProviderProps {
  /** Active org name from the org-selector hook (`use-org`). */
  currentOrg: string;
  /** Server-seeded map: org name → theme block. Omits orgs without a theme. */
  orgThemes: Record<string, OrgTheme>;
  children: ReactNode;
}

export function OrgThemeProvider({ currentOrg, orgThemes, children }: OrgThemeProviderProps) {
  const activeTheme = currentOrg === 'all' ? undefined : orgThemes[currentOrg];

  // Apply / clear the CSS override side-effect. Runs whenever the active
  // org's theme changes (covers both org switches and theme edits picked
  // up by Next.js' server-side reload).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const css = generateThemeCss(activeTheme);
    if (!css) {
      // No override → clear both the style tag and the persisted CSS so
      // the next reload doesn't re-apply a stale override.
      const existing = document.getElementById(STYLE_ID);
      if (existing) existing.remove();
      try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return;
    }
    let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css;
    try { window.localStorage.setItem(STORAGE_KEY, css); } catch { /* ignore */ }
  }, [activeTheme]);

  const branding = useMemo<OrgBranding>(() => {
    if (!activeTheme) return DEFAULT_BRANDING;
    return {
      brandName: activeTheme.brandName?.trim() || DEFAULT_BRAND_NAME,
      logoPath: activeTheme.logoPath,
      hasOverride: true,
    };
  }, [activeTheme]);

  return (
    <OrgBrandingContext.Provider value={branding}>
      {children}
    </OrgBrandingContext.Provider>
  );
}
