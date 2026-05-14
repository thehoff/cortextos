/**
 * PR6 dashboard-local filesystem helpers for MCP server management.
 *
 * The dashboard does NOT import from the parent cortextos main src/ tree —
 * Next.js's bundler cannot follow the .js-extension NodeNext import
 * convention used there. So the dashboard re-implements the file ops it
 * needs (scaffold, wire, unwire), with a SLIM validator covering just
 * the mcp_servers entry shape. The full RunnerConfig validation still
 * runs at agent boot via the runtime's validateConfig — the dashboard's
 * check is a fast-fail layer, not the authoritative source of truth.
 *
 * Drift is intentionally bounded: the slim validator should accept
 * STRICTLY FEWER configs than the runtime. If they ever diverge, the
 * runtime rejection at agent boot surfaces it.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

export const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]*$/;
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export interface McpServerSpec {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  tool_timeout_sec?: number;
  env_inherit?: boolean;
}

/**
 * Slim validator for ONE mcp_servers entry. Same constraints as the
 * runtime's validateConfig section for mcp_servers, minus the duplicate-
 * name check (caller passes the existing entries so it can decide
 * whether to allow replacement).
 *
 * Codex pass-2 PR6-019: env-key restrictions intentionally deferred to
 * the runtime's full validateConfig. If the runtime adds an env-name
 * blocklist in the future, the dashboard's slim check should be kept
 * narrower than the runtime so any drift surfaces as a runtime
 * rejection at agent boot rather than a dashboard accept of something
 * the runtime rejects.
 */
export function validateMcpServerSpec(raw: unknown): McpServerSpec {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('mcp_servers entry must be an object');
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || s.name.length === 0 || s.name.length > 32) {
    throw new Error('mcp_servers[].name must be a non-empty string of length <= 32');
  }
  if (!MCP_SERVER_NAME_RE.test(s.name)) {
    throw new Error(`mcp_servers[].name "${s.name}" must match /^[a-z][a-z0-9-]*$/`);
  }
  if (typeof s.command !== 'string' || s.command.length === 0 || s.command.length > 256) {
    throw new Error('mcp_servers[].command must be a non-empty string of length <= 256');
  }
  // Codex PR6-020 (HIGH): mirror the runtime's PR5-026 path-traversal +
  // config-file-shape guards on `command`. Without these, the dashboard
  // can persist a config that fails at agent boot with an opaque
  // FATAL line. Slim validator stays a subset of validateConfig: any
  // future drift surfaces at boot rather than as a silent dashboard
  // accept of a runtime-rejected shape.
  if (s.command.includes('..')) {
    throw new Error('mcp_servers[].command must not contain ".." (path-traversal guard)');
  }
  if (s.command.toLowerCase().endsWith('.json')) {
    throw new Error('mcp_servers[].command must not end with ".json" — set "command" to the interpreter (e.g. "node", "tsx") and put the script in "args"');
  }
  if (s.args !== undefined) {
    if (!Array.isArray(s.args) || s.args.length > 32) {
      throw new Error('mcp_servers[].args must be an array of length <= 32');
    }
    for (const a of s.args) {
      if (typeof a !== 'string' || a.length > 1024 || /\x00/.test(a)) {
        throw new Error('mcp_servers[].args entries must be strings of length <= 1024 with no NUL');
      }
    }
  }
  if (s.env !== undefined) {
    if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) {
      throw new Error('mcp_servers[].env must be an object');
    }
    for (const [k, v] of Object.entries(s.env)) {
      if (!ENV_VAR_NAME_RE.test(k)) {
        throw new Error(`mcp_servers[].env key "${k}" must match /^[A-Z][A-Z0-9_]*$/`);
      }
      if (typeof v !== 'string' || v.length > 4096 || /\x00/.test(v)) {
        throw new Error(`mcp_servers[].env["${k}"] must be a string of length <= 4096 with no NUL`);
      }
    }
  }
  if (s.cwd !== undefined) {
    if (typeof s.cwd !== 'string' || s.cwd.length === 0 || s.cwd.length > 1024) {
      throw new Error('mcp_servers[].cwd must be a non-empty string of length <= 1024');
    }
    // Codex PR6-020 (HIGH): mirror PR5-027's absolute-or-explicit-relative
    // cwd guard. A plain `relative/path` would resolve against the
    // runner's process cwd at spawn time, rarely what the operator
    // intended.
    const isAbsolute = s.cwd.startsWith('/');
    const isExplicitRelative = s.cwd.startsWith('./') || s.cwd.startsWith('../');
    if (!isAbsolute && !isExplicitRelative) {
      throw new Error(`mcp_servers[].cwd must be absolute (starting with "/") or start with "./" or "../" (got ${JSON.stringify(s.cwd)})`);
    }
  }
  if (s.tool_timeout_sec !== undefined && (typeof s.tool_timeout_sec !== 'number' || s.tool_timeout_sec < 1 || s.tool_timeout_sec > 600)) {
    throw new Error('mcp_servers[].tool_timeout_sec must be a number in [1, 600]');
  }
  if (s.env_inherit !== undefined && typeof s.env_inherit !== 'boolean') {
    throw new Error('mcp_servers[].env_inherit must be a boolean');
  }
  return s as unknown as McpServerSpec;
}

export class ScaffoldDestExistsError extends Error {
  readonly code = 'EEXIST';
  constructor(destDir: string) {
    super(`destination already exists: ${destDir}`);
    this.name = 'ScaffoldDestExistsError';
  }
}

function renderPackageJson(name: string): string {
  return JSON.stringify({
    name: `mcp-server-${name}`,
    version: '0.1.0',
    description: `MCP server: ${name}`,
    type: 'module',
    main: 'dist/index.js',
    scripts: { build: 'tsc', start: 'node dist/index.js', dev: 'tsx src/index.ts' },
    dependencies: { '@modelcontextprotocol/sdk': '1.29.0' },
    devDependencies: { '@types/node': '^20.0.0', typescript: '^5.0.0', tsx: '^4.0.0' },
  }, null, 2) + '\n';
}

function renderTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      outDir: 'dist', rootDir: 'src', strict: true, esModuleInterop: true,
      skipLibCheck: true, declaration: false,
    },
    include: ['src/**/*.ts'],
  }, null, 2) + '\n';
}

function renderIndexTs(name: string): string {
  return `import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: '${name}', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'hello',
      description: 'Returns a greeting. Replace this with a real tool.',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: [] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'hello') {
    const who = (req.params.arguments as { who?: string } | undefined)?.who ?? 'world';
    return { content: [{ type: 'text', text: \`hello from ${name} to \${who}\` }] };
  }
  return { content: [{ type: 'text', text: \`unknown tool: \${req.params.name}\` }], isError: true };
});

void server.connect(new StdioServerTransport());
`;
}

function renderReadme(name: string): string {
  return `# MCP server: ${name}\n\nCreated from the cortextOS dashboard. Build with \`npm install && npm run build\`, then wire into agents from their detail page.\n`;
}

export interface ScaffoldOptions { serverName: string; destDir: string; }
export interface ScaffoldResult { filesWritten: string[]; }

export function writeMcpScaffold(opts: ScaffoldOptions): ScaffoldResult {
  if (!MCP_SERVER_NAME_RE.test(opts.serverName)) {
    throw new Error(`MCP server name "${opts.serverName}" must match /^[a-z][a-z0-9-]*$/`);
  }
  if (existsSync(opts.destDir)) {
    throw new ScaffoldDestExistsError(opts.destDir);
  }
  try {
    mkdirSync(opts.destDir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new ScaffoldDestExistsError(opts.destDir);
    if (code === 'ENOENT') throw new Error(`parent directory does not exist for ${opts.destDir}`);
    throw err;
  }
  mkdirSync(join(opts.destDir, 'src'), { recursive: false });

  const written: string[] = [];
  const write = (rel: string, content: string): void => {
    const abs = join(opts.destDir, rel);
    writeFileSync(abs, content);
    written.push(abs);
  };
  write('package.json', renderPackageJson(opts.serverName));
  write('tsconfig.json', renderTsconfig());
  write('src/index.ts', renderIndexTs(opts.serverName));
  write('README.md', renderReadme(opts.serverName));
  return { filesWritten: written };
}

export interface WireOptions {
  agentConfigPath: string;
  serverEntry: McpServerSpec;
  force?: boolean;
}
export interface WireResult {
  added: boolean;
  existingEntry?: McpServerSpec;
}

export function wireMcpServerToAgent(opts: WireOptions): WireResult {
  validateMcpServerSpec(opts.serverEntry);
  if (!existsSync(opts.agentConfigPath)) {
    throw new Error(`agent config not found: ${opts.agentConfigPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(opts.agentConfigPath, 'utf-8'));
  } catch (err) {
    throw new Error(`agent config at ${opts.agentConfigPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`agent config at ${opts.agentConfigPath} is not a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;
  const existing = Array.isArray(cfg.mcp_servers) ? (cfg.mcp_servers as McpServerSpec[]) : [];
  const existingEntry = existing.find(e => e.name === opts.serverEntry.name);
  if (existingEntry && !opts.force) {
    return { added: false, existingEntry };
  }
  const newList = existing.filter(e => e.name !== opts.serverEntry.name);
  newList.push(opts.serverEntry);
  const merged: Record<string, unknown> = { ...cfg, mcp_servers: newList };

  const tmpPath = `${opts.agentConfigPath}.wire-${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmpPath, opts.agentConfigPath);
  return { added: true, ...(existingEntry ? { existingEntry } : {}) };
}

export interface UnwireOptions {
  agentConfigPath: string;
  serverName: string;
}
export interface UnwireResult {
  removed: boolean;
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
    throw new Error(`agent config at ${opts.agentConfigPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`agent config at ${opts.agentConfigPath} is not a JSON object`);
  }
  const cfg = raw as Record<string, unknown>;
  const existing = Array.isArray(cfg.mcp_servers) ? (cfg.mcp_servers as McpServerSpec[]) : [];
  const removedEntry = existing.find(e => e.name === opts.serverName);
  if (!removedEntry) return { removed: false };

  // Codex pass-2 PR6-013: if cfg.tools[] references any qualified tool
  // belonging to the server we're about to remove, unwiring will produce
  // a config that fails the runtime's phase-1 validation at agent boot
  // (a dangling `mcp__<server>__<tool>` reference). Reject the unwire
  // here with a clear error so the operator removes the tools[] entries
  // first instead of getting a FATAL when they restart.
  if (Array.isArray(cfg.tools)) {
    const underscored = opts.serverName.replace(/-/g, '_');
    const referencing = (cfg.tools as unknown[]).filter(
      (t): t is string => typeof t === 'string' && t.startsWith(`mcp__${underscored}__`),
    );
    if (referencing.length > 0) {
      throw new Error(
        `cannot unwire "${opts.serverName}": tools[] still references ${referencing.join(', ')}. Remove those entries from tools[] first.`,
      );
    }
  }

  const newList = existing.filter(e => e.name !== opts.serverName);
  const merged: Record<string, unknown> =
    newList.length > 0
      ? { ...cfg, mcp_servers: newList }
      : (() => { const { mcp_servers: _drop, ...rest } = cfg; return rest; })();

  const tmpPath = `${opts.agentConfigPath}.unwire-${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2) + '\n');
  renameSync(tmpPath, opts.agentConfigPath);
  return { removed: true, removedEntry };
}
