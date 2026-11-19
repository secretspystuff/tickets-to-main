type Scope = Readonly<{ board: string; session: string }>;
type RequestKind = "read-changes" | "read-snapshot";
type PendingRead = Readonly<{ kind: RequestKind; requestId: number; announcedAtStart: number }>;
type Terminal = "connection-ended" | "board-deleted";
type Replay = Readonly<{
  scope: Scope;
  cursor: number;
  announcedSequence: number;
  pending: PendingRead | null;
  snapshotRequired: boolean;
  nextRequestId: number;
  terminal: Terminal | null;
}>;
type ReadAction = Readonly<{ scope: Scope; requestId: number } & (
  { kind: "read-changes"; since: number } | { kind: "read-snapshot" }
)>;
type ReplyId = string | number;
type Event = Readonly<{ scope: Scope } & (
  { kind: "hi" | "signal"; seq: number }
  | { kind: "idle" | "wake" }
  | { kind: "changes-applied"; requestId: ReplyId; next: number; more: boolean }
  | { kind: "changes-too-old" | "snapshot-read-failed"; requestId: ReplyId }
  | { kind: "snapshot-applied"; requestId: ReplyId; next: number }
  | { kind: "closed"; code: 4403 | 4404 }
)>;
type Hint = Extract<Event, { kind: "hi" | "signal" }>;
type Step = Readonly<{ state: Replay; actions: readonly ReadAction[] }>;

function sequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value: object, fields: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function data(value: object, field: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function validSignal(frame: object, tip: number): boolean {
  const items = data(frame, "items");
  if (!Array.isArray(items) || items.length > 50 || Reflect.ownKeys(items).length !== items.length + 1) return false;
  if (items.length === 0) return exactFields(frame, ["t", "seq", "items", "more"]) && data(frame, "more") === true;
  if (!exactFields(frame, ["t", "seq", "items"])) return false;

  let previous = -1;
  for (let index = 0; index < items.length; index++) {
    const item = data(items, index);
    if (!record(item) || !exactFields(item, ["seq", "kind", "ticket"])) return false;
    const seq = data(item, "seq");
    const ticket = data(item, "ticket");
    if (!sequence(seq) || seq <= previous || seq > tip || typeof data(item, "kind") !== "string"
      || (ticket !== null && typeof ticket !== "string")) return false;
    previous = seq;
  }
  return true;
}

export function decodeBoardFeedHint(frame: unknown, scope: Scope): Hint | null {
  if (!record(frame)) return null;
  const kind = data(frame, "t");
  const seq = data(frame, "seq");
  if (!sequence(seq)) return null;
  if (kind === "hi") {
    if (!exactFields(frame, ["t", "v", "seq"]) || data(frame, "v") !== 1) return null;
  } else if (kind !== "signal" || !validSignal(frame, seq)) {
    return null;
  }
  return { kind, seq, scope: { board: scope.board, session: scope.session } };
}

function quiet(state: Replay): Step {
  return { state, actions: [] };
}

function read(state: Replay, kind: RequestKind): Step {
  const requestId = state.nextRequestId;
  if (!Number.isSafeInteger(requestId)) return quiet(state);
  const request = { scope: { ...state.scope }, requestId };
  const action: ReadAction = kind === "read-changes"
    ? { ...request, kind, since: state.cursor }
    : { ...request, kind };
  const pending = { kind, requestId, announcedAtStart: state.announcedSequence };
  return { state: { ...state, pending, nextRequestId: requestId + 1 }, actions: [action] };
}

export function createBoardFeedReplay(scope: Scope, handledCursor: number): Replay {
  if (!sequence(handledCursor)) throw new RangeError("The handled cursor must be a nonnegative safe integer.");
  return {
    scope: { board: scope.board, session: scope.session },
    cursor: handledCursor,
    announcedSequence: handledCursor,
    pending: null,
    snapshotRequired: false,
    nextRequestId: 1,
    terminal: null,
  };
}

export function stepBoardFeedReplay(state: Replay, event: Event): Step {
  if (state.terminal || event.scope.board !== state.scope.board || event.scope.session !== state.scope.session) {
    return quiet(state);
  }

  const pending = state.pending;
  switch (event.kind) {
    case "idle":
      return quiet(state);
    case "wake":
      return pending ? quiet(state) : read(state, state.snapshotRequired ? "read-snapshot" : "read-changes");
    case "hi":
    case "signal": {
      if (!sequence(event.seq)) return quiet(state);
      const latest = state.snapshotRequired ? state.announcedSequence : Math.max(state.cursor, state.announcedSequence);
      const newer = event.seq > latest;
      if (event.kind === "signal" && !newer) return quiet(state);
      const announced = newer ? { ...state, announcedSequence: event.seq } : state;
      return pending || state.snapshotRequired ? quiet(announced) : read(announced, "read-changes");
    }
    case "changes-applied": {
      if (pending?.kind !== "read-changes" || pending.requestId !== event.requestId
        || !sequence(event.next) || event.next < state.cursor || (event.more && event.next === state.cursor)) return quiet(state);
      const applied = { ...state, cursor: event.next, pending: null };
      const progressOrNewSignal = event.next > state.cursor || state.announcedSequence > pending.announcedAtStart;
      return event.more || (progressOrNewSignal && event.next < state.announcedSequence) ? read(applied, "read-changes") : quiet(applied);
    }
    case "changes-too-old":
      return pending?.kind === "read-changes" && pending.requestId === event.requestId
        ? read({ ...state, pending: null, announcedSequence: 0, snapshotRequired: true }, "read-snapshot") : quiet(state);
    case "snapshot-read-failed":
      return pending?.kind === "read-snapshot" && pending.requestId === event.requestId
        ? quiet({ ...state, pending: null }) : quiet(state);
    case "snapshot-applied":
      if (pending?.kind !== "read-snapshot" || pending.requestId !== event.requestId || !sequence(event.next)) return quiet(state);
      // A board restored from backup can have a lower latest sequence.
      return read({ ...state, cursor: event.next, pending: null, snapshotRequired: false }, "read-changes");
    case "closed":
      return quiet({ ...state, pending: null, snapshotRequired: false, terminal: event.code === 4403 ? "connection-ended" : "board-deleted" });
  }
}
