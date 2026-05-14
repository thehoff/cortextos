/**
 * Fixture: writes its PID to MCP_PIDFILE synchronously on startup, then
 * hangs without ever responding to the MCP `initialize` handshake. Used
 * by tests/integration/runner-mcp-sigint-during-boot.test.ts (Codex
 * pass-4 PR5-041) to verify the hang subprocess is actually reaped
 * after the runner's SIGTERM handler awaits the manager teardown.
 */
import { writeFileSync } from 'fs';

const pidfile = process.env.MCP_PIDFILE;
if (pidfile) {
  writeFileSync(pidfile, String(process.pid));
}

// Keep the process alive without speaking the MCP protocol. The SDK
// transport spawns us with stdio piped; not reading or writing means
// the parent runner's `initialize` request times out.
process.stdin.resume();
setInterval(() => undefined, 10_000);
