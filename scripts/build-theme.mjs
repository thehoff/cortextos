#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const THEME_FONT_VARIABLES = ['--font-sans', '--font-mono', '--font-heading'];
const THEME_COLOR_VARIABLES = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
  '--border',
  '--input',
  '--ring',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--radius',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
];
const THEME_DARK_REQUIRED_VARIABLES = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
  '--border',
  '--input',
  '--ring',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--sidebar',
  '--sidebar-foreground',
  '--sidebar-primary',
  '--sidebar-primary-foreground',
  '--sidebar-accent',
  '--sidebar-accent-foreground',
  '--sidebar-border',
  '--sidebar-ring',
];

function resolveThemePackagePath(input) {
  const candidate = path.resolve(process.cwd(), input);
  if (!fs.existsSync(candidate)) return null;
  const stat = fs.statSync(candidate);
  if (stat.isDirectory()) {
    const themeJsonPath = path.join(candidate, 'theme.json');
    return fs.existsSync(themeJsonPath) ? { themeDir: candidate, themeJsonPath } : null;
  }
  if (stat.isFile()) {
    if (path.basename(candidate) === 'theme.json') {
      return { themeDir: path.dirname(candidate), themeJsonPath: candidate };
    }
    if (path.basename(candidate) === 'theme.css') {
      const themeDir = path.dirname(candidate);
      const themeJsonPath = path.join(themeDir, 'theme.json');
      return fs.existsSync(themeJsonPath) ? { themeDir, themeJsonPath } : null;
    }
  }
  return null;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tokens = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim();
    if (normalized) tokens[key] = normalized;
  }
  return tokens;
}

function normalizeFonts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fonts = {};
  if (typeof value.sans === 'string' && value.sans.trim()) fonts.sans = value.sans.trim();
  if (typeof value.mono === 'string' && value.mono.trim()) fonts.mono = value.mono.trim();
  if (typeof value.heading === 'string' && value.heading.trim()) fonts.heading = value.heading.trim();
  return Object.keys(fonts).length > 0 ? fonts : null;
}

function normalizePalette(value) {
  if (!Array.isArray(value)) return null;
  const palette = value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter(Boolean);
  return palette.length > 0 ? palette : null;
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const manifest = {
    id: normalizeString(value.id),
    name: normalizeString(value.name),
    description: normalizeString(value.description),
    light: normalizeTokens(value.light),
    dark: normalizeTokens(value.dark),
  };
  if (!manifest.id || !manifest.name || !manifest.description || !manifest.light || !manifest.dark) {
    return null;
  }
  const fonts = normalizeFonts(value.fonts);
  if (fonts) manifest.fonts = fonts;
  const chartPalette = normalizePalette(value.chartPalette);
  if (chartPalette) manifest.chartPalette = chartPalette;
  return manifest;
}

function isSafeValue(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && !/[{}\n\r;]/.test(value);
}

function expandTokens(manifest, mode, includeRootOnly = false) {
  const tokens = { ...manifest[mode] };
  if (includeRootOnly && manifest.fonts) {
    if (!tokens['--font-sans'] && manifest.fonts.sans) tokens['--font-sans'] = manifest.fonts.sans;
    if (!tokens['--font-mono'] && manifest.fonts.mono) tokens['--font-mono'] = manifest.fonts.mono;
    if (!tokens['--font-heading'] && manifest.fonts.heading) tokens['--font-heading'] = manifest.fonts.heading;
  }
  if (includeRootOnly && !tokens['--radius']) {
    const radius = manifest.light['--radius'] || manifest.dark['--radius'];
    if (radius) tokens['--radius'] = radius;
  }
  if (manifest.chartPalette) {
    for (let i = 0; i < 5; i++) {
      const key = `--chart-${i + 1}`;
      if (!tokens[key] && manifest.chartPalette[i]) tokens[key] = manifest.chartPalette[i];
    }
  }
  return tokens;
}

function validateManifest(manifest) {
  const normalized = normalizeManifest(manifest);
  if (!normalized) return { ok: false, errors: ['Invalid theme manifest.'] };
  const errors = [];
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(normalized.id)) {
    errors.push(`Invalid theme id "${normalized.id}"`);
  }
  if (normalized.chartPalette && normalized.chartPalette.length !== 5) {
    errors.push('chartPalette must contain exactly 5 entries when present');
  }
  const light = expandTokens(normalized, 'light', true);
  const dark = expandTokens(normalized, 'dark', false);
  for (const variable of THEME_COLOR_VARIABLES) {
    if (light[variable] == null) {
      errors.push(`Missing required light token ${variable}`);
    } else if (!isSafeValue(light[variable])) {
      errors.push(`Unsafe light token ${variable}`);
    }
  }
  for (const variable of THEME_DARK_REQUIRED_VARIABLES) {
    if (dark[variable] == null) {
      errors.push(`Missing required dark token ${variable}`);
    } else if (!isSafeValue(dark[variable])) {
      errors.push(`Unsafe dark token ${variable}`);
    }
  }
  for (const [mode, tokens] of [['light', light], ['dark', dark]]) {
    for (const [key, value] of Object.entries(tokens)) {
      if (!key.startsWith('--')) continue;
      if (!isSafeValue(value)) errors.push(`Unsafe ${mode} token ${key}`);
    }
  }
  return errors.length === 0 ? { ok: true, manifest: normalized } : { ok: false, errors };
}

function renderDeclarations(tokens, includeRootOnly) {
  const lines = [];
  if (includeRootOnly) {
    for (const key of THEME_FONT_VARIABLES) {
      if (isSafeValue(tokens[key])) lines.push(`  ${key}: ${tokens[key]};`);
    }
  }
  for (const key of THEME_COLOR_VARIABLES) {
    if (!includeRootOnly && key === '--radius') continue;
    if (isSafeValue(tokens[key])) lines.push(`  ${key}: ${tokens[key]};`);
  }
  return lines;
}

export function buildThemeCss(manifest) {
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }
  const normalized = validation.manifest;
  const light = expandTokens(normalized, 'light', true);
  const dark = expandTokens(normalized, 'dark', false);
  return [
    ':root {',
    ...renderDeclarations(light, true),
    '}',
    '',
    '.dark {',
    ...renderDeclarations(dark, false),
    '}',
    '',
  ].join('\n');
}

export function loadThemeManifest(themeJsonPath) {
  const raw = fs.readFileSync(themeJsonPath, 'utf-8');
  return normalizeManifest(JSON.parse(raw));
}

export function buildThemePackage(inputPath, { validateOnly = false } = {}) {
  const resolved = resolveThemePackagePath(inputPath);
  if (!resolved) {
    throw new Error(`Theme package not found: ${inputPath}`);
  }
  const manifest = loadThemeManifest(resolved.themeJsonPath);
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }

  const css = buildThemeCss(validation.manifest);
  const themeCssPath = path.join(resolved.themeDir, 'theme.css');
  if (!validateOnly) {
    fs.writeFileSync(themeCssPath, css, 'utf-8');
  }

  return {
    manifest: validation.manifest,
    themeDir: resolved.themeDir,
    themeJsonPath: resolved.themeJsonPath,
    themeCssPath,
    css,
  };
}

function printUsage() {
  console.error('Usage: node scripts/build-theme.mjs [--validate] <theme-package-dir|theme.json>');
}

function parseCliArgs(argv) {
  const positional = [];
  let validateOnly = false;

  for (const arg of argv) {
    if (arg === '--validate') {
      validateOnly = true;
      continue;
    }
    if (arg.startsWith('--')) {
      continue;
    }
    positional.push(arg);
  }

  return {
    input: positional[0],
    validateOnly,
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/build-theme.mjs')) {
  const { input, validateOnly } = parseCliArgs(process.argv.slice(2));
  if (!input) {
    printUsage();
    process.exit(1);
  }

  try {
    buildThemePackage(input, { validateOnly });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
