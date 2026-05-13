/**
 * Atomic MCP client wrapper.
 *
 * `connectMcpServer` spawns the subprocess, runs the initialize
 * handshake, lists tools, validates their names, and returns a
 * `ConnectedMcpClient`. If ANY step after spawn fails, the function
 * tears down its own transport BEFORE rejecting so no zombie child
 * is left behind — this is the load-bearing invariant for the
 * manager's parallel-boot rollback semantics (PLAN.md §6 + Codex
 * pass-1 PR5-001).
 *
 * Tool names are validated against the OpenAI function-name regex
 * up front so a buggy or malicious MCP server can't poison the LLM
 * tool registry with a name that the API would reject mid-conversation
 * (Codex pass-1 PR5-005).
 *
 * Errors are normalized to flat strings; the SDK's McpError shape is
 * not exposed to the runner.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ConnectedMcpClient, McpServerSpec, McpToolDescriptor } from './types.js';

/** OpenAI-compatible function-name regex. Length capped at 64 chars. */
const OPENAI_FN_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_TOOL_NAME_LENGTH = 64;

/** Env vars that always pass through, even with env_inherit:false. */
const ALWAYS_INHERITED_ENV_VARS = ['PATH', 'HOME', 'USER', 'LANG', 'NODE_ENV'];

const ENV_VAR_REF_RE = /^\$([A-Z][A-Z0-9_]*)$/;

/**
 * Build the resolved subprocess environment from a server spec.
 *
 * Returns BOTH the resulting env object AND the set of secret values
 * that should be added to the manager's redaction set so they don't
 * leak through stderr or error messages (Codex pass-1 PR5-007).
 */
export function resolveMcpServerEnv(
  spec: McpServerSpec,
  runnerEnv: NodeJS.ProcessEnv,
): { env: Record<string, string>; secrets: Set<string> } {
  const env: Record<string, string> = {};
  const secrets = new Set<string>();

  // Always-inherited minimal set first.
  for (const k of ALWAYS_INHERITED_ENV_VARS) {
    const v = runnerEnv[k];
    if (typeof v === 'string') env[k] = v;
  }

  // Full inherit on top if requested.
  if (spec.env_inherit === true) {
    for (const [k, v] of Object.entries(runnerEnv)) {
      if (typeof v === 'string') env[k] = v;
    }
  }

  // Explicit env, with $VAR resolution.
  for (const [k, raw] of Object.entries(spec.env ?? {})) {
    const refMatch = raw.match(ENV_VAR_REF_RE);
    if (refMatch) {
      const refName = refMatch[1]!;
      const refValue = runnerEnv[refName];
      if (typeof refValue !== 'string' || refValue.length === 0) {
        throw new Error(
          `mcp_servers["${spec.name}"].env["${k}"] references $${refName} which is unset or empty`,
        );
      }
      env[k] = refValue;
      secrets.add(refValue);
    } else {
      env[k] = raw;
    }
  }

  return { env, secrets };
}

export interface ConnectOptions {
  /** Resolved env vars (use resolveMcpServerEnv to produce). */
  env: Record<string, string>;
  /** Working directory for the subprocess. */
  cwd: string;
  /** Total time the connect+handshake+listTools step may take, in ms. */
  bootTimeoutMs: number;
}

/**
 * Spawn the MCP server subprocess + complete handshake + list tools.
 *
 * Atomicity contract: returns a ConnectedMcpClient on success; on
 * any failure, the function closes its own transport before rejecting
 * so no zombie process remains.
 */
export async function connectMcpServer(
  spec: McpServerSpec,
  opts: ConnectOptions,
): Promise<ConnectedMcpClient> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args ?? [],
    env: opts.env,
    cwd: opts.cwd,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'cortextos-openai-runner', version: '1.0.0' },
    { capabilities: {} },
  );

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try { await client.close(); } catch { /* swallow — already errored */ }
  };

  try {
    // Race connect+handshake+listTools against the boot timeout. The
    // bootTimeoutMs applies as one budget for the whole sequence so
    // a server that handshakes fast but then hangs on listTools still
    // surfaces the failure.
    const work = (async (): Promise<ConnectedMcpClient> => {
      await client.connect(transport);
      const result = await client.listTools();
      const rawTools = Array.isArray(result.tools) ? result.tools : [];

      const tools: McpToolDescriptor[] = [];
      for (const t of rawTools) {
        if (typeof t.name !== 'string' || t.name.length === 0) {
          throw new Error(`mcp server "${spec.name}" advertised a tool with no name`);
        }
        if (t.name.length > MAX_TOOL_NAME_LENGTH) {
          throw new Error(
            `mcp server "${spec.name}" tool name "${t.name}" exceeds ${MAX_TOOL_NAME_LENGTH} chars`,
          );
        }
        if (!OPENAI_FN_NAME_RE.test(t.name)) {
          throw new Error(
            `mcp server "${spec.name}" tool name "${t.name}" is not a valid ` +
            `OpenAI function name (must match /^[a-zA-Z][a-zA-Z0-9_-]*$/)`,
          );
        }
        tools.push({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : undefined,
          inputSchema: t.inputSchema,
        });
      }

      return {
        name: spec.name,
        tools,
        async call(toolName, args, timeoutMs, signal): Promise<string> {
          const controller = new AbortController();
          const onAbort = (): void => controller.abort(new Error('caller aborted'));
          signal?.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => controller.abort(new Error(`mcp tool ${toolName} timed out after ${timeoutMs}ms`)), timeoutMs);
          try {
            const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, { signal: controller.signal });
            const blocks = Array.isArray(result.content) ? result.content : [];
            const textParts: string[] = [];
            for (const block of blocks) {
              if (block && typeof block === 'object' && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
                textParts.push((block as { text: string }).text);
              } else {
                throw new Error('MCP tool returned unsupported non-text content');
              }
            }
            if (result.isError === true) {
              throw new Error(`MCP tool reported error: ${textParts.join('\n').slice(0, 2000)}`);
            }
            return textParts.join('\n');
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          }
        },
        disconnect: cleanup,
      };
    })();

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`mcp server "${spec.name}" boot timed out after ${opts.bootTimeoutMs}ms`)), opts.bootTimeoutMs);
    });

    return await Promise.race([work, timeoutPromise]);
  } catch (err) {
    await cleanup();
    throw err;
  }
}
