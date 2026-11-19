import assert from "node:assert/strict";
import { test } from "node:test";

type Scope = Readonly<{ board: string; session: string }>;
type RequestId = string | number;
type Replay = { scope: Scope; cursor: number; terminal: "connection-ended" | "board-deleted" | null };
type Action = { scope: Scope; requestId: RequestId } & (
  { kind: "read-changes"; since: number } | { kind: "read-snapshot" }
);
type Event = { scope: Scope } & (
  { kind: "hi" | "signal"; seq: number }
  | { kind: "idle" | "wake" }
  | { kind: "changes-applied"; requestId: RequestId; next: number; more: boolean }
  | { kind: "changes-too-old"; requestId: RequestId }
  | { kind: "snapshot-applied"; requestId: RequestId; next: number }
  | { kind: "closed"; code: 4403 | 4404 }
);
type Step = { state: Replay; actions: readonly Action[] };

const modulePath = "../src/board-feed-replay.ts";
const { createBoardFeedReplay, stepBoardFeedReplay }: {
  createBoardFeedReplay(scope: Scope, handledCursor: number): Replay;
  stepBoardFeedReplay(state: Replay, event: Event): Step;
} = await import(modulePath);

const scope = { board: "fabricated-board-a", session: "fabricated-session-2" } as const;
const otherBoard = { ...scope, board: "fabricated-board-b" } as const;
const retiredSession = { ...scope, session: "fabricated-session-1" } as const;

function readChanges(step: Step, since: number) {
  assert.equal(step.actions.length, 1);
  const read = step.actions[0];
  assert.ok(read?.kind === "read-changes");
  assert.equal(read.since, since);
  assert.deepEqual(read.scope, scope);
  assert.deepEqual(step.state.scope, scope);
  return read;
}

function readSnapshot(step: Step) {
  assert.equal(step.actions.length, 1);
  const read = step.actions[0];
  assert.ok(read?.kind === "read-snapshot");
  assert.deepEqual(read.scope, scope);
  return read;
}

function unchanged(state: Replay, event: Event) {
  const before = structuredClone(state);
  const next = stepBoardFeedReplay(state, event);
  assert.deepEqual(next.actions, []);
  assert.deepEqual(next.state, before);
  assert.deepEqual(state, before);
}

test("hello catches up from the last handled cursor and only an applied page advances it", () => {
  const initial = createBoardFeedReplay(scope, 10);
  const kicked = stepBoardFeedReplay(initial, { kind: "hi", scope, seq: 10 });
  const read = readChanges(kicked, 10);
  assert.equal(kicked.state.cursor, 10);
  unchanged(kicked.state, { kind: "signal", scope, seq: 9 });

  const applied = stepBoardFeedReplay(kicked.state, { kind: "changes-applied", scope, requestId: read.requestId, next: 14, more: false });
  assert.equal(applied.state.cursor, 14);
  assert.deepEqual(applied.actions, []);
  unchanged(applied.state, { kind: "signal", scope, seq: 14 });
  unchanged(applied.state, { kind: "signal", scope, seq: 13 });
  assert.equal(initial.cursor, 10);
});

test("newer signals during a read are caught up once and late page results cannot jump the cursor", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(scope, 10), { kind: "signal", scope, seq: 12 });
  const first = readChanges(started, 10);
  assert.equal(started.state.cursor, 10);
  const queued = stepBoardFeedReplay(started.state, { kind: "signal", scope, seq: 16 });
  assert.equal(queued.state.cursor, 10);
  assert.deepEqual(queued.actions, []);
  unchanged(queued.state, { kind: "signal", scope, seq: 16 });

  const partial = stepBoardFeedReplay(queued.state, { kind: "changes-applied", scope, requestId: first.requestId, next: 12, more: false });
  assert.equal(partial.state.cursor, 12);
  const second = readChanges(partial, 12);
  assert.notEqual(second.requestId, first.requestId);
  unchanged(partial.state, { kind: "changes-applied", scope, requestId: first.requestId, next: 99, more: false });

  const caught = stepBoardFeedReplay(partial.state, { kind: "changes-applied", scope, requestId: second.requestId, next: 16, more: false });
  assert.equal(caught.state.cursor, 16);
  assert.deepEqual(caught.actions, []);
  unchanged(caught.state, { kind: "signal", scope, seq: 16 });
});

test("an applied page with more results requests the next page even after reaching the announced sequence", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(scope, 10), { kind: "hi", scope, seq: 11 });
  const first = readChanges(started, 10);
  const partial = stepBoardFeedReplay(started.state, { kind: "changes-applied", scope, requestId: first.requestId, next: 11, more: true });
  assert.equal(partial.state.cursor, 11);
  const second = readChanges(partial, 11);
  const done = stepBoardFeedReplay(partial.state, { kind: "changes-applied", scope, requestId: second.requestId, next: 15, more: false });
  assert.equal(done.state.cursor, 15);
  assert.deepEqual(done.actions, []);
});

test("410 keeps the old cursor until the matching snapshot is applied, then catches up newer signals", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(scope, 7), { kind: "signal", scope, seq: 9 });
  const read = readChanges(started, 7);
  const gap = stepBoardFeedReplay(started.state, { kind: "changes-too-old", scope, requestId: read.requestId });
  const snapshot = readSnapshot(gap);
  assert.equal(gap.state.cursor, 7);
  const pending = stepBoardFeedReplay(gap.state, { kind: "signal", scope, seq: 18 });
  assert.equal(pending.state.cursor, 7);
  assert.deepEqual(pending.actions, []);
  unchanged(pending.state, { kind: "changes-too-old", scope, requestId: read.requestId });
  unchanged(pending.state, { kind: "changes-applied", scope, requestId: read.requestId, next: 90, more: false });
  const unrelatedRequest = "fabricated-unmatched-snapshot";
  assert.notEqual(snapshot.requestId, unrelatedRequest);
  unchanged(pending.state, { kind: "snapshot-applied", scope, requestId: unrelatedRequest, next: 90 });
  unchanged(pending.state, { kind: "snapshot-applied", scope: retiredSession, requestId: snapshot.requestId, next: 91 });

  const restored = stepBoardFeedReplay(pending.state, { kind: "snapshot-applied", scope, requestId: snapshot.requestId, next: 12 });
  assert.equal(restored.state.cursor, 12);
  const replay = readChanges(restored, 12);
  const done = stepBoardFeedReplay(restored.state, { kind: "changes-applied", scope, requestId: replay.requestId, next: 18, more: false });
  assert.equal(done.state.cursor, 18);
  assert.deepEqual(done.actions, []);
});

test("another board or retired session cannot affect current scope or consume a current request", () => {
  const initial = createBoardFeedReplay(scope, 10);
  const started = stepBoardFeedReplay(initial, { kind: "signal", scope, seq: 12 });
  const read = readChanges(started, 10);
  for (const foreign of [otherBoard, retiredSession]) {
    unchanged(initial, { kind: "hi", scope: foreign, seq: 90 });
    unchanged(initial, { kind: "wake", scope: foreign });
    unchanged(started.state, { kind: "signal", scope: foreign, seq: 91 });
    unchanged(started.state, { kind: "changes-applied", scope: foreign, requestId: read.requestId, next: 92, more: false });
    unchanged(started.state, { kind: "changes-too-old", scope: foreign, requestId: read.requestId });
    unchanged(started.state, { kind: "closed", scope: foreign, code: 4403 });
    unchanged(started.state, { kind: "closed", scope: foreign, code: 4404 });
  }
  const applied = stepBoardFeedReplay(started.state, { kind: "changes-applied", scope, requestId: read.requestId, next: 12, more: false });
  assert.deepEqual(applied.state.scope, scope);
  assert.equal(applied.state.cursor, 12);
});

test("permission loss and board removal are terminal even when a read or snapshot is pending", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(scope, 10), { kind: "signal", scope, seq: 12 });
  const read = readChanges(started, 10);
  const denied = stepBoardFeedReplay(started.state, { kind: "closed", scope, code: 4403 });
  assert.equal(denied.state.terminal, "connection-ended");
  assert.equal(denied.state.cursor, 10);
  assert.deepEqual(denied.state.scope, scope);
  assert.deepEqual(denied.actions, []);
  unchanged(denied.state, { kind: "changes-applied", scope, requestId: read.requestId, next: 12, more: false });
  unchanged(denied.state, { kind: "signal", scope, seq: 99 });
  unchanged(denied.state, { kind: "wake", scope });

  const gap = stepBoardFeedReplay(started.state, { kind: "changes-too-old", scope, requestId: read.requestId });
  const snapshot = readSnapshot(gap);
  const removed = stepBoardFeedReplay(gap.state, { kind: "closed", scope, code: 4404 });
  assert.equal(removed.state.terminal, "board-deleted");
  assert.equal(removed.state.cursor, 10);
  assert.deepEqual(removed.state.scope, scope);
  assert.deepEqual(removed.actions, []);
  unchanged(removed.state, { kind: "snapshot-applied", scope, requestId: snapshot.requestId, next: 15 });
  unchanged(removed.state, { kind: "hi", scope, seq: 99 });
  unchanged(removed.state, { kind: "wake", scope });
});

test("idle stays silent and wake explicitly requests catch-up from the saved cursor", () => {
  const initial = createBoardFeedReplay(scope, 10);
  unchanged(initial, { kind: "idle", scope });
  const waking = stepBoardFeedReplay(initial, { kind: "wake", scope });
  const read = readChanges(waking, 10);
  unchanged(waking.state, { kind: "idle", scope });
  const caught = stepBoardFeedReplay(waking.state, { kind: "changes-applied", scope, requestId: read.requestId, next: 11, more: false });
  assert.equal(caught.state.cursor, 11);
  unchanged(caught.state, { kind: "idle", scope });
  unchanged(caught.state, { kind: "idle", scope });
});
