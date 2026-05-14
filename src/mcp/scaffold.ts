/**
 * Pure-function MCP server scaffold writer.
 *
 * Creates a minimal MCP server (TypeScript, SDK-based) at a target
 * directory. CLI consumer: `cortextos init-mcp`. PR6 consumer: the
 * daemon HTTP endpoint that the dashboard's "Add MCP server" UI calls.
 *
 * Lives at src/mcp/ (not src/cli/, not src/openai-runner/) so neither
 * consumer pulls in CLI or runner internals.
 */
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * Sentinel error code surfaced when destDir already exists, so callers
 * can return a clean 409 from HTTP routes without parsing message text.
 */
export class ScaffoldDestExistsError extends Error {
  readonly code = 'EEXIST';
  constructor(destDir: string) {
    super(`destination already exists: ${destDir}`);
    this.name = 'ScaffoldDestExistsError';
  }
}

const MCP_SERVER_NAME_RE = /^[a-z][a-z0-9-]*$/;
const PACKAGE_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface ScaffoldOptions {
  /** Kebab-lowercase server name. Used as the directory name and the SDK Server's name. */
  serverName: string;
  /** Absolute path to create. Must NOT already exist. */
  destDir: string;
}

export interface ScaffoldResult {
  /** Absolute paths of files written, in order. */
  filesWritten: string[];
}

/**
 * Render the package.json content for the scaffold. The MCP SDK is
 * listed as a runtime dep on the SERVER's package.json — separate
 * from cortextOS's own deps — so individual MCP servers manage
 * their own version pinning.
 */
function renderPackageJson(serverName: string): string {
  return JSON.stringify({
    name: `mcp-server-${serverName}`,
    version: '0.1.0',
    description: `MCP server: ${serverName}`,
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      build: 'tsc',
      start: 'node dist/index.js',
      dev: 'tsx src/index.ts',
    },
    dependencies: {
      '@modelcontextprotocol/sdk': '1.29.0',
    },
    devDependencies: {
      '@types/node': '^20.0.0',
      typescript: '^5.0.0',
      tsx: '^4.0.0',
    },
  }, null, 2) + '\n';
}

function renderTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: 'dist',
      rootDir: 'src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: false,
    },
    include: ['src/**/*.ts'],
  }, null, 2) + '\n';
}

function renderIndexTs(serverName: string): string {
  return `/**
 * MCP server: ${serverName}
 *
 * Replace the example tool below with your own. Each tool is a
 * function on the server: declare its input schema (JSON Schema)
 * and return text content blocks.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: '${serverName}', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'hello',
      description: 'Returns a greeting. Replace this with a real tool.',
      inputSchema: {
        type: 'object',
        properties: { who: { type: 'string', description: 'name to greet' } },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'hello') {
    const who = (req.params.arguments as { who?: string } | undefined)?.who ?? 'world';
    return { content: [{ type: 'text', text: \`hello from ${serverName} to \${who}\` }] };
  }
  return {
    content: [{ type: 'text', text: \`unknown tool: \${req.params.name}\` }],
    isError: true,
  };
});

void server.connect(new StdioServerTransport());
`;
}

function renderReadme(serverName: string): string {
  return `# MCP server: ${serverName}

This scaffold was created by \`cortextos init-mcp ${serverName}\`. Replace the
example \`hello\` tool in \`src/index.ts\` with your own.

## Build

\`\`\`
npm install
npm run build
\`\`\`

## Wire into an agent

From the cortextOS project root:

\`\`\`
cortextos add-mcp ${serverName} --agent <agent-name> [--org <org>]
\`\`\`

This appends an \`mcp_servers\` entry to that agent's \`config.json\` so the
runner spawns this server at boot.

## Run standalone (smoke test)

\`\`\`
npm run dev
\`\`\`

Then send JSON-RPC requests on stdin (use an MCP client or Claude Desktop's
dev settings UI).
`;
}

export function writeMcpScaffold(opts: ScaffoldOptions): ScaffoldResult {
  if (!MCP_SERVER_NAME_RE.test(opts.serverName) || !PACKAGE_NAME_RE.test(opts.serverName)) {
    throw new Error(
      `MCP server name "${opts.serverName}" must match /^[a-z][a-z0-9-]*$/ (kebab-lowercase, starts with a letter)`,
    );
  }
  // Codex pass-1 PR6-002 (HIGH): exclusive-create semantics. mkdirSync
  // without `recursive` throws EEXIST atomically if another process
  // (or another concurrent dashboard request) already created the dir
  // between our existsSync check and our mkdir. Wrap both in one
  // operation so two concurrent scaffolds can't both pass the existence
  // check.
  if (existsSync(opts.destDir)) {
    throw new ScaffoldDestExistsError(opts.destDir);
  }
  try {
    mkdirSync(opts.destDir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new ScaffoldDestExistsError(opts.destDir);
    }
    if (code === 'ENOENT') {
      // Parent directory missing — operator hasn't run cortextos init,
      // or destDir is rooted somewhere weird. Surface as a normal error.
      throw new Error(`parent directory does not exist for ${opts.destDir}`);
    }
    throw err;
  }
  mkdirSync(join(opts.destDir, 'src'), { recursive: false });

  const filesWritten: string[] = [];
  const write = (relPath: string, content: string): void => {
    const absPath = join(opts.destDir, relPath);
    writeFileSync(absPath, content);
    filesWritten.push(absPath);
  };

  write('package.json', renderPackageJson(opts.serverName));
  write('tsconfig.json', renderTsconfig());
  write('src/index.ts', renderIndexTs(opts.serverName));
  write('README.md', renderReadme(opts.serverName));

  return { filesWritten };
}
