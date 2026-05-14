/**
 * Config schema + validator + resolver helpers for the openai-compatible
 * runtime.
 *
 * Lives at the top of src/openai-runner/ (not under src/cli/) so that
 * non-CLI consumers can import the schema + validator without pulling in
 * the runner's bus / paths / commander dependencies. PR6's daemon HTTP
 * routes and PR5's wire.ts both import from here.
 *
 * Depends only on node:* builtins + the TOOL_REGISTRY for tool-name
 * cross-reference validation.
 */
import { TOOL_REGISTRY } from './tools/index.js';
import type { McpServerSpec } from './mcp/types.js';

export type { McpServerSpec };

export interface RunnerConfig {
  endpoint: string;
  model: string;
  api_key?: string;
  /** Name of a process.env variable holding the API key. Mutually exclusive with api_key. */
  api_key_env?: string;
  /** Extra HTTP headers merged into every /v1/chat/completions request. Cannot override Content-Type or Authorization. */
  headers?: Record<string, string>;
  /** Informational provider tag. Some values (e.g. "openrouter") trigger default headers. */
  provider?: string;
  max_tokens?: number;
  temperature?: number;
  heartbeat_interval_sec?: number;
  request_timeout_sec?: number;
  /** Names of tools (from TOOL_REGISTRY) the model can call. Empty/absent = no tools. */
  tools?: string[];
  /** Max number of tool-call iterations per inbox message. Default 5. */
  tool_loop_max_iterations?: number;
  /** Global per-tool timeout in seconds. Default 10. */
  tool_timeout_sec?: number;
  /** Per-tool timeout overrides in seconds. */
  tool_timeouts_sec?: Record<string, number>;
  /** Cap on bus_send_message calls per inbox message. Default 3. */
  tool_bus_send_budget?: number;
  /** MCP servers this agent spawns at boot. */
  mcp_servers?: McpServerSpec[];
  /** Total boot-timeout budget (seconds) for ALL MCP servers, parallel. Default 30. */
  mcp_boot_timeout_sec?: number;
  /** Default per-tool timeout (seconds) for MCP-discovered tools. Default 30. */
  mcp_tool_timeout_sec?: number;
}

const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const HTTP_HEADER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const PROVIDER_TAG_RE = /^[a-z][a-z0-9-]*$/;
const RESERVED_HEADER_NAMES_LOWER = new Set(['content-type', 'authorization']);
const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]*$/;
/** Syntactic shape for an mcp__<server>__<tool> qualified tool name in tools[]. */
const MCP_QUALIFIED_TOOL_NAME_RE = /^mcp__[a-z][a-z0-9_]*__[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENV_VAR_REF_RE = /^\$([A-Z][A-Z0-9_]*)$/;

export function validateConfig(raw: unknown): RunnerConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config.json must be a JSON object');
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.endpoint !== 'string' || !/^https?:\/\//.test(c.endpoint)) {
    throw new Error('config.json: "endpoint" must be a string starting with http:// or https://');
  }
  if (typeof c.model !== 'string' || !c.model) {
    throw new Error('config.json: "model" must be a non-empty string');
  }
  if (c.api_key !== undefined) {
    if (typeof c.api_key !== 'string' || c.api_key.length === 0 || c.api_key.length > 512) {
      throw new Error('config.json: "api_key" must be a non-empty string of length <= 512');
    }
  }
  if (c.api_key_env !== undefined) {
    if (typeof c.api_key_env !== 'string' || c.api_key_env.length === 0 || c.api_key_env.length > 64) {
      throw new Error('config.json: "api_key_env" must be a non-empty string of length <= 64');
    }
    if (!ENV_VAR_NAME_RE.test(c.api_key_env)) {
      throw new Error(`config.json: "api_key_env" must match /^[A-Z][A-Z0-9_]*$/ (got ${JSON.stringify(c.api_key_env)})`);
    }
  }
  if (c.api_key !== undefined && c.api_key_env !== undefined) {
    throw new Error('config.json: "api_key" and "api_key_env" are mutually exclusive; pick one');
  }
  if (c.headers !== undefined) {
    if (typeof c.headers !== 'object' || c.headers === null || Array.isArray(c.headers)) {
      throw new Error('config.json: "headers" must be an object of header-name → string');
    }
    for (const [k, v] of Object.entries(c.headers)) {
      if (typeof k !== 'string' || k.length === 0 || k.length > 64) {
        throw new Error(`config.json: headers key must be a string of length 1..64 (got ${JSON.stringify(k)})`);
      }
      if (!HTTP_HEADER_NAME_RE.test(k)) {
        throw new Error(`config.json: headers key ${JSON.stringify(k)} must match /^[A-Za-z][A-Za-z0-9-]*$/`);
      }
      if (RESERVED_HEADER_NAMES_LOWER.has(k.toLowerCase())) {
        throw new Error(`config.json: header ${JSON.stringify(k)} is reserved by the runner (Content-Type, Authorization)`);
      }
      if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
        throw new Error(`config.json: headers[${JSON.stringify(k)}] must be a non-empty string of length <= 512`);
      }
      // Per RFC 7230 §3.2.6, a header field-value is HTAB + visible-ASCII
      // (0x21-0x7E) + SP. Anything outside that range (CR, LF, NUL, other
      // control chars, or bytes >= 0x7F) is rejected by undici's native
      // fetch at call time, which would surface as an uncaught TypeError
      // inside the message loop. Reject at boot instead so the failure
      // surfaces as a clear FATAL config error.
      if (/[^\t\x20-\x7e]/.test(v)) {
        throw new Error(
          `config.json: headers[${JSON.stringify(k)}] must contain only HTAB and printable ASCII (0x20-0x7E)`,
        );
      }
    }
  }
  if (c.provider !== undefined) {
    if (typeof c.provider !== 'string' || c.provider.length === 0 || c.provider.length > 32) {
      throw new Error('config.json: "provider" must be a non-empty string of length <= 32');
    }
    if (!PROVIDER_TAG_RE.test(c.provider)) {
      throw new Error(`config.json: "provider" must match /^[a-z][a-z0-9-]*$/ (got ${JSON.stringify(c.provider)})`);
    }
  }
  if (c.max_tokens !== undefined && (typeof c.max_tokens !== 'number' || c.max_tokens < 1 || c.max_tokens > 100000)) {
    throw new Error('config.json: "max_tokens" must be a number in [1, 100000]');
  }
  if (c.temperature !== undefined && (typeof c.temperature !== 'number' || c.temperature < 0 || c.temperature > 2)) {
    throw new Error('config.json: "temperature" must be a number in [0, 2]');
  }
  if (c.heartbeat_interval_sec !== undefined && (typeof c.heartbeat_interval_sec !== 'number' || c.heartbeat_interval_sec < 5)) {
    throw new Error('config.json: "heartbeat_interval_sec" must be a number >= 5');
  }
  if (c.request_timeout_sec !== undefined && (typeof c.request_timeout_sec !== 'number' || c.request_timeout_sec < 1)) {
    throw new Error('config.json: "request_timeout_sec" must be a positive number');
  }
  // mcp_servers validation runs BEFORE tools[] validation so the
  // phase-1 syntactic check can reference the configured server names.
  const declaredMcpServerNames = new Set<string>();
  if (c.mcp_servers !== undefined) {
    if (!Array.isArray(c.mcp_servers)) {
      throw new Error('config.json: "mcp_servers" must be an array');
    }
    for (let i = 0; i < c.mcp_servers.length; i++) {
      const raw = c.mcp_servers[i];
      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`config.json: mcp_servers[${i}] must be an object`);
      }
      const s = raw as Record<string, unknown>;
      if (typeof s.name !== 'string' || s.name.length === 0 || s.name.length > 32) {
        throw new Error(`config.json: mcp_servers[${i}].name must be a non-empty string of length <= 32`);
      }
      if (!MCP_SERVER_NAME_RE.test(s.name)) {
        throw new Error(`config.json: mcp_servers[${i}].name "${s.name}" must match /^[a-z][a-z0-9-]*$/`);
      }
      if (declaredMcpServerNames.has(s.name)) {
        throw new Error(`config.json: mcp_servers contains duplicate name "${s.name}"`);
      }
      declaredMcpServerNames.add(s.name);
      if (typeof s.command !== 'string' || s.command.length === 0 || s.command.length > 256) {
        throw new Error(`config.json: mcp_servers["${s.name}"].command must be a non-empty string of length <= 256`);
      }
      // PR5-026 (Codex pass-3): PLAN §5.1 trivially-wrong-input guards.
      // Operators can run arbitrary subprocesses through this field — that's
      // intentional — but ".." (path-traversal) and a .json suffix (operator
      // confused the command field with a config-file path) are mistake
      // shapes worth catching at boot rather than as an opaque ENOENT.
      if (s.command.includes('..')) {
        throw new Error(
          `config.json: mcp_servers["${s.name}"].command must not contain ".." (path-traversal guard)`,
        );
      }
      if (s.command.toLowerCase().endsWith('.json')) {
        throw new Error(
          `config.json: mcp_servers["${s.name}"].command must not end with ".json" — set "command" to the interpreter (e.g. "node", "tsx") and put the script in "args"`,
        );
      }
      if (s.args !== undefined) {
        if (!Array.isArray(s.args) || s.args.length > 32) {
          throw new Error(`config.json: mcp_servers["${s.name}"].args must be an array of length <= 32`);
        }
        for (const a of s.args) {
          if (typeof a !== 'string' || a.length > 1024 || /\x00/.test(a)) {
            throw new Error(`config.json: mcp_servers["${s.name}"].args entries must be strings of length <= 1024 with no NUL`);
          }
        }
      }
      if (s.env !== undefined) {
        if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) {
          throw new Error(`config.json: mcp_servers["${s.name}"].env must be an object`);
        }
        for (const [k, v] of Object.entries(s.env)) {
          if (!ENV_VAR_NAME_RE.test(k)) {
            throw new Error(`config.json: mcp_servers["${s.name}"].env key "${k}" must match /^[A-Z][A-Z0-9_]*$/`);
          }
          if (typeof v !== 'string' || v.length > 4096 || /\x00/.test(v)) {
            throw new Error(`config.json: mcp_servers["${s.name}"].env["${k}"] must be a string of length <= 4096 with no NUL`);
          }
        }
      }
      if (s.cwd !== undefined) {
        if (typeof s.cwd !== 'string' || s.cwd.length === 0 || s.cwd.length > 1024) {
          throw new Error(`config.json: mcp_servers["${s.name}"].cwd must be a non-empty string of length <= 1024`);
        }
        // PR5-027 (Codex pass-3): PLAN §5.1 — cwd must be absolute or
        // an explicit "./" / "../"-prefixed relative path that the
        // manager will resolve against the agent directory. Plain
        // relative paths like "mcp-servers/foo" silently resolve
        // against the runner's process cwd, which is rarely what
        // operators expect.
        const isAbsolute = s.cwd.startsWith('/');
        const isExplicitRelative = s.cwd.startsWith('./') || s.cwd.startsWith('../');
        if (!isAbsolute && !isExplicitRelative) {
          throw new Error(
            `config.json: mcp_servers["${s.name}"].cwd must be absolute (starting with "/") or start with "./" or "../" (got ${JSON.stringify(s.cwd)})`,
          );
        }
      }
      if (s.tool_timeout_sec !== undefined && (typeof s.tool_timeout_sec !== 'number' || s.tool_timeout_sec < 1 || s.tool_timeout_sec > 600)) {
        throw new Error(`config.json: mcp_servers["${s.name}"].tool_timeout_sec must be a number in [1, 600]`);
      }
      if (s.env_inherit !== undefined && typeof s.env_inherit !== 'boolean') {
        throw new Error(`config.json: mcp_servers["${s.name}"].env_inherit must be a boolean`);
      }
    }
  }
  if (c.mcp_boot_timeout_sec !== undefined && (typeof c.mcp_boot_timeout_sec !== 'number' || c.mcp_boot_timeout_sec < 1 || c.mcp_boot_timeout_sec > 600)) {
    throw new Error('config.json: "mcp_boot_timeout_sec" must be a number in [1, 600]');
  }
  if (c.mcp_tool_timeout_sec !== undefined && (typeof c.mcp_tool_timeout_sec !== 'number' || c.mcp_tool_timeout_sec < 1 || c.mcp_tool_timeout_sec > 600)) {
    throw new Error('config.json: "mcp_tool_timeout_sec" must be a number in [1, 600]');
  }
  if (c.tools !== undefined) {
    if (!Array.isArray(c.tools) || c.tools.some(t => typeof t !== 'string')) {
      throw new Error('config.json: "tools" must be an array of strings');
    }
    // Codex M6 + PR5-003: phase-1 syntactic check. A name is valid here if it
    // EITHER references a builtin tool OR matches the mcp__<server>__<tool>
    // shape AND points at a declared mcp_servers entry. Existence of the
    // tool on the running MCP server is phase-2, checked at boot after the
    // server is up. The error preserves PR3's wording for builtin typos.
    const unknown: string[] = [];
    for (const name of c.tools as string[]) {
      if (name in TOOL_REGISTRY) continue;
      const mcpMatch = name.match(/^mcp__([a-z][a-z0-9_]*)__/);
      if (mcpMatch) {
        // Convert the underscored server-name back to the kebab form used
        // in mcp_servers[].name (manager.ts replaces hyphens with underscores
        // when building qualified names). Either direction is acceptable
        // here for shape — we only check that the syntactic form is valid
        // and SOME declared server matches.
        if (!MCP_QUALIFIED_TOOL_NAME_RE.test(name)) {
          unknown.push(name);
          continue;
        }
        const underscoredName = mcpMatch[1]!;
        // Check against both raw and hyphen-flipped forms (mcp__foo_bar__x
        // could come from server name "foo-bar" or "foo_bar"). The server
        // name regex disallows underscores in mcp_servers[].name so the
        // only way to match an underscored prefix is via the hyphen-flip.
        const kebab = underscoredName.replace(/_/g, '-');
        if (!declaredMcpServerNames.has(underscoredName) && !declaredMcpServerNames.has(kebab)) {
          unknown.push(name);
        }
        continue;
      }
      unknown.push(name);
    }
    if (unknown.length > 0) {
      throw new Error(
        `config.json: unknown tool(s) in "tools": ${unknown.join(', ')}. ` +
        `Available builtins: ${Object.keys(TOOL_REGISTRY).join(', ')}` +
        (declaredMcpServerNames.size > 0
          ? `; declared MCP servers: ${[...declaredMcpServerNames].join(', ')} (use mcp__<server>__<tool> form, where <server> hyphens become underscores)`
          : ''),
      );
    }
  }
  if (c.tool_loop_max_iterations !== undefined && (typeof c.tool_loop_max_iterations !== 'number' || c.tool_loop_max_iterations < 1)) {
    throw new Error('config.json: "tool_loop_max_iterations" must be a positive number');
  }
  if (c.tool_timeout_sec !== undefined && (typeof c.tool_timeout_sec !== 'number' || c.tool_timeout_sec < 1)) {
    throw new Error('config.json: "tool_timeout_sec" must be a positive number');
  }
  if (c.tool_timeouts_sec !== undefined) {
    // Codex P3-4: validate each entry. Otherwise a typo in a tool name or
    // a string value silently produces broken timeout policy that's hard
    // to diagnose from runtime behavior alone.
    if (typeof c.tool_timeouts_sec !== 'object' || c.tool_timeouts_sec === null || Array.isArray(c.tool_timeouts_sec)) {
      throw new Error('config.json: "tool_timeouts_sec" must be an object of tool-name → seconds');
    }
    for (const [k, v] of Object.entries(c.tool_timeouts_sec)) {
      // PR5: accept either builtin names or mcp__-shaped qualified names.
      // Phase-2 validation at boot covers whether the MCP tool actually
      // exists on the running server.
      const looksLikeMcp = k.startsWith('mcp__') && MCP_QUALIFIED_TOOL_NAME_RE.test(k);
      if (!(k in TOOL_REGISTRY) && !looksLikeMcp) {
        throw new Error(
          `config.json: tool_timeouts_sec key "${k}" is not a known tool. ` +
          `Available builtins: ${Object.keys(TOOL_REGISTRY).join(', ')}; ` +
          `MCP tools use the mcp__<server>__<tool> form.`,
        );
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
        throw new Error(`config.json: tool_timeouts_sec["${k}"] must be a finite number >= 1 (got ${JSON.stringify(v)})`);
      }
    }
  }
  if (c.tool_bus_send_budget !== undefined && (typeof c.tool_bus_send_budget !== 'number' || c.tool_bus_send_budget < 0)) {
    throw new Error('config.json: "tool_bus_send_budget" must be a non-negative number');
  }
  return c as unknown as RunnerConfig;
}

/**
 * Resolve the API key for this runner instance. Precedence:
 *
 *   1. cfg.api_key_env → process.env[cfg.api_key_env] — fail-fast if unset.
 *   2. cfg.api_key (committed in config.json — fine for local LLMs that
 *      ignore Authorization, dangerous for hosted providers).
 *   3. process.env.OPENAI_API_KEY (back-compat fallback from PR3 era).
 *
 * Throwing here is caught by the same outer try/catch that wraps
 * validateConfig at main() → emits FATAL: ... on stderr, exit 1.
 */
export function resolveApiKey(cfg: RunnerConfig): string | undefined {
  if (cfg.api_key_env !== undefined) {
    const v = process.env[cfg.api_key_env];
    if (!v) {
      throw new Error(
        `api_key_env "${cfg.api_key_env}" is unset or empty in the environment`,
      );
    }
    return v;
  }
  if (cfg.api_key !== undefined) return cfg.api_key;
  return process.env['OPENAI_API_KEY'];
}

/**
 * Materialize the effective HTTP headers to send on every LLM request.
 * Provider-specific defaults (currently: provider="openrouter" injects
 * HTTP-Referer + X-Title for leaderboard attribution) are applied first;
 * the operator's `headers` from config.json are merged on top with
 * case-insensitive dedup.
 */
export function resolveExtraHeaders(cfg: RunnerConfig): Record<string, string> {
  const seenLower = new Map<string, string>();
  const result: Record<string, string> = {};

  const setHeader = (key: string, value: string): void => {
    const lc = key.toLowerCase();
    const existing = seenLower.get(lc);
    if (existing !== undefined) {
      delete result[existing];
    }
    seenLower.set(lc, key);
    result[key] = value;
  };

  if (cfg.provider === 'openrouter') {
    setHeader('HTTP-Referer', 'https://github.com/grandamenium/cortextos');
    setHeader('X-Title', 'cortextOS');
  }

  for (const [k, v] of Object.entries(cfg.headers ?? {})) {
    setHeader(k, v);
  }

  return result;
}
