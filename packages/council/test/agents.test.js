// Local-LLM framework tests: OpenAI-compatible peer (against a mock stub server,
// no creds/network) + agent registry validation + per-agent system prompt delivery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { makeOpenAIPeer } from "../src/peers.mjs";
import { loadAgents, validateAgent, getAgents } from "../src/agents.mjs";

/** Mock OpenAI-compatible server. Echoes back the system + user messages it got
 *  so tests can prove what was actually sent. `mode` forces error/slow paths. */
function stub(mode = "ok") {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (mode === "500") { res.writeHead(500).end("boom"); return; }
      if (mode === "slow") { setTimeout(() => res.writeHead(200).end("{}"), 5000); return; }
      const { messages, model } = JSON.parse(body);
      const sys = messages.find((m) => m.role === "system")?.content || "(none)";
      const user = messages.find((m) => m.role === "user")?.content || "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model,
        choices: [{ message: { role: "assistant", content: `SYS=[${sys}] USER=[${user.slice(0, 30)}]` } }],
        usage: { total_tokens: 42 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

test("registry agents.json loads and validates", () => {
  const agents = loadAgents();
  assert.ok(agents.length >= 8);
  assert.ok(agents.find((a) => a.id === "codex" && a.kind === "cli"));
  assert.ok(agents.find((a) => a.kind === "openai" && a.baseUrl));
  // every agent carries a system prompt
  for (const a of agents) assert.ok(a.systemPrompt, `${a.id} has no systemPrompt`);
});

test("validateAgent rejects bad entries", () => {
  assert.deepEqual(validateAgent({ id: "x", kind: "openai", model: "m" }), ["x: openai agent needs baseUrl"]);
  assert.ok(validateAgent({ id: "y", kind: "bogus" }).some((e) => /kind must be/.test(e)));
  const seen = new Set(["dup"]);
  assert.ok(validateAgent({ id: "dup", kind: "cli", cli: "codex" }, seen).some((e) => /duplicate/.test(e)));
});

test("getAgents filters by kind/role/enabled", () => {
  assert.ok(getAgents({ kind: "openai" }).every((a) => a.kind === "openai"));
  assert.ok(getAgents({ enabled: true }).every((a) => a.enabled !== false));
});

test("openai peer sends the agent's OWN system prompt + returns content", async () => {
  const { server, port } = await stub("ok");
  try {
    const peer = makeOpenAIPeer({
      id: "t", model: "test-model", baseUrl: `http://127.0.0.1:${port}/v1`,
      systemPrompt: "YOU-ARE-AGENT-T",
    });
    const r = await peer.run("review this please");
    assert.equal(r.ok, true);
    assert.match(r.text, /SYS=\[YOU-ARE-AGENT-T\]/); // per-agent system prompt was delivered
    assert.match(r.text, /USER=\[review this please\]/);
    assert.equal(r.usage.total_tokens, 42);
  } finally { server.close(); }
});

test("openai peer degrades gracefully on HTTP error", async () => {
  const { server, port } = await stub("500");
  try {
    const peer = makeOpenAIPeer({ id: "t", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` });
    const r = await peer.run("x");
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 500/);
  } finally { server.close(); }
});

test("openai peer times out cleanly", async () => {
  const { server, port } = await stub("slow");
  try {
    const peer = makeOpenAIPeer({ id: "t", model: "m", baseUrl: `http://127.0.0.1:${port}/v1` });
    const r = await peer.run("x", { timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "timeout");
  } finally { server.close(); }
});
