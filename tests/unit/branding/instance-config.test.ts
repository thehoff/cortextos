import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readInstanceConfig,
  writeInstanceConfig,
} from '../../../src/branding/instance-config.js';

describe('readInstanceConfig + writeInstanceConfig', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevInstance: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'cortextos-branding-test-'));
    prevHome = process.env.HOME;
    prevInstance = process.env.CTX_INSTANCE_ID;
    process.env.HOME = tmpHome;
    process.env.CTX_INSTANCE_ID = 'testinst';
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevInstance === undefined) delete process.env.CTX_INSTANCE_ID;
    else process.env.CTX_INSTANCE_ID = prevInstance;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('returns undefined when no branding.json exists', () => {
    expect(readInstanceConfig()).toBeUndefined();
  });

  it('round-trips brandName through write + read', () => {
    writeInstanceConfig({ brandName: 'AcmeOS' });
    expect(readInstanceConfig()).toEqual({ brandName: 'AcmeOS' });
  });

  it('merges patches with existing config (read-merge-write)', () => {
    writeInstanceConfig({ brandName: 'AcmeOS' });
    writeInstanceConfig({ primaryColorLight: 'oklch(0.7 0.2 200)', primaryColorDark: 'oklch(0.6 0.2 200)' });
    const cfg = readInstanceConfig();
    expect(cfg?.brandName).toBe('AcmeOS');
    expect(cfg?.primaryColorLight).toBe('oklch(0.7 0.2 200)');
    expect(cfg?.primaryColorDark).toBe('oklch(0.6 0.2 200)');
  });

  it('drops invalid color values silently on read', () => {
    const dir = join(tmpHome, '.cortextos', 'testinst', 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'branding.json'),
      JSON.stringify({
        brandName: 'ValidName',
        primaryColorLight: 'not-a-color',
        accentColorDark: '#abcdef',
      }) + '\n',
      'utf-8',
    );
    const cfg = readInstanceConfig();
    expect(cfg?.brandName).toBe('ValidName');
    expect(cfg?.primaryColorLight).toBeUndefined();
    expect(cfg?.accentColorDark).toBe('#abcdef');
  });

  it('returns undefined on JSON parse failure', () => {
    const dir = join(tmpHome, '.cortextos', 'testinst', 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'branding.json'), '{ not json', 'utf-8');
    expect(readInstanceConfig()).toBeUndefined();
  });

  it('returns undefined when the file is valid JSON but has no recognized fields', () => {
    const dir = join(tmpHome, '.cortextos', 'testinst', 'config');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'branding.json'), JSON.stringify({ unrecognized: 'thing' }), 'utf-8');
    expect(readInstanceConfig()).toBeUndefined();
  });

  it('writes the file with 0o600 perms', () => {
    writeInstanceConfig({ brandName: 'Foo' });
    const filePath = join(tmpHome, '.cortextos', 'testinst', 'config', 'branding.json');
    expect(existsSync(filePath)).toBe(true);
    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.brandName).toBe('Foo');
    // 0o600 = 384; OS may add additional flags so mask to permission bits.
    const fs = require('fs');
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
