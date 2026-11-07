import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_MARK, unfold } from "./secret-text.ts";
import { PACKAGE_VERSION } from "./version.ts";
import { StateError, assertPrivateDirectory, writePrivateFile } from "./fs-safety.ts";
import { validCheckAttemptRecord, type CheckAttemptRecord } from "./check-attempt-record.ts";

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
};

export type Ledger = {
  version: 1;
  install: InstallRecord | null;
  connection: ConnectionRecord | null;
  tools: ToolRecord[];
  workspace: WorkspaceRecord | null;
  checkAttempts?: CheckAttemptRecord[];
};

export const LEDGER_FILE = "ledger.json";

const FORBIDDEN_KEYS = new Set(["key", "device_code", "secret", "token", "password", "authorization", "bearer"]);

export function emptyLedger(): Ledger {
  return { version: 1, install: null, connection: null, tools: [], workspace: null };
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
    && row.path.startsWith("/")
    && row.path.length <= 4096
    && pid
    && row.qualified === false;
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
  if (row.version !== 1) return null;
  const install = row.install;
  let installRecord: InstallRecord | null = null;
  if (install !== null) {
    if (install === undefined || typeof install !== "object") return null;
    const item = install as Record<string, unknown>;
    if (item.packageVersion !== PACKAGE_VERSION && typeof item.packageVersion !== "string") return null;
    if (!isOsLabel(item.platform) || typeof item.arch !== "string" || typeof item.installedAt !== "string") return null;
    if (item.startup !== "not-registered" || item.signedInstallers !== "not-qualified") return null;
    if (typeof item.packageVersion !== "string") return null;
    installRecord = {
      packageVersion: item.packageVersion,
      platform: item.platform,
      arch: item.arch,
      installedAt: item.installedAt,
      startup: "not-registered",
      signedInstallers: "not-qualified",
    };
  }
  if (row.connection !== null && !isConnection(row.connection)) return null;
  if (!Array.isArray(row.tools) || !row.tools.every(isTool)) return null;
  if (row.checkAttempts !== undefined && (!Array.isArray(row.checkAttempts) || !row.checkAttempts.every(validCheckAttemptRecord)
    || new Set(row.checkAttempts.map((attempt) => attempt.attemptId)).size !== row.checkAttempts.length)) return null;
  let workspace: WorkspaceRecord | null = null;
  if (row.workspace !== undefined && row.workspace !== null) {
    if (!isWorkspace(row.workspace)) return null;
    workspace = row.workspace;
  }
  try {
    assertPublicRecord(parsed, []);
  } catch {
    return null;
  }
  return {
    version: 1,
    install: installRecord,
    connection: row.connection === null ? null : row.connection,
    tools: row.tools,
    workspace,
    ...(row.checkAttempts === undefined ? {} : { checkAttempts: row.checkAttempts }),
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, ledger: emptyLedger() };
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
  return { ok: true, ledger };
}

export function saveLedger(stateDir: string, ledger: Ledger, secrets: readonly string[]): void {
  if (ledger.checkAttempts !== undefined && (!Array.isArray(ledger.checkAttempts) || !ledger.checkAttempts.every(validCheckAttemptRecord)
    || new Set(ledger.checkAttempts.map((attempt) => attempt.attemptId)).size !== ledger.checkAttempts.length)) {
    throw new StateError("The check attempt record is not valid. It was not saved.");
  }
  assertPublicRecord(ledger, secrets);
  writePrivateFile(ledgerPath(stateDir), `${JSON.stringify(ledger, null, 2)}\n`);
}
