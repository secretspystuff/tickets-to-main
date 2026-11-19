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
type Hint = Extract<Event, { kind: "hi" | "signal" }>;
type Step = { state: Replay; actions: readonly Action[] };

const modulePath = "../src/board-feed-replay.ts";
const { createBoardFeedReplay, stepBoardFeedReplay, decodeBoardFeedHint }: {
  createBoardFeedReplay(scope: Scope, handledCursor: number): Replay;
  stepBoardFeedReplay(state: Replay, event: Event): Step;
  decodeBoardFeedHint(input: unknown, scope: Scope): Hint | null;
} = await import(modulePath);

const currentScope = (): Scope => ({ board: "fabricated-board-a", session: "fabricated-session-2" });
const otherBoard = { ...currentScope(), board: "fabricated-board-b" } as const;
const retiredSession = { ...currentScope(), session: "fabricated-session-1" } as const;

function readChanges(step: Step, since: number) {
  assert.equal(step.actions.length, 1);
  const read = step.actions[0];
  assert.ok(read?.kind === "read-changes");
  assert.ok(typeof read.requestId === "string" || typeof read.requestId === "number");
  assert.equal(read.since, since);
  assert.deepEqual(read.scope, currentScope());
  assert.deepEqual(step.state.scope, currentScope());
  return read;
}

function readSnapshot(step: Step) {
  assert.equal(step.actions.length, 1);
  const read = step.actions[0];
  assert.ok(read?.kind === "read-snapshot");
  assert.ok(typeof read.requestId === "string" || typeof read.requestId === "number");
  assert.deepEqual(read.scope, currentScope());
  return read;
}

function unchanged(state: Replay, event: Event) {
  const before = structuredClone(state);
  const next = stepBoardFeedReplay(state, event);
  assert.deepEqual(next.actions, []);
  assert.deepEqual(next.state, before);
  assert.deepEqual(state, before);
}

function terminalIgnoresEvents(state: Replay, requestId: RequestId, laterClose: 4403 | 4404) {
  const events: Event[] = [
    { kind: "hi", scope: currentScope(), seq: 99 },
    { kind: "signal", scope: currentScope(), seq: 99 },
    { kind: "idle", scope: currentScope() },
    { kind: "wake", scope: currentScope() },
    { kind: "changes-applied", scope: currentScope(), requestId, next: 99, more: false },
    { kind: "changes-too-old", scope: currentScope(), requestId },
    { kind: "snapshot-applied", scope: currentScope(), requestId, next: 99 },
    { kind: "closed", scope: currentScope(), code: laterClose },
  ];
  for (const event of events) unchanged(state, event);
}

test("hello catches up from the last handled cursor and only an applied page advances it", () => {
  const initial = createBoardFeedReplay(currentScope(), 10);
  const kicked = stepBoardFeedReplay(initial, { kind: "hi", scope: currentScope(), seq: 10 });
  const read = readChanges(kicked, 10);
  assert.deepEqual(stepBoardFeedReplay(initial, { kind: "hi", scope: currentScope(), seq: 10 }), kicked);
  assert.equal(kicked.state.cursor, 10);
  unchanged(kicked.state, { kind: "signal", scope: currentScope(), seq: 9 });

  const applied = stepBoardFeedReplay(kicked.state, { kind: "changes-applied", scope: currentScope(), requestId: read.requestId, next: 14, more: false });
  assert.equal(applied.state.cursor, 14);
  assert.deepEqual(applied.actions, []);
  unchanged(applied.state, { kind: "signal", scope: currentScope(), seq: 14 });
  unchanged(applied.state, { kind: "signal", scope: currentScope(), seq: 13 });
  assert.equal(initial.cursor, 10);
});

test("newer signals during a read are caught up once and late page results cannot jump the cursor", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(currentScope(), 10), { kind: "signal", scope: currentScope(), seq: 12 });
  const first = readChanges(started, 10);
  assert.equal(started.state.cursor, 10);
  unchanged(started.state, { kind: "snapshot-applied", scope: currentScope(), requestId: first.requestId, next: 99 });
  const queued = stepBoardFeedReplay(started.state, { kind: "signal", scope: currentScope(), seq: 16 });
  assert.equal(queued.state.cursor, 10);
  assert.deepEqual(queued.actions, []);
  unchanged(queued.state, { kind: "signal", scope: currentScope(), seq: 16 });

  const partial = stepBoardFeedReplay(queued.state, { kind: "changes-applied", scope: currentScope(), requestId: first.requestId, next: 12, more: false });
  assert.equal(partial.state.cursor, 12);
  const second = readChanges(partial, 12);
  assert.notEqual(second.requestId, first.requestId);
  unchanged(partial.state, { kind: "changes-applied", scope: currentScope(), requestId: first.requestId, next: 99, more: false });

  const caught = stepBoardFeedReplay(partial.state, { kind: "changes-applied", scope: currentScope(), requestId: second.requestId, next: 16, more: false });
  assert.equal(caught.state.cursor, 16);
  assert.deepEqual(caught.actions, []);
  unchanged(caught.state, { kind: "signal", scope: currentScope(), seq: 16 });
});

test("an applied page with more results requests the next page even after reaching the announced sequence", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(currentScope(), 10), { kind: "hi", scope: currentScope(), seq: 11 });
  const first = readChanges(started, 10);
  const partial = stepBoardFeedReplay(started.state, { kind: "changes-applied", scope: currentScope(), requestId: first.requestId, next: 11, more: true });
  assert.equal(partial.state.cursor, 11);
  const second = readChanges(partial, 11);
  const done = stepBoardFeedReplay(partial.state, { kind: "changes-applied", scope: currentScope(), requestId: second.requestId, next: 15, more: false });
  assert.equal(done.state.cursor, 15);
  assert.deepEqual(done.actions, []);
});

test("an empty accepted page continues for a newly announced signal without repeating unchanged reads", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(currentScope(), 10), { kind: "wake", scope: currentScope() });
  const first = readChanges(started, 10);
  const queued = stepBoardFeedReplay(started.state, { kind: "signal", scope: currentScope(), seq: 12 });
  assert.deepEqual(queued.actions, []);
  const caught = stepBoardFeedReplay(queued.state, { kind: "changes-applied", scope: currentScope(), requestId: first.requestId, next: 10, more: false });
  const second = readChanges(caught, 10);
  const empty = stepBoardFeedReplay(caught.state, { kind: "changes-applied", scope: currentScope(), requestId: second.requestId, next: 10, more: false });
  assert.equal(empty.state.cursor, 10);
  assert.deepEqual(empty.actions, []);
  unchanged(empty.state, { kind: "signal", scope: currentScope(), seq: 12 });
  const newer = stepBoardFeedReplay(empty.state, { kind: "signal", scope: currentScope(), seq: 13 });
  readChanges(newer, 10);
});

test("410 keeps the old cursor until the matching snapshot is applied, then catches up newer signals", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(currentScope(), 7), { kind: "signal", scope: currentScope(), seq: 9 });
  const read = readChanges(started, 7);
  const gap = stepBoardFeedReplay(started.state, { kind: "changes-too-old", scope: currentScope(), requestId: read.requestId });
  const snapshot = readSnapshot(gap);
  assert.equal(gap.state.cursor, 7);
  const pending = stepBoardFeedReplay(gap.state, { kind: "signal", scope: currentScope(), seq: 18 });
  assert.equal(pending.state.cursor, 7);
  assert.deepEqual(pending.actions, []);
  unchanged(pending.state, { kind: "changes-too-old", scope: currentScope(), requestId: read.requestId });
  unchanged(pending.state, { kind: "changes-applied", scope: currentScope(), requestId: read.requestId, next: 90, more: false });
  unchanged(pending.state, { kind: "changes-too-old", scope: currentScope(), requestId: snapshot.requestId });
  unchanged(pending.state, { kind: "changes-applied", scope: currentScope(), requestId: snapshot.requestId, next: 90, more: false });
  const unrelatedRequest = "fabricated-unmatched-snapshot";
  assert.notEqual(snapshot.requestId, unrelatedRequest);
  unchanged(pending.state, { kind: "snapshot-applied", scope: currentScope(), requestId: unrelatedRequest, next: 90 });
  for (const foreign of [otherBoard, retiredSession]) {
    unchanged(pending.state, { kind: "changes-too-old", scope: foreign, requestId: snapshot.requestId });
    unchanged(pending.state, { kind: "snapshot-applied", scope: foreign, requestId: snapshot.requestId, next: 91 });
  }

  const restored = stepBoardFeedReplay(pending.state, { kind: "snapshot-applied", scope: currentScope(), requestId: snapshot.requestId, next: 12 });
  assert.equal(restored.state.cursor, 12);
  const replay = readChanges(restored, 12);
  const done = stepBoardFeedReplay(restored.state, { kind: "changes-applied", scope: currentScope(), requestId: replay.requestId, next: 18, more: false });
  assert.equal(done.state.cursor, 18);
  assert.deepEqual(done.actions, []);
});

test("a matching 410 snapshot can reset a cursor above the restored board's latest sequence", () => {
  const initial = createBoardFeedReplay(currentScope(), 100);
  const started = stepBoardFeedReplay(initial, { kind: "hi", scope: currentScope(), seq: 105 });
  const oldRead = readChanges(started, 100);
  unchanged(started.state, { kind: "changes-applied", scope: currentScope(), requestId: oldRead.requestId, next: 20, more: false });

  const gap = stepBoardFeedReplay(started.state, { kind: "changes-too-old", scope: currentScope(), requestId: oldRead.requestId });
  const snapshot = readSnapshot(gap);
  const queued = stepBoardFeedReplay(gap.state, { kind: "signal", scope: currentScope(), seq: 24 });
  assert.equal(queued.state.cursor, 100);
  assert.deepEqual(queued.actions, []);

  const restored = stepBoardFeedReplay(queued.state, { kind: "snapshot-applied", scope: currentScope(), requestId: snapshot.requestId, next: 20 });
  assert.equal(restored.state.cursor, 20);
  const read = readChanges(restored, 20);
  const partial = stepBoardFeedReplay(restored.state, { kind: "changes-applied", scope: currentScope(), requestId: read.requestId, next: 22, more: false });
  assert.equal(partial.state.cursor, 22);
  const finalRead = readChanges(partial, 22);
  const done = stepBoardFeedReplay(partial.state, { kind: "changes-applied", scope: currentScope(), requestId: finalRead.requestId, next: 24, more: false });
  assert.equal(done.state.cursor, 24);
  assert.deepEqual(done.actions, []);
  assert.equal(initial.cursor, 100);
});

test("another board or retired session cannot affect current scope or consume a current request", () => {
  const initial = createBoardFeedReplay(currentScope(), 10);
  const started = stepBoardFeedReplay(initial, { kind: "signal", scope: currentScope(), seq: 12 });
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
  const applied = stepBoardFeedReplay(started.state, { kind: "changes-applied", scope: currentScope(), requestId: read.requestId, next: 12, more: false });
  assert.deepEqual(applied.state.scope, currentScope());
  assert.equal(applied.state.cursor, 12);
});

test("permission loss and board removal are terminal even when a read or snapshot is pending", () => {
  const started = stepBoardFeedReplay(createBoardFeedReplay(currentScope(), 10), { kind: "signal", scope: currentScope(), seq: 12 });
  const read = readChanges(started, 10);
  const denied = stepBoardFeedReplay(started.state, { kind: "closed", scope: currentScope(), code: 4403 });
  assert.equal(denied.state.terminal, "connection-ended");
  assert.equal(denied.state.cursor, 10);
  assert.deepEqual(denied.state.scope, currentScope());
  assert.deepEqual(denied.actions, []);
  terminalIgnoresEvents(denied.state, read.requestId, 4404);

  const gap = stepBoardFeedReplay(started.state, { kind: "changes-too-old", scope: currentScope(), requestId: read.requestId });
  const snapshot = readSnapshot(gap);
  const removed = stepBoardFeedReplay(gap.state, { kind: "closed", scope: currentScope(), code: 4404 });
  assert.equal(removed.state.terminal, "board-deleted");
  assert.equal(removed.state.cursor, 10);
  assert.deepEqual(removed.state.scope, currentScope());
  assert.deepEqual(removed.actions, []);
  terminalIgnoresEvents(removed.state, snapshot.requestId, 4403);
});

test("idle stays silent and wake explicitly requests catch-up from the saved cursor", () => {
  const initial = createBoardFeedReplay(currentScope(), 10);
  unchanged(initial, { kind: "idle", scope: currentScope() });
  const waking = stepBoardFeedReplay(initial, { kind: "wake", scope: currentScope() });
  const read = readChanges(waking, 10);
  unchanged(waking.state, { kind: "idle", scope: currentScope() });
  const caught = stepBoardFeedReplay(waking.state, { kind: "changes-applied", scope: currentScope(), requestId: read.requestId, next: 11, more: false });
  assert.equal(caught.state.cursor, 11);
  unchanged(caught.state, { kind: "idle", scope: currentScope() });
  unchanged(caught.state, { kind: "idle", scope: currentScope() });
});

test("the offline hint decoder projects only approved hints with the caller's scope", async t => {
  assert.equal(typeof decodeBoardFeedHint, "function", "the test-first board-feed hint decoder export is pending");
  const hello = { t: "hi", v: 1, seq: 0 };
  const item = { seq: 11, kind: "ticket.ready", ticket: "fabricated-ticket" };
  const lowerItem = { ...item, seq: 10 };
  const nextItem = { seq: 12, kind: "ticket.patched", ticket: "fabricated-other-ticket" };
  const signal = { t: "signal", seq: 12, items: [item] };
  const lowerSignal = { ...signal, items: [lowerItem] };
  const multiple = { ...signal, seq: 13, items: [item, nextItem] };
  const overflow = { t: "signal", seq: 14, items: [], more: true };
  const max = Number.MAX_SAFE_INTEGER;
  const maxSignal = { ...signal, seq: max };
  const maxMultiple = { ...maxSignal, items: [lowerItem, nextItem] };
  const atLimit = { ...signal, seq: 100, items: Array.from({ length: 50 }, (_, i) => ({ ...item, seq: 20 + i })) };
  const omit = Symbol("omit field");
  const invalidSequence = [omit, "12", -1, 10.5, NaN, Infinity, max + 1];
  const invalidTag = [omit, 1, "seq", "pong", "closed", "changes-applied"];
  type Fields = readonly (readonly [string, readonly unknown[]])[];
  const unexpected: Fields = [
    ["board", [otherBoard.board]],
    ["session", [retiredSession.session]],
    ["scope", [otherBoard, retiredSession]],
    ["author", [{ board: otherBoard.board, session: retiredSession.session }, { scope: retiredSession }]],
    ["extra", ["fabricated-extension"]],
  ];

  function vary(
    record: Record<string, unknown>, fields: Fields,
    check: (changed: Record<string, unknown>, description: string) => void,
  ) {
    for (const [field, values] of fields) {
      for (const [index, value] of values.entries()) {
        const candidate = { ...record };
        if (value === omit) delete candidate[field];
        else candidate[field] = value;
        check(candidate, `${field} variant ${index + 1}`);
      }
    }
  }

  function ignored(frame: unknown, state = createBoardFeedReplay(currentScope(), 10), description?: string) {
    const scope = currentScope();
    const original = structuredClone(frame);
    const before = structuredClone(state);
    const hint = decodeBoardFeedHint(frame, scope);
    const result = hint === null ? { state, actions: [] } : stepBoardFeedReplay(state, hint);
    assert.deepEqual(result.actions, [], description);
    assert.deepEqual(result.state, before, description);
    assert.equal(hint, null, description);
    assert.deepEqual(scope, currentScope());
    assert.deepEqual(state, before);
    assert.deepEqual(frame, original);
  }

  await t.test("accepts publisher frames across the sequence and item-count boundaries", () => {
    const cases = [
      { frame: hello, kind: "hi", cursor: 0 },
      { frame: { ...hello, seq: 23 }, kind: "hi", cursor: 20 },
      { frame: { ...hello, seq: max }, kind: "hi", cursor: 10 },
      { frame: signal, kind: "signal", cursor: 10 },
      { frame: lowerSignal, kind: "signal", cursor: 10 },
      { frame: { ...signal, items: [{ ...item, seq: 12 }] }, kind: "signal", cursor: 10 },
      { frame: multiple, kind: "signal", cursor: 10 },
      { frame: { ...multiple, seq: 14, items: [item, { ...nextItem, seq: 13 }] }, kind: "signal", cursor: 10 },
      { frame: { ...signal, items: [{ ...item, ticket: null }] }, kind: "signal", cursor: 10 },
      { frame: atLimit, kind: "signal", cursor: 10 },
      { frame: maxSignal, kind: "signal", cursor: 10 },
      { frame: maxMultiple, kind: "signal", cursor: 10 },
      { frame: { ...maxSignal, items: [{ ...item, seq: max }] }, kind: "signal", cursor: 10 },
      { frame: overflow, kind: "signal", cursor: 10 },
      { frame: { ...overflow, seq: max }, kind: "signal", cursor: 10 },
    ] as const;
    for (const { frame, kind, cursor } of cases) {
      const scope = currentScope();
      const before = structuredClone(frame);
      const state = createBoardFeedReplay(scope, cursor);
      const hint = decodeBoardFeedHint(frame, scope);
      assert.deepEqual(hint, { kind, seq: frame.seq, scope: currentScope() });
      assert.ok(hint);
      const step = stepBoardFeedReplay(state, hint);
      readChanges(step, cursor);
      assert.equal(step.state.cursor, cursor);
      assert.deepEqual(frame, before);
      assert.deepEqual(scope, currentScope());
    }
  });

  await t.test("the same frame takes the caller's generation and a retired hint cannot wake current replay", () => {
    const state = createBoardFeedReplay(currentScope(), 10);
    const retired = decodeBoardFeedHint(signal, retiredSession);
    assert.deepEqual(retired, { kind: "signal", seq: 12, scope: retiredSession });
    assert.ok(retired);
    unchanged(state, retired);
    const current = decodeBoardFeedHint(signal, currentScope());
    assert.deepEqual(current, { kind: "signal", seq: 12, scope: currentScope() });
    assert.ok(current);
    readChanges(stepBoardFeedReplay(state, current), 10);
  });

  await t.test("rejects malformed publisher fields one at a time", () => {
    const state = createBoardFeedReplay(currentScope(), 10);
    const cases: { name: string; frame: Record<string, unknown>; fields: Fields }[] = [
      { name: "hello", frame: hello, fields: [
        ["v", [omit, 0, 2, "1", true, null]], ["items", [[]]], ["more", [true]],
        ["mine", [0]], ["text_connection", ["fabricated-text-connection"]], ["text_protocol", [{}]],
      ] },
      { name: "ordinary signal", frame: lowerSignal, fields: [
        ["items", [omit, null, "fabricated", {}, [], [null]]], ["more", [true, false, "true"]], ["v", [1]],
      ] },
      { name: "overflow", frame: overflow, fields: [
        ["items", [omit, null, "fabricated", {}, [item]]], ["more", [omit, false, "true", null, 1]], ["v", [1]],
      ] },
    ];
    for (const { name, frame, fields } of cases) {
      vary(frame, [["t", invalidTag], ["seq", invalidSequence], ...fields, ...unexpected], (candidate, description) => {
        ignored(candidate, state, `${name} ${description}`);
      });
    }
    ignored({ ...atLimit, items: [...atLimit.items, { ...item, seq: 70 }] }, state, "ordinary signal above the item limit");
  });

  await t.test("rejects malformed item fields in the first and later positions", () => {
    const state = createBoardFeedReplay(currentScope(), 10);
    const fields: Fields = [
      ["seq", invalidSequence], ["kind", [omit, 1, null]], ["ticket", [omit, 1, false]], ...unexpected,
    ];
    vary(lowerItem, fields, (candidate, description) => {
      ignored({ ...maxMultiple, items: [candidate, nextItem] }, state, `first item ${description}`);
    });
    vary(nextItem, fields, (candidate, description) => {
      ignored({ ...maxMultiple, items: [lowerItem, candidate] }, state, `later item ${description}`);
    });
    ignored({ ...signal, items: [{ ...item, seq: 99 }] }, state, "first item beyond the frame tip");
    ignored({ ...signal, items: [item, { ...nextItem, seq: 99 }] }, state, "later item beyond the frame tip");
    ignored({ ...multiple, items: [nextItem, item] }, state, "items out of publisher order");
    ignored({ ...multiple, items: [item, { ...nextItem, seq: 11 }] }, state, "duplicate item sequence");
  });

  await t.test("rejects non-hint shapes without issuing a read", () => {
    for (const frame of [
      null, "fabricated text frame", ["signal", 12], { kind: "signal", seq: 12 },
      { t: "closed", code: 4403, seq: 12 }, { t: "changes-applied", requestId: 1, next: 12, seq: 12 },
    ]) ignored(frame);
  });

  await t.test("complete internal events with any scope cannot enter through the hint decoder", () => {
    const initial = createBoardFeedReplay(currentScope(), 10);
    const pending = stepBoardFeedReplay(initial, { kind: "signal", scope: currentScope(), seq: 12 });
    const read = readChanges(pending, 10);
    const gap = stepBoardFeedReplay(pending.state, { kind: "changes-too-old", scope: currentScope(), requestId: read.requestId });
    const snapshot = readSnapshot(gap);
    for (const scope of [currentScope(), retiredSession, otherBoard]) {
      const cases: { frame: Event; state: Replay }[] = [
        { frame: { kind: "hi", scope, seq: 0 }, state: initial },
        { frame: { kind: "signal", scope, seq: 12 }, state: initial },
        { frame: { kind: "idle", scope }, state: initial },
        { frame: { kind: "wake", scope }, state: initial },
        { frame: { kind: "changes-applied", scope, requestId: read.requestId, next: 99, more: false }, state: pending.state },
        { frame: { kind: "changes-too-old", scope, requestId: read.requestId }, state: pending.state },
        { frame: { kind: "snapshot-applied", scope, requestId: snapshot.requestId, next: 99 }, state: gap.state },
        { frame: { kind: "closed", scope, code: 4403 }, state: pending.state },
        { frame: { kind: "closed", scope, code: 4404 }, state: gap.state },
      ];
      for (const { frame, state } of cases) ignored(frame, state);
    }
  });
});
