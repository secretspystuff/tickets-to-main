import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

    const legacy = saveFixture(dir);
    assert.deepEqual(api.restoreBoardFeedCursor(dir, current), { kind: "missing" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), legacy);
    const malformed = [
      [row(-1)], [row(1.5)], [row(Number.MAX_SAFE_INTEGER + 1)],
      [{ ...row(0), handled: "0" }], [row(0), row(1)],
      [{ ...row(0), session: "fabricated-retired-session" }],
    ];
    for (const cursors of malformed) {
      const bytes = saveFixture(dir, cursors);
      assert.deepEqual(api.restoreBoardFeedCursor(dir, current), { kind: "invalid" });
      assert.deepEqual(readFileSync(ledgerPath(dir)), bytes);
    }
    const truncated = Buffer.from('{"version":1,"boardFeedCursors":[');
    writeFileSync(ledgerPath(dir), truncated);
    assert.deepEqual(api.restoreBoardFeedCursor(dir, current), { kind: "invalid" });
    assert.deepEqual(readFileSync(ledgerPath(dir)), truncated);
  } finally { removeDir(dir); }
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
