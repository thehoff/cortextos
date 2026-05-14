/**
 * MCP manager: parallel boot, explicit route table, atomic rollback,
 * boot-safe shutdown.
 *
 * The manager exists in three states:
 *   1. booting — children being spawned in parallel; signal handlers
 *      can still find every in-flight transport via the manager's
 *      internal child list.
 *   2. ready — all servers booted; routes table is final.
 *   3. closing — shutdown initiated, idempotent.
 *
 * The PR5-002 (SIGINT during boot) and PR5-001 (rollback leak) fixes
 * both depend on the same trick: the manager registers each transport
 * BEFORE awaiting the connect handshake, so a shutdown call at any
 * point during boot has access to every spawned child.
 */
import { resolve as pathResolve } from 'path';
import { beginMcpConnect, resolveMcpServerEnv } from './client.js';
import type { ConnectedMcpClient, McpServerSpec, McpToolDescriptor, McpRoute } from './types.js';

export interface McpManager {
  /** Connected clients keyed by server.name. */
  readonly clients: ReadonlyMap<string, ConnectedMcpClient>;
  /** Explicit route table from qualified name to (server, original-name, default-timeout-ms). */
  readonly routes: ReadonlyMap<string, McpRoute>;
  /** All discovered tools as LLM-facing namespaced descriptors. */
  readonly tools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>;
  /** Secret values that flowed through $VAR env resolution — feed to redactSecrets. */
  readonly secrets: ReadonlySet<string>;
  /** Idempotent shutdown; closes all clients with a 5s overall budget. */
  shutdown(): Promise<void>;
}

export interface BootMcpManagerOptions {
  specs: McpServerSpec[];
  /** Working directory for each subprocess. Caller passes the agent dir. */
  cwd: string;
  /** Total budget for the whole boot (all servers, in parallel). */
  bootTimeoutMs: number;
  /** Per-server default tool timeout if the spec doesn't override (ms). */
  defaultToolTimeoutMs: number;
  /** Used to validate that no MCP-qualified name collides with a builtin (Codex pass-1 PR5-005). */
  builtinToolNames: ReadonlySet<string>;
  /** Runner env to resolve $VAR references from. */
  runnerEnv: NodeJS.ProcessEnv;
  /**
   * Called once with the (still-booting) manager so the runner can wire
   * shutdown() into its SIGTERM/SIGINT handlers BEFORE the children
   * actually spawn. Handles the SIGINT-during-boot leak path
   * (Codex pass-1 PR5-002).
   */
  onBeforeFirstSpawn?: (handle: { shutdown: () => Promise<void> }) => void;
  /**
   * Optional sink for $VAR-resolved secret values. The manager populates
   * this as it walks specs (BEFORE awaiting any spawn), so callers can
   * redact FATAL error messages with the collected secrets even when
   * boot rejects mid-flight (Codex pass-3 PR5-025).
   */
  secretsSink?: Set<string>;
}

const SHUTDOWN_TOTAL_BUDGET_MS = 5_000;
const QUALIFIED_NAME_MAX_LENGTH = 64;

function buildQualifiedName(serverName: string, toolName: string): string {
  // Replace hyphens with underscores so the result satisfies the
  // OpenAI function-name regex /^[a-zA-Z][a-zA-Z0-9_-]*$/. The hyphen
  // is allowed in the regex too, but underscores avoid the "is this
  // a server-name dash or a tool-name dash" parsing ambiguity, since
  // we route via the explicit table rather than parsing the prefix.
  const safeServer = serverName.replace(/-/g, '_');
  return `mcp__${safeServer}__${toolName}`;
}

export async function bootMcpManager(opts: BootMcpManagerOptions): Promise<McpManager> {
  const clients = new Map<string, ConnectedMcpClient>();
  const routes = new Map<string, McpRoute>();
  const tools: { name: string; description?: string; inputSchema?: unknown }[] = [];
  // PR5-025 (Codex pass-3): reuse the caller's Set if provided so resolved
  // $VAR secrets remain visible after a rejecting boot.
  const secrets = opts.secretsSink ?? new Set<string>();
  const childCleanups: Array<() => Promise<void>> = [];
  // Codex pass-5 PR5-044: track PID getters in tandem with cleanups so
  // the race-timeout path below can force-kill any still-alive children
  // without falling into the recycled-PID trap.
  const childPidGetters: Array<() => number | null> = [];
  // Codex pass-4 PR5-041: track the in-flight close promise so concurrent
  // shutdown callers (e.g. the runner's SIGTERM handler AND the bootMcpManager
  // rollback path both call shutdown()) all AWAIT the same close-all race
  // rather than the second caller seeing `closing=true` and returning
  // immediately. The original idempotency form let a later `process.exit(1)`
  // fire before the first caller's cleanups finished, abandoning the SDK
  // transport.close() chain (which is the part that actually SIGKILLs the
  // hang subprocess).
  let closingPromise: Promise<void> | null = null;

  const shutdown = async (): Promise<void> => {
    if (closingPromise) return closingPromise;
    closingPromise = (async () => {
      const deadline = Date.now() + SHUTDOWN_TOTAL_BUDGET_MS;
      // Race close-all against a hard budget so a stuck server can't block
      // SIGTERM compliance.
      const cleanupsDone = Promise.allSettled(childCleanups.map(c => c()));
      const result = await Promise.race([
        cleanupsDone.then(() => 'done' as const),
        new Promise<'timeout'>(resolve =>
          setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())),
        ),
      ]);
      // Codex pass-5 PR5-045: when the budget timer wins the race, the
      // SDK's close() chain hasn't confirmed child death yet — the
      // cleanups are still pending, and exiting now would orphan
      // whatever children survived. Force-kill via captured pids before
      // returning. The getPid() snapshot is safe: it reads transport.pid
      // which becomes null after SDK close() nulls _process, so a
      // recycled-PID kill is impossible (we only get a non-null pid
      // for children whose close() is still in flight).
      if (result === 'timeout') {
        for (const get of childPidGetters) {
          const pid = get();
          if (pid !== null && pid !== undefined) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
          }
        }
        // After SIGKILL, wait briefly for the cleanups' close() to
        // observe the child's 'close' event and finish. This keeps the
        // shutdown bounded but ensures cleanups don't dangle past
        // process.exit. Bounded at 1s — kernel close-event delivery
        // is sub-second under any normal load.
        await Promise.race([
          cleanupsDone,
          new Promise<void>(resolve => setTimeout(resolve, 1_000)),
        ]);
      }
    })();
    return closingPromise;
  };

  // Wire the partial-manager shutdown BEFORE any spawn so SIGINT
  // during boot can still tear down children (Codex pass-1 PR5-002).
  opts.onBeforeFirstSpawn?.({ shutdown });

  const manager: McpManager = {
    clients,
    routes,
    tools,
    secrets,
    shutdown,
  };

  if (opts.specs.length === 0) {
    return manager;
  }

  // Validate server-name uniqueness UP FRONT so we don't even start
  // any spawn if the operator's config is broken.
  const seenNames = new Set<string>();
  for (const spec of opts.specs) {
    if (seenNames.has(spec.name)) {
      throw new Error(`mcp_servers: duplicate server name "${spec.name}"`);
    }
    seenNames.add(spec.name);
  }

  const results = await Promise.allSettled(opts.specs.map(async (spec) => {
    const { env, secrets: specSecrets } = resolveMcpServerEnv(spec, opts.runnerEnv);
    for (const s of specSecrets) secrets.add(s);
    // PR5-027 (Codex pass-3): resolve a relative cwd against the runner's
    // base cwd (the agent dir) so a `./mcp-servers/...` config entry lands
    // at <agentDir>/mcp-servers/... regardless of the runner's process
    // cwd. Absolute cwds pass through verbatim. validateConfig already
    // rejected forms that aren't absolute or "./"/"../"-prefixed.
    const resolvedCwd = spec.cwd
      ? (spec.cwd.startsWith('/') ? spec.cwd : pathResolve(opts.cwd, spec.cwd))
      : opts.cwd;
    // PR5-013 fix: register the REAL cleanup synchronously, BEFORE the
    // connect await. beginMcpConnect returns the cleanup handle alongside
    // the in-flight Promise. If shutdown() fires while the connect is
    // still pending, the cleanup actually closes the transport.
    const { ready, cleanup, getPid } = beginMcpConnect(spec, {
      env,
      cwd: resolvedCwd,
      bootTimeoutMs: opts.bootTimeoutMs,
    });
    childCleanups.push(cleanup);
    childPidGetters.push(getPid);
    const client = await ready;
    return { spec, client };
  }));

  // If anything failed, roll back: shutdown closes every cleanup we
  // registered (whether successful or not). Then throw with the FIRST
  // error so the operator sees a clear cause.
  const failures = results.flatMap(r => r.status === 'rejected' ? [r.reason] : []);
  if (failures.length > 0) {
    await shutdown();
    throw failures[0];
  }

  // Wire successful results into the manager state.
  const successes = results
    .filter((r): r is PromiseFulfilledResult<{ spec: McpServerSpec; client: ConnectedMcpClient }> => r.status === 'fulfilled')
    .map(r => r.value);

  for (const { spec, client } of successes) {
    clients.set(spec.name, client);
    const serverTimeoutMs = spec.tool_timeout_sec !== undefined
      ? spec.tool_timeout_sec * 1000
      : opts.defaultToolTimeoutMs;

    for (const tool of client.tools) {
      const qualifiedName = buildQualifiedName(spec.name, tool.name);
      if (qualifiedName.length > QUALIFIED_NAME_MAX_LENGTH) {
        await shutdown();
        throw new Error(
          `mcp server "${spec.name}" tool "${tool.name}": qualified name "${qualifiedName}" exceeds ${QUALIFIED_NAME_MAX_LENGTH} chars`,
        );
      }
      if (opts.builtinToolNames.has(qualifiedName)) {
        await shutdown();
        throw new Error(
          `mcp server "${spec.name}" tool "${tool.name}": qualified name "${qualifiedName}" collides with a builtin tool`,
        );
      }
      if (routes.has(qualifiedName)) {
        await shutdown();
        throw new Error(
          `mcp server "${spec.name}" tool "${tool.name}": qualified name "${qualifiedName}" collides with another MCP tool (likely from a server with a hyphen-vs-underscore variant)`,
        );
      }
      routes.set(qualifiedName, {
        serverName: spec.name,
        originalToolName: tool.name,
        defaultTimeoutMs: serverTimeoutMs,
      });
      tools.push({
        name: qualifiedName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  return manager;
}

/**
 * Dispatch a qualified tool call to the right MCP client. The manager's
 * route table is the single source of truth; callers do NOT parse the
 * `mcp__<server>__<tool>` prefix themselves (Codex pass-1 PR5-005).
 */
export async function dispatchMcpCall(
  manager: McpManager,
  qualifiedName: string,
  args: unknown,
  perCallTimeoutMs: number | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const route = manager.routes.get(qualifiedName);
  if (!route) {
    throw new Error(`unknown MCP tool: ${qualifiedName}`);
  }
  const client = manager.clients.get(route.serverName);
  if (!client) {
    // Should be impossible — route table is built from the clients map —
    // but guard for the case where someone closed a single client.
    throw new Error(`MCP server ${route.serverName} is not connected`);
  }
  const timeoutMs = perCallTimeoutMs ?? route.defaultTimeoutMs;
  return client.call(route.originalToolName, args, timeoutMs, signal);
}
