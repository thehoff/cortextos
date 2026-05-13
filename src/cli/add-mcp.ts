/**
 * `cortextos add-mcp <server-name> --agent <agent-name> [--org <org>] [--cwd <path>] [--force]`
 *
 * Appends an mcp_servers entry to the named agent's config.json so the
 * runner spawns this server at boot. Thin commander shell over
 * src/mcp/wire.ts.
 *
 * Default behavior assumes the scaffold lives at
 * `<projectRoot>/mcp-servers/<server-name>/` (where `cortextos init-mcp`
 * placed it). The recorded `command` is `node` with args pointing at
 * `<server-dir>/dist/index.js`; the operator runs `npm run build` in
 * the server directory before enabling the agent.
 */
import { Command } from 'commander';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import chalk from 'chalk';
import { wireMcpServerToAgent } from '../mcp/wire.js';
import { discoverProjectRoot } from './enable-agent.js';
import type { McpServerSpec } from '../openai-runner/config.js';

export const addMcpCommand = new Command('add-mcp')
  .description('Wire an MCP server into an agent\'s config.json')
  .argument('<server-name>', 'kebab-lowercase MCP server name (must match a mcp-servers/<name>/ scaffold)')
  .requiredOption('--agent <agent-name>', 'target agent')
  .option('--org <org>', 'org name (when the project has multiple orgs)')
  .option('--cwd <path>', 'override the working directory for the subprocess (default: project root)')
  .option('--server-path <path>', 'override the path to the server\'s built entry script')
  .option('--force', 'replace an existing mcp_servers entry with the same name', false)
  .action((serverName: string, options: {
    agent: string;
    org?: string;
    cwd?: string;
    serverPath?: string;
    force?: boolean;
  }) => {
    let projectRoot: string;
    try {
      projectRoot = discoverProjectRoot();
    } catch (err) {
      process.stderr.write(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }

    // Resolve the agent's config.json. Match the orgs/<org>/agents/<agent>
    // and bare agents/<agent> patterns used by `cortextos enable`.
    let agentDir: string | null = null;
    if (options.org) {
      const candidate = join(projectRoot, 'orgs', options.org, 'agents', options.agent);
      if (existsSync(candidate)) agentDir = candidate;
    }
    if (!agentDir) {
      const candidate = join(projectRoot, 'agents', options.agent);
      if (existsSync(candidate)) agentDir = candidate;
    }
    if (!agentDir) {
      // Last try: scan orgs/*/agents/<agent>.
      // For now keep it simple — error and tell the operator to pass --org.
      process.stderr.write(
        chalk.red(`error: could not find agent "${options.agent}".\n`) +
        `Looked in:\n` +
        (options.org ? `  ${join(projectRoot, 'orgs', options.org, 'agents', options.agent)}\n` : '') +
        `  ${join(projectRoot, 'agents', options.agent)}\n` +
        `Pass --org <org> if the agent lives under orgs/<org>/agents/.\n`,
      );
      process.exit(1);
    }

    const configPath = join(agentDir, 'config.json');
    if (!existsSync(configPath)) {
      process.stderr.write(chalk.red(`error: agent config not found at ${configPath}\n`));
      process.exit(1);
    }

    const serverDir = join(projectRoot, 'mcp-servers', serverName);
    // Codex pass-2 PR5-017: resolve --server-path to an absolute path so
    // it doesn't get re-rooted against the agent's cwd at boot time.
    const serverArgPath = options.serverPath
      ? resolve(options.serverPath)
      : join(serverDir, 'dist', 'index.js');

    if (!options.serverPath) {
      if (!existsSync(serverDir)) {
        process.stderr.write(
          chalk.yellow(`warning: ${serverDir} does not exist — did you run \`cortextos init-mcp ${serverName}\`?\n`) +
          `Continuing; the agent will fail to boot until the server is built.\n`,
        );
      } else if (!existsSync(serverArgPath)) {
        // Codex pass-2 PR5-018: the scaffold exists but hasn't been built.
        // This is the most common operator path and the failure mode is
        // an opaque ENOENT from node:child_process at agent boot.
        process.stderr.write(
          chalk.yellow(`warning: ${serverArgPath} does not exist — the MCP server has not been built.\n`) +
          `Build it before enabling the agent:\n` +
          chalk.cyan(`  cd ${serverDir} && npm install && npm run build\n`),
        );
      }
    }

    const serverEntry: McpServerSpec = {
      name: serverName,
      command: 'node',
      args: [serverArgPath],
      ...(options.cwd ? { cwd: resolve(options.cwd) } : {}),
    };

    try {
      const result = wireMcpServerToAgent({
        agentConfigPath: configPath,
        serverEntry,
        force: options.force === true,
      });
      if (!result.added) {
        process.stderr.write(
          chalk.yellow(`agent "${options.agent}" already has an mcp_servers entry named "${serverName}".\n`) +
          `Existing command: ${result.existingEntry?.command} ${(result.existingEntry?.args ?? []).join(' ')}\n` +
          `Use --force to replace it.\n`,
        );
        process.exit(2);
      }
      const verb = result.existingEntry ? 'Replaced' : 'Added';
      process.stdout.write(
        chalk.green(`${verb} mcp_servers entry "${serverName}" in:\n`) +
        `  ${configPath}\n\n` +
        `Restart the agent to pick up the change:\n` +
        chalk.cyan(`  cortextos disable ${options.agent} && cortextos enable ${options.agent}\n`),
      );
    } catch (err) {
      process.stderr.write(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  });
