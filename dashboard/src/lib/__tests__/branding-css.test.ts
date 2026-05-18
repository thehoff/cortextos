import { describe, it, expect } from 'vitest';
import { generateThemeCss, resolveOrgBrandColors } from '../branding-css';
import { DEFAULT_BRAND_COLORS } from '../branding';

describe('generateThemeCss', () => {
  it('returns empty string when theme has no color overrides', () => {
    expect(generateThemeCss(undefined)).toBe('');
    expect(generateThemeCss({})).toBe('');
    expect(generateThemeCss({ brandName: 'Foo' })).toBe('');
    expect(generateThemeCss({ logoPath: '/x.svg' })).toBe('');
  });

  it('emits :root + .dark blocks when any color override is set', () => {
    const css = generateThemeCss({
      primaryColorLight: 'oklch(0.7 0.2 200)',
      primaryColorDark:  'oklch(0.6 0.2 200)',
    });
    expect(css).toContain(':root {');
    expect(css).toContain('.dark {');
    expect(css).toContain('--primary: oklch(0.7 0.2 200);');
    expect(css).toContain('--primary: oklch(0.6 0.2 200);');
  });

  it('overrides primary AND sidebar-primary AND ring in lock-step', () => {
    const css = generateThemeCss({ primaryColorLight: '#abcdef', primaryColorDark: '#123456' });
    // Should appear 3× per mode (primary, sidebar-primary, ring)
    expect((css.match(/#abcdef/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((css.match(/#123456/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('falls through to defaults for unspecified tokens', () => {
    const css = generateThemeCss({ primaryColorLight: '#aabbcc', primaryColorDark: '#001122' });
    // Accent wasn't overridden → defaults appear
    expect(css).toContain(DEFAULT_BRAND_COLORS.accentLight);
    expect(css).toContain(DEFAULT_BRAND_COLORS.accentDark);
  });
});

describe('resolveOrgBrandColors', () => {
  it('returns default colors when no theme passed', () => {
    expect(resolveOrgBrandColors()).toEqual(DEFAULT_BRAND_COLORS);
    expect(resolveOrgBrandColors({})).toEqual(DEFAULT_BRAND_COLORS);
  });

  it('per-org override beats default on a per-token basis', () => {
    const colors = resolveOrgBrandColors({ primaryColorLight: 'oklch(0.5 0.1 90)' });
    expect(colors.primaryLight).toBe('oklch(0.5 0.1 90)');
    expect(colors.primaryDark).toBe(DEFAULT_BRAND_COLORS.primaryDark);
    expect(colors.accentLight).toBe(DEFAULT_BRAND_COLORS.accentLight);
  });
});
