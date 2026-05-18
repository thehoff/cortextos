/**
 * CLI-side reader + writer for the instance branding.json file.
 *
 * Path: `~/.cortextos/{instance}/config/branding.json`. Owned by `cortextos
 * setup --white-label <name>` (writer) and the daemon / any CLI surface
 * that needs to know the current brand (reader, via #15's `getBrandName()`).
 *
 * The dashboard has its own reader at
 * `dashboard/src/lib/data/branding-config.ts` because it can't import
 * across the package boundary cleanly.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { isValidBrandColor, type BrandInstanceConfig } from './index.js';

function brandingConfigPath(instanceId: string): string {
  return join(homedir(), '.cortextos', instanceId, 'config', 'branding.json');
}

/**
 * Read + validate the instance branding config. Returns undefined when the
 * file is missing or unreadable. Invalid color values are silently dropped
 * so the resolver falls back to defaults rather than failing closed.
 */
export function readInstanceConfig(instanceId = process.env.CTX_INSTANCE_ID ?? 'default'): BrandInstanceConfig | undefined {
  const path = brandingConfigPath(instanceId);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out: BrandInstanceConfig = {};
  if (typeof obj.brandName === 'string' && obj.brandName.trim().length > 0) {
    out.brandName = obj.brandName.trim();
  }
  if (typeof obj.logoPath === 'string' && obj.logoPath.trim().length > 0) {
    out.logoPath = obj.logoPath.trim();
  }
  for (const k of ['primaryColorLight', 'primaryColorDark', 'accentColorLight', 'accentColorDark'] as const) {
    const v = obj[k];
    if (typeof v === 'string' && isValidBrandColor(v)) {
      out[k] = v.trim();
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Write a (potentially partial) branding config. Used by
 * `cortextos setup --white-label <name>`. Read-merge-write so existing
 * fields aren't trampled.
 */
export function writeInstanceConfig(
  patch: BrandInstanceConfig,
  instanceId = process.env.CTX_INSTANCE_ID ?? 'default',
): void {
  const path = brandingConfigPath(instanceId);
  mkdirSync(dirname(path), { recursive: true });
  const existing: BrandInstanceConfig = readInstanceConfig(instanceId) ?? {};
  const merged: BrandInstanceConfig = { ...existing, ...patch };
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  try { chmodSync(path, 0o600); } catch { /* ignore on Windows */ }
}
