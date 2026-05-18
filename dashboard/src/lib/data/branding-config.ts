/**
 * Dashboard-side reader for the instance branding.json file.
 *
 * Mirrors `src/branding/instance-config.ts:readInstanceConfig` (CLI side)
 * because the dashboard can't import across the package boundary.
 *
 * Path: `~/.cortextos/{instance}/config/branding.json`. Read once per
 * page load in the dashboard layout and passed through to client surfaces
 * as an `instanceConfig` prop on the org/branding provider.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { isValidBrandColor, type BrandInstanceConfig } from '@/lib/branding';

function brandingConfigPath(instanceId: string): string {
  return path.join(os.homedir(), '.cortextos', instanceId, 'config', 'branding.json');
}

/**
 * Read + validate the instance branding config. Returns undefined when the
 * file is missing or unreadable. Invalid color values are silently dropped.
 */
export function readBrandingConfig(
  instanceId: string = process.env.CTX_INSTANCE_ID ?? 'default',
): BrandInstanceConfig | undefined {
  const filePath = brandingConfigPath(instanceId);
  if (!fs.existsSync(filePath)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
