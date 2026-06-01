// council job — dispatch a CODING task to a single council worker (codex or
// opencode/MiniMax) running agentically in WRITE mode, inside a given worktree.
// agy is review-only and has no job mode. The worker's stdout/stderr stream
// straight through so you watch it work. (Law 1: council members as workers.)
import { spawn } from "node:child_process";
import { PEER_DEFS } from "./peers.mjs";

/** Workers that can write code (have a jobBuild). */
export function workerIds() {
  return Object.values(PEER_DEFS).filter((d) => typeof d.jobBuild === "function").map((d) => d.id);
}

/**
 * Run a coding job. Streams the worker's output live; resolves when it exits.
 * @param {{worker:string, cwd:string, task:string, timeoutMs?:number}} o
 * @returns {Promise<{ok:boolean, code?:number, error?:string, worker:string}>}
 */
export function runJob({ worker, cwd, task, timeoutMs }) {
  const def = PEER_DEFS[worker];
  if (!def) return Promise.resolve({ ok: false, error: `unknown worker '${worker}'`, worker });
  if (typeof def.jobBuild !== "function")
    return Promise.resolve({ ok: false, error: `'${worker}' is review-only — coders are: ${workerIds().join(", ")}`, worker });

  // The lane path is passed both as spawn cwd AND into the worker's own
  // directory flag (jobBuild's 2nd arg) — see peers.mjs for why cwd alone fails.
  const [cmd, args] = def.jobBuild(task, cwd);
  // Guard against NaN (e.g. `--timeout abc`): setTimeout(NaN) fires instantly.
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : def.timeoutMs;
  return new Promise((resolve) => {
    let child, done = false;
    // Kill the whole process GROUP — agentic workers spawn children that would
    // otherwise keep mutating the lane after we stop.
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { try { child && child.kill("SIGKILL"); } catch {} } };
    // Forward Ctrl-C / SIGTERM: a detached worker is in its own session, so
    // without this it survives the wrapper and keeps writing. Kill it, then exit.
    const onSig = () => { kill(); process.exit(130); };
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); process.off("SIGINT", onSig); process.off("SIGTERM", onSig); resolve({ ...r, worker }); } };
    const timer = setTimeout(() => { kill(); finish({ ok: false, error: "timeout" }); }, t);
    process.on("SIGINT", onSig); process.on("SIGTERM", onSig);
    try {
      // detached → own process group (so -pid kills the tree); stdin ignored
      // (EOF fix); stdout/stderr inherited so the Hoff watches the worker live.
      // PWD is overridden to the lane: child processes inherit the dispatcher
      // shell's $PWD, and tools that trust $PWD over getcwd() (opencode) would
      // otherwise root themselves in the wrong worktree. Only override when cwd
      // is a real value — never inject PWD: undefined into the child env.
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"], detached: true, env: cwd ? { ...process.env, PWD: cwd } : process.env });
    } catch (e) { return finish({ ok: false, error: e.message }); }
    child.on("error", (e) => finish({ ok: false, error: e.message }));
    child.on("close", (code) => finish({ ok: code === 0, code }));
  });
}
