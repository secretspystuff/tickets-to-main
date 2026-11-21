import assert from "node:assert/strict";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { restoreBoardFeedCursor, stepBoardFeedCursor } from "../src/board-feed-cursor.ts";
import { emptyLedger, ledgerPath, loadLedger } from "../src/ledger.ts";
import { removeDir, tempDir } from "./helpers.ts";

const fixture = (name: string) => readFileSync(new URL("../../src/lib/ttm-protocol/feed-recovery/" + name + ".json", import.meta.url), "utf8");
const request = fixture("request");
const reference = JSON.parse(fixture("response"));
const current = { board: reference.board as string, binding: "fabricated-binding", session: "fabricated-session" };
const other = { board: "fabricated-other-board", binding: "other-binding", handled: 12 };
type Context = typeof current;
type Replay = Extract<ReturnType<typeof restoreBoardFeedCursor>, { kind: "loaded" }>["replay"];
type Event = Parameters<typeof stepBoardFeedCursor>[3];
type Completion = Extract<Event, { kind: "snapshot-applied" }> & { response: string };
const restore: (dir: string, context: Context, request: string) => ReturnType<typeof restoreBoardFeedCursor> = restoreBoardFeedCursor;

function start(dir: string, at = 91) {
  const baseline = { ...emptyLedger(), boardFeedCursors: [{ board: current.board, binding: current.binding, handled: at }, other] };
  writeFileSync(ledgerPath(dir), JSON.stringify(baseline), { mode: 0o600 });
}

function gap(dir: string, context = current, selected = request) {
  const restored = restore(dir, context, selected);
  assert.equal(restored.kind, "loaded");
  const scope = { board: context.board, session: context.session };
  const hi = stepBoardFeedCursor(dir, context, restored.replay, { kind: "hi", scope, seq: 92 });
  assert.equal(hi.kind, "stepped");
  const changes = hi.step.actions[0];
  assert.equal(changes?.kind, "read-changes");
  const tooOld = stepBoardFeedCursor(dir, context, hi.step.state, { kind: "changes-too-old", scope, requestId: changes.requestId });
  assert.equal(tooOld.kind, "stepped");
  const snapshot = tooOld.step.actions[0];
  assert.equal(snapshot?.kind, "read-snapshot");
  return { state: tooOld.step.state, scope, requestId: snapshot.requestId };
}

function apply(dir: string, read: ReturnType<typeof gap>, response = reference, context = current, state: Replay = read.state) {
  const event: Completion = { kind: "snapshot-applied", scope: read.scope, requestId: read.requestId,
    next: response.next, response: JSON.stringify(response) };
  return stepBoardFeedCursor(dir, context, state, event);
}

function saved(dir: string) {
  const loaded = loadLedger(dir);
  assert.equal(loaded.ok, true);
  assert.ok(loaded.ledger.boardFeedCursors);
  assert.deepEqual(loaded.ledger.boardFeedCursors[1], other);
  return loaded.ledger.boardFeedCursors[0] as { handled: number; recoverySnapshot?: unknown };
}

test("a scoped recovery stores the selected graph and its matching lower cursor before continuing from it", () => {
  const dir = tempDir();
  try {
    start(dir);
    const read = gap(dir);
    const result = apply(dir, read);
    assert.equal(result.kind, "stepped");
    assert.deepEqual(result.step.actions.map(action => [action.kind, "since" in action && action.since]), [["read-changes", reference.next]]);
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
    assert.equal(saved(dir).handled, reference.next);
    const restart = restore(dir, { ...current, session: "fabricated-restart" }, request);
    assert.equal(restart.kind, "loaded");
    assert.equal(restart.replay.cursor, reference.next);
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
  } finally { removeDir(dir); }
});

test("current capture accepts an empty graph at an unchanged cursor but not a late result from an earlier selection", () => {
  const dir = tempDir();
  try {
    start(dir, reference.next);
    const old = gap(dir);
    const replacement = JSON.parse(request);
    replacement.selection[0].activation_id = "d".repeat(32);
    const nextContext = { ...current, session: "fabricated-second-session" };
    const active = gap(dir, nextContext, JSON.stringify(replacement));
    const empty = { ...reference, selection: replacement.selection, tickets: [] };
    const accepted = apply(dir, active, empty, nextContext);
    assert.equal(accepted.kind, "stepped");
    const before = readFileSync(ledgerPath(dir));
    assert.deepEqual(apply(dir, old), { kind: "held" });
    assert.deepEqual(apply(dir, active, empty, nextContext), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    assert.deepEqual(saved(dir).recoverySnapshot, empty);
  } finally { removeDir(dir); }
});

test("a mismatched answer or retirement keeps the uncommitted baseline intact", () => {
  const dir = tempDir();
  try {
    start(dir);
    const read = gap(dir), before = readFileSync(ledgerPath(dir));
    for (const value of [
      { ...reference, board: other.board },
      { ...reference, selection: [] },
      { ...reference, selection: [{ ...reference.selection[0], activation_id: "e".repeat(32) }] },
      { ...reference, tickets: [{ ...reference.tickets[0], repo_id: "different" }] },
      { ...reference, graph_revision: reference.graph_revision + 1 },
    ]) assert.deepEqual(apply(dir, read, value), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    const closed = stepBoardFeedCursor(dir, current, read.state, { kind: "closed", scope: read.scope, code: 4403 });
    assert.equal(closed.kind, "stepped");
    const afterClose = readFileSync(ledgerPath(dir));
    assert.deepEqual(apply(dir, read), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), afterClose);
    assert.equal(saved(dir).handled, 91);
    assert.equal(saved(dir).recoverySnapshot, undefined);
  } finally { removeDir(dir); }
});

test("a failed ledger replacement preserves both sides of the checkpoint and permits the original capture to retry", () => {
  const dir = tempDir(), rename = fs.renameSync;
  try {
    start(dir);
    const read = gap(dir), before = readFileSync(ledgerPath(dir));
    let replacements = 0;
    fs.renameSync = (from, to) => {
      if (to === ledgerPath(dir)) { replacements++; throw new Error("fabricated storage interruption"); }
      rename(from, to);
    };
    syncBuiltinESMExports();
    assert.deepEqual(apply(dir, read), { kind: "held" });
    assert.equal(replacements, 1);
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    fs.renameSync = rename;
    syncBuiltinESMExports();
    assert.equal(apply(dir, read).kind, "stepped");
    assert.equal(saved(dir).handled, reference.next);
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); removeDir(dir); }
});
