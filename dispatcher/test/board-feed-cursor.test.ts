import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { createBoardFeedReplay, stepBoardFeedReplay } from "../src/board-feed-replay.ts";
import { emptyLedger, ledgerPath, loadLedger } from "../src/ledger.ts";
import { removeDir, tempDir } from "./helpers.ts";

type Replay = ReturnType<typeof createBoardFeedReplay>;
type Event = Parameters<typeof stepBoardFeedReplay>[1];
type Step = ReturnType<typeof stepBoardFeedReplay>;
type Context = Readonly<{ board: string; binding: string; session: string }>;
type Restore = { kind: "loaded"; replay: Replay } | { kind: "missing" | "invalid" | "scope-mismatch" };
type SavedStep = { kind: "stepped"; step: Step } | { kind: "held" };
type Checkpoint = {
  restoreBoardFeedCursor(stateDir: string, current: Context): Restore;
  stepBoardFeedCursor(stateDir: string, current: Context, replay: Replay, event: Event): SavedStep;
};

const cursorSource = new URL("../src/board-feed-cursor.ts", import.meta.url);
const ledgerSource = new URL("../src/ledger.ts", import.meta.url);
const context = (session = "fabricated-current-session"): Context => ({
  board: "fabricated-board-a",
  binding: "fabricated-local-scope-a",
  session,
});
const scopeOf = ({ board, session }: Context) => ({ board, session });
const row = (handled: number, { board, binding }: Context = context()) => ({ board, binding, handled });
const otherBoard = { ...context(), board: "fabricated-board-b" };
const otherBinding = { ...context(), binding: "fabricated-local-scope-b" };

async function checkpoint(): Promise<Checkpoint> {
  assert.ok(existsSync(cursorSource), "the test-first durable cursor checkpoint module is pending");
  return await import(cursorSource.href);
}

function saveFixture(dir: string, cursors?: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify({
    ...emptyLedger(),
    ...(cursors === undefined ? {} : { boardFeedCursors: cursors }),
  }) + "\n");
  writeFileSync(ledgerPath(dir), bytes, { mode: 0o600 });
  return bytes;
}

function restored(result: Restore, current: Context, cursor: number): Replay {
  assert.deepEqual(result, { kind: "loaded", replay: createBoardFeedReplay(scopeOf(current), cursor) });
  assert.equal(result.kind, "loaded");
  return result.replay;
}

function accepted(result: SavedStep): Step {
  assert.equal(result.kind, "stepped");
  return result.step;
}

function read(step: Step, current: Context, since: number) {
  assert.equal(step.actions.length, 1);
  const action = step.actions[0];
  assert.ok(action?.kind === "read-changes");
  assert.deepEqual(action.scope, scopeOf(current));
  assert.equal(action.since, since);
  return action.requestId;
}

const exitAtCommit = 73;
const child = `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { ledgerPath, updateLedger } from ${JSON.stringify(ledgerSource.href)};

  const [stateDir, phase, operation, currentJson] = process.argv.slice(1);
  const destination = ledgerPath(stateDir);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to !== destination) return rename(from, to);
    if (phase === "after") rename(from, to);
    process.exit(${exitAtCommit});
  };
  syncBuiltinESMExports();

  if (operation === "ledger-control") {
    updateLedger(stateDir, [], ledger => {
      ledger.tools = [{
        vendor: "codex", interfaceId: "cli", qualification: "documented",
        experimental: "unknown", version: null, limit: "fabricated atomic control",
      }];
    });
  } else {
    const { restoreBoardFeedCursor, stepBoardFeedCursor } = await import(${JSON.stringify(cursorSource.href)});
    const current = JSON.parse(currentJson);
    const scope = { board: current.board, session: current.session };
    const loaded = restoreBoardFeedCursor(stateDir, current);
    if (loaded.kind !== "loaded") process.exit(81);
    const begun = stepBoardFeedCursor(stateDir, current, loaded.replay, { kind: "hi", scope, seq: 90 });
    const action = begun.kind === "stepped" && begun.step.actions[0];
    if (action?.kind !== "read-changes" || action.since !== 5) process.exit(82);
    stepBoardFeedCursor(stateDir, current, begun.step.state, {
      kind: "changes-applied", scope, requestId: action.requestId, next: 7, more: true,
    });
  }
  process.exit(83);
`;

function interruptCommit(dir: string, phase: "before" | "after", operation: "ledger-control" | "cursor") {
  const result = spawnSync(process.execPath, [
    "--max-old-space-size=2048", "--experimental-strip-types", "--input-type=module",
    "-e", child, dir, phase, operation, JSON.stringify(context("fabricated-retired-session")),
  ], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, exitAtCommit, result.stderr);
}

test("the interruption fixture straddles an actual ledger replacement", async t => {
  for (const phase of ["before", "after"] as const) {
    await t.test(phase, () => {
      const dir = tempDir();
      try {
        const before = saveFixture(dir);
        interruptCommit(dir, phase, "ledger-control");
        const loaded = loadLedger(dir);
        assert.equal(loaded.ok, true);
        if (phase === "before") {
          assert.deepEqual(readFileSync(ledgerPath(dir)), before);
          assert.deepEqual(loaded.ledger, emptyLedger());
        } else {
          assert.equal(loaded.ledger.tools[0]?.limit, "fabricated atomic control");
        }
      } finally { removeDir(dir); }
    });
  }
});

test("restart accepts a recorded zero only in its independently supplied local scope", async () => {
  const api = await checkpoint();
  const dir = tempDir();
  try {
    const current = context();
    const zero = saveFixture(dir, [row(0)]);
    const initial = restored(api.restoreBoardFeedCursor(dir, current), current, 0);
    read(accepted(api.stepBoardFeedCursor(dir, current, initial, { kind: "hi", scope: scopeOf(current), seq: 1 })), current, 0);
    assert.deepEqual(api.restoreBoardFeedCursor(dir, otherBoard), { kind: "missing" });
    assert.deepEqual(api.restoreBoardFeedCursor(dir, otherBinding), { kind: "scope-mismatch" });
    assert.deepEqual(api.stepBoardFeedCursor(dir, otherBinding, initial, { kind: "hi", scope: scopeOf(current), seq: 1 }), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), zero);
  } finally { removeDir(dir); }
});

test("a matching completed page cannot repair, create or borrow an unusable cursor record", async t => {
  const current = context();
  const scope = scopeOf(current);
  const open = stepBoardFeedReplay(createBoardFeedReplay(scope, 0), { kind: "hi", scope, seq: 7 });
  const event = { kind: "changes-applied", scope, requestId: read(open, current, 0), next: 7, more: false } as const;
  assert.equal(stepBoardFeedReplay(open.state, event).state.cursor, 7);
  const api = await checkpoint();

  const cases: ReadonlyArray<{
    name: string;
    kind: "missing" | "invalid" | "scope-mismatch";
    cursors?: unknown;
    raw?: string;
    noFile?: true;
  }> = [
    { name: "absent ledger file", kind: "missing", noFile: true },
    { name: "legacy ledger without cursors", kind: "missing" },
    { name: "empty cursor list", kind: "missing", cursors: [] },
    { name: "absent board", kind: "missing", cursors: [row(33, otherBoard)] },
    { name: "same board with a different binding", kind: "scope-mismatch", cursors: [row(0, otherBinding)] },
    { name: "null cursor list", kind: "invalid", cursors: null },
    { name: "object cursor list", kind: "invalid", cursors: {} },
    { name: "negative cursor", kind: "invalid", cursors: [row(-1)] },
    { name: "noninteger cursor", kind: "invalid", cursors: [row(1.5)] },
    { name: "unsafe cursor", kind: "invalid", cursors: [row(Number.MAX_SAFE_INTEGER + 1)] },
    { name: "string cursor", kind: "invalid", cursors: [{ ...row(0), handled: "0" }] },
    { name: "missing board", kind: "invalid", cursors: [{ binding: current.binding, handled: 0 }] },
    { name: "missing binding", kind: "invalid", cursors: [{ board: current.board, handled: 0 }] },
    { name: "non-string board", kind: "invalid", cursors: [{ ...row(0), board: 1 }] },
    { name: "non-string binding", kind: "invalid", cursors: [{ ...row(0), binding: 1 }] },
    { name: "duplicate board", kind: "invalid", cursors: [row(0), row(1)] },
    { name: "conflicting bindings with the current row first", kind: "invalid", cursors: [row(0), row(0, otherBinding)] },
    { name: "conflicting bindings with the current row last", kind: "invalid", cursors: [row(0, otherBinding), row(0)] },
    { name: "unexpected persisted session", kind: "invalid", cursors: [{ ...row(0), session: "fabricated-retired-session" }] },
    { name: "truncated ledger", kind: "invalid", raw: '{"version":1,"boardFeedCursors":[' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, () => {
      const dir = tempDir();
      const path = ledgerPath(dir);
      try {
        if (entry.raw !== undefined) writeFileSync(path, entry.raw, { mode: 0o600 });
        else if (!entry.noFile) saveFixture(dir, entry.cursors);
        assert.equal(existsSync(path), !entry.noFile);
        const before = entry.noFile ? null : readFileSync(path);
        const replay = structuredClone(open.state);
        assert.deepEqual(api.restoreBoardFeedCursor(dir, current), { kind: entry.kind });
        assert.deepEqual(existsSync(path) ? readFileSync(path) : null, before);
        assert.deepEqual(api.stepBoardFeedCursor(dir, current, replay, event), { kind: "held" });
        assert.deepEqual(replay, open.state);
        assert.deepEqual(existsSync(path) ? readFileSync(path) : null, before);
      } finally { removeDir(dir); }
    });
  }
});

test("same-scope completions require an exact match with the durable prior cursor", async t => {
  const api = await checkpoint();
  for (const [name, staleNext] of [["below the saved cursor", 7], ["above the saved cursor", 11]] as const) {
    await t.test(name, () => {
      const dir = tempDir();
      try {
        const current = context();
        const scope = scopeOf(current);
        saveFixture(dir, [row(5), row(33, otherBoard)]);
        const older = restored(api.restoreBoardFeedCursor(dir, current), current, 5);
        const stale = accepted(api.stepBoardFeedCursor(dir, current, older, { kind: "hi", scope, seq: 11 }));
        const staleRequest = read(stale, current, 5);
        const latest = restored(api.restoreBoardFeedCursor(dir, current), current, 5);
        const competing = accepted(api.stepBoardFeedCursor(dir, current, latest, { kind: "hi", scope, seq: 9 }));
        const currentRequest = read(competing, current, 5);
        assert.equal(currentRequest, staleRequest);
        const committed = accepted(api.stepBoardFeedCursor(dir, current, competing.state, {
          kind: "changes-applied", scope, requestId: currentRequest, next: 9, more: false,
        }));
        assert.equal(committed.state.cursor, 9);
        const before = readFileSync(ledgerPath(dir));
        assert.deepEqual(JSON.parse(before.toString("utf8")), {
          ...emptyLedger(), boardFeedCursors: [row(9), row(33, otherBoard)],
        });

        const late = { kind: "changes-applied", scope, requestId: staleRequest, next: staleNext, more: false } as const;
        assert.equal(stepBoardFeedReplay(stale.state, late).state.cursor, staleNext);
        assert.deepEqual(api.stepBoardFeedCursor(dir, current, stale.state, late), { kind: "held" });
        assert.deepEqual(readFileSync(ledgerPath(dir)), before);
        restored(api.restoreBoardFeedCursor(dir, current), current, 9);
      } finally { removeDir(dir); }
    });
  }

  await t.test("replay starts above the saved cursor", probe => {
    const dir = tempDir();
    try {
      const current = context();
      const scope = scopeOf(current);
      const path = ledgerPath(dir);
      const before = saveFixture(dir, [row(5), row(33, otherBoard)]);
      restored(api.restoreBoardFeedCursor(dir, current), current, 5);
      const open = stepBoardFeedReplay(createBoardFeedReplay(scope, 7), { kind: "hi", scope, seq: 12 });
      const event = { kind: "changes-applied", scope, requestId: read(open, current, 7), next: 9, more: false } as const;
      assert.equal(stepBoardFeedReplay(open.state, event).state.cursor, 9);

      let replacements = 0;
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (destination === path) replacements++;
        rename(source, destination);
      };
      syncBuiltinESMExports();
      probe.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });

      assert.deepEqual(api.stepBoardFeedCursor(dir, current, open.state, event), { kind: "held" });
      assert.equal(replacements, 0);
      assert.deepEqual(readFileSync(path), before);
      restored(api.restoreBoardFeedCursor(dir, current), current, 5);
    } finally { removeDir(dir); }
  });
});

test("hints and a retired response leave the durable cursor at the last completed page", async () => {
  const api = await checkpoint();
  const dir = tempDir();
  try {
    const current = context();
    const retired = context("fabricated-retired-session");
    const before = saveFixture(dir, [row(5), row(33, otherBoard)]);
    const old = restored(api.restoreBoardFeedCursor(dir, retired), retired, 5);
    const oldRead = accepted(api.stepBoardFeedCursor(dir, retired, old, { kind: "hi", scope: scopeOf(retired), seq: 90 }));
    const oldRequest = read(oldRead, retired, 5);
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);

    const initial = restored(api.restoreBoardFeedCursor(dir, current), current, 5);
    const begun = accepted(api.stepBoardFeedCursor(dir, current, initial, { kind: "hi", scope: scopeOf(current), seq: 91 }));
    const requestId = read(begun, current, 5);
    assert.equal(requestId, oldRequest);
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    const announced = accepted(api.stepBoardFeedCursor(dir, current, begun.state, {
      kind: "signal", scope: scopeOf(current), seq: 99,
    }));
    assert.deepEqual(announced.actions, []);
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);
    const event = { kind: "changes-applied", requestId, next: 7, more: true } as const;
    assert.deepEqual(accepted(api.stepBoardFeedCursor(dir, current, announced.state, { ...event, scope: scopeOf(retired) })), {
      state: announced.state, actions: [],
    });
    assert.deepEqual(api.stepBoardFeedCursor(dir, current, oldRead.state, { ...event, scope: scopeOf(retired) }), { kind: "held" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), before);

    const advanced = accepted(api.stepBoardFeedCursor(dir, current, announced.state, { ...event, scope: scopeOf(current) }));
    read(advanced, current, 7);
    assert.deepEqual(JSON.parse(readFileSync(ledgerPath(dir), "utf8")), {
      ...emptyLedger(), boardFeedCursors: [row(7), row(33, otherBoard)],
    });
    restored(api.restoreBoardFeedCursor(dir, otherBoard), otherBoard, 33);
  } finally { removeDir(dir); }
});

test("restart before and after the cursor commit reads only complete local state", async t => {
  const api = await checkpoint();
  for (const phase of ["before", "after"] as const) {
    await t.test(phase, () => {
      const dir = tempDir();
      try {
        const current = context();
        const before = saveFixture(dir, [row(5), row(33, otherBoard)]);
        interruptCommit(dir, phase, "cursor");
        const handled = phase === "before" ? 5 : 7;
        if (phase === "before") assert.deepEqual(readFileSync(ledgerPath(dir)), before);
        assert.deepEqual(JSON.parse(readFileSync(ledgerPath(dir), "utf8")), {
          ...emptyLedger(), boardFeedCursors: [row(handled), row(33, otherBoard)],
        });
        const replay = restored(api.restoreBoardFeedCursor(dir, current), current, handled);
        read(accepted(api.stepBoardFeedCursor(dir, current, replay, {
          kind: "hi", scope: scopeOf(current), seq: 90,
        })), current, handled);
      } finally { removeDir(dir); }
    });
  }
});
