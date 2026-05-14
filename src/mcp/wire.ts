/**
 * Pure-function MCP-server-to-agent wiring.
 *
 * Appends an `mcp_servers` entry to an agent's config.json. Used by
 * the CLI's `cortextos add-mcp` command and (in PR6) by the daemon
 * HTTP endpoint backing the dashboard's "Wire MCP" UI.
 *
 * Depends only on src/openai-runner/config.ts (for validateConfig)
 * and node:* builtins — no CLI or runner internals.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { validateConfig, type McpServerSpec } from '../openai-runner/config.js';

export interface WireOptions {
  /** Absolute path to the agent's config.json. */
  agentConfigPath: string;
  /** The mcp_servers entry to add. Includes name, command, args, etc. */
  serverEntry: McpServerSpec;
  /** When true, replace an existing entry with the same name. Default false. */
  force?: boolean;
}

export interface WireResult {
  /** True when the entry was added (or replaced); false when the entry already existed and force was not set. */
  added: boolean;
  /** The existing entry under the same name, if there was one. */
  existingEntry?: McpServerSpec;
}

export function wireMcpServerToAgent(opts: WireOptions): WireResult {
  if (!existsSync(opts.agentConfigPath)) {
    throw new Error(`agent config not found: ${opts.agentConfigPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.agentConfigPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `agent config at ${opts.agentConfigPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`agent config at ${opts.agentConfigPath} is not a JSON object`);
  }

  const cfg = raw as Record<string, unknown>;
  const existing = Array.isArray(cfg.mcp_servers) ? (cfg.mcp_servers as McpServerSpec[]) : [];
  const existingByName = new Map(existing.map(e => [e.name, e]));
  const existingEntry = existingByName.get(opts.serverEntry.name);

  if (existingEntry !== undefined && !opts.force) {
    return { added: false, existingEntry };
  }

  // Build the new list. If we're replacing, drop the old entry first.
  const newList = existing.filter(e => e.name !== opts.serverEntry.name);
  newList.push(opts.serverEntry);

  const mergedCfg: Record<string, unknown> = { ...cfg, mcp_servers: newList };

  // Validate BEFORE writing so a typo in serverEntry doesn't produce
  // a broken file on disk.
  validateConfig(mergedCfg);

  // Atomic-ish write: write to tmp, rename. Pretty-print to keep the
  // file diff-friendly. Codex pass-1 PR6-002 (HIGH): per-call random
  // suffix so concurrent wire/unwire calls against the same agent
  // can't clobber a shared tmp file even if the dashboard's per-agent
  // lock fails open.
  const tmpPath = `${opts.agentConfigPath}.wire-${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(mergedCfg, null, 2) + '\n');
  renameSync(tmpPath, opts.agentConfigPath);

  return { added: true, ...(existingEntry !== undefined ? { existingEntry } : {}) };
}
