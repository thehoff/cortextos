import { describe, it, expect } from 'vitest';
// Import the script's exported helpers directly (no shell-out).
import {
  extractBlock,
  parseTokens,
  isThemeToken,
  filterTokens,
  renderCss,
  renderJson,
} from '../export-tokens.mjs';

describe('extractBlock', () => {
  it('extracts a flat :root block', () => {
    const css = ':root {\n  --a: 1;\n  --b: 2;\n}';
    expect(extractBlock(css, ':root').trim()).toBe('--a: 1;\n  --b: 2;');
  });

  it('handles nested braces (calc with function call)', () => {
    const css = ':root {\n  --r: calc(1rem * 2);\n  --r2: 0.5rem;\n}\n.dark { --x: 0; }';
    const block = extractBlock(css, ':root');
    expect(block).toContain('--r: calc(1rem * 2);');
    expect(block).toContain('--r2: 0.5rem;');
    expect(block).not.toContain('--x:');
  });

  it('throws when the selector is missing', () => {
    expect(() => extractBlock(':root { --x: 1; }', '.missing')).toThrow();
  });
});

describe('parseTokens', () => {
  it('parses declarations into an ordered map', () => {
    const block = '  --primary: oklch(0.6 0.1 80);\n  --accent: #abcdef;\n';
    expect(parseTokens(block)).toEqual({
      '--primary': 'oklch(0.6 0.1 80)',
      '--accent': '#abcdef',
    });
  });

  it('preserves insertion order', () => {
    const block = '  --z: 1;\n  --a: 2;\n  --m: 3;\n';
    expect(Object.keys(parseTokens(block))).toEqual(['--z', '--a', '--m']);
  });

  it('ignores non-token lines (comments, blank)', () => {
    const block = '  /* comment */\n  --x: 1;\n  \n  --y: 2;\n';
    expect(parseTokens(block)).toEqual({ '--x': '1', '--y': '2' });
  });
});

describe('isThemeToken / filterTokens', () => {
  it('keeps color/radius/sidebar tokens', () => {
    expect(isThemeToken('--primary')).toBe(true);
    expect(isThemeToken('--sidebar-accent')).toBe(true);
    expect(isThemeToken('--radius')).toBe(true);
    expect(isThemeToken('--chart-1')).toBe(true);
  });

  it('drops density / spacing / font tokens', () => {
    expect(isThemeToken('--space-nav-y')).toBe(false);
    expect(isThemeToken('--height-topbar')).toBe(false);
    expect(isThemeToken('--density-scale')).toBe(false);
    expect(isThemeToken('--font-sora')).toBe(false);
  });

  it('filterTokens applies isThemeToken', () => {
    const input = { '--primary': 'oklch(0.6 0.1 80)', '--space-foo': '1rem' };
    expect(filterTokens(input)).toEqual({ '--primary': 'oklch(0.6 0.1 80)' });
  });
});

describe('renderCss', () => {
  it('emits :root + .dark blocks with the generated-from header', () => {
    const css = renderCss(
      { '--primary': 'oklch(0.6 0.1 80)' },
      { '--primary': 'oklch(0.7 0.1 80)' },
    );
    expect(css).toMatch(/AUTO-GENERATED/);
    expect(css).toContain(':root {\n  --primary: oklch(0.6 0.1 80);\n}');
    expect(css).toContain('.dark {\n  --primary: oklch(0.7 0.1 80);\n}');
  });
});

describe('renderJson', () => {
  it('emits the schema marker, source, and both modes', () => {
    const json = JSON.parse(
      renderJson({ '--primary': 'oklch(0.6 0.1 80)' }, { '--primary': 'oklch(0.7 0.1 80)' })
    );
    expect(json.$schema).toBe('cortextos-design-tokens-v1');
    expect(json.source).toBe('dashboard/src/app/globals.css');
    expect(json.light['--primary']).toBe('oklch(0.6 0.1 80)');
    expect(json.dark['--primary']).toBe('oklch(0.7 0.1 80)');
  });
});

describe('end-to-end: parse the real globals.css', () => {
  it('extracts a sensible set of theme tokens from each mode', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cssPath = path.join(__dirname, '../../src/app/globals.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const light = filterTokens(parseTokens(extractBlock(css, ':root')));
    const dark = filterTokens(parseTokens(extractBlock(css, '.dark')));
    // Anchored expectations — these specific tokens must exist in both modes
    // and their values must be OKLCh (sanity check the parser).
    for (const required of ['--primary', '--accent', '--background', '--foreground', '--border']) {
      expect(light[required]).toMatch(/^oklch\(/);
      expect(dark[required]).toMatch(/^oklch\(/);
    }
    // We should have meaningfully many tokens (>15 in each mode).
    expect(Object.keys(light).length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(dark).length).toBeGreaterThanOrEqual(15);
  });
});
