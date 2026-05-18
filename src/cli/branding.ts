/**
 * CLI visual polish — color helpers, output-mode detection, branded banner.
 *
 * Pure Node, no deps. cortextOS bundles as CJS (`tsup --format cjs`) and
 * chalk v5 is ESM-only; rolling our own ~50 lines avoids the interop
 * dance and keeps the build simple. The palette below mirrors the brand
 * gold from `dashboard/src/app/globals.css:170-250` (#B8860B / #D4AF37);
 * we use the nearest SGR codes that work without 256-color support.
 *
 * NO_COLOR and FORCE_COLOR follow https://no-color.org and
 * https://force-color.org conventions:
 *   - NO_COLOR set to any non-empty value → never color
 *   - FORCE_COLOR=0 / 'false'             → never color (overrides TTY)
 *   - FORCE_COLOR set to anything else    → always color
 *   - Otherwise: color only when stdout is a TTY
 *
 * JSON-emitting code paths should call `outputMode()` and bypass `color.*`
 * + `banner()` entirely. The helpers below are no-ops when piping, so even
 * a forgotten check produces clean output to log files / pipes.
 */

const ESC = '\x1b[';

function isStdoutTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * True when colored output should be emitted. Inspected on every call so
 * tests / scripts can toggle `process.env.NO_COLOR` mid-run.
 */
export function shouldUseColor(): boolean {
  if (process.env.NO_COLOR && process.env.NO_COLOR !== '') return false;
  const force = process.env.FORCE_COLOR;
  if (force === '0' || force === 'false') return false;
  if (force !== undefined && force !== '') return true;
  return isStdoutTty();
}

/**
 * Output mode the current invocation should target. `json` is a caller-
 * supplied hint (when `--json` / `--format json` is set); the helper
 * itself only distinguishes interactive (`tty`) from piped (`pipe`).
 */
export type OutputMode = 'tty' | 'pipe' | 'json';
export function outputMode(opts?: { jsonRequested?: boolean }): OutputMode {
  if (opts?.jsonRequested) return 'json';
  if (!isStdoutTty()) return 'pipe';
  return 'tty';
}

function wrap(open: number, close = 39): (s: string) => string {
  return (s: string) => (shouldUseColor() ? `${ESC}${open}m${s}${ESC}${close}m` : s);
}

/**
 * Palette helpers. Each call returns the input string optionally wrapped
 * in the corresponding SGR codes. No-op when `shouldUseColor()` is false.
 */
export const color = {
  primary: wrap(33),                 // gold-ish yellow — brand
  accent: wrap(93),                  // bright yellow — accent
  muted: wrap(90),                   // dim grey — secondary text
  ok: wrap(32),                      // green — pass
  warn: wrap(33),                    // yellow — warning
  err: wrap(31),                     // red — failure
  bold: wrap(1, 22),                 // bold (close with 22 not 39)
  dim: wrap(2, 22),                  // dim (close with 22 not 39)
};

/**
 * Status markers. Unicode by default; ASCII fallback when stdout is not a
 * TTY (some log viewers garble the symbols).
 */
export const mark = {
  ok: () => (isStdoutTty() ? color.ok('✓') : color.ok('[OK]')),
  warn: () => (isStdoutTty() ? color.warn('⚠') : color.warn('[WARN]')),
  err: () => (isStdoutTty() ? color.err('✗') : color.err('[FAIL]')),
};

/**
 * Branded banner — a single accent-coloured line. Kept deliberately small
 * so it doesn't dominate the terminal; the audit explicitly cautioned
 * against figlet-style multi-line ASCII art.
 */
export function banner(label?: string): string {
  const head = color.bold(color.primary('cortextOS'));
  return label ? `${head} ${color.muted('·')} ${color.accent(label)}` : head;
}
