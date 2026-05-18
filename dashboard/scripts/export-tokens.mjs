#!/usr/bin/env node
/**
 * Design-token export — generates `public/brand/tokens.{json,css}` from
 * `src/app/globals.css`. Run via `npm run postbuild` (auto), or directly with
 * `node scripts/export-tokens.mjs`.
 *
 * Why: theme tokens are the source-of-truth for cortextOS branding. Marketing
 * sites, mobile companions, and downstream embedded surfaces need to import
 * them without copy-pasting OKLCh values (which silently drift). Issue #13.
 *
 * The script is intentionally dep-free (plain Node ESM + regex parser) so the
 * build chain doesn't grow a new dependency for one postbuild hook.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_ROOT = join(__dirname, '..');
const GLOBALS_CSS = join(DASHBOARD_ROOT, 'src/app/globals.css');
const OUT_DIR = join(DASHBOARD_ROOT, 'public/brand');
const OUT_JSON = join(OUT_DIR, 'tokens.json');
const OUT_CSS = join(OUT_DIR, 'tokens.css');

const TOKEN_RE = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+?);/gm;

/**
 * Extract the body of `<selector> { … }` (matching nested braces). Returns
 * the contents between the outer braces.
 */
export function extractBlock(css, selector) {
  // Anchor on `<selector> {` — `:root {` and `.dark {` are simple block
  // openers in globals.css. We don't try to handle selector groups or media
  // queries; if those ever appear, raise the requirement explicitly here.
  const opener = `${selector} {`;
  const start = css.indexOf(opener);
  if (start < 0) throw new Error(`Block not found: ${selector}`);
  const blockStart = start + opener.length;
  let depth = 1;
  let i = blockStart;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth > 0) i++;
  }
  return css.slice(blockStart, i);
}

/**
 * Parse `--name: value;` declarations out of a CSS block. Returns an ordered
 * map (object preserves insertion order in modern JS).
 */
export function parseTokens(block) {
  const tokens = {};
  for (const match of block.matchAll(TOKEN_RE)) {
    const [, name, value] = match;
    tokens[name] = value.trim();
  }
  return tokens;
}

/**
 * Theme tokens only — exclude spacing/layout/density tokens that share the
 * same `:root` block but aren't part of the brand palette.
 */
export function isThemeToken(name) {
  if (name.startsWith('--space-')) return false;
  if (name.startsWith('--height-')) return false;
  if (name.startsWith('--density-')) return false;
  if (name.startsWith('--font-')) return false;
  return true;
}

export function filterTokens(tokens) {
  return Object.fromEntries(
    Object.entries(tokens).filter(([name]) => isThemeToken(name))
  );
}

export function renderCss(light, dark) {
  return [
    '/* AUTO-GENERATED from dashboard/src/app/globals.css */',
    '/* Source of truth: that file. DO NOT edit this one — re-run `npm run build`. */',
    '',
    ':root {',
    ...Object.entries(light).map(([k, v]) => `  ${k}: ${v};`),
    '}',
    '',
    '.dark {',
    ...Object.entries(dark).map(([k, v]) => `  ${k}: ${v};`),
    '}',
    '',
  ].join('\n');
}

export function renderJson(light, dark) {
  return JSON.stringify({
    $schema: 'cortextos-design-tokens-v1',
    source: 'dashboard/src/app/globals.css',
    light,
    dark,
  }, null, 2) + '\n';
}

function main() {
  const css = readFileSync(GLOBALS_CSS, 'utf-8');
  const light = filterTokens(parseTokens(extractBlock(css, ':root')));
  const dark = filterTokens(parseTokens(extractBlock(css, '.dark')));

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_JSON, renderJson(light, dark), 'utf-8');
  writeFileSync(OUT_CSS, renderCss(light, dark), 'utf-8');

  console.log(
    `[export-tokens] ${Object.keys(light).length} light + ` +
    `${Object.keys(dark).length} dark theme tokens → public/brand/{tokens.json,tokens.css}`
  );
}

// Only run if invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
