/**
 * Pure-function MCP-server-from-agent removal.
 *
 * Mirror of src/mcp/wire.ts for the reverse operation. Removes a named
 * mcp_servers entry from an agent's config.json. Used by the dashboard's
 * DELETE /api/agents/[name]/mcp-servers/[server] route (PR6).
 *
 * Same dependency-light shape as wire.ts: only node:* + the shared
 * config-validation module. No CLI or runner internals.
 *
 * Codex pass-1 PR6-011: validates the resulting config before writing
 * (so removing an entry that leaves the config in an invalid shape
 * fails cleanly) and uses a per-call random tmp filename (so concurrent
 * wire/unwire calls don't clobber a shared tmp).
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { validateConfig, type McpServerSpec } from '../openai-runner/config.js';

export interface UnwireOptions {
  /** Absolute path to the agent's config.json. */
  agentConfigPath: string;
  /** Name of the mcp_servers entry to remove. */
  serverName: string;
}

export interface UnwireResult {
  /** True when an entry was removed; false when no entry with that name existed. */
  removed: boolean;
  /** The entry that was removed (if removed:true). */
  removedEntry?: McpServerSpec;
}

export function unwireMcpServerFromAgent(opts: UnwireOptions): UnwireResult {
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
  const removedEntry = existing.find(e => e.name === opts.serverName);

  if (!removedEntry) {
    return { removed: false };
  }

  const newList = existing.filter(e => e.name !== opts.serverName);
  // Drop the field entirely when empty so a fresh-config-shape unwire
  // returns the file to its pre-PR5 state (rather than an empty array).
  const mergedCfg: Record<string, unknown> =
    newList.length > 0
      ? { ...cfg, mcp_servers: newList }
      : (() => { const { mcp_servers: _drop, ...rest } = cfg; return rest; })();

  // Validate before writing — guards against the (unlikely) case where
  // removing a server leaves a referenced tool name in `tools[]` that
  // becomes invalid. validateConfig phase-1 catches that.
  validateConfig(mergedCfg);

  const tmpPath = `${opts.agentConfigPath}.unwire-${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(mergedCfg, null, 2) + '\n');
  renameSync(tmpPath, opts.agentConfigPath);

  return { removed: true, removedEntry };
}
