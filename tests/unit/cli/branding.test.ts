import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shouldUseColor, outputMode, color, mark, banner } from '../../../src/cli/branding.js';

// Strip SGR escapes for "what does the plain text look like" assertions.
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[\d+(;\d+)*m/g, '');
}

describe('shouldUseColor', () => {
  let prevNoColor: string | undefined;
  let prevForce: string | undefined;
  let prevIsTty: boolean | undefined;

  beforeEach(() => {
    prevNoColor = process.env.NO_COLOR;
    prevForce = process.env.FORCE_COLOR;
    prevIsTty = process.stdout.isTTY;
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
  });

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    if (prevForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prevForce;
    // restore TTY
    Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTty, configurable: true });
  });

  function setTty(v: boolean) {
    Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
  }

  it('returns true when TTY and no overrides', () => {
    setTty(true);
    expect(shouldUseColor()).toBe(true);
  });

  it('returns false when not a TTY', () => {
    setTty(false);
    expect(shouldUseColor()).toBe(false);
  });

  it('NO_COLOR overrides TTY → false', () => {
    setTty(true);
    process.env.NO_COLOR = '1';
    expect(shouldUseColor()).toBe(false);
  });

  it('NO_COLOR="" does NOT disable (per no-color.org)', () => {
    setTty(true);
    process.env.NO_COLOR = '';
    expect(shouldUseColor()).toBe(true);
  });

  it('FORCE_COLOR=0 overrides TTY → false', () => {
    setTty(true);
    process.env.FORCE_COLOR = '0';
    expect(shouldUseColor()).toBe(false);
  });

  it('FORCE_COLOR="false" overrides TTY → false', () => {
    setTty(true);
    process.env.FORCE_COLOR = 'false';
    expect(shouldUseColor()).toBe(false);
  });

  it('FORCE_COLOR=1 enables when not a TTY', () => {
    setTty(false);
    process.env.FORCE_COLOR = '1';
    expect(shouldUseColor()).toBe(true);
  });

  it('NO_COLOR wins over FORCE_COLOR', () => {
    setTty(true);
    process.env.FORCE_COLOR = '1';
    process.env.NO_COLOR = '1';
    expect(shouldUseColor()).toBe(false);
  });
});

describe('outputMode', () => {
  let prevIsTty: boolean | undefined;
  beforeEach(() => { prevIsTty = process.stdout.isTTY; });
  afterEach(() => { Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTty, configurable: true }); });
  function setTty(v: boolean) {
    Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
  }

  it('returns "tty" when stdout is a TTY', () => {
    setTty(true);
    expect(outputMode()).toBe('tty');
  });

  it('returns "pipe" when stdout is not a TTY', () => {
    setTty(false);
    expect(outputMode()).toBe('pipe');
  });

  it('returns "json" when caller hints --json regardless of TTY', () => {
    setTty(true);
    expect(outputMode({ jsonRequested: true })).toBe('json');
    setTty(false);
    expect(outputMode({ jsonRequested: true })).toBe('json');
  });
});

describe('color helpers', () => {
  let prevForce: string | undefined;
  beforeEach(() => { prevForce = process.env.FORCE_COLOR; });
  afterEach(() => {
    if (prevForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prevForce;
  });

  it('wraps text in SGR codes when color is enabled', () => {
    process.env.FORCE_COLOR = '1';
    const out = color.ok('PASS');
    expect(out).toContain('\x1b[32m');
    expect(out).toContain('\x1b[39m');
    expect(strip(out)).toBe('PASS');
  });

  it('returns plain text when color is disabled', () => {
    process.env.FORCE_COLOR = '0';
    expect(color.ok('PASS')).toBe('PASS');
    expect(color.err('FAIL')).toBe('FAIL');
    expect(color.primary('cortextOS')).toBe('cortextOS');
  });

  it('bold uses close=22 not 39', () => {
    process.env.FORCE_COLOR = '1';
    const out = color.bold('Hi');
    expect(out).toBe('\x1b[1mHi\x1b[22m');
  });
});

describe('mark', () => {
  let prevIsTty: boolean | undefined;
  let prevForce: string | undefined;
  beforeEach(() => {
    prevIsTty = process.stdout.isTTY;
    prevForce = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = '1';
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTty, configurable: true });
    if (prevForce === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = prevForce;
  });
  function setTty(v: boolean) {
    Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
  }

  it('uses Unicode glyphs on TTY', () => {
    setTty(true);
    expect(strip(mark.ok())).toBe('✓');
    expect(strip(mark.warn())).toBe('⚠');
    expect(strip(mark.err())).toBe('✗');
  });

  it('falls back to ASCII brackets when not TTY', () => {
    setTty(false);
    expect(strip(mark.ok())).toBe('[OK]');
    expect(strip(mark.warn())).toBe('[WARN]');
    expect(strip(mark.err())).toBe('[FAIL]');
  });
});

describe('banner', () => {
  it('includes "cortextOS" plain in either mode', () => {
    process.env.FORCE_COLOR = '0';
    expect(banner()).toContain('cortextOS');
    expect(strip(banner('Doctor'))).toContain('cortextOS');
    expect(strip(banner('Doctor'))).toContain('Doctor');
  });

  it('emits ANSI when color is enabled', () => {
    process.env.FORCE_COLOR = '1';
    expect(banner()).toContain('\x1b[');
  });
});
