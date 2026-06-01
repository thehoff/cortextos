// Proves the council consumes the CANONICAL cortextOS agent registry (vote A):
// a cortextOS agent dir (config.json + SYSTEM_PROMPT.md) resolves to a working
// council peer that calls the agent's endpoint with the agent's system prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCortextAgent, loadCortextAgents } from "../src/cortext-agents.mjs";

function stub() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { messages, model } = JSON.parse(body);
      const sys = messages.find((m) => m.role === "system")?.content || "(none)";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model, choices: [{ message: { content: `SYS=[${sys}]` } }] }));
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, port: server.address().port })));
}

function writeCortextAgent(root, org, name, cfg, systemPrompt) {
  const dir = join(root, "orgs", org, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  if (systemPrompt != null) writeFileSync(join(dir, "SYSTEM_PROMPT.md"), systemPrompt);
  return dir;
}

test("resolveCortextAgent bridges a native openai-compatible agent into a working peer", async () => {
  const { server, port } = await stub();
  const root = mkdtempSync(join(tmpdir(), "ctx-"));
  try {
    const dir = writeCortextAgent(root, "askew", "sentinel", {
      name: "sentinel", runtime: "openai-compatible",
      endpoint: `http://127.0.0.1:${port}/v1`, model: "local-qwen",
    }, "You are SENTINEL.");
    const peer = resolveCortextAgent(dir);
    assert.ok(peer, "should resolve");
    assert.equal(peer.id, "sentinel");
    assert.equal(peer.source, "cortext");
    const r = await peer.run("hello");
    assert.equal(r.ok, true);
    assert.match(r.text, /SYS=\[You are SENTINEL\.\]/); // native SYSTEM_PROMPT.md delivered
  } finally { server.close(); }
});

test("loadCortextAgents scans orgs/* and skips non-callable runtimes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctx-"));
  writeCortextAgent(root, "askew", "local1", { name: "local1", runtime: "openai-compatible", endpoint: "http://x/v1", model: "m" }, "p1");
  writeCortextAgent(root, "askew", "claude1", { name: "claude1", runtime: "claude-code", model: "claude" }, "p2");
  const peers = loadCortextAgents(join(root, "orgs"));
  assert.equal(peers.length, 1); // only the openai-compatible one is a one-shot voice
  assert.equal(peers[0].id, "local1");
});

test("loadCortextAgents returns [] when no orgs dir", () => {
  assert.deepEqual(loadCortextAgents("/nonexistent/orgs"), []);
});
