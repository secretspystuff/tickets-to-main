import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readRecoverySelection, readRecoverySnapshot, type RecoverySelection, type RecoverySnapshot } from "./board-feed-recovery.ts";
import { createBoardFeedReplay, stepBoardFeedReplay } from "./board-feed-replay.ts";
import { StateError } from "./fs-safety.ts";
import { loadLedger, updateLedger, type BoardFeedCursorRecord, type Ledger } from "./ledger.ts";

type BoardFeedContext = Readonly<{ board: string; binding: string; session: string }>;
type Replay = ReturnType<typeof createBoardFeedReplay>;
type ReplayEvent = Parameters<typeof stepBoardFeedReplay>[1];
type CursorEvent = ReplayEvent | (Extract<ReplayEvent, { requestId: string | number }> & { capture: object; response?: string });
type ReplayStep = ReturnType<typeof stepBoardFeedReplay>;
type UnavailableCursor = { kind: "missing" | "invalid" | "scope-mismatch" };
type CursorLookup = { kind: "matched"; record: BoardFeedCursorRecord } | UnavailableCursor;
type RestoredCursor = { kind: "loaded"; replay: Replay } | UnavailableCursor;
type CursorStep = { kind: "stepped"; step: ReplayStep } | { kind: "held" };
type Recovery = { epoch: string; current: Replay; selection: RecoverySelection; resumeSnapshot: boolean;
  pendingRead?: ReplayStep["actions"][number]; heldValues: string[] };
type Origin = { stateDir: string; binding: string; recovery?: Recovery };

const origins = new WeakMap<Replay, Origin>();
const epoch = () => randomBytes(16).toString("hex");

function cursorFor(ledger: Ledger, current: BoardFeedContext): CursorLookup {
  const record = ledger.boardFeedCursors?.find(cursor => cursor.board === current.board);
  if (!record) return { kind: "missing" };
  if (record.binding !== current.binding) return { kind: "scope-mismatch" };
  return { kind: "matched", record };
}

function readCursor(stateDir: string, current: BoardFeedContext): CursorLookup {
  try {
    const loaded = loadLedger(stateDir);
    if (!loaded.ok) return { kind: loaded.reason === "missing" ? "missing" : "invalid" };
    return cursorFor(loaded.ledger, current);
  } catch {
    return { kind: "invalid" };
  }
}

function checkedCursor(ledger: Ledger, current: BoardFeedContext, handled: number, expectedEpoch: string | undefined): BoardFeedCursorRecord {
  const latest = cursorFor(ledger, current);
  if (latest.kind !== "matched" || latest.record.handled !== handled || latest.record.recoveryEpoch !== expectedEpoch) {
    throw new StateError("The handled cursor changed. Its record was preserved.");
  }
  return latest.record;
}

export function restoreBoardFeedCursor(stateDir: string, current: BoardFeedContext, recoveryRequest?: string,
  heldValues: readonly string[] = []): RestoredCursor {
  const cursor = readCursor(stateDir, current);
  if (cursor.kind !== "matched") return cursor;
  const { board, session } = current;
  let replay = createBoardFeedReplay({ board, session }, cursor.record.handled);
  const origin: Origin = { stateDir: resolve(stateDir), binding: cursor.record.binding };
  if (recoveryRequest !== undefined) {
    const selection = readRecoverySelection(recoveryRequest);
    if (!selection || !/^[A-Za-z0-9_-]{1,300}$/.test(board)) return { kind: "invalid" };
    const nextEpoch = epoch();
    let resumeSnapshot = false;
    try {
      updateLedger(stateDir, heldValues, ledger => {
        const row = checkedCursor(ledger, current, replay.cursor, cursor.record.recoveryEpoch);
        row.recoveryEpoch = nextEpoch;
        if (row.recoverySnapshot && !isDeepStrictEqual(row.recoverySnapshot.selection, selection)) row.recoveryRequired = true;
        resumeSnapshot = row.recoveryRequired === true;
      });
    } catch {
      return { kind: "invalid" };
    }
    if (resumeSnapshot) replay = { ...replay, snapshotRequired: true, announcedSequence: 0 };
    origin.recovery = { epoch: nextEpoch, current: replay, selection, resumeSnapshot, heldValues: [...heldValues] };
  } else if (cursor.record.recoveryEpoch !== undefined) {
    return { kind: "scope-mismatch" };
  }
  origins.set(replay, origin);
  return { kind: "loaded", replay };
}

export function stepBoardFeedCursor(stateDir: string, current: BoardFeedContext, replay: Replay, event: CursorEvent): CursorStep {
  const origin = origins.get(replay);
  if (!origin || origin.stateDir !== resolve(stateDir) || origin.binding !== current.binding
    || replay.scope.board !== current.board || replay.scope.session !== current.session) return { kind: "held" };
  if (!event?.scope || typeof event.scope.board !== "string" || typeof event.scope.session !== "string") return { kind: "held" };
  const recovery = origin.recovery;
  if (recovery && recovery.current !== replay) return { kind: "held" };
  const cursor = readCursor(stateDir, current);
  if (cursor.kind !== "matched" || cursor.record.handled !== replay.cursor || cursor.record.recoveryEpoch !== recovery?.epoch) return { kind: "held" };
  if (cursor.record.recoveryRequired && !replay.snapshotRequired) return { kind: "held" };

  if (recovery && (event.kind === "changes-applied" || event.kind === "changes-too-old"
    || event.kind === "snapshot-applied" || event.kind === "snapshot-read-failed")) {
    const kind = event.kind === "snapshot-applied" || event.kind === "snapshot-read-failed" ? "read-snapshot" : "read-changes";
    if (typeof event.requestId !== "number" || !("capture" in event) || !recovery.pendingRead || event.capture !== recovery.pendingRead
      || replay.pending?.kind !== kind || replay.pending.requestId !== event.requestId
      || event.scope.board !== current.board || event.scope.session !== current.session) return { kind: "held" };
  }
  let snapshot: RecoverySnapshot | null = null;
  if (event.kind === "snapshot-applied") {
    if (!recovery || !cursor.record.recoveryRequired || !("response" in event) || typeof event.response !== "string"
      || !replay.snapshotRequired || replay.terminal) return { kind: "held" };
    snapshot = readRecoverySnapshot(event.response, current.board, recovery.selection);
    if (!snapshot || snapshot.next !== event.next) return { kind: "held" };
  }
  let step = stepBoardFeedReplay(replay, event);
  if (!step) return { kind: "held" };
  if (recovery?.resumeSnapshot && event.scope.board === current.board && event.scope.session === current.session
    && (event.kind === "hi" && Number.isSafeInteger(event.seq) && event.seq >= 0
      || event.kind === "signal" && step.state.announcedSequence > replay.announcedSequence)) {
    step = stepBoardFeedReplay(step.state, { kind: "wake", scope: event.scope });
  }
  const issued = step.actions[0];
  if (snapshot && (step.state === replay || step.state.snapshotRequired || step.state.cursor !== snapshot.next
    || issued?.kind !== "read-changes" || issued.since !== snapshot.next)) return { kind: "held" };
  const markRequired = recovery !== undefined && issued?.kind === "read-snapshot" && !cursor.record.recoveryRequired;
  if (markRequired || snapshot || step.state.cursor !== replay.cursor) {
    const nextEpoch = snapshot ? epoch() : recovery?.epoch;
    try {
      updateLedger(stateDir, recovery?.heldValues ?? [], ledger => {
        const latest = checkedCursor(ledger, current, replay.cursor, recovery?.epoch);
        if (snapshot && !latest.recoveryRequired) throw new StateError("The recovery request changed. Its record was preserved.");
        latest.handled = step.state.cursor;
        if (markRequired) latest.recoveryRequired = true;
        if (snapshot) {
          latest.recoverySnapshot = snapshot;
          latest.recoveryEpoch = nextEpoch;
          delete latest.recoveryRequired;
        }
      });
    } catch {
      return { kind: "held" };
    }
    if (recovery && snapshot && nextEpoch) {
      recovery.epoch = nextEpoch;
    }
  }
  if (recovery) {
    if (issued) {
      recovery.pendingRead = issued;
      recovery.resumeSnapshot = false;
    } else if (!step.state.pending) {
      delete recovery.pendingRead;
    }
    recovery.current = step.state;
  }
  origins.set(step.state, origin);
  return { kind: "stepped", step };
}
