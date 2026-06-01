// Dispatcher tests with MOCK peers — deterministic, no real model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { review, aggregate } from "../src/review.mjs";

const mockPeer = (id, behaviour) => ({
  id, model: `mock-${id}`,
  run: async () => behaviour,
});

test("fans out to all peers in parallel and aggregates", async () => {
  const peers = [
    mockPeer("a", { ok: true, text: "Issue 1 - blocker: fix. Issue 2 - high: fix." }),
    mockPeer("b", { ok: true, text: "medium: tweak. low: nit." }),
    mockPeer("c", { ok: true, text: "high: thing." }),
  ];
  const events = [];
  const { results, summary } = await review({ content: "x", peers, onEvent: (e) => events.push(`${e.stage}:${e.peer}`) });

  assert.equal(results.length, 3);
  assert.equal(summary.responded, 3);
  assert.equal(summary.fullPanel, true);
  assert.equal(summary.quorum, true);
  assert.equal(summary.tagTally.blocker, 1);
  assert.equal(summary.tagTally.high, 2);
  assert.equal(summary.tagTally.medium, 1);
  assert.equal(summary.tagTally.low, 1);
  // every peer emits dispatch + a terminal event
  assert.equal(events.filter((e) => e.startsWith("dispatch")).length, 3);
  assert.equal(events.filter((e) => e.startsWith("done")).length, 3);
});

test("a failing peer degrades gracefully and is flagged, not silently passed", async () => {
  const peers = [
    mockPeer("a", { ok: true, text: "high: x" }),
    mockPeer("b", { ok: false, error: "timeout", text: "" }),
    { id: "c", model: "mock-c", run: async () => { throw new Error("crashed"); } },
  ];
  const { summary } = await review({ content: "x", peers });
  assert.equal(summary.responded, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.fullPanel, false);
  assert.equal(summary.quorum, false); // 1 of 3
  assert.match(summary.note, /partial|do not treat/i);
  assert.ok(summary.failedPeers.some((f) => f.includes("timeout")));
  assert.ok(summary.failedPeers.some((f) => f.includes("crashed")));
});

test("aggregate is a pure function", () => {
  const r = [{ peer: "a", ok: true, text: "blocker here" }];
  assert.deepEqual(aggregate(r), aggregate(r));
});

test("throws with no peers", async () => {
  await assert.rejects(() => review({ content: "x", peers: [] }), /no peers/);
});
