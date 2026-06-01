import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  buildThemeCss,
  getDefaultThemeManifest,
  loadThemeManifest,
  resolveTheme,
  validateThemeManifest,
  THEME_COLOR_VARIABLES,
  THEME_FONT_VARIABLES,
} from '../../../src/theming/index.js';

const repoRoot = process.cwd();
const globalsPath = join(repoRoot, 'dashboard', 'src', 'app', 'globals.css');
const buildThemeScript = join(repoRoot, 'scripts', 'build-theme.mjs');

let tempRoot = '';
let frameworkRoot = '';
let ctxRoot = '';

function makeTempThemePackage(themeDir: string, manifest: Record<string, unknown>) {
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, 'theme.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

function parseCssBlock(source: string, selector: string): Record<string, string> {
  const needle = `${selector} {`;
  const start = source.indexOf(needle);
  if (start < 0) return {};
  const body = source.slice(start + needle.length);
  const end = body.indexOf('\n}');
  const block = end >= 0 ? body.slice(0, end) : body;
  const vars: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const clean = line.replace(/\/\*.*?\*\//g, '').trim();
    const token = clean.match(/^(--[a-z0-9-]+):\s*(.+);$/i);
    if (token) vars[token[1]] = token[2].trim();
  }
  return vars;
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cortext-theme-'));
  frameworkRoot = join(tempRoot, 'framework');
  ctxRoot = join(tempRoot, 'state');
  mkdirSync(join(frameworkRoot, 'themes'), { recursive: true });
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  delete process.env.CTX_ROOT;
  delete process.env.CTX_FRAMEWORK_ROOT;
  delete process.env.CORTEXTOS_THEME;
});

describe('resolveTheme', () => {
  it('prefers explicit config over env and default', () => {
    makeTempThemePackage(join(frameworkRoot, 'themes', 'from-config'), {
      ...getDefaultThemeManifest(),
      id: 'from-config',
      name: 'From Config',
      light: {
        ...getDefaultThemeManifest().light,
        '--primary': 'oklch(0.7 0.2 123)',
      },
    });
    makeTempThemePackage(join(frameworkRoot, 'themes', 'from-env'), {
      ...getDefaultThemeManifest(),
      id: 'from-env',
      name: 'From Env',
      light: {
        ...getDefaultThemeManifest().light,
        '--primary': 'oklch(0.4 0.2 210)',
      },
    });
    writeFileSync(join(ctxRoot, 'config', 'branding.json'), JSON.stringify({ theme: 'from-config' }, null, 2) + '\n', 'utf-8');

    const theme = resolveTheme({
      ctxRoot,
      frameworkRoot,
      env: {
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: frameworkRoot,
        CORTEXTOS_THEME: 'from-env',
      },
    });

    expect(theme.source).toBe('config');
    expect(theme.id).toBe('from-config');
    expect(theme.light['--primary']).toBe('oklch(0.7 0.2 123)');
  });

  it('uses env when config is absent', () => {
    makeTempThemePackage(join(frameworkRoot, 'themes', 'from-env'), {
      ...getDefaultThemeManifest(),
      id: 'from-env',
      name: 'From Env',
      light: {
        ...getDefaultThemeManifest().light,
        '--primary': 'oklch(0.4 0.2 210)',
      },
    });

    const theme = resolveTheme({
      ctxRoot,
      frameworkRoot,
      env: {
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: frameworkRoot,
        CORTEXTOS_THEME: 'from-env',
      },
    });

    expect(theme.source).toBe('env');
    expect(theme.id).toBe('from-env');
    expect(theme.light['--primary']).toBe('oklch(0.4 0.2 210)');
  });

  it('silently falls back to the built-in default when selection is invalid', () => {
    writeFileSync(join(ctxRoot, 'config', 'branding.json'), JSON.stringify({ theme: 'missing-theme' }, null, 2) + '\n', 'utf-8');

    const theme = resolveTheme({
      ctxRoot,
      frameworkRoot,
      env: {
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: frameworkRoot,
        CORTEXTOS_THEME: 'also-missing',
      },
    });

    expect(theme.source).toBe('default');
    expect(theme.id).toBe('cortex');
    expect(theme.css).toBe(buildThemeCss(getDefaultThemeManifest()));
  });

  it('silently falls back to the built-in default when a theme path runs through an existing file', () => {
    makeTempThemePackage(join(frameworkRoot, 'themes', 'cortex'), getDefaultThemeManifest());

    const theme = resolveTheme({
      ctxRoot,
      frameworkRoot,
      env: {
        CTX_ROOT: ctxRoot,
        CTX_FRAMEWORK_ROOT: frameworkRoot,
        CORTEXTOS_THEME: 'themes/cortex/theme.json/nope',
      },
    });

    expect(theme.source).toBe('default');
    expect(theme.id).toBe('cortex');
    expect(theme.css).toBe(buildThemeCss(getDefaultThemeManifest()));
  });
});

describe('validation', () => {
  it('accepts the built-in default manifest', () => {
    expect(validateThemeManifest(getDefaultThemeManifest()).ok).toBe(true);
  });

  it('rejects manifests missing required tokens', () => {
    const manifest = getDefaultThemeManifest();
    const invalid = {
      ...manifest,
      light: { ...manifest.light },
    };
    delete (invalid.light as Record<string, string>)['--primary'];

    const result = validateThemeManifest(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors.some((message) => message.includes('--primary'))).toBe(true);
  });
});

describe('generator', () => {
  it('is deterministic and writes the same bytes on repeated runs', () => {
    const themeDir = join(frameworkRoot, 'themes', 'cortex');
    const manifestPath = join(themeDir, 'theme.json');
    mkdirSync(themeDir, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(getDefaultThemeManifest(), null, 2) + '\n', 'utf-8');

    const firstRun = spawnSync(process.execPath, [buildThemeScript, themeDir], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expect(firstRun.status).toBe(0);
    const first = readFileSync(join(themeDir, 'theme.css'), 'utf-8');

    const secondRun = spawnSync(process.execPath, [buildThemeScript, themeDir], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expect(secondRun.status).toBe(0);
    const second = readFileSync(join(themeDir, 'theme.css'), 'utf-8');

    expect(second).toBe(first);
    expect(second).toBe(buildThemeCss(loadThemeManifest(manifestPath) ?? getDefaultThemeManifest()));
  });

  it('matches the current globals.css contract values', () => {
    const globals = readFileSync(globalsPath, 'utf-8');
    const defaultTheme = getDefaultThemeManifest();
    const generated = buildThemeCss(defaultTheme);

    const globalsRoot = parseCssBlock(globals, ':root');
    const globalsDark = parseCssBlock(globals, '.dark');
    const globalsFonts = parseCssBlock(globals, '@theme inline');
    const generatedRoot = parseCssBlock(generated, ':root');
    const generatedDark = parseCssBlock(generated, '.dark');

    for (const variable of THEME_FONT_VARIABLES) {
      expect(generatedRoot[variable]).toBe(globalsFonts[variable]);
    }

    for (const variable of THEME_COLOR_VARIABLES) {
      expect(generatedRoot[variable]).toBe(globalsRoot[variable]);
      if (variable !== '--radius') {
        expect(generatedDark[variable]).toBe(globalsDark[variable]);
      }
    }
  });
});
