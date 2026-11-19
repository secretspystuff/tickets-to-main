type Scope = Readonly<{ board: string; session: string }>;
type RequestKind = "read-changes" | "read-snapshot";
type PendingRead = Readonly<{ kind: RequestKind; requestId: number; announcedAtStart: number }>;
type Terminal = "connection-ended" | "board-deleted";
type Replay = Readonly<{
  scope: Scope;
  cursor: number;
  announcedSequence: number;
  pending: PendingRead | null;
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
  | { kind: "changes-too-old"; requestId: ReplyId }
  | { kind: "snapshot-applied"; requestId: ReplyId; next: number }
  | { kind: "closed"; code: 4403 | 4404 }
)>;
type Step = Readonly<{ state: Replay; actions: readonly ReadAction[] }>;

function sequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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
      return pending ? quiet(state) : read(state, "read-changes");
    case "hi":
    case "signal": {
      if (!sequence(event.seq)) return quiet(state);
      const latest = pending?.kind === "read-snapshot" ? state.announcedSequence : Math.max(state.cursor, state.announcedSequence);
      const newer = event.seq > latest;
      if (event.kind === "signal" && !newer) return quiet(state);
      const announced = newer ? { ...state, announcedSequence: event.seq } : state;
      return pending ? quiet(announced) : read(announced, "read-changes");
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
        ? read({ ...state, announcedSequence: 0 }, "read-snapshot") : quiet(state);
    case "snapshot-applied":
      if (pending?.kind !== "read-snapshot" || pending.requestId !== event.requestId || !sequence(event.next)) return quiet(state);
      // A board restored from backup can have a lower latest sequence.
      return read({ ...state, cursor: event.next, pending: null }, "read-changes");
    case "closed":
      return quiet({ ...state, pending: null, terminal: event.code === 4403 ? "connection-ended" : "board-deleted" });
  }
}
