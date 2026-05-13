/**
 * `cortextos init-mcp <server-name> [--dest <path>]`
 *
 * Scaffolds a new MCP server skeleton at <dest> (default:
 * <projectRoot>/mcp-servers/<server-name>/). Thin commander shell over
 * src/mcp/scaffold.ts.
 *
 * After init, the operator runs:
 *   cortextos add-mcp <server-name> --agent <agent-name>
 * to wire the server into an agent's config.json.
 */
import { Command } from 'commander';
import { resolve, join } from 'path';
import chalk from 'chalk';
import { writeMcpScaffold } from '../mcp/scaffold.js';
import { discoverProjectRoot } from './enable-agent.js';

export const initMcpCommand = new Command('init-mcp')
  .description('Scaffold a new MCP server skeleton')
  .argument('<server-name>', 'kebab-lowercase MCP server name')
  .option('--dest <path>', 'override the scaffold destination directory')
  .action((serverName: string, options: { dest?: string }) => {
    let dest: string;
    if (options.dest) {
      dest = resolve(options.dest);
    } else {
      try {
        const projectRoot = discoverProjectRoot();
        dest = join(projectRoot, 'mcp-servers', serverName);
      } catch (err) {
        process.stderr.write(
          chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`) +
          'Pass --dest <path> to specify an explicit destination.\n',
        );
        process.exit(1);
      }
    }
    try {
      const result = writeMcpScaffold({ serverName, destDir: dest });
      process.stdout.write(
        chalk.green(`Created MCP server scaffold:\n`) +
        `  ${dest}\n\n` +
        `Files written:\n` +
        result.filesWritten.map(p => `  ${p}`).join('\n') + '\n\n' +
        `Next steps:\n` +
        `  cd ${dest}\n` +
        `  npm install\n` +
        `  npm run build\n\n` +
        `Then wire it into an agent:\n` +
        chalk.cyan(`  cortextos add-mcp ${serverName} --agent <agent-name>\n`),
      );
    } catch (err) {
      process.stderr.write(chalk.red(`error: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exit(1);
    }
  });
