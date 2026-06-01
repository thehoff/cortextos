import fs from 'fs';
import path from 'path';
import { getBrandingConfigPath, getFrameworkRoot } from '../utils/paths.js';

export const THEME_FONT_VARIABLES = [
  '--font-sans',
  '--font-mono',
  '--font-heading',
] as const;

export const THEME_COLOR_VARIABLES = [
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
] as const;

export const THEME_REQUIRED_VARIABLES = [...THEME_COLOR_VARIABLES] as const;
export const THEME_DARK_REQUIRED_VARIABLES = [
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
] as const;
export const THEME_VARIABLES = [...THEME_FONT_VARIABLES, ...THEME_COLOR_VARIABLES] as const;
export const THEME_ROOT_ONLY_VARIABLES = [...THEME_FONT_VARIABLES, '--radius'] as const;

export type ThemeVariableName = (typeof THEME_VARIABLES)[number];
export type ThemeColorVariableName = (typeof THEME_COLOR_VARIABLES)[number];
export type ThemeFontVariableName = (typeof THEME_FONT_VARIABLES)[number];

export interface ThemeTokens extends Partial<Record<ThemeVariableName, string>> {
  [key: string]: string | undefined;
}

export interface ThemeFonts {
  sans?: string;
  mono?: string;
  heading?: string;
}

export interface ThemeManifest {
  id: string;
  name: string;
  description: string;
  light: ThemeTokens;
  dark: ThemeTokens;
  chartPalette?: string[];
  fonts?: ThemeFonts;
}

export interface ResolvedThemePackage extends ThemeManifest {
  source: 'config' | 'env' | 'default';
  sourceValue: string;
  themeDir: string;
  themeJsonPath: string;
  themeCssPath: string;
  css: string;
}

export interface ThemeResolutionInput {
  env?: NodeJS.ProcessEnv;
  ctxRoot?: string;
  frameworkRoot?: string;
}

export interface ThemeValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: ThemeManifest;
}

const DEFAULT_THEME_ID = 'cortex';

const DEFAULT_THEME_MANIFEST: ThemeManifest = {
  id: 'cortex',
  name: 'Cortex',
  description: 'Default cortextOS theme matching the current gold dashboard look.',
  fonts: {
    sans: 'var(--font-sora), system-ui, sans-serif',
    mono: 'var(--font-jetbrains), "JetBrains Mono", monospace',
    heading: 'var(--font-sora), system-ui, sans-serif',
  },
  chartPalette: [
    'oklch(0.762 0.125 82)',
    'oklch(0.546 0.2 262)',
    'oklch(0.507 0.22 293)',
    'oklch(0.543 0.22 340)',
    'oklch(0.555 0.17 160)',
  ],
  light: {
    '--background': 'oklch(1 0 0)',
    '--foreground': 'oklch(0.187 0 0)',
    '--card': 'oklch(1 0 0)',
    '--card-foreground': 'oklch(0.187 0 0)',
    '--popover': 'oklch(1 0 0)',
    '--popover-foreground': 'oklch(0.187 0 0)',
    '--primary': 'oklch(0.618 0.13 75)',
    '--primary-foreground': 'oklch(1 0 0)',
    '--secondary': 'oklch(0.975 0.005 80)',
    '--secondary-foreground': 'oklch(0.187 0 0)',
    '--muted': 'oklch(0.975 0.005 80)',
    '--muted-foreground': 'oklch(0.478 0 0)',
    '--accent': 'oklch(0.762 0.125 82)',
    '--accent-foreground': 'oklch(0.187 0 0)',
    '--destructive': 'oklch(0.577 0.245 27.325)',
    '--destructive-foreground': 'oklch(1 0 0)',
    '--success': 'oklch(0.555 0.17 145)',
    '--success-foreground': 'oklch(1 0 0)',
    '--warning': 'oklch(0.72 0.17 75)',
    '--warning-foreground': 'oklch(0.187 0 0)',
    '--border': 'oklch(0.905 0.01 70)',
    '--input': 'oklch(0.905 0.01 70)',
    '--ring': 'oklch(0.618 0.13 75)',
    '--chart-1': 'oklch(0.762 0.125 82)',
    '--chart-2': 'oklch(0.546 0.2 262)',
    '--chart-3': 'oklch(0.507 0.22 293)',
    '--chart-4': 'oklch(0.543 0.22 340)',
    '--chart-5': 'oklch(0.555 0.17 160)',
    '--radius': '0.5rem',
    '--sidebar': 'oklch(0.975 0.005 80)',
    '--sidebar-foreground': 'oklch(0.187 0 0)',
    '--sidebar-primary': 'oklch(0.618 0.13 75)',
    '--sidebar-primary-foreground': 'oklch(1 0 0)',
    '--sidebar-accent': 'oklch(0.762 0.125 82)',
    '--sidebar-accent-foreground': 'oklch(0.187 0 0)',
    '--sidebar-border': 'oklch(0.905 0.01 70)',
    '--sidebar-ring': 'oklch(0.618 0.13 75)',
  },
  dark: {
    '--background': 'oklch(0.145 0 0)',
    '--foreground': 'oklch(0.975 0.005 80)',
    '--card': 'oklch(0.145 0 0)',
    '--card-foreground': 'oklch(0.975 0.005 80)',
    '--popover': 'oklch(0.145 0 0)',
    '--popover-foreground': 'oklch(0.975 0.005 80)',
    '--primary': 'oklch(0.762 0.125 82)',
    '--primary-foreground': 'oklch(0.145 0 0)',
    '--secondary': 'oklch(0.187 0 0)',
    '--secondary-foreground': 'oklch(0.975 0.005 80)',
    '--muted': 'oklch(0.187 0 0)',
    '--muted-foreground': 'oklch(0.6 0 0)',
    '--accent': 'oklch(0.618 0.13 75)',
    '--accent-foreground': 'oklch(0.975 0.005 80)',
    '--destructive': 'oklch(0.704 0.191 22.216)',
    '--destructive-foreground': 'oklch(1 0 0)',
    '--success': 'oklch(0.555 0.17 145)',
    '--success-foreground': 'oklch(1 0 0)',
    '--warning': 'oklch(0.72 0.17 75)',
    '--warning-foreground': 'oklch(0.187 0 0)',
    '--border': 'oklch(0.25 0.015 60)',
    '--input': 'oklch(0.25 0.015 60)',
    '--ring': 'oklch(0.762 0.125 82)',
    '--chart-1': 'oklch(0.762 0.125 82)',
    '--chart-2': 'oklch(0.546 0.2 262)',
    '--chart-3': 'oklch(0.507 0.22 293)',
    '--chart-4': 'oklch(0.543 0.22 340)',
    '--chart-5': 'oklch(0.555 0.17 160)',
    '--radius': '0.5rem',
    '--sidebar': 'oklch(0.187 0 0)',
    '--sidebar-foreground': 'oklch(0.975 0.005 80)',
    '--sidebar-primary': 'oklch(0.762 0.125 82)',
    '--sidebar-primary-foreground': 'oklch(0.975 0.005 80)',
    '--sidebar-accent': 'oklch(0.25 0.015 60)',
    '--sidebar-accent-foreground': 'oklch(0.975 0.005 80)',
    '--sidebar-border': 'oklch(0.25 0.015 60)',
    '--sidebar-ring': 'oklch(0.762 0.125 82)',
  },
};

export function getDefaultThemeManifest(): ThemeManifest {
  return cloneThemeManifest(DEFAULT_THEME_MANIFEST);
}

export function validateThemeManifest(manifest: unknown): ThemeValidationResult {
  const normalized = normalizeThemeManifest(manifest);
  if (!normalized) {
    return { ok: false, errors: ['Theme manifest must be an object with id, name, description, light, and dark blocks.'] };
  }

  const errors: string[] = [];

  if (!isSafeThemeId(normalized.id)) {
    errors.push(`Invalid theme id "${normalized.id}"`);
  }
  if (!normalized.name.trim()) {
    errors.push('Theme name is required');
  }
  if (!normalized.description.trim()) {
    errors.push('Theme description is required');
  }

  if (normalized.chartPalette && normalized.chartPalette.length !== 5) {
    errors.push('chartPalette must contain exactly 5 entries when present');
  }

  const light = expandThemeTokens(normalized, 'light', true);
  const dark = expandThemeTokens(normalized, 'dark', false);

  for (const variable of THEME_REQUIRED_VARIABLES) {
    if (!isPresentThemeValue(light[variable])) {
      errors.push(`Missing required light token ${variable}`);
    }
  }

  for (const variable of THEME_DARK_REQUIRED_VARIABLES) {
    if (!isPresentThemeValue(dark[variable])) {
      errors.push(`Missing required dark token ${variable}`);
    }
  }

  for (const [mode, tokens] of [['light', light], ['dark', dark]] as const) {
    for (const [key, value] of Object.entries(tokens)) {
      if (!key.startsWith('--')) continue;
      if (!isSafeThemeValue(value)) {
        errors.push(`Unsafe ${mode} token ${key}`);
      }
    }
  }

  if (normalized.fonts) {
    for (const [key, value] of Object.entries(normalized.fonts)) {
      if (value !== undefined && !isSafeThemeValue(value)) {
        errors.push(`Unsafe font token ${key}`);
      }
    }
  }

  return errors.length === 0 ? { ok: true, errors: [], manifest: normalized } : { ok: false, errors };
}

export function buildThemeCss(manifest: ThemeManifest): string {
  const normalized = validateThemeManifest(manifest);
  if (!normalized.ok || !normalized.manifest) {
    throw new Error(normalized.errors.join('; '));
  }

  const rootTokens = expandThemeTokens(normalized.manifest, 'light', true);
  const darkTokens = expandThemeTokens(normalized.manifest, 'dark', false);

  return [
    ':root {',
    ...renderThemeDeclarations(rootTokens, true),
    '}',
    '',
    '.dark {',
    ...renderThemeDeclarations(darkTokens, false),
    '}',
    '',
  ].join('\n');
}

export function loadThemePackage(themePath: string, source: ResolvedThemePackage['source'] = 'default', sourceValue = themePath): ResolvedThemePackage | null {
  const resolved = resolveThemeDirectory(themePath);
  if (!resolved) return null;

  const themeJsonPath = path.join(resolved, 'theme.json');
  const parsed = loadThemeManifest(themeJsonPath);
  if (!parsed) return null;

  const validation = validateThemeManifest(parsed);
  if (!validation.ok || !validation.manifest) return null;

  return {
    ...validation.manifest,
    source,
    sourceValue,
    themeDir: resolved,
    themeJsonPath,
    themeCssPath: path.join(resolved, 'theme.css'),
    css: buildThemeCss(validation.manifest),
  };
}

export function resolveTheme(input: ThemeResolutionInput = {}): ResolvedThemePackage {
  const env = input.env ?? process.env;
  const ctxRoot = input.ctxRoot ?? env.CTX_ROOT;
  const frameworkRoot = input.frameworkRoot ?? getFrameworkRoot();

  const candidates: Array<{ source: ResolvedThemePackage['source']; sourceValue: string }> = [];
  const configTheme = readThemeSelection(getBrandingConfigPath(ctxRoot));
  if (configTheme) candidates.push({ source: 'config', sourceValue: configTheme });

  const envTheme = env.CORTEXTOS_THEME?.trim();
  if (envTheme) candidates.push({ source: 'env', sourceValue: envTheme });

  candidates.push({ source: 'default', sourceValue: DEFAULT_THEME_ID });

  for (const candidate of candidates) {
    const loaded = loadThemePackageFromSpecifier(candidate.sourceValue, frameworkRoot, candidate.source);
    if (loaded) return loaded;
  }

  return {
    ...getDefaultThemeManifest(),
    source: 'default',
    sourceValue: DEFAULT_THEME_ID,
    themeDir: path.join(frameworkRoot, 'themes', DEFAULT_THEME_ID),
    themeJsonPath: path.join(frameworkRoot, 'themes', DEFAULT_THEME_ID, 'theme.json'),
    themeCssPath: path.join(frameworkRoot, 'themes', DEFAULT_THEME_ID, 'theme.css'),
    css: buildThemeCss(getDefaultThemeManifest()),
  };
}

export function loadThemePackageFromSpecifier(
  specifier: string,
  frameworkRoot: string = getFrameworkRoot(),
  source: ResolvedThemePackage['source'] = 'default',
): ResolvedThemePackage | null {
  for (const candidate of buildThemePathCandidates(specifier, frameworkRoot)) {
    const loaded = loadThemePackage(candidate, source, specifier);
    if (loaded) return loaded;
  }
  return null;
}

export function readThemeSelection(brandingPath: string): string | null {
  try {
    if (!fs.existsSync(brandingPath)) return null;
    const raw = fs.readFileSync(brandingPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const direct = extractThemeSpecifier(parsed);
    if (direct) return direct;
  } catch {
    return null;
  }

  return null;
}

export function loadThemeManifest(themeJsonPath: string): ThemeManifest | null {
  try {
    if (!fs.existsSync(themeJsonPath)) return null;
    const raw = fs.readFileSync(themeJsonPath, 'utf-8');
    return normalizeThemeManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

function buildThemePathCandidates(specifier: string, frameworkRoot: string): string[] {
  const trimmed = specifier.trim();
  if (!trimmed) return [];

  const candidates = new Set<string>();
  if (path.isAbsolute(trimmed)) {
    candidates.add(trimmed);
  } else if (trimmed.startsWith('.') || trimmed.includes(path.sep) || trimmed.includes('/')) {
    candidates.add(path.resolve(frameworkRoot, trimmed));
  } else {
    candidates.add(path.resolve(frameworkRoot, 'themes', trimmed));
    candidates.add(path.resolve(frameworkRoot, trimmed));
  }

  const expanded = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.endsWith('.json')) {
      expanded.add(candidate);
    } else {
      expanded.add(candidate);
      expanded.add(path.join(candidate, 'theme.json'));
    }
  }

  return Array.from(expanded);
}

function resolveThemeDirectory(candidatePath: string): string | null {
  try {
    if (!fs.existsSync(candidatePath)) return null;

    const stat = fs.statSync(candidatePath);
    if (stat.isDirectory()) {
      const themeJsonPath = path.join(candidatePath, 'theme.json');
      return fs.existsSync(themeJsonPath) ? candidatePath : null;
    }

    if (stat.isFile()) {
      if (path.basename(candidatePath) === 'theme.json') {
        return path.dirname(candidatePath);
      }
      if (path.basename(candidatePath) === 'theme.css') {
        const dir = path.dirname(candidatePath);
        const themeJsonPath = path.join(dir, 'theme.json');
        return fs.existsSync(themeJsonPath) ? dir : null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function expandThemeTokens(manifest: ThemeManifest, mode: 'light' | 'dark', includeRootOnly: boolean = false): ThemeTokens {
  const base: ThemeTokens = { ...manifest[mode] };

  if (includeRootOnly) {
    for (let i = 0; i < THEME_FONT_VARIABLES.length; i++) {
      const variable = THEME_FONT_VARIABLES[i];
      const fontKey = variable === '--font-sans'
        ? 'sans'
        : variable === '--font-mono'
          ? 'mono'
          : 'heading';
      const value = manifest.fonts?.[fontKey];
      if (!base[variable] && value) {
        base[variable] = value;
      }
    }

    if (!base['--radius']) {
      const radius = manifest.light['--radius'] ?? manifest.dark['--radius'];
      if (radius) {
        base['--radius'] = radius;
      }
    }
  }

  if (manifest.chartPalette) {
    for (let i = 0; i < 5; i++) {
      const variable = `--chart-${i + 1}` as ThemeColorVariableName;
      if (!base[variable] && manifest.chartPalette[i]) {
        base[variable] = manifest.chartPalette[i];
      }
    }
  }

  return base;
}

function renderThemeDeclarations(tokens: ThemeTokens, includeRootOnly: boolean): string[] {
  const lines: string[] = [];
  if (includeRootOnly) {
    for (const variable of THEME_FONT_VARIABLES) {
      const value = tokens[variable];
      if (isPresentThemeValue(value)) {
        lines.push(`  ${variable}: ${value};`);
      }
    }
  }
  for (const variable of THEME_COLOR_VARIABLES) {
    if (!includeRootOnly && variable === '--radius') {
      continue;
    }
    const value = tokens[variable];
    if (!isPresentThemeValue(value)) {
      continue;
    }
    lines.push(`  ${variable}: ${value};`);
  }
  return lines;
}

function normalizeThemeManifest(manifest: unknown): ThemeManifest | null {
  if (!manifest || typeof manifest !== 'object') return null;
  const data = manifest as Record<string, unknown>;

  const id = normalizeString(data.id);
  const name = normalizeString(data.name);
  const description = normalizeString(data.description);
  const light = normalizeThemeTokens(data.light);
  const dark = normalizeThemeTokens(data.dark);
  const fonts = normalizeThemeFonts(data.fonts);
  const chartPalette = normalizeThemeChartPalette(data.chartPalette);

  if (!id || !name || !description || !light || !dark) return null;

  const normalized: ThemeManifest = { id, name, description, light, dark };
  if (fonts) normalized.fonts = fonts;
  if (chartPalette) normalized.chartPalette = chartPalette;
  return normalized;
}

function normalizeThemeTokens(value: unknown): ThemeTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tokens: ThemeTokens = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim();
    if (normalized) tokens[key] = normalized;
  }
  return tokens;
}

function normalizeThemeFonts(value: unknown): ThemeFonts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const fonts: ThemeFonts = {};
  if (typeof raw.sans === 'string' && raw.sans.trim()) fonts.sans = raw.sans.trim();
  if (typeof raw.mono === 'string' && raw.mono.trim()) fonts.mono = raw.mono.trim();
  if (typeof raw.heading === 'string' && raw.heading.trim()) fonts.heading = raw.heading.trim();
  return Object.keys(fonts).length > 0 ? fonts : null;
}

function normalizeThemeChartPalette(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const palette = value
    .map((entry) => typeof entry === 'string' ? entry.trim() : '')
    .filter((entry): entry is string => Boolean(entry));
  return palette.length > 0 ? palette : null;
}

function extractThemeSpecifier(value: Record<string, unknown>): string | null {
  const direct = value.theme;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    const nested = direct as Record<string, unknown>;
    if (typeof nested.id === 'string' && nested.id.trim()) return nested.id.trim();
    if (typeof nested.path === 'string' && nested.path.trim()) return nested.path.trim();
  }
  if (typeof value.themePackage === 'string' && value.themePackage.trim()) {
    return value.themePackage.trim();
  }
  if (typeof value.path === 'string' && value.path.trim()) {
    return value.path.trim();
  }
  return null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isSafeThemeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-_]*$/i.test(value);
}

function isSafeThemeValue(value: string | undefined): boolean {
  if (!isPresentThemeValue(value)) return false;
  return !/[{}\n\r;]/.test(value);
}

function isPresentThemeValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneThemeManifest(manifest: ThemeManifest): ThemeManifest {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    light: { ...manifest.light },
    dark: { ...manifest.dark },
    ...(manifest.fonts ? { fonts: { ...manifest.fonts } } : {}),
    ...(manifest.chartPalette ? { chartPalette: [...manifest.chartPalette] } : {}),
  };
}
