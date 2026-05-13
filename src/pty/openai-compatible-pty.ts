import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { OutputBuffer } from './output-buffer.js';

interface IPty {
  pid: number;
  write(data: string): void;
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

interface IPtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

type SpawnFn = (file: string, args: string[], options: IPtySpawnOptions) => IPty;

// Test seam: vitest's `vi.mock('node-pty')` does not always intercept lazy
// `require('node-pty')` calls inside CJS-compiled methods. Tests can install a
// fake spawn here before constructing OpenAICompatiblePTY. Production code
// leaves this null and falls through to require('node-pty') in spawn().
let spawnFnOverride: SpawnFn | null = null;
/** @internal — vitest hook only; not part of the public adapter contract. */
export function __setSpawnFnForTest(fn: SpawnFn | null): void {
  spawnFnOverride = fn;
}

// Bootstrap signal emitted by run-openai-agent on stdout once the bus is wired
// up and stdin readline is ready to accept FastChecker AGENT MESSAGE blocks.
// The string is intentionally specific to avoid false positives in LLM output
// (e.g. an agent writing the word "READY" in a reply).
const BOOTSTRAP_PATTERN = '[openai-runner] READY';

// Bracketed-paste escape codes injected by src/pty/inject.ts on every PTY
// write. Stripped at write() time so the runner's stdin readline sees clean
// line-delimited text — same boundary pattern as CodexAppServerPTY's write().
const PASTE_START_RE = /\x1b\[200~/g;
const PASTE_END_RE = /\x1b\[201~/g;

/**
 * PTY adapter for openai-compatible runtime agents.
 *
 * Spawns `cortextos run-openai-agent` (the bundled runner) under node-pty so
 * the daemon can inject FastChecker-formatted AGENT MESSAGE blocks via the
 * shared inject.ts path the other runtimes use. The runner reads stdin
 * line-by-line and replies via direct bus imports — no Claude Code, no
 * Telegram, no skill dispatch.
 *
 * Lifecycle differs from AgentPTY in two ways:
 *   - Bootstrap signal is a literal "[openai-runner] READY" line emitted on
 *     stdout once `setStatus('idle')` has succeeded; no trust-folder prompt.
 *   - Stop: SIGTERM to the runner, 5s grace for it to log agent_offline +
 *     flip heartbeat to 'stopping' before exit. SIGHUP/SIGKILL fallback is
 *     applied by AgentProcess.stop() if the runner doesn't exit cleanly.
 *
 * Implements the same duck-typed surface (spawn / write / kill / isAlive /
 * getPid / onExit / getOutputBuffer) that AgentProcess uses for AgentPTY and
 * CodexAppServerPTY, so the dispatch ternary in agent-process.ts can pick
 * whichever class fits the runtime without further branching.
 */
export class OpenAICompatiblePTY {
  private pty: IPty | null = null;
  private _alive = false;
  private outputBuffer: OutputBuffer;
  private env: CtxEnv;
  private config: AgentConfig;
  private onExitHandler: ((exitCode: number, signal?: number) => void) | null = null;
  private spawnFn: SpawnFn | null = null;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    this.env = env;
    this.config = config;
    this.outputBuffer = new OutputBuffer(1000, logPath, BOOTSTRAP_PATTERN);
  }

  async spawn(_mode: 'fresh' | 'continue', _prompt: string): Promise<void> {
    if (this.pty) {
      throw new Error('PTY already spawned. Kill first.');
    }

    if (!this.spawnFn) {
      if (spawnFnOverride) {
        this.spawnFn = spawnFnOverride;
      } else {
        const nodePty = require('node-pty');
        this.spawnFn = nodePty.spawn;
      }
    }

    const cwd = this.config.working_directory || this.env.agentDir || process.cwd();
    const ptyEnv = this.buildEnv();

    // The runner is the cortextos CLI's `run-openai-agent` subcommand.
    // tsup bundles src/cli/index.ts into dist/cli.js as a single file, so
    // __dirname resolves to <clone>/dist at runtime and joining 'cli.js'
    // lands on the bundled CLI binary. Spawning via process.execPath (node)
    // avoids depending on a global `cortextos` shim being on PATH inside the
    // daemon-process env.
    const cliJs = join(__dirname, 'cli.js');
    const args = [cliJs, 'run-openai-agent'];

    this.pty = this.spawnFn!(process.execPath, args, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env: ptyEnv,
    });

    this._alive = true;

    this.pty.onData((data: string) => {
      this.outputBuffer.push(data);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this._alive = false;
      this.pty = null;
      if (this.onExitHandler) {
        this.onExitHandler(exitCode, signal);
      }
    });
  }

  write(data: string): void {
    if (!this.pty) {
      throw new Error('PTY not spawned');
    }
    // Strip bracketed-paste markers — inject.ts wraps every injection in
    // \e[200~...\e[201~ so the host terminal won't interpret special chars
    // as input. The runner reads its stdin via readline and treats those
    // escape sequences as opaque bytes inside the first/last line, which
    // would break the AGENT MESSAGE header/terminator regexes. Strip here
    // so the runner sees clean line-delimited text.
    const cleaned = data.replace(PASTE_START_RE, '').replace(PASTE_END_RE, '');
    this.pty.write(cleaned);
  }

  /**
   * Signal the runner to begin graceful shutdown without tearing down PTY
   * state. The runner's SIGTERM trap emits `agent_offline` + flips heartbeat
   * to `stopping` before calling process.exit(0); node-pty's onExit handler
   * then flips _alive and resolveExit in the normal way.
   *
   * Called from AgentProcess.stop()'s openai-compatible branch before the
   * shared 5s grace sleep — see agent-process.ts.
   */
  signalShutdown(): void {
    const pty = this.pty;
    if (pty) {
      try {
        pty.kill('SIGTERM');
      } catch {
        // ignore — process may have already exited
      }
    }
  }

  /**
   * Forceful teardown. Called by AgentProcess.stop() as the fallback after
   * the per-runtime graceful sequence times out. Matches AgentPTY.kill()'s
   * eager-state-mutation contract.
   */
  kill(): void {
    const pty = this.pty;
    if (pty) {
      this._alive = false;
      this.pty = null;
      try {
        pty.kill();
      } catch {
        // ignore — process may have already exited
      }
    }
  }

  isAlive(): boolean {
    return this._alive && this.pty !== null;
  }

  getPid(): number | null {
    return this.pty?.pid || null;
  }

  onExit(handler: (exitCode: number, signal?: number) => void): void {
    this.onExitHandler = handler;
  }

  getOutputBuffer(): OutputBuffer {
    return this.outputBuffer;
  }

  /**
   * Build the env passed to the spawned runner.
   *
   * Superset is intentional and matches `src/pty/agent-pty.ts:65-137`'s
   * shape minus the Telegram-specific keys and the agent-level `.env`
   * loading step. Openai-compatible agents have no `.env` by design —
   * agent-specific config goes in `config.json`, org-shared secrets stay
   * in `orgs/<org>/secrets.env` (loaded here so e.g. `OPENAI_API_KEY` is
   * available for the LLM endpoint).
   */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {
      ...this.getBaseEnv(),
      CTX_INSTANCE_ID: this.env.instanceId,
      CTX_ROOT: this.env.ctxRoot,
      CTX_FRAMEWORK_ROOT: this.env.frameworkRoot,
      CTX_AGENT_NAME: this.env.agentName,
      CTX_ORG: this.env.org,
      CTX_AGENT_DIR: this.env.agentDir,
      CTX_PROJECT_ROOT: this.env.projectRoot,
      // Backward-compat aliases. agent-pty.ts:76-77.
      CRM_AGENT_NAME: this.env.agentName,
      CRM_TEMPLATE_ROOT: this.env.frameworkRoot,
    };

    // Org-level shared secrets (OPENAI_API_KEY, etc.). Same loader as AgentPTY.
    if (this.env.org && this.env.projectRoot) {
      const orgEnvFile = join(this.env.projectRoot, 'orgs', this.env.org, 'secrets.env');
      this.loadEnvFile(orgEnvFile, env);
    }

    // Timezone propagation — config.json timezone wins over process.env.TZ.
    if (this.config.timezone) {
      env['CTX_TIMEZONE'] = this.config.timezone;
      env['TZ'] = this.config.timezone;
    } else if (process.env.TZ) {
      env['CTX_TIMEZONE'] = process.env.TZ;
    }

    // Orchestrator handle: read from the org's context.json so a specialist
    // minion can route escalations back to its orchestrator without hard-
    // coding a name. Variable name matches `agent-pty.ts:133` exactly —
    // CTX_ORCHESTRATOR_AGENT, NOT CTX_ORCHESTRATOR.
    if (this.env.projectRoot && this.env.org) {
      try {
        const contextPath = join(this.env.projectRoot, 'orgs', this.env.org, 'context.json');
        if (existsSync(contextPath)) {
          const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
          if (ctx.orchestrator) {
            env['CTX_ORCHESTRATOR_AGENT'] = ctx.orchestrator;
          }
        }
      } catch { /* leave unset if context.json is missing or malformed */ }
    }

    return env;
  }

  private loadEnvFile(path: string, env: Record<string, string>): void {
    if (!existsSync(path)) return;
    try {
      const content = readFileSync(path, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
        }
      }
    } catch { /* ignore unreadable env file */ }
  }

  private getBaseEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const keepVars = [
      'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
      'TMPDIR', 'TEMP', 'TMP', 'NODE_PATH', 'COMSPEC', 'USERPROFILE',
      'SystemDrive', 'SystemRoot', 'windir',
      'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ALLUSERSPROFILE',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
      'HOMEDRIVE', 'HOMEPATH', 'PUBLIC',
    ];
    for (const key of keepVars) {
      if (process.env[key]) {
        env[key] = process.env[key]!;
      }
    }
    if (platform() === 'win32') {
      if (!env['LANG']) env['LANG'] = 'en_US.UTF-8';
      if (!env['LC_ALL']) env['LC_ALL'] = 'en_US.UTF-8';
      if (!process.env['PYTHONIOENCODING']) env['PYTHONIOENCODING'] = 'utf-8';
    }
    return env;
  }
}
