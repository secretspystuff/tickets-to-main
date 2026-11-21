import { resolve } from "node:path";
import { createBoardFeedReplay, stepBoardFeedReplay } from "./board-feed-replay.ts";
import { StateError } from "./fs-safety.ts";
import { loadLedger, updateLedger, type BoardFeedCursorRecord, type Ledger } from "./ledger.ts";

type BoardFeedContext = Readonly<{ board: string; binding: string; session: string }>;
type Replay = ReturnType<typeof createBoardFeedReplay>;
type ReplayEvent = Parameters<typeof stepBoardFeedReplay>[1];
type ReplayStep = ReturnType<typeof stepBoardFeedReplay>;
type UnavailableCursor = { kind: "missing" | "invalid" | "scope-mismatch" };
type CursorLookup = { kind: "matched"; record: BoardFeedCursorRecord } | UnavailableCursor;
type RestoredCursor = { kind: "loaded"; replay: Replay } | UnavailableCursor;
type CursorStep = { kind: "stepped"; step: ReplayStep } | { kind: "held" };

const origins = new WeakMap<Replay, { stateDir: string; binding: string }>();

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

export function restoreBoardFeedCursor(stateDir: string, current: BoardFeedContext): RestoredCursor {
  const cursor = readCursor(stateDir, current);
  if (cursor.kind !== "matched") return cursor;
  const { board, session } = current;
  const replay = createBoardFeedReplay({ board, session }, cursor.record.handled);
  origins.set(replay, { stateDir: resolve(stateDir), binding: cursor.record.binding });
  return { kind: "loaded", replay };
}

export function stepBoardFeedCursor(stateDir: string, current: BoardFeedContext, replay: Replay, event: ReplayEvent): CursorStep {
  const origin = origins.get(replay);
  if (!origin || origin.stateDir !== resolve(stateDir) || origin.binding !== current.binding
    || replay.scope.board !== current.board || replay.scope.session !== current.session || event.kind === "snapshot-applied") {
    return { kind: "held" };
  }
  const cursor = readCursor(stateDir, current);
  if (cursor.kind !== "matched" || cursor.record.handled !== replay.cursor) return { kind: "held" };

  const step = stepBoardFeedReplay(replay, event);
  if (step.state.cursor !== replay.cursor) {
    try {
      updateLedger(stateDir, [], ledger => {
        const latest = cursorFor(ledger, current);
        if (latest.kind !== "matched" || latest.record.handled !== replay.cursor) {
          throw new StateError("The handled cursor changed. Its record was preserved.");
        }
        latest.record.handled = step.state.cursor;
      });
    } catch {
      return { kind: "held" };
    }
  }
  origins.set(step.state, origin);
  return { kind: "stepped", step };
}
