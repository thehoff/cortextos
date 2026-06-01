// The dispatcher: fan a prompt out to N peers IN PARALLEL, capture each verdict,
// aggregate. Graceful degradation — a peer that errors/times out is recorded,
// never hangs the run (spec: review with < full quorum is flagged, not silently
// passed). Emits stage/transition events (the seam the future visualiser taps).

const REVIEW_INSTRUCTION =
  "You are one voice on a multi-model review council. Act as a hard critic of " +
  "the TARGET below. List the top issues, each tagged blocker/high/medium/low, " +
  "with a one-line fix. Be concrete. No preamble.";

/**
 * @param {object} o
 * @param {string} o.content      the material to review (file body, diff, spec…)
 * @param {string} [o.instruction] override the critic instruction
 * @param {Array}  o.peers        runnable peers (see peers.mjs / or mocks)
 * @param {string} [o.cwd]
 * @param {number} [o.timeoutMs]
 * @param {(e:object)=>void} [o.onEvent]  stage events: {peer, stage, ts}
 */
export async function review({ content, instruction = REVIEW_INSTRUCTION, peers, cwd, timeoutMs, onEvent = () => {} }) {
  if (!peers || peers.length === 0) throw new Error("council: no peers to dispatch to");
  const prompt = `${instruction}\n\n----- TARGET -----\n${content}`;

  const results = await Promise.all(
    peers.map(async (p) => {
      onEvent({ peer: p.id, stage: "dispatch", ts: Date.now() });
      let r;
      try {
        // OpenAI peers send systemPrompt via the system slot; CLI peers have no
        // system slot, so prepend their per-agent system prompt into the prompt.
        const peerPrompt = p.kind !== "openai" && p.systemPrompt ? `${p.systemPrompt}\n\n${prompt}` : prompt;
        r = await p.run(peerPrompt, { cwd, timeoutMs });
      } catch (e) {
        r = { ok: false, error: e.message, text: "" };
      }
      onEvent({ peer: p.id, stage: r.ok ? "done" : "error", ts: Date.now() });
      return { peer: p.id, model: p.model, ...r };
    }),
  );

  return { results, summary: aggregate(results) };
}

/** Deterministic aggregation: response counts, quorum, and a tag tally. */
export function aggregate(results) {
  const responded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const tags = { blocker: 0, high: 0, medium: 0, low: 0 };
  for (const r of responded) {
    const text = (r.text || "").toLowerCase();
    for (const t of Object.keys(tags)) tags[t] += (text.match(new RegExp(`\\b${t}\\b`, "g")) || []).length;
  }
  return {
    dispatched: results.length,
    responded: responded.length,
    failed: failed.length,
    failedPeers: failed.map((r) => `${r.peer}:${r.error || "exit " + r.code}`),
    quorum: responded.length >= Math.ceil(results.length / 2),
    fullPanel: failed.length === 0,
    tagTally: tags,
    note: failed.length === 0
      ? "all peers responded"
      : `${failed.length}/${results.length} peer(s) failed — verdict is partial, do not treat as full-panel`,
  };
}
