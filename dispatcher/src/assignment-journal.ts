import { createHash } from "node:crypto";
import { inspectPrivateJournal, readExistingPrivateJournalUnderLease, withPrivateJournal, type JournalWriteOptions } from "./private-journal.ts";
import { currentProcessOwner, validProcessBirth, type ProcessOwner } from "./process-identity.ts";
import type { NativePredecessorRecord } from "./ledger.ts";

export type Intent = {
  version?: 2 | 3 | 4;
  kind: "intent"; id: string; sequence: number; requestDigest: string; bindingDigest: string;
  workspaceDigest: string; aliasDigest?: string; scopeDigest: string; at: number; pid: number; birth?: string;
};
type Result = { kind: "result"; id: string; sequence: number; requestDigest: string; at: number; outcome: "completed" | "failed" | "not-started" };
type Started = { kind: "started"; id: string; sequence: number; requestDigest: string; at: number };
type Entry = { intent: Intent; started: boolean; result: Result | null };
export const journalDigest = (value: string): string => createHash("sha256").update(value).digest("hex");
const opaque = (value: unknown) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number) => Number.isSafeInteger(value) && (value as number) >= min;
const unavailable = () => new Error("Assignment history is unavailable; saved work was preserved.");
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function records(text: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  if (text === "") return entries;
  if (!text.endsWith("\n")) throw unavailable();
  for (const line of text.slice(0, -1).split("\n")) {
    if (Buffer.byteLength(line) > 2048) throw unavailable();
    const row: unknown = JSON.parse(line);
    // Only the writer's exact serialization is valid history; JSON.parse alone hides duplicate keys.
    if (JSON.stringify(row) !== line) throw unavailable();
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw unavailable();
    const value = row as Record<string, unknown>;
    if (!opaque(value.id) || !integer(value.sequence, 1) || !digest(value.requestDigest) || !integer(value.at, 0)) throw unavailable();
    if (value.kind === "intent") {
      if (!exact(value, ["kind", "id", "sequence", "requestDigest", "bindingDigest", "workspaceDigest", "scopeDigest", "at", "pid", ...(Object.hasOwn(value, "version") ? ["version"] : []), ...(Object.hasOwn(value, "birth") ? ["birth"] : []), ...(value.version === 4 ? ["aliasDigest"] : [])])
        || (Object.hasOwn(value, "version") && value.version !== 2 && value.version !== 3 && value.version !== 4)
        || (Object.hasOwn(value, "birth") && ((value.version !== 3 && value.version !== 4) || !validProcessBirth(value.birth)))
        || (value.version === 4 && !digest(value.aliasDigest))
        || !digest(value.bindingDigest) || !digest(value.workspaceDigest) || !digest(value.scopeDigest) || !integer(value.pid, 1)
        || entries.has(value.id as string)) throw unavailable();
      const intent = value as Intent;
      const prior = [...entries.values()].filter((entry) => entry.intent.scopeDigest === intent.scopeDigest);
      if (prior.some((entry) => entry.intent.sequence >= intent.sequence)
        || [...entries.values()].some((entry) => !entry.result && overlap(entry.intent, intent))) throw unavailable();
      // Legacy intents could execute without a start record, so their absence is not proof of non-execution.
      entries.set(intent.id, { intent, started: intent.version === undefined, result: null });
    } else if (value.kind === "started") {
      if (!exact(value, ["kind", "id", "sequence", "requestDigest", "at"])) throw unavailable();
      const entry = entries.get(value.id as string);
      if (!entry || entry.started || entry.result || entry.intent.version === undefined
        || entry.intent.sequence !== value.sequence || entry.intent.requestDigest !== value.requestDigest
        || (value.at as number) < entry.intent.at) throw unavailable();
      entry.started = true;
    } else if (value.kind === "result") {
      if (!exact(value, ["kind", "id", "sequence", "requestDigest", "at", "outcome"])
        || !["completed", "failed", "not-started"].includes(value.outcome as string)) throw unavailable();
      const entry = entries.get(value.id as string);
      if (!entry || entry.result || entry.intent.sequence !== value.sequence || entry.intent.requestDigest !== value.requestDigest
        || (value.at as number) < entry.intent.at
        || (value.outcome === "not-started" ? entry.intent.version === undefined : !entry.started)) throw unavailable();
      entry.result = value as Result;
    } else throw unavailable();
  }
  return entries;
}

function transact<T>(stateDir: string, operation: (entries: Map<string, Entry>, append: (value: Intent | Started | Result) => void) => T,
  options?: JournalWriteOptions): T {
  return withPrivateJournal(stateDir, "assignment-intents.jsonl", records, operation, options);
}

function matching(left: Intent, right: Intent): boolean {
  return left.id === right.id && left.sequence === right.sequence && left.requestDigest === right.requestDigest
    && left.bindingDigest === right.bindingDigest && left.workspaceDigest === right.workspaceDigest && left.scopeDigest === right.scopeDigest
    && left.aliasDigest === right.aliasDigest;
}

function sameReservation(left: Intent, right: Intent): boolean {
  return matching(left, right) && left.version === right.version && left.pid === right.pid
    && left.birth === right.birth && left.at === right.at;
}

function overlap(a: Intent, b: Intent): boolean {
  if (a.version === 4 && b.version === 4) return a.workspaceDigest === b.workspaceDigest || a.aliasDigest === b.aliasDigest;
  return a.version === b.version && a.workspaceDigest === b.workspaceDigest;
}

function ownedAssignmentUnderLease(stateDir: string, intent: Intent): { entries: Map<string, Entry>; entry: Entry } | null {
  const entries = readExistingPrivateJournalUnderLease(stateDir, "assignment-intents.jsonl", records);
  const entry = entries.get(intent.id);
  if (!entry || entry.intent.version !== 4 || !sameReservation(entry.intent, intent)) return null;
  return { entries, entry };
}

export function preparedOwnedBindingsUnderLease(stateDir: string, intent: Intent, previous: readonly string[]): string[] | null {
  const history = ownedAssignmentUnderLease(stateDir, intent);
  if (!history || history.entry.started || history.entry.result || previous.includes(intent.id)) return null;
  const retained: string[] = [];
  for (const id of previous) {
    const bound = history.entries.get(id);
    if (!bound) return null;
    if (!bound.started && !bound.result) retained.push(id);
  }
  return [...retained, intent.id];
}

export function ownedTerminalUnderLease(stateDir: string, intent: Intent): Result | null {
  const history = ownedAssignmentUnderLease(stateDir, intent);
  if (!history) return null;
  const { entry, entries } = history;
  if (!entry.started || (entry.result?.outcome !== "completed" && entry.result?.outcome !== "failed")) return null;
  let later = false;
  for (const other of entries.values()) {
    if (other === entry) later = true;
    else if ((!other.result || (later && other.started)) && (other.intent.version !== 4 || overlap(other.intent, intent))) return null;
  }
  return entry.result;
}

export function matchesNativePredecessorJournal(stateDir: string, receipt: NativePredecessorRecord): boolean {
  const entry = inspectPrivateJournal(stateDir, "assignment-intents.jsonl", records).get(receipt.assignmentId);
  return entry !== undefined && entry.started && entry.intent.version === 4 && entry.intent.sequence === receipt.sequence
    && entry.intent.requestDigest === receipt.requestDigest && entry.intent.bindingDigest === receipt.bindingDigest
    && entry.intent.workspaceDigest === receipt.workspaceDigest && entry.intent.aliasDigest === receipt.workspaceIdentityDigest
    && entry.result?.outcome === "completed" && entry.result.at === receipt.completedAt;
}

export function reserveAssignment(stateDir: string, intent: Intent, legacyWorkspaceDigest: string, ownerAlive: (owner: ProcessOwner) => boolean,
  stateIsCurrent?: () => boolean): { state: "new" | "pending" | Result["outcome"]; intent: Intent } {
  return transact(stateDir, (entries, append) => {
    const sameWorkspace = (old: Intent) => old.version === 4 ? overlap(old, intent)
      : old.workspaceDigest === (old.version === 3 ? intent.aliasDigest : legacyWorkspaceDigest);
    const previous = entries.get(intent.id);
    if (previous && (!matching(previous.intent, { ...intent, workspaceDigest: previous.intent.workspaceDigest, aliasDigest: previous.intent.aliasDigest })
      || (previous.intent.version === 4 && !sameWorkspace(previous.intent))
      || intent.at < previous.intent.at)) throw unavailable();
    for (const entry of entries.values()) {
      if (!entry.result && !entry.started && (sameWorkspace(entry.intent) || entry === previous) && !ownerAlive(entry.intent)) {
        if (intent.at < entry.intent.at) throw unavailable();
        const result: Result = { kind: "result", id: entry.intent.id, sequence: entry.intent.sequence,
          requestDigest: entry.intent.requestDigest, at: intent.at, outcome: "not-started" };
        append(result);
        entry.result = result;
      }
    }
    if (previous) {
      return { state: previous.result?.outcome ?? "pending", intent: previous.intent };
    }
    const prior = [...entries.values()].filter((entry) => entry.intent.scopeDigest === intent.scopeDigest);
    // Legacy path hashes cannot rule out an alternate spelling of this workspace.
    if ([...entries.values()].some((entry) => !entry.result && (entry.intent.version !== 4 || sameWorkspace(entry.intent)))
      || prior.some((entry) => entry.intent.sequence >= intent.sequence)
      || (prior.length > 0 && Math.max(...prior.map((entry) => entry.intent.sequence)) + 1 !== intent.sequence)) throw unavailable();
    append(intent);
    return { state: "new", intent };
  }, { stateIsCurrent });
}

export function startAssignment(stateDir: string, intent: Intent, at: number, claimIsCurrent?: () => boolean): void {
  transact(stateDir, (entries, append) => {
    const entry = entries.get(intent.id);
    if (!entry || entry.intent.version === undefined || !owned(entry.intent)
      || entry.started || entry.result || !integer(at, 0) || at < entry.intent.at) throw unavailable();
    if (claimIsCurrent) {
      if (entry.intent.version !== 4 || !sameReservation(entry.intent, intent) || !claimIsCurrent()) throw unavailable();
    } else if (!matching(entry.intent, intent)) throw unavailable();
    append({ kind: "started", id: intent.id, sequence: intent.sequence, requestDigest: intent.requestDigest, at });
  }, { existingOnly: claimIsCurrent !== undefined });
}

export function completeAssignment(stateDir: string, intent: Intent, outcome: Result["outcome"], at: number,
  stateIsCurrent?: () => boolean): void {
  transact(stateDir, (entries, append) => {
    const previous = entries.get(intent.id);
    if (!previous || !integer(at, 0) || at < previous.intent.at
      || !(stateIsCurrent ? sameReservation(previous.intent, intent) : matching(previous.intent, intent))) throw unavailable();
    if (outcome === "not-started" ? previous.intent.version === undefined || !owned(previous.intent) : !previous.started) throw unavailable();
    if (previous.result) {
      if (previous.result.outcome !== outcome) throw unavailable();
      return;
    }
    append({ kind: "result", id: intent.id, sequence: intent.sequence, requestDigest: intent.requestDigest, at, outcome });
  }, { existingOnly: stateIsCurrent !== undefined, stateIsCurrent });
}

function owned(intent: Intent): boolean {
  const current = currentProcessOwner();
  return intent.pid === current.pid && (!intent.birth || intent.birth === current.birth);
}
