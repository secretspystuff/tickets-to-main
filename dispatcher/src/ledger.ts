import { closeSync, fsyncSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { withStateLease } from "./state-lease.ts";
import { join } from "node:path";
import { KEY_MARK, unfold } from "./secret-text.ts";
import { PACKAGE_VERSION } from "./version.ts";
import { StateError, assertPrivateDirectory, writePrivateFile } from "./fs-safety.ts";
import { validCheckAttemptRecord, type CheckAttemptRecord } from "./check-attempt-record.ts";
import { recoveryTextIsStorable, validRecoverySnapshot, type RecoverySnapshot } from "./board-feed-recovery.ts";
import type { AppServerTerminalLineage } from "./adapters/codex-app-server.ts";
import { nativePredecessorId, record } from "./adapters/native-result.ts";
import { matchesNativePredecessorJournal } from "./assignment-journal.ts";

export type OsLabel = "early-linux-probe" | "unqualified-windows" | "unqualified-macos" | "unqualified-other";

export type ConnectionPhase = "pending" | "approved" | "denied" | "expired";

export type ToolQualification = "documented" | "unavailable" | "unknown";

export type ToolRecord = {
  vendor: "codex";
  interfaceId: "cli" | "app-server";
  qualification: ToolQualification;
  experimental: true | "unknown";
  version: string | null;
  limit: string;
};

export type InstallRecord = {
  packageVersion: string;
  platform: OsLabel;
  arch: string;
  installedAt: string;
  startup: "not-registered";
  signedInstallers: "not-qualified";
  release?: { directory: string; manifestDigest: string; qualified: false };
};

export type DeliveryReceipt = {
  version: 1;
  scopeId: string;
  enrollmentId: string;
  bindingDigest: string;
  credentialDigest: string;
  boardName: string;
  agentName: string;
};

export type ConnectionRecord = {
  phase: ConnectionPhase;
  fixture: true;
  protocolRevision: "waiting-on-t1";
  origin: string;
  computer: string;
  userCode: string;
  verificationUriComplete: string;
  boardName: string | null;
  agentName: string | null;
  lastPollAt: string | null;
  fixturePollIndex: number;
  enrollmentId?: string;
  deliveryReceipt?: DeliveryReceipt;
};

export type WorkspaceRecord = {
  path: string;
  writerPid: number | null;
  qualified: false;
  claimGeneration?: string;
};

export type NativePredecessorRecord = {
  assignmentId: string;
  sequence: number;
  requestDigest: string;
  bindingDigest: string;
  workspaceDigest: string;
  workspaceIdentityDigest: string;
  workspaceBirthDigest: string;
  claimGeneration: string;
  completedAt: number;
  nativeTerminal: AppServerTerminalLineage;
  originalJob: { state: "verified"; activeProcesses: 0 };
};

export type BoardFeedCursorRecord = {
  board: string;
  binding: string;
  handled: number;
  recoveryEpoch?: string;
  recoveryRequired?: true;
  recoverySnapshot?: RecoverySnapshot;
};

export type Ledger = {
  version: 1;
  install: InstallRecord | null;
  connection: ConnectionRecord | null;
  tools: ToolRecord[];
  workspace: WorkspaceRecord | null;
  boundWorkspaceIntents?: string[];
  nativePredecessor?: NativePredecessorRecord;
  checkAttempts?: CheckAttemptRecord[];
  boardFeedCursors?: BoardFeedCursorRecord[];
};

export const LEDGER_FILE = "ledger.json";

const origins = new WeakMap<Ledger, { path: string | null; digest: string | null }>();
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");

const FORBIDDEN_KEYS = new Set(["key", "device_code", "secret", "token", "password", "authorization", "bearer"]);

export function emptyLedger(): Ledger {
  const ledger: Ledger = { version: 1, install: null, connection: null, tools: [], workspace: null };
  origins.set(ledger, { path: null, digest: null });
  return ledger;
}

export function ledgerPath(stateDir: string): string {
  return join(stateDir, LEDGER_FILE);
}

function exposure(node: string, secrets: readonly string[]): "unreadable" | "key" | "secret" | null {
  const shown = unfold(node);
  if (shown === null) return "unreadable";
  const forms = shown === node ? [node] : [node, shown];
  if (forms.some((form) => form.includes(KEY_MARK))) return "key";
  if (forms.some((form) => secrets.some((secret) => secret.length > 0 && form.includes(secret)))) return "secret";
  return null;
}

export function assertPublicRecord(value: unknown, secrets: readonly string[]): void {
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      const found = exposure(node, secrets);
      if (found === "unreadable") throw new StateError("The local record could not be read safely. It was not saved.");
      if (found === "key") throw new StateError("The local record cannot store a key. It was not saved.");
      if (found === "secret") throw new StateError("The local record included a secret. It was not saved.");
      return;
    }
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, entry] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(key)) throw new StateError(`The local record cannot store ${key}. It was not saved.`);
        walk(entry);
      }
    }
  };
  walk(value);
}

function isOsLabel(value: unknown): value is OsLabel {
  return value === "early-linux-probe" || value === "unqualified-windows" || value === "unqualified-macos" || value === "unqualified-other";
}

function isTool(value: unknown): value is ToolRecord {
  if (value === null || typeof value !== "object") return false;
  const tool = value as Record<string, unknown>;
  return tool.vendor === "codex"
    && (tool.interfaceId === "cli" || tool.interfaceId === "app-server")
    && (tool.qualification === "documented" || tool.qualification === "unavailable" || tool.qualification === "unknown")
    && (tool.experimental === true || tool.experimental === "unknown")
    && (tool.version === null || typeof tool.version === "string")
    && typeof tool.limit === "string";
}

function isWorkspace(value: unknown): value is WorkspaceRecord {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const pid = row.writerPid === null || (typeof row.writerPid === "number" && Number.isInteger(row.writerPid) && row.writerPid > 0);
  return typeof row.path === "string"
    && isAbsolute(row.path)
    && row.path.length <= 4096
    && pid
    && (!Object.hasOwn(row, "claimGeneration") || (row.writerPid !== null && typeof row.claimGeneration === "string"
      && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.claimGeneration)))
    && row.qualified === false;
}

function isNativePredecessor(value: unknown): value is NativePredecessorRecord {
  const row = record(value);
  if (!row) return false;
  const digests = ["requestDigest", "bindingDigest", "workspaceDigest", "workspaceIdentityDigest", "workspaceBirthDigest"];
  const keys = [...digests, "assignmentId", "sequence", "claimGeneration", "completedAt", "nativeTerminal", "originalJob"];
  const terminal = record(row.nativeTerminal), job = record(row.originalJob);
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))
    && digests.every(key => typeof row[key] === "string" && /^[a-f0-9]{64}$/.test(row[key]))
    && typeof row.assignmentId === "string" && /^[a-f0-9]{32}$/.test(row.assignmentId)
    && typeof row.sequence === "number" && Number.isSafeInteger(row.sequence) && row.sequence >= 1
    && typeof row.claimGeneration === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.claimGeneration)
    && typeof row.completedAt === "number" && Number.isSafeInteger(row.completedAt) && row.completedAt >= 0
    && terminal !== null && Object.keys(terminal).length === 4 && terminal.vendor === "codex" && terminal.interfaceId === "app-server"
    && nativePredecessorId(terminal.threadId) && nativePredecessorId(terminal.turnId)
    && job !== null && Object.keys(job).length === 2 && job.state === "verified" && Object.is(job.activeProcesses, 0);
}

function isBoardFeedCursor(value: unknown): value is BoardFeedCursorRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ["board", "binding", "handled"];
  if (Object.hasOwn(row, "recoveryEpoch")) keys.push("recoveryEpoch");
  if (Object.hasOwn(row, "recoveryRequired")) keys.push("recoveryRequired");
  if (Object.hasOwn(row, "recoverySnapshot")) keys.push("recoverySnapshot");
  return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key))
    && typeof row.board === "string" && row.board.length > 0
    && typeof row.binding === "string" && row.binding.length > 0
    && typeof row.handled === "number" && Number.isSafeInteger(row.handled) && row.handled >= 0
    && (row.recoveryEpoch === undefined || typeof row.recoveryEpoch === "string" && /^[a-f0-9]{32}$/.test(row.recoveryEpoch))
    && (row.recoveryRequired === undefined || row.recoveryRequired === true && row.recoveryEpoch !== undefined)
    && (row.recoverySnapshot === undefined || row.recoveryEpoch !== undefined
      && validRecoverySnapshot(row.recoverySnapshot, row.board) && row.recoverySnapshot.next <= row.handled);
}

function assertLedgerRecord(value: Ledger, secrets: readonly string[]): void {
  if (!Array.isArray(value.boardFeedCursors) || !value.boardFeedCursors.some(row => row?.recoverySnapshot !== undefined)) {
    assertPublicRecord(value, secrets);
    return;
  }
  // Display headings and locators can contain ordinary percent signs. Scan their decoded forms with the text checker.
  const cursors = value.boardFeedCursors.map(({ recoverySnapshot, ...cursor }) => {
    if (recoverySnapshot !== undefined && (!validRecoverySnapshot(recoverySnapshot, cursor.board)
      || !recoveryTextIsStorable(recoverySnapshot, secrets))) throw new StateError("The recovery snapshot could not be saved safely.");
    return cursor;
  });
  assertPublicRecord({ ...value, boardFeedCursors: cursors }, secrets);
}

function isDeliveryReceipt(value: unknown): value is DeliveryReceipt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ["version", "scopeId", "enrollmentId", "bindingDigest", "credentialDigest", "boardName", "agentName"];
  return Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key))
    && row.version === 1
    && typeof row.scopeId === "string" && /^[a-f0-9]{64}$/.test(row.scopeId)
    && typeof row.enrollmentId === "string" && /^[a-f0-9]{32}$/.test(row.enrollmentId)
    && typeof row.bindingDigest === "string" && /^[a-f0-9]{64}$/.test(row.bindingDigest)
    && typeof row.credentialDigest === "string" && /^[a-f0-9]{64}$/.test(row.credentialDigest)
    && typeof row.boardName === "string" && typeof row.agentName === "string";
}

function isConnection(value: unknown): value is ConnectionRecord {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const phase = row.phase === "pending" || row.phase === "approved" || row.phase === "denied" || row.phase === "expired";
  return phase
    && row.fixture === true
    && row.protocolRevision === "waiting-on-t1"
    && typeof row.origin === "string"
    && typeof row.computer === "string"
    && typeof row.userCode === "string"
    && typeof row.verificationUriComplete === "string"
    && (row.boardName === null || typeof row.boardName === "string")
    && (row.agentName === null || typeof row.agentName === "string")
    && (row.lastPollAt === null || typeof row.lastPollAt === "string")
    && typeof row.fixturePollIndex === "number"
    && (row.enrollmentId === undefined || (typeof row.enrollmentId === "string" && /^[a-f0-9]{32}$/.test(row.enrollmentId)))
    && (row.deliveryReceipt === undefined || isDeliveryReceipt(row.deliveryReceipt));
}

export function parseLedger(text: string): Ledger | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const fields = ["version", "install", "connection", "tools", "workspace", "boundWorkspaceIntents", "nativePredecessor", "checkAttempts", "boardFeedCursors"];
  if (row.version !== 1 || Object.keys(row).some(key => !fields.includes(key))) return null;
  const install = row.install;
  let installRecord: InstallRecord | null = null;
  if (install !== null) {
    if (install === undefined || typeof install !== "object") return null;
    const item = install as Record<string, unknown>;
    if (item.packageVersion !== PACKAGE_VERSION && typeof item.packageVersion !== "string") return null;
    if (!isOsLabel(item.platform) || typeof item.arch !== "string" || typeof item.installedAt !== "string") return null;
    if (item.startup !== "not-registered" || item.signedInstallers !== "not-qualified") return null;
    if (typeof item.packageVersion !== "string") return null;
    if (item.release !== undefined) {
      if (item.release === null || typeof item.release !== "object" || Array.isArray(item.release)) return null;
      const selected = item.release as Record<string, unknown>;
      if (Object.keys(selected).length !== 3 || typeof selected.directory !== "string"
        || !/^releases\/[0-9A-Za-z.+-]+-[a-f0-9]{64}$/.test(selected.directory)
        || typeof selected.manifestDigest !== "string" || !/^[a-f0-9]{64}$/.test(selected.manifestDigest) || selected.qualified !== false) return null;
    }
    installRecord = {
      packageVersion: item.packageVersion,
      platform: item.platform,
      arch: item.arch,
      installedAt: item.installedAt,
      startup: "not-registered",
      signedInstallers: "not-qualified",
      ...(item.release === undefined ? {} : { release: item.release as NonNullable<InstallRecord["release"]> }),
    };
  }
  if (row.connection !== null && !isConnection(row.connection)) return null;
  if (!Array.isArray(row.tools) || !row.tools.every(isTool)) return null;
  if (row.checkAttempts !== undefined && (!Array.isArray(row.checkAttempts) || !row.checkAttempts.every(validCheckAttemptRecord)
    || new Set(row.checkAttempts.map((attempt) => attempt.attemptId)).size !== row.checkAttempts.length)) return null;
  const cursors = row.boardFeedCursors;
  if (cursors !== undefined && (!Array.isArray(cursors) || !cursors.every(isBoardFeedCursor)
    || new Set(cursors.map(cursor => cursor.board)).size !== cursors.length)) return null;
  let workspace: WorkspaceRecord | null = null;
  if (row.workspace !== undefined && row.workspace !== null) {
    if (!isWorkspace(row.workspace)) return null;
    workspace = row.workspace;
  }
  const boundWorkspaceIntents = row.boundWorkspaceIntents;
  if (boundWorkspaceIntents !== undefined && (!Array.isArray(boundWorkspaceIntents) || boundWorkspaceIntents.length === 0
    || !boundWorkspaceIntents.every(id => typeof id === "string" && /^[a-f0-9]{32}$/.test(id))
    || new Set(boundWorkspaceIntents).size !== boundWorkspaceIntents.length)) return null;
  if (workspace?.claimGeneration !== undefined && boundWorkspaceIntents === undefined) return null;
  const predecessor = row.nativePredecessor;
  if (predecessor !== undefined && (!isNativePredecessor(predecessor) || workspace?.claimGeneration === predecessor.claimGeneration
    || boundWorkspaceIntents?.includes(predecessor.assignmentId))) return null;
  try {
    assertLedgerRecord(parsed as Ledger, []);
  } catch {
    return null;
  }
  return {
    version: 1,
    install: installRecord,
    connection: row.connection === null ? null : row.connection,
    tools: row.tools,
    workspace,
    ...(boundWorkspaceIntents === undefined ? {} : { boundWorkspaceIntents }),
    ...(predecessor === undefined ? {} : { nativePredecessor: predecessor }),
    ...(row.checkAttempts === undefined ? {} : { checkAttempts: row.checkAttempts }),
    ...(cursors === undefined ? {} : { boardFeedCursors: cursors }),
  };
}

export type LoadResult =
  | { ok: true; ledger: Ledger }
  | { ok: false; reason: "missing" | "unreadable" | "unsafe" };

export function loadLedger(stateDir: string): LoadResult {
  try {
    assertPrivateDirectory(stateDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unsafe" };
  }
  const path = ledgerPath(stateDir);
  try {
    if (lstatSync(path).isSymbolicLink()) throw new StateError("The local record is a link. It was not saved.");
  } catch (error) {
    if (error instanceof StateError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const ledger = emptyLedger();
      origins.set(ledger, { path: resolve(stateDir), digest: null });
      return { ok: true, ledger };
    }
    return { ok: false, reason: "unreadable" };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const ledger = parseLedger(text);
  if (!ledger) return { ok: false, reason: "unreadable" };
  try {
    if (ledger.nativePredecessor && !matchesNativePredecessorJournal(stateDir, ledger.nativePredecessor)) return { ok: false, reason: "unreadable" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  origins.set(ledger, { path: resolve(stateDir), digest: fingerprint(text) });
  return { ok: true, ledger };
}

function validateSave(ledger: Ledger, secrets: readonly string[]): void {
  if (ledger.checkAttempts !== undefined && (!Array.isArray(ledger.checkAttempts) || !ledger.checkAttempts.every(validCheckAttemptRecord)
    || new Set(ledger.checkAttempts.map((attempt) => attempt.attemptId)).size !== ledger.checkAttempts.length)) {
    throw new StateError("The check attempt record is not valid. It was not saved.");
  }
  assertLedgerRecord(ledger, secrets);
  if (parseLedger(JSON.stringify(ledger)) === null) throw new StateError("The local record is not valid. It was not saved.");
}

function currentLedger(stateDir: string): Ledger {
  const loaded = loadLedger(stateDir);
  if (loaded.ok) return loaded.ledger;
  if (loaded.reason === "missing") return emptyLedger();
  throw new StateError("The local record could not be read safely. Its work was preserved.");
}

function persist(stateDir: string, ledger: Ledger, secrets: readonly string[]): void {
  validateSave(ledger, secrets);
  const text = JSON.stringify(ledger, null, 2) + "\n";
  writePrivateFile(ledgerPath(stateDir), text);
  if (process.platform !== "win32") {
    const fd = openSync(stateDir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  origins.set(ledger, { path: resolve(stateDir), digest: fingerprint(text) });
}

function sameOrigin(stateDir: string, expected: { path: string | null; digest: string | null } | undefined, current: Ledger): boolean {
  const actual = origins.get(current);
  return expected !== undefined && (expected.path === null || expected.path === resolve(stateDir))
    && expected.digest === actual?.digest;
}

export function saveLedger(stateDir: string, ledger: Ledger, secrets: readonly string[]): void {
  validateSave(ledger, secrets);
  const origin = origins.get(ledger) ?? { path: resolve(stateDir), digest: null };
  if (!sameOrigin(stateDir, origin, currentLedger(stateDir))) throw new StateError("The local record changed. Reload it before retrying; its work was preserved.");
  withStateLease(stateDir, "ledger", () => {
    if (!sameOrigin(stateDir, origin, currentLedger(stateDir))) throw new StateError("The local record changed. Reload it before retrying; its work was preserved.");
    persist(stateDir, ledger, secrets);
  });
}

export function updateLedger(stateDir: string, secrets: readonly string[], mutate: (current: Ledger) => void,
  onPersist?: () => void): Ledger {
  currentLedger(stateDir);
  return withStateLease(stateDir, "ledger", () => {
    const current = currentLedger(stateDir);
    const before = JSON.stringify(current);
    const result: unknown = mutate(current);
    if (result !== null && typeof result === "object" && "then" in result) throw new StateError("The local record transaction must finish before returning.");
    validateSave(current, secrets);
    if (JSON.stringify(current) !== before || origins.get(current)?.digest === null) {
      persist(stateDir, current, secrets);
      onPersist?.();
    }
    return current;
  });
}
