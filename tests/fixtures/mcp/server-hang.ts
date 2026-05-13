/**
 * Fixture: stay alive but never respond to MCP protocol. Used to test
 * boot-timeout enforcement (PLAN.md §6 + PR5-001).
 */
process.stdin.resume();
setInterval(() => undefined, 10_000);
