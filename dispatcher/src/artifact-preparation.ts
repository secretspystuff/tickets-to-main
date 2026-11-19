import { isDeepStrictEqual } from "node:util";
import { journalDigest } from "./assignment-journal.ts";
import { validCheckSnapshot, type CheckAttemptRecord, type CurrentCheckSnapshot } from "./check-attempt-record.ts";
import { assignmentDirectory, directoriesOverlap, type DirectoryIdentity } from "./directory-identity.ts";
import { assertPrivateDirectory } from "./fs-safety.ts";
import { loadLedger } from "./ledger.ts";
import { withPrivateJournal } from "./private-journal.ts";
import { checkPushArtifacts } from "./push-artifact-gate.ts";

type StopReason = "secret-detected" | "incomplete-scan" | "scan-interrupted";
type Result = {
  state: "prepared" | "stopped" | "held" | "resumed" | "unavailable";
  reason: StopReason | "authorization-required" | "local-state-unavailable" | null;
  stopSequence: number | null;
  qualification: "unqualified-harness";
  publishable: false;
};
type ReceiptIdentity = { jobId: string; checkAttemptId: string };
type Request = ReceiptIdentity & ({ action: "prepare" } | { action: "after-fix"; stopSequence: number });
type Current = ReceiptIdentity & { workspace: string; snapshot: CurrentCheckSnapshot; afterFixStopSequence: number | null };
type Input = {
  stateDir: string;
  request: Request;
  artifacts: unknown;
  context: { kind: "fabricated-harness"; now(): number; readCurrent(): Current };
};
type Marker = { sequence: number; at: number };
type Intent = Marker & { kind: "artifact.intent"; jobDigest: string; workspaceDigest: string };
type Stopped = Marker & { kind: "runner.stopped"; reason: StopReason };
type Entry = Intent | Stopped | (Marker & { kind: "artifact.checked" | "runner.resumed" });
type Stop = { intent: Intent; marker: Stopped };
type History = { sequence: number; at: number; pending: Intent | null; stop: Stop | null; resumedAt: number };
type Approval = { workspace: DirectoryIdentity; receipt: CheckAttemptRecord };

function outcome(state: Result["state"], reason: Result["reason"] = null, stopSequence: number | null = null): Result {
  return { state, reason, stopSequence, qualification: "unqualified-harness", publishable: false };
}

const unavailable = () => outcome("unavailable", "local-state-unavailable");
const held = () => outcome("held", "authorization-required");
const stopped = (marker: Stopped) => outcome("stopped", marker.reason, marker.sequence);
const invalidHistory = () => new Error("The artifact history could not be read safely.");
const opaque = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, minimum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
const exact = (value: object, keys: readonly string[]) => Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function workspaceDigest(workspace: DirectoryIdentity): string {
  return journalDigest(JSON.stringify([workspace.path, workspace.identity]));
}

function requestOf(value: unknown): Request | null {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  const action: unknown = fields.action?.value;
  const jobId: unknown = fields.jobId?.value;
  const checkAttemptId: unknown = fields.checkAttemptId?.value;
  if (!opaque(jobId) || !opaque(checkAttemptId)) return null;
  const keys = ["action", "jobId", "checkAttemptId"];
  if (action === "prepare" && exact(fields, keys)) return { action, jobId, checkAttemptId };
  const stopSequence: unknown = fields.stopSequence?.value;
  if (action === "after-fix" && exact(fields, [...keys, "stopSequence"]) && integer(stopSequence, 1)) {
    return { action, jobId, checkAttemptId, stopSequence };
  }
  return null;
}

function records(text: string): History {
  const history: History = { sequence: 0, at: 0, pending: null, stop: null, resumedAt: -1 };
  if (text === "") return history;
  if (!text.endsWith("\n")) throw invalidHistory();
  for (const line of text.slice(0, -1).split("\n")) {
    if (Buffer.byteLength(line) > 2048) throw invalidHistory();
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== line) throw invalidHistory();
    const row = value as Record<string, unknown>;
    const { kind, sequence, at } = row;
    if (!integer(sequence, 1) || !integer(at, history.at)) throw invalidHistory();
    const keys = ["kind", "sequence", "at"];
    if (kind === "artifact.intent") {
      if (!exact(row, [...keys, "jobDigest", "workspaceDigest"]) || !digest(row.jobDigest) || !digest(row.workspaceDigest)
        || sequence !== history.sequence + 1 || history.pending || history.stop) throw invalidHistory();
      history.pending = { kind, sequence, at, jobDigest: row.jobDigest, workspaceDigest: row.workspaceDigest };
      history.sequence = sequence;
    } else if (kind === "artifact.checked") {
      if (!exact(row, keys) || history.pending?.sequence !== sequence) throw invalidHistory();
      history.pending = null;
    } else if (kind === "runner.stopped") {
      const { reason } = row;
      if (!exact(row, [...keys, "reason"]) || history.pending?.sequence !== sequence
        || (reason !== "secret-detected" && reason !== "incomplete-scan" && reason !== "scan-interrupted")) throw invalidHistory();
      history.stop = { intent: history.pending, marker: { kind, sequence, at, reason } };
      history.pending = null;
    } else if (kind === "runner.resumed") {
      if (!exact(row, keys) || history.stop?.marker.sequence !== sequence) throw invalidHistory();
      history.stop = null;
      history.resumedAt = at;
    } else {
      throw invalidHistory();
    }
    history.at = at;
  }
  return history;
}

function approval(input: Input, state: DirectoryIdentity, request: Request, at: number, newerThan: number): Approval | null {
  try {
    const current = structuredClone(input.context.readCurrent());
    if (!current || current.jobId !== request.jobId || current.checkAttemptId !== request.checkAttemptId
      || !validCheckSnapshot(current.snapshot) || !current.snapshot.authorized
      || request.action === "after-fix" && current.afterFixStopSequence !== request.stopSequence) return null;
    const loaded = loadLedger(state.path);
    if (!loaded.ok || !loaded.ledger.install || !loaded.ledger.workspace) return null;
    const workspace = assignmentDirectory(current.workspace);
    const selected = assignmentDirectory(loaded.ledger.workspace.path);
    if (selected.path !== workspace.path || selected.identity !== workspace.identity || directoriesOverlap(state, workspace)) return null;
    assertPrivateDirectory(workspace.path);
    const receipt = loaded.ledger.checkAttempts?.find(row => row.attemptId === request.checkAttemptId);
    if (!receipt || receipt.jobId !== request.jobId || receipt.completedAt === null || receipt.completedAt > at
      || receipt.startedAt <= newerThan || receipt.outstandingHostChecks.length > 0
      || (receipt.state !== "passed" && receipt.state !== "not_required")
      || !isDeepStrictEqual(receipt.snapshot, current.snapshot)) return null;
    return { workspace, receipt };
  } catch {
    return null;
  }
}

export function runArtifactPreparation(input: Input): Result {
  try {
    if (input.context.kind !== "fabricated-harness") return unavailable();
    const request = requestOf(input.request);
    if (!request) return held();
    const state = assignmentDirectory(input.stateDir);
    return withPrivateJournal<History, Entry, Result>(state.path, "artifact-preparation.jsonl", records, (history, append) => {
      if (history.stop && request.action === "prepare") return stopped(history.stop.marker);
      const at = input.context.now();
      if (!integer(at, history.at)) return history.stop ? stopped(history.stop.marker) : unavailable();
      if (history.pending) {
        const marker: Stopped = { kind: "runner.stopped", sequence: history.pending.sequence, at, reason: "scan-interrupted" };
        append(marker);
        return stopped(marker);
      }
      if (request.action === "after-fix") {
        const stop = history.stop;
        if (!stop) return held();
        if (request.stopSequence !== stop.marker.sequence || journalDigest(request.jobId) !== stop.intent.jobDigest) return stopped(stop.marker);
        const before = approval(input, state, request, at, stop.marker.at);
        if (!before || workspaceDigest(before.workspace) !== stop.intent.workspaceDigest) return stopped(stop.marker);
        if (checkPushArtifacts(input.artifacts).state !== "clear") return stopped(stop.marker);
        const completedAt = input.context.now();
        if (!integer(completedAt, at) || !isDeepStrictEqual(before, approval(input, state, request, completedAt, stop.marker.at))) {
          return stopped(stop.marker);
        }
        append({ kind: "runner.resumed", sequence: stop.marker.sequence, at: completedAt });
        return outcome("resumed");
      }
      const before = approval(input, state, request, at, history.resumedAt);
      if (!before) return held();
      const sequence = history.sequence + 1;
      if (!integer(sequence, 1)) return unavailable();
      append({ kind: "artifact.intent", sequence, at,
        jobDigest: journalDigest(request.jobId), workspaceDigest: workspaceDigest(before.workspace) });
      const scan = checkPushArtifacts(input.artifacts);
      const completedAt = input.context.now();
      if (!integer(completedAt, at)) return unavailable();
      if (scan.state !== "clear") {
        const marker: Stopped = { kind: "runner.stopped", sequence, at: completedAt, reason: scan.reason };
        append(marker);
        return stopped(marker);
      }
      const stillApproved = isDeepStrictEqual(before, approval(input, state, request, completedAt, history.resumedAt));
      append({ kind: "artifact.checked", sequence, at: completedAt });
      return stillApproved ? outcome("prepared") : held();
    });
  } catch {
    return unavailable();
  }
}
