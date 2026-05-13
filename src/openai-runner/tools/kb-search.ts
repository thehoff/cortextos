import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'fs';
import { join } from 'path';
import type { ToolDefinition } from './types.js';

// Caps from PLAN.md (Codex M5 fix). All checked even when individual limits
// would alone suffice — defense in depth against pathological inputs.
const MAX_FILE_BYTES = 1024 * 1024;        // 1 MB scanned per file
const MAX_LINE_CHARS = 200;                // truncate a single matched line
const MAX_MATCHES = 5;                     // total matches returned
const MAX_RESPONSE_BYTES = 4 * 1024;       // 4 KB total response budget

/**
 * Escape regex special chars in a user-supplied query so a query like
 * "(beta) v1.0" doesn't blow up the matcher with unbalanced parens.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Searches the agent's memory + identity files for a literal substring.
 * Returns up to 5 matched lines with file:line context. Doesn't recurse;
 * doesn't use embeddings; case-insensitive.
 *
 * Files scanned:
 *   - <agentDir>/memory/*.md (and .txt, .json — same set as read_memory_file)
 *   - <agentDir>/IDENTITY.md
 *   - <agentDir>/SYSTEM_PROMPT.md
 *
 * Each cap is applied independently so a single multi-MB file or a single
 * 50KB-line file can't break the next LLM call.
 */
export const kbSearchTool: ToolDefinition = {
  name: 'kb_search',
  description: 'Search the agent\'s memory and identity files for a literal substring (case-insensitive). Returns up to 5 file:line matches with context. Use this before answering questions where the agent\'s memory might be relevant.',
  parameters: {
    type: 'object',
    properties: {
      q: {
        type: 'string',
        description: 'The substring to search for. Regex special characters are auto-escaped.',
      },
    },
    required: ['q'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 3_000,
  handler: async (args, ctx, signal) => {
    const argsObj = args as { q?: unknown } | null;
    if (!argsObj || typeof argsObj.q !== 'string' || !argsObj.q.trim()) {
      return 'error: missing or empty argument "q"';
    }
    const query = argsObj.q.trim();
    const matcher = new RegExp(escapeRegex(query), 'i');

    const candidates: string[] = [];
    const memDir = join(ctx.agentDir, 'memory');
    if (existsSync(memDir)) {
      try {
        for (const entry of readdirSync(memDir)) {
          if (/\.(md|txt|json)$/i.test(entry)) {
            candidates.push(join(memDir, entry));
          }
        }
      } catch { /* ignore — memory dir is best-effort scope */ }
    }
    for (const top of ['IDENTITY.md', 'SYSTEM_PROMPT.md']) {
      const path = join(ctx.agentDir, top);
      if (existsSync(path)) candidates.push(path);
    }

    const matches: string[] = [];
    let responseBytes = 0;
    let truncated = false;

    outer:
    for (const path of candidates) {
      // Codex P3-1: cooperative cancellation between file boundaries. Sync
      // readFileSync inside the inner loop can't be preempted, but checking
      // the abort signal here bounds the worst-case stall to one file's
      // read time. signal is passed in via the third handler argument.
      if (signal.aborted) {
        truncated = true;
        break;
      }
      let content: string;
      let fd: number | null = null;
      try {
        const size = statSync(path).size;
        if (size > MAX_FILE_BYTES) {
          // Codex P3-1: bound the actual disk read to MAX_FILE_BYTES via
          // openSync + readSync rather than reading the whole file and
          // slicing. A multi-GB log file would otherwise allocate full
          // size before being truncated.
          const buf = Buffer.alloc(MAX_FILE_BYTES);
          fd = openSync(path, 'r');
          let totalRead = 0;
          while (totalRead < MAX_FILE_BYTES) {
            const n = readSync(fd, buf, totalRead, MAX_FILE_BYTES - totalRead, totalRead);
            if (n === 0) break;
            totalRead += n;
          }
          content = buf.subarray(0, totalRead).toString('utf-8');
        } else {
          content = readFileSync(path, 'utf-8');
        }
      } catch {
        continue;
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* fd already closed */ }
        }
      }
      const relPath = path.startsWith(ctx.agentDir + '/')
        ? path.slice(ctx.agentDir.length + 1)
        : path;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i]!)) continue;
        let excerpt = lines[i]!.trim();
        if (excerpt.length > MAX_LINE_CHARS) {
          excerpt = excerpt.slice(0, MAX_LINE_CHARS) + ' ...';
        }
        const line = `${relPath}:${i + 1} — ${excerpt}`;
        if (responseBytes + line.length + 1 > MAX_RESPONSE_BYTES) {
          truncated = true;
          break outer;
        }
        matches.push(line);
        responseBytes += line.length + 1;
        if (matches.length >= MAX_MATCHES) {
          // Codex P3-5: there may be more matches we didn't return —
          // flag it so the model knows it's not seeing an exhaustive list.
          truncated = true;
          break outer;
        }
      }
    }

    if (matches.length === 0) {
      return JSON.stringify({ query, matches: [], message: 'No matches found.' });
    }
    return JSON.stringify({ query, matches, ...(truncated ? { truncated: true } : {}) });
  },
};
