import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { restoreBoardFeedCursor, stepBoardFeedCursor } from "../src/board-feed-cursor.ts";
import { emptyLedger, ledgerPath, loadLedger, updateLedger } from "../src/ledger.ts";
import { removeDir, tempDir } from "./helpers.ts";

const fixture = (name: string) => readFileSync(new URL("../../src/lib/ttm-protocol/feed-recovery/" + name + ".json", import.meta.url), "utf8");
const request = fixture("request");
const reference = JSON.parse(fixture("response"));
const link = { link_id: "f".repeat(32), unavailable: false, id: "e".repeat(32), heading: "Review 100%",
  repo_id: reference.selection[0].repo.board_repo_id, status: "closed", closed: true, satisfies: true };
reference.tickets[0].relationships.depends_on = [link];
reference.tickets[0].relationships.related = [{ link_id: "9".repeat(32), unavailable: true }];
const current = { board: reference.board as string, binding: "fabricated-binding", session: "fabricated-session" };
const other = { board: "fabricated-other-board", binding: "other-binding", handled: 12 };
type Context = typeof current;
type Replay = Extract<ReturnType<typeof restoreBoardFeedCursor>, { kind: "loaded" }>["replay"];
type Event = Parameters<typeof stepBoardFeedCursor>[3];
type Completion = Extract<Event, { kind: "snapshot-applied" }> & { response: string; capture: object };
const restore: (dir: string, context: Context, request: string, heldValues?: string[]) => ReturnType<typeof restoreBoardFeedCursor> = restoreBoardFeedCursor;

function start(dir: string, at = 91) {
  const baseline = { ...emptyLedger(), boundWorkspaceIntents: ["5".repeat(32)],
    boardFeedCursors: [{ board: current.board, binding: current.binding, handled: at }, other] };
  writeFileSync(ledgerPath(dir), JSON.stringify(baseline), { mode: 0o600 });
}

function gap(dir: string, context = current, selected = request, heldValues?: string[]) {
  const restored = restore(dir, context, selected, heldValues);
  assert.equal(restored.kind, "loaded");
  const scope = { board: context.board, session: context.session };
  const hi = stepBoardFeedCursor(dir, context, restored.replay, { kind: "hi", scope, seq: 92 });
  assert.equal(hi.kind, "stepped");
  const changes = hi.step.actions[0];
  if (changes?.kind === "read-snapshot") {
    return { state: hi.step.state, scope, requestId: changes.requestId, capture: changes };
  }
  assert.equal(changes?.kind, "read-changes");
  const tooOld = stepBoardFeedCursor(dir, context, hi.step.state, { kind: "changes-too-old", scope, requestId: changes.requestId });
  assert.equal(tooOld.kind, "stepped");
  const snapshot = tooOld.step.actions[0];
  assert.equal(snapshot?.kind, "read-snapshot");
  return { state: tooOld.step.state, scope, requestId: snapshot.requestId, capture: snapshot };
}

function apply(dir: string, read: ReturnType<typeof gap>, response = reference, context = current, state: Replay = read.state,
  next = response.next, body = JSON.stringify(response)) {
  const event: Completion = { kind: "snapshot-applied", scope: read.scope, requestId: read.requestId,
    next, response: body, capture: read.capture };
  return stepBoardFeedCursor(dir, context, state, event);
}

function saved(dir: string) {
  const loaded = loadLedger(dir);
  assert.equal(loaded.ok, true);
  assert.ok(loaded.ledger.boardFeedCursors);
  assert.deepEqual(loaded.ledger.boundWorkspaceIntents, ["5".repeat(32)]);
  assert.deepEqual(loaded.ledger.boardFeedCursors[1], other);
  return loaded.ledger.boardFeedCursors[0] as { handled: number; recoverySnapshot?: unknown };
}

test("a scoped recovery stores the selected graph and its matching lower cursor before continuing from it", () => {
  const dir = tempDir();
  try {
    start(dir);
    const read = gap(dir);
    updateLedger(dir, [], ledger => { ledger.tools.push({ vendor: "codex", interfaceId: "cli", qualification: "unknown",
      experimental: "unknown", version: null, limit: "fabricated retained observation" }); });
    const result = apply(dir, read);
    assert.equal(result.kind, "stepped");
    assert.deepEqual(result.step.actions.map(action => [action.kind, "since" in action && action.since]), [["read-changes", reference.next]]);
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
    assert.equal(saved(dir).handled, reference.next);
    const independent = loadLedger(dir);
    assert.ok(independent.ok && independent.ledger.tools[0]?.limit === "fabricated retained observation");
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
    gap(dir);
    const old = gap(dir);
    const replacement = JSON.parse(request);
    replacement.selection[0].activation_id = "d".repeat(32);
    const nextContext = { ...current };
    const active = gap(dir, nextContext, JSON.stringify(replacement));
    assert.equal(old.requestId, active.requestId);
    const during = readFileSync(ledgerPath(dir));
    assert.deepEqual(apply(dir, old), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), during);
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

test("a changed selection keeps its previous baseline until the fresh 410 capture commits", () => {
  const dir = tempDir();
  try {
    start(dir);
    assert.equal(apply(dir, gap(dir)).kind, "stepped");
    const changed = JSON.parse(request);
    changed.selection[0].activation_id = "2".repeat(32);
    const selected = JSON.stringify(changed);
    const opened = restore(dir, current, selected);
    assert.equal(opened.kind, "loaded");
    const scope = { board: current.board, session: current.session };
    const read = stepBoardFeedCursor(dir, current, opened.replay, { kind: "wake", scope });
    assert.equal(read.kind, "stepped");
    const action = read.step.actions[0];
    assert.ok(action?.kind === "read-snapshot");
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
    const fresh = { ...reference, next: reference.next + 1, selection: changed.selection };
    assert.equal(apply(dir, { state: read.step.state, scope, requestId: action.requestId, capture: action }, fresh).kind, "stepped");
    assert.deepEqual(saved(dir).recoverySnapshot, fresh);
  } finally { removeDir(dir); }
});

test("a held value in a display heading keeps the saved cursor and graph private", () => {
  const dir = tempDir();
  try {
    start(dir);
    const read = gap(dir, current, request, ["fabricated private phrase"]);
    const body = structuredClone(reference);
    body.tickets[0].relationships.depends_on[0].heading = "a fabricated private phrase";
    const before = readFileSync(ledgerPath(dir));
    assert.deepEqual(apply(dir, read, body), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    assert.equal(apply(dir, read).kind, "stepped");
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
  } finally { removeDir(dir); }
});

test("a mismatched answer or retirement keeps the uncommitted baseline intact", () => {
  const dir = tempDir();
  try {
    start(dir);
    const read = gap(dir), before = readFileSync(ledgerPath(dir));
    const missing = structuredClone(reference);
    delete missing.tickets[0].relationships.eligibility;
    const foreignLink = structuredClone(reference);
    foreignLink.tickets[0].relationships.depends_on[0].repo_id = "another-repo";
    const changedIdentity = structuredClone(reference), changedLocator = structuredClone(reference);
    changedIdentity.selection[0].repo.identity_id = "1".repeat(32);
    changedLocator.selection[0].repo.locator = { host: "example.com", owner: "fabricated", name: "different" };
    for (const value of [
      missing, foreignLink, changedIdentity, changedLocator,
      { ...reference, board: other.board },
      { ...reference, selection: [] },
      { ...reference, selection: [{ ...reference.selection[0], activation_id: "e".repeat(32) }] },
      { ...reference, tickets: [{ ...reference.tickets[0], repo_id: "different" }] },
      { ...reference, graph_revision: reference.graph_revision + 1 },
    ]) assert.deepEqual(apply(dir, read, value), { kind: "held" });
    assert.deepEqual(apply(dir, read, reference, current, read.state, reference.next + 1), { kind: "held" });
    assert.deepEqual(apply(dir, read, reference, current, read.state, reference.next, "{"), { kind: "held" });
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

test("a retried read cannot consume the previous response or lose its own matching response", () => {
  const dir = tempDir();
  try {
    start(dir);
    const old = gap(dir);
    const failed = stepBoardFeedCursor(dir, current, old.state, { kind: "snapshot-read-failed", scope: old.scope, requestId: old.requestId });
    assert.equal(failed.kind, "stepped");
    const retry = stepBoardFeedCursor(dir, current, failed.step.state, { kind: "wake", scope: old.scope });
    assert.equal(retry.kind, "stepped");
    const action = retry.step.actions[0];
    assert.ok(action?.kind === "read-snapshot" && action.requestId !== old.requestId);
    const before = readFileSync(ledgerPath(dir));
    assert.deepEqual(apply(dir, old), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    assert.equal(apply(dir, { ...old, state: retry.step.state, requestId: action.requestId, capture: action }).kind, "stepped");
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
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

const cursorModule = new URL("../src/board-feed-cursor.ts", import.meta.url).href;
const ledgerModule = new URL("../src/ledger.ts", import.meta.url).href;
const childEnv = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
function runChild(program: string, args: string[]) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program, ...args],
    { env: childEnv, encoding: "utf8", windowsHide: true });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test("after process interruption the reopened ledger contains exactly one complete recovery checkpoint", async t => {
  for (const phase of ["before", "after"]) await t.test(phase, () => {
    const dir = tempDir();
    try {
      start(dir);
      const run = runChild(`
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { restoreBoardFeedCursor, stepBoardFeedCursor } from ${JSON.stringify(cursorModule)};
        import { ledgerPath } from ${JSON.stringify(ledgerModule)};
        const [dir, phase, rawContext, request, response] = process.argv.slice(1);
        const current = JSON.parse(rawContext), scope = { board: current.board, session: current.session };
        const opened = restoreBoardFeedCursor(dir, current, request);
        const reading = stepBoardFeedCursor(dir, current, opened.replay, { kind: "wake", scope });
        const gap = stepBoardFeedCursor(dir, current, reading.step.state, {
          kind: "changes-too-old", scope, requestId: reading.step.actions[0].requestId });
        const rename = fs.renameSync, target = ledgerPath(dir);
        fs.renameSync = (from, to) => {
          if (to !== target) return rename(from, to);
          if (phase === "after") rename(from, to);
          process.exit(73);
        };
        syncBuiltinESMExports();
        stepBoardFeedCursor(dir, current, gap.step.state, { kind: "snapshot-applied", scope,
          requestId: gap.step.actions[0].requestId, capture: gap.step.actions[0], next: JSON.parse(response).next, response });
        process.exit(74);
      `, [dir, phase, JSON.stringify(current), request, JSON.stringify(reference)]);
      assert.equal(run.status, 73, run.stderr);
      const reopen = runChild(`
        import { loadLedger } from ${JSON.stringify(ledgerModule)};
        const loaded = loadLedger(process.argv[1]);
        if (!loaded.ok) process.exit(79);
        const row = loaded.ledger.boardFeedCursors[0];
        process.stdout.write(JSON.stringify({ next: row.handled, graph: row.recoverySnapshot ?? null,
          retained: loaded.ledger.boundWorkspaceIntents, other: loaded.ledger.boardFeedCursors[1] }));
      `, [dir]);
      assert.equal(reopen.status, 0, reopen.stderr);
      const expected = phase === "after" ? { next: reference.next, graph: reference } : { next: 91, graph: null };
      assert.deepEqual(JSON.parse(reopen.stdout), { ...expected, retained: ["5".repeat(32)], other });
    } finally { removeDir(dir); }
  });
});

test("a restarted process reads a fresh snapshot after the 410 was observed locally", () => {
  const dir = tempDir();
  try {
    start(dir);
    gap(dir);
    const result = runChild(`
      import { restoreBoardFeedCursor, stepBoardFeedCursor } from ${JSON.stringify(cursorModule)};
      const [dir, context, request] = process.argv.slice(1), current = JSON.parse(context);
      const replay = restoreBoardFeedCursor(dir, current, request).replay;
      const scope = { board: current.board, session: current.session };
      const hi = stepBoardFeedCursor(dir, current, replay, { kind: "hi", scope, seq: 94 });
      process.stdout.write(JSON.stringify(hi.step.actions.map(action => action.kind)));
    `, [dir, JSON.stringify({ ...current, session: "fresh-process" }), request]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["read-snapshot"]);
    assert.equal(saved(dir).handled, 91);
  } finally { removeDir(dir); }
});

test("the original capture distinguishes matching numeric request IDs on a newer current replay", () => {
  const dir = tempDir();
  try {
    start(dir);
    gap(dir);
    const earlier = gap(dir), latest = gap(dir);
    assert.equal(earlier.requestId, latest.requestId);
    const before = readFileSync(ledgerPath(dir));
    assert.deepEqual(apply(dir, earlier, reference, current, latest.state), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    const fresh = { ...reference, next: reference.next + 1 };
    assert.equal(apply(dir, latest, fresh).kind, "stepped");
    assert.deepEqual(saved(dir).recoverySnapshot, fresh);
  } finally { removeDir(dir); }
});

test("a recorded gap still fences an ordinary page if the rename acknowledgment is lost", () => {
  const dir = tempDir(), rename = fs.renameSync;
  try {
    start(dir);
    const opened = restore(dir, current, request);
    assert.equal(opened.kind, "loaded");
    const scope = { board: current.board, session: current.session };
    const reading = stepBoardFeedCursor(dir, current, opened.replay, { kind: "wake", scope });
    assert.equal(reading.kind, "stepped");
    const action = reading.step.actions[0];
    assert.ok(action?.kind === "read-changes");
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (to === ledgerPath(dir)) throw new Error("fabricated lost acknowledgment");
    };
    syncBuiltinESMExports();
    assert.deepEqual(stepBoardFeedCursor(dir, current, reading.step.state, { kind: "changes-too-old", scope, requestId: action.requestId }), { kind: "held" });
    fs.renameSync = rename;
    syncBuiltinESMExports();
    const afterRename = readFileSync(ledgerPath(dir));
    assert.deepEqual(stepBoardFeedCursor(dir, current, reading.step.state, {
      kind: "changes-applied", scope, requestId: action.requestId, next: 93, more: false,
    }), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), afterRename);
    const fresh = gap(dir);
    assert.equal(apply(dir, fresh).kind, "stepped");
    assert.deepEqual(saved(dir).recoverySnapshot, reference);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); removeDir(dir); }
});
