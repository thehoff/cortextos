import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildThemeCss as buildThemeCssCore,
  getDefaultThemeManifest,
  resolveTheme as resolveThemeCore,
  validateThemeManifest as validateThemeManifestCore,
} from '../../../../src/theming/index.js';
import {
  buildThemeCss as buildThemeCssDashboard,
  resolveTheme as resolveThemeDashboard,
  validateThemeManifest as validateThemeManifestDashboard,
} from '../theming';

let tempRoot = '';
let frameworkRoot = '';
let ctxRoot = '';

function seedTheme(themeDir: string) {
  mkdirSync(themeDir, { recursive: true });
  writeFileSync(join(themeDir, 'theme.json'), JSON.stringify({
    ...getDefaultThemeManifest(),
    id: 'sync-theme',
    name: 'Sync Theme',
    light: {
      ...getDefaultThemeManifest().light,
      '--primary': 'oklch(0.7 0.2 100)',
    },
  }, null, 2) + '\n', 'utf-8');
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cortext-theme-sync-'));
  frameworkRoot = join(tempRoot, 'framework');
  ctxRoot = join(tempRoot, 'state');
  mkdirSync(join(frameworkRoot, 'themes'), { recursive: true });
  mkdirSync(join(ctxRoot, 'config'), { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('theming module sync', () => {
  it('buildThemeCss stays byte-identical between core and dashboard mirrors', () => {
    const manifest = {
      ...getDefaultThemeManifest(),
      id: 'sync-theme',
    };

    expect(buildThemeCssDashboard(manifest)).toBe(buildThemeCssCore(manifest));
  });

  it('validateThemeManifest returns the same verdict in both modules', () => {
    const manifest = {
      ...getDefaultThemeManifest(),
      light: {
        ...getDefaultThemeManifest().light,
        '--primary': undefined,
      },
    };

    const core = validateThemeManifestCore(manifest);
    const dashboard = validateThemeManifestDashboard(manifest);

    expect(dashboard.ok).toBe(core.ok);
    expect(dashboard.errors).toEqual(core.errors);
  });

  it('resolveTheme returns the same result for a concrete fixture', () => {
    seedTheme(join(frameworkRoot, 'themes', 'sync-theme'));
    writeFileSync(join(ctxRoot, 'config', 'branding.json'), JSON.stringify({ theme: 'sync-theme' }, null, 2) + '\n', 'utf-8');

    const env = {
      CTX_ROOT: ctxRoot,
      CTX_FRAMEWORK_ROOT: frameworkRoot,
      CORTEXTOS_THEME: '',
    };

    const core = resolveThemeCore({ ctxRoot, frameworkRoot, env });
    const dashboard = resolveThemeDashboard({ ctxRoot, frameworkRoot, env });

    expect(dashboard.source).toBe(core.source);
    expect(dashboard.id).toBe(core.id);
    expect(dashboard.themeJsonPath).toBe(core.themeJsonPath);
    expect(dashboard.css).toBe(core.css);
    expect(dashboard.light['--primary']).toBe(core.light['--primary']);
  });
});
