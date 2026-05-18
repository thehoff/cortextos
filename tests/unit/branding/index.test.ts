import { describe, it, expect } from 'vitest';
import {
  getBrandName,
  getBrandColors,
  getBrandLogoPath,
  validateOkLch,
  validateHex,
  isValidBrandColor,
  DEFAULT_BRAND_NAME,
  DEFAULT_BRAND_COLORS,
} from '../../../src/branding/index.js';

describe('getBrandName', () => {
  it('returns default with no input', () => {
    expect(getBrandName({ env: {} })).toBe(DEFAULT_BRAND_NAME);
  });

  it('uses env var when set', () => {
    expect(getBrandName({ env: { CORTEXTOS_BRAND_NAME: 'AcmeOS' } })).toBe('AcmeOS');
  });

  it('per-org override beats env var', () => {
    expect(getBrandName({
      env: { CORTEXTOS_BRAND_NAME: 'EnvName' },
      orgContext: { theme: { brandName: 'OrgName' } },
    })).toBe('OrgName');
  });

  it('ignores blank-only org override', () => {
    expect(getBrandName({
      env: { CORTEXTOS_BRAND_NAME: 'EnvName' },
      orgContext: { theme: { brandName: '   ' } },
    })).toBe('EnvName');
  });
});

describe('getBrandColors', () => {
  it('returns defaults that match globals.css', () => {
    const colors = getBrandColors({ env: {} });
    expect(colors).toEqual(DEFAULT_BRAND_COLORS);
  });

  it('env var overrides individual color', () => {
    const colors = getBrandColors({
      env: { CORTEXTOS_BRAND_PRIMARY_LIGHT: 'oklch(0.7 0.2 200)' },
    });
    expect(colors.primaryLight).toBe('oklch(0.7 0.2 200)');
    expect(colors.primaryDark).toBe(DEFAULT_BRAND_COLORS.primaryDark);
  });

  it('per-org override beats env var per token', () => {
    const colors = getBrandColors({
      env: { CORTEXTOS_BRAND_PRIMARY_LIGHT: 'oklch(0.7 0.2 200)' },
      orgContext: { theme: { primaryColorLight: '#abcdef' } },
    });
    expect(colors.primaryLight).toBe('#abcdef');
  });

  it('falls back through to default when org + env values are invalid', () => {
    const colors = getBrandColors({
      env: { CORTEXTOS_BRAND_PRIMARY_LIGHT: 'not-a-color' },
      orgContext: { theme: { primaryColorLight: 'also-bad' } },
    });
    expect(colors.primaryLight).toBe(DEFAULT_BRAND_COLORS.primaryLight);
  });

  it('mixes org override (one token) with env override (another) cleanly', () => {
    const colors = getBrandColors({
      env: { CORTEXTOS_BRAND_ACCENT_DARK: '#112233' },
      orgContext: { theme: { primaryColorLight: 'oklch(0.5 0.1 90)' } },
    });
    expect(colors.primaryLight).toBe('oklch(0.5 0.1 90)');
    expect(colors.accentDark).toBe('#112233');
    expect(colors.primaryDark).toBe(DEFAULT_BRAND_COLORS.primaryDark);
    expect(colors.accentLight).toBe(DEFAULT_BRAND_COLORS.accentLight);
  });
});

describe('getBrandLogoPath', () => {
  it('returns null when nothing set', () => {
    expect(getBrandLogoPath({ env: {} })).toBeNull();
  });

  it('returns env value', () => {
    expect(getBrandLogoPath({ env: { CORTEXTOS_BRAND_LOGO_PATH: '/brand/logo.svg' } })).toBe('/brand/logo.svg');
  });

  it('per-org override beats env', () => {
    expect(getBrandLogoPath({
      env: { CORTEXTOS_BRAND_LOGO_PATH: '/env/logo.svg' },
      orgContext: { theme: { logoPath: '/org/logo.svg' } },
    })).toBe('/org/logo.svg');
  });
});

describe('validateOkLch', () => {
  it('accepts canonical default palette values', () => {
    expect(validateOkLch('oklch(0.618 0.13 75)')).toBe(true);
    expect(validateOkLch('oklch(0.762 0.125 82)')).toBe(true);
  });

  it('accepts boundary values', () => {
    expect(validateOkLch('oklch(0 0 0)')).toBe(true);
    expect(validateOkLch('oklch(1 0 359.999)')).toBe(true);
  });

  it('rejects out-of-range lightness', () => {
    expect(validateOkLch('oklch(1.5 0.1 90)')).toBe(false);
    expect(validateOkLch('oklch(-0.1 0.1 90)')).toBe(false);
  });

  it('rejects out-of-range hue', () => {
    expect(validateOkLch('oklch(0.5 0.1 360)')).toBe(false);
    expect(validateOkLch('oklch(0.5 0.1 -10)')).toBe(false);
  });

  it('rejects negative chroma', () => {
    expect(validateOkLch('oklch(0.5 -0.1 90)')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(validateOkLch('not-a-color')).toBe(false);
    expect(validateOkLch('rgb(255 0 0)')).toBe(false);
    expect(validateOkLch('#abcdef')).toBe(false);
    expect(validateOkLch('')).toBe(false);
  });

  it('is case-insensitive on the OKLCH prefix', () => {
    expect(validateOkLch('OKLCH(0.5 0.1 90)')).toBe(true);
  });
});

describe('validateHex', () => {
  it('accepts 3, 6, and 8-digit hex', () => {
    expect(validateHex('#abc')).toBe(true);
    expect(validateHex('#abcdef')).toBe(true);
    expect(validateHex('#abcdef12')).toBe(true);
  });

  it('rejects 4 / 5 / 7 digit hex', () => {
    expect(validateHex('#abcd')).toBe(false);
    expect(validateHex('#abcde')).toBe(false);
    expect(validateHex('#abcdefg')).toBe(false);
  });

  it('rejects missing hash', () => {
    expect(validateHex('abcdef')).toBe(false);
  });
});

describe('isValidBrandColor', () => {
  it('accepts either OKLCh or hex', () => {
    expect(isValidBrandColor('oklch(0.5 0.1 90)')).toBe(true);
    expect(isValidBrandColor('#abcdef')).toBe(true);
  });

  it('rejects neither', () => {
    expect(isValidBrandColor('rgb(1 2 3)')).toBe(false);
    expect(isValidBrandColor('blue')).toBe(false);
  });
});
