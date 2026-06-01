// Regression: council job workers MUST be confined to the lane they're given.
// The 2026-06-01 incident: opencode resolved `--dir .` against the inherited
// $PWD (the dispatcher's worktree), so three parallel workers all coded in the
// dispatcher's tree instead of their lanes. jobBuild now receives the absolute
// lane path and must embed it in the worker's own directory flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PEER_DEFS } from "../src/peers.mjs";
import { workerIds } from "../src/job.mjs";

const LANE = "/tmp/some/absolute/lane";

test("workerIds exposes exactly the write-capable peers", () => {
  assert.deepEqual(workerIds().sort(), ["codex", "opencode"]);
});

test("opencode jobBuild embeds the absolute lane path in --dir", () => {
  const [cmd, args] = PEER_DEFS.opencode.jobBuild("do the thing", LANE);
  assert.equal(cmd, "opencode");
  const dirIdx = args.indexOf("--dir");
  assert.notEqual(dirIdx, -1, "--dir flag missing");
  assert.equal(args[dirIdx + 1], LANE, "--dir must be the absolute lane path, never '.'");
});

test("codex jobBuild embeds the absolute lane path in --cd", () => {
  const [cmd, args] = PEER_DEFS.codex.jobBuild("do the thing", LANE);
  assert.equal(cmd, "codex");
  const cdIdx = args.indexOf("--cd");
  assert.notEqual(cdIdx, -1, "--cd flag missing");
  assert.equal(args[cdIdx + 1], LANE, "--cd must be the absolute lane path");
});

test("every write-capable worker pins its directory flag to the lane", () => {
  for (const id of workerIds()) {
    const [, args] = PEER_DEFS[id].jobBuild("task", LANE);
    assert.ok(args.includes(LANE), `${id}: lane path must appear in worker args`);
  }
});

test("the task prompt always lands after the -- terminator", () => {
  for (const id of workerIds()) {
    const [, args] = PEER_DEFS[id].jobBuild("task with --flags inside", LANE);
    const sep = args.indexOf("--");
    assert.notEqual(sep, -1, `${id}: missing -- terminator`);
    assert.equal(args[args.length - 1], "task with --flags inside", `${id}: prompt must be the final arg`);
  }
});
