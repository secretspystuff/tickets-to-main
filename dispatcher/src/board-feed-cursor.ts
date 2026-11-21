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
type CursorEvent = ReplayEvent | (Extract<ReplayEvent, { kind: "snapshot-applied" }> & { response: string });
type ReplayStep = ReturnType<typeof stepBoardFeedReplay>;
type UnavailableCursor = { kind: "missing" | "invalid" | "scope-mismatch" };
type CursorLookup = { kind: "matched"; record: BoardFeedCursorRecord } | UnavailableCursor;
type RestoredCursor = { kind: "loaded"; replay: Replay } | UnavailableCursor;
type CursorStep = { kind: "stepped"; step: ReplayStep } | { kind: "held" };
type Recovery = { epoch: string; current: Replay; selection: RecoverySelection; baselineChanged: boolean; heldValues: string[] };
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
  const replay = createBoardFeedReplay({ board, session }, cursor.record.handled);
  const origin: Origin = { stateDir: resolve(stateDir), binding: cursor.record.binding };
  if (recoveryRequest !== undefined) {
    const selection = readRecoverySelection(recoveryRequest);
    if (!selection || !/^[A-Za-z0-9_-]{1,300}$/.test(board)) return { kind: "invalid" };
    const prior = cursor.record.recoverySnapshot;
    const nextEpoch = epoch();
    try {
      updateLedger(stateDir, heldValues, ledger => {
        checkedCursor(ledger, current, replay.cursor, cursor.record.recoveryEpoch).recoveryEpoch = nextEpoch;
      });
    } catch {
      return { kind: "invalid" };
    }
    origin.recovery = { epoch: nextEpoch, current: replay, selection,
      baselineChanged: prior !== undefined && !isDeepStrictEqual(prior.selection, selection), heldValues: [...heldValues] };
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
  const recovery = origin.recovery;
  if (recovery && (recovery.current !== replay || recovery.baselineChanged && event.kind === "changes-applied")) return { kind: "held" };
  const cursor = readCursor(stateDir, current);
  if (cursor.kind !== "matched" || cursor.record.handled !== replay.cursor || cursor.record.recoveryEpoch !== recovery?.epoch) return { kind: "held" };

  let snapshot: RecoverySnapshot | null = null;
  if (event.kind === "snapshot-applied") {
    if (!recovery || !("response" in event) || !replay.snapshotRequired || replay.terminal
      || event.scope.board !== current.board || event.scope.session !== current.session
      || replay.pending?.kind !== "read-snapshot" || replay.pending.requestId !== event.requestId) return { kind: "held" };
    snapshot = readRecoverySnapshot(event.response, current.board, recovery.selection);
    if (!snapshot || snapshot.next !== event.next) return { kind: "held" };
  }
  const step = stepBoardFeedReplay(replay, event);
  if (snapshot || step.state.cursor !== replay.cursor) {
    const nextEpoch = snapshot ? epoch() : recovery?.epoch;
    try {
      updateLedger(stateDir, recovery?.heldValues ?? [], ledger => {
        const latest = checkedCursor(ledger, current, replay.cursor, recovery?.epoch);
        latest.handled = step.state.cursor;
        if (snapshot) {
          latest.recoverySnapshot = snapshot;
          latest.recoveryEpoch = nextEpoch;
        }
      });
    } catch {
      return { kind: "held" };
    }
    if (recovery && snapshot && nextEpoch) {
      recovery.epoch = nextEpoch;
      recovery.baselineChanged = false;
    }
  }
  if (recovery) recovery.current = step.state;
  origins.set(step.state, origin);
  return { kind: "stepped", step };
}
