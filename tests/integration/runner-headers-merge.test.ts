/**
 * PR4 (provider polish): end-to-end header shape on outgoing LLM requests.
 *
 * Drives callLlmWithTools() against a mock HTTP server, captures the inbound
 * request headers, and pins:
 *   - Authorization is set from the runner-resolved api key (proving the
 *     api_key_env path wires through).
 *   - User-supplied extraHeaders arrive on the wire.
 *   - The runner's reserved headers (Content-Type, Authorization) cannot
 *     be displaced — even if a test passes extraHeaders bypassing
 *     validateConfig.
 *   - On HTTP 401 with the live key echoed in the body, the thrown Error
 *     contains ***REDACTED*** (Codex pass-1 PR4-001).
 *
 * Mock server listens on 127.0.0.1:0 (ephemeral port). One server reused
 * across tests; one-shot request capture per test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { callLlmWithTools, type ToolLoopOptions } from '../../src/openai-runner/loop';
import type { BusPaths } from '../../src/types';

interface CapturedRequest {
  method: string;
  headers: IncomingMessage['headers'];
  rawHeaders: string[];
  body: string;
}

function stubBusPaths(tmpRoot: string): BusPaths {
  const ctxRoot = join(tmpRoot, 'ctx');
  mkdirSync(ctxRoot, { recursive: true });
  return {
    ctxRoot,
    inbox: join(ctxRoot, 'inbox'),
    inflight: join(ctxRoot, 'inflight'),
    processed: join(ctxRoot, 'processed'),
    logDir: join(ctxRoot, 'logs'),
    stateDir: join(ctxRoot, 'state'),
    taskDir: join(ctxRoot, 'tasks'),
    approvalDir: join(ctxRoot, 'approvals'),
    analyticsDir: join(ctxRoot, 'analytics'),
    deliverablesRoot: (_org: string) => join(ctxRoot, 'orgs', _org, 'deliverables'),
  } as unknown as BusPaths;
}

function baseOpts(endpoint: string, busPaths: BusPaths, overrides: Partial<ToolLoopOptions> = {}): ToolLoopOptions {
  return {
    endpoint,
    apiKey: 'test-secret-from-env-do-not-leak-1234567890',
    model: 'mock',
    maxTokens: 100,
    temperature: 0,
    requestTimeoutMs: 5000,
    toolsSupported: { value: true },
    enabledToolNames: [],
    defaultToolTimeoutMs: undefined,
    toolTimeoutsMs: {},
    maxIterations: 3,
    sendBudget: 0,
    onProgress: () => undefined,
    busPaths,
    agentName: 'test-agent',
    org: 'test-org',
    toolContext: {
      agentName: 'test-agent',
      agentDir: '/tmp/nothing',
      paths: busPaths,
      org: 'test-org',
      currentInboxMsgId: 'm-1',
      enabledAgentsRegistry: new Set(),
    },
    ...overrides,
  };
}

describe('PR4 header merge (integration)', { timeout: 15_000 }, () => {
  let server: Server;
  let endpoint: string;
  let captured: CapturedRequest | null;
  let respondWith: (req: CapturedRequest) => { statusCode: number; body: string; contentType?: string };
  let tmpRoot: string;
  let busPaths: BusPaths;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'pr4-headers-'));
    busPaths = stubBusPaths(tmpRoot);
    captured = null;
    respondWith = () => ({
      statusCode: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'mock reply' } }],
      }),
    });

    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        captured = {
          method: req.method ?? 'GET',
          headers: req.headers,
          rawHeaders: req.rawHeaders,
          body: Buffer.concat(chunks).toString(),
        };
        const out = respondWith(captured);
        res.statusCode = out.statusCode;
        res.setHeader('Content-Type', out.contentType ?? 'application/json');
        res.end(out.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    endpoint = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('Authorization header is set from opts.apiKey', async () => {
    await callLlmWithTools(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      baseOpts(endpoint, busPaths),
    );
    expect(captured).not.toBeNull();
    expect(captured!.headers.authorization).toBe('Bearer test-secret-from-env-do-not-leak-1234567890');
  });

  it('Content-Type is set by the runner regardless of extraHeaders', async () => {
    await callLlmWithTools(
      [{ role: 'user', content: 'hi' }],
      baseOpts(endpoint, busPaths, {
        extraHeaders: { 'X-Title': 'demo' },
      }),
    );
    expect(captured!.headers['content-type']).toBe('application/json');
  });

  it('operator extraHeaders arrive on the wire', async () => {
    await callLlmWithTools(
      [{ role: 'user', content: 'hi' }],
      baseOpts(endpoint, busPaths, {
        extraHeaders: {
          'HTTP-Referer': 'https://example.invalid',
          'X-Title': 'cortextOS test',
          'User-Agent': 'cortextos-test/1.0',
        },
      }),
    );
    expect(captured!.headers['http-referer']).toBe('https://example.invalid');
    expect(captured!.headers['x-title']).toBe('cortextOS test');
    expect(captured!.headers['user-agent']).toBe('cortextos-test/1.0');
  });

  it('operator-supplied Authorization in extraHeaders CANNOT clobber the runner-set token at the HTTP boundary', async () => {
    // validateConfig already rejects this combination at the config layer;
    // this test pins the second line of defense — the spread order in
    // callLlmOnce — by passing extraHeaders directly, bypassing the config
    // boundary entirely (as a test might, or as a future caller might).
    await callLlmWithTools(
      [{ role: 'user', content: 'hi' }],
      baseOpts(endpoint, busPaths, {
        extraHeaders: { 'Authorization': 'Bearer attacker-supplied' },
      }),
    );
    expect(captured!.headers.authorization).toBe('Bearer test-secret-from-env-do-not-leak-1234567890');
    expect(captured!.headers.authorization).not.toContain('attacker-supplied');
  });

  it('operator-supplied Content-Type in extraHeaders CANNOT clobber the runner default', async () => {
    await callLlmWithTools(
      [{ role: 'user', content: 'hi' }],
      baseOpts(endpoint, busPaths, {
        extraHeaders: { 'Content-Type': 'text/plain' },
      }),
    );
    expect(captured!.headers['content-type']).toBe('application/json');
  });

  it('on 401 with the live key echoed in the body, the thrown Error has the key REDACTED', async () => {
    const liveKey = 'test-secret-from-env-do-not-leak-1234567890';
    respondWith = () => ({
      statusCode: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        error: `Authorization Bearer ${liveKey} rejected; key invalid`,
      }),
    });

    let thrown: unknown = null;
    try {
      await callLlmWithTools(
        [{ role: 'user', content: 'hi' }],
        baseOpts(endpoint, busPaths),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('LLM HTTP 401');
    expect(msg).toContain('***REDACTED***');
    expect(msg).not.toContain(liveKey);
  });
});
