import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { join } from 'path';
import type { ToolDefinition } from './types.js';

// Pinned regex from PLAN.md (Codex L2 fix): ASCII allowlist, must start with
// alphanumeric, allow alphanumeric + dot + underscore + hyphen, end with one
// of the three permitted extensions. Rejects path traversal (`..`), absolute
// paths (`/`), Unicode confusables (input is NFC-normalized first).
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(md|txt|json)$/;

const MAX_FILE_BYTES = 256 * 1024;

/**
 * Reads a file from the agent's `memory/` directory. The filename is
 * strictly validated to prevent path traversal — only alphanumerics, dots,
 * underscores, hyphens; extensions are restricted to .md/.txt/.json.
 * Files larger than 256 KB return the first chunk + a truncation marker.
 */
export const readMemoryFileTool: ToolDefinition = {
  name: 'read_memory_file',
  description: 'Read a single file from this agent\'s memory/ directory. Path traversal is rejected. Files over 256 KB are truncated.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Filename within memory/, e.g. "2026-05-13.md" or "notes.md". No paths, no leading dots.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  defaultTimeoutMs: 2_000,
  handler: async (args, ctx) => {
    const argsObj = args as { name?: unknown } | null;
    if (!argsObj || typeof argsObj.name !== 'string') {
      return 'error: missing or non-string argument "name"';
    }
    const normalized = argsObj.name.normalize('NFC');
    if (!FILENAME_RE.test(normalized)) {
      return `error: filename "${normalized}" rejected. Allowed: alphanumerics, dots, underscores, hyphens, ending in .md/.txt/.json. No paths.`;
    }
    const path = join(ctx.agentDir, 'memory', normalized);
    if (!existsSync(path)) {
      return `error: memory file not found: ${normalized}`;
    }
    // Codex P3-1: bound the actual disk read to MAX_FILE_BYTES rather than
    // reading the whole file and slicing the string. A multi-MB memory
    // file (no longer expected, but operators can write arbitrary content)
    // would otherwise allocate the full size before truncation.
    let fd: number | null = null;
    try {
      const size = statSync(path).size;
      const readLimit = Math.min(size, MAX_FILE_BYTES);
      const buf = Buffer.alloc(readLimit);
      fd = openSync(path, 'r');
      let totalRead = 0;
      while (totalRead < readLimit) {
        const n = readSync(fd, buf, totalRead, readLimit - totalRead, totalRead);
        if (n === 0) break;
        totalRead += n;
      }
      const content = buf.subarray(0, totalRead).toString('utf-8');
      if (size > MAX_FILE_BYTES) {
        return content + `\n... [truncated — file is ${size} bytes, showing first ${MAX_FILE_BYTES}]`;
      }
      return content;
    } catch (err) {
      return `error: failed to read ${normalized}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch { /* fd already closed */ }
      }
    }
  },
};
