/**
 * Shared type shapes for the MCP client + manager.
 *
 * These mirror just enough of the MCP wire protocol shape for the
 * runner's needs. We intentionally do NOT re-export SDK types directly
 * — the SDK is internal, the runner/manager surface is stable.
 */

export interface McpServerSpec {
  /** Kebab-lowercase tag, used as the qualified-name prefix. */
  name: string;
  /** Subprocess command (e.g. "node" or an absolute path). */
  command: string;
  /** Subprocess args. */
  args?: string[];
  /** Extra env vars. Values matching /^\$([A-Z][A-Z0-9_]*)$/ are resolved from process.env at boot. */
  env?: Record<string, string>;
  /** Working directory for the subprocess. Defaults to agentDir. */
  cwd?: string;
  /** Per-tool timeout override for tools exposed by THIS server. Seconds. */
  tool_timeout_sec?: number;
  /** Inherit the runner's process.env into the subprocess. Default false (see PLAN.md §5 + §22 #1). */
  env_inherit?: boolean;
}

/** Subset of an MCP tool descriptor that the runner cares about. */
export interface McpToolDescriptor {
  /** Original tool name as advertised by the server. */
  name: string;
  description?: string;
  /** JSON Schema for tool input. */
  inputSchema?: unknown;
}

/** A fully-connected MCP client wrapping one stdio subprocess. */
export interface ConnectedMcpClient {
  /** The original spec.name (may contain hyphens). */
  name: string;
  /** Discovered tools, validated to have OpenAI-compatible names. */
  tools: McpToolDescriptor[];
  /**
   * Issue a tool call. The result is the concatenation of all `text`
   * content blocks. If ANY content block is non-text (image, audio,
   * resource), the call rejects with `MCP tool returned unsupported
   * non-text content` — PR5 is tools-text-only.
   */
  call(toolName: string, args: unknown, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  /** Close the transport and wait for the child to exit. */
  disconnect(): Promise<void>;
}

/** A namespaced route from `mcp__<server>__<tool>` back to the server + original name. */
export interface McpRoute {
  serverName: string;
  originalToolName: string;
  defaultTimeoutMs: number;
}
