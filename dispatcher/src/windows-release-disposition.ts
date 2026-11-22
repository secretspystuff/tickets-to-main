import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { VerifiedSelectedRelease } from "./install.ts";
import { inspectPrivateJournal, WINDOWS_RELEASE_JOURNAL } from "./private-journal.ts";
import {
  parseWindowsPackageFullName, releaseError, releaseVersion, validAppxDigest, windowsInventoryMatches,
  type WindowsPackageDescriptor,
} from "./release-manifest.ts";
import { assertReleaseRoot, exists, WINDOWS_RELEASE_SUBMISSION_DIRECTORY } from "./release-store.ts";
import { observeStateLeaseEpoch } from "./state-lease.ts";

type Inventory = WindowsPackageDescriptor["installed"]["files"];
type Registration = { fullName: string; healthy: boolean; files: Inventory };
export type WindowsStageReceipt = {
  activityId: string;
  status: "completed";
  errorCode: number;
  extendedErrorCode: number;
  stagedPackageFullName: string;
  registrations: Registration[];
} | {
  activityId: string;
  status: "error";
  errorCode: number;
  extendedErrorCode: number;
  registrations: Registration[];
};

type WindowsSubmissionIdentity = {
  release: VerifiedSelectedRelease;
  archiveSha256: string;
  appxDigest: string;
  packageFullName: string;
};
type Attempt = WindowsSubmissionIdentity & { leaseEpoch: string; leaseGeneration: string };
type Terminal = { state: "staged" | "registered"; attempt: Attempt; activityId: string }
  | { state: "failed"; attempt: Attempt; activityId: string; errorCode: number; extendedErrorCode: number };
export type WindowsReleaseDisposition = { state: "none" } | { state: "held"; attempt: Attempt } | Terminal;
export type WindowsReleaseOutcome = Exclude<WindowsReleaseDisposition, { state: "none" }>;
export type WindowsReleaseJournalRow = { phase: "intent"; attempt: Attempt }
  | { phase: "staged" | "registered"; attempt: Attempt; activityId: string }
  | { phase: "failed"; attempt: Attempt; activityId: string; errorCode: number; extendedErrorCode: number };

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function activity(value: unknown): value is string {
  return typeof value === "string" && /^\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/i.test(value)
    && value !== "{00000000-0000-0000-0000-000000000000}";
}

function hresult(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
}

export function validWindowsReleaseAttempt(value: unknown): value is Attempt {
  if (!exact(value, ["release", "archiveSha256", "appxDigest", "packageFullName", "leaseEpoch", "leaseGeneration"])
    || !sha(value.archiveSha256) || !validAppxDigest(value.appxDigest)
    || parseWindowsPackageFullName(value.packageFullName)?.architecture !== "x64"
    || typeof value.leaseEpoch !== "string" || !/^(0|[1-9][0-9]{0,63})$/.test(value.leaseEpoch)
    || !sha(value.leaseGeneration)) return false;
  const release = value.release;
  return exact(release, ["version", "manifestDigest", "sourceCommit"]) && releaseVersion(release.version)
    && sha(release.manifestDigest) && typeof release.sourceCommit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(release.sourceCommit);
}

export function readWindowsReleaseHistory(text: string): WindowsReleaseOutcome {
  const endOfIntent = text.indexOf("\n");
  if (endOfIntent < 0) throw releaseError();
  const intent: unknown = JSON.parse(text.slice(0, endOfIntent));
  if (!exact(intent, ["phase", "attempt"]) || intent.phase !== "intent" || !validWindowsReleaseAttempt(intent.attempt)) throw releaseError();
  const attempt = intent.attempt;
  const result = text.slice(endOfIntent + 1);
  const endOfResult = result.indexOf("\n");
  if (endOfResult < 0) return { state: "held", attempt };
  if (endOfResult !== result.length - 1) throw releaseError();

  const terminal: unknown = JSON.parse(result.slice(0, endOfResult));
  if (exact(terminal, ["phase", "attempt", "activityId"])
    && (terminal.phase === "staged" || terminal.phase === "registered")
    && isDeepStrictEqual(terminal.attempt, attempt) && activity(terminal.activityId)) {
    return { state: terminal.phase, attempt, activityId: terminal.activityId };
  }
  if (exact(terminal, ["phase", "attempt", "activityId", "errorCode", "extendedErrorCode"])
    && terminal.phase === "failed" && isDeepStrictEqual(terminal.attempt, attempt) && activity(terminal.activityId)
    && hresult(terminal.errorCode) && terminal.errorCode < 0 && hresult(terminal.extendedErrorCode)) {
    return { state: "failed", attempt, activityId: terminal.activityId, errorCode: terminal.errorCode, extendedErrorCode: terminal.extendedErrorCode };
  }
  throw releaseError();
}

export function readWindowsReleaseDisposition(stateDir: string): WindowsReleaseDisposition {
  try {
    assertReleaseRoot(stateDir);
    const directory = join(stateDir, WINDOWS_RELEASE_SUBMISSION_DIRECTORY);
    if (!exists(directory)) return { state: "none" };
    const disposition = inspectPrivateJournal(directory, WINDOWS_RELEASE_JOURNAL, readWindowsReleaseHistory);
    const { leaseEpoch, leaseGeneration } = disposition.attempt;
    if (observeStateLeaseEpoch(stateDir, "release", BigInt(leaseEpoch)).generation !== leaseGeneration) throw releaseError();
    return disposition;
  } catch { throw releaseError(); }
}

export function matchingWindowsDisposition(disposition: WindowsReleaseOutcome, offer: WindowsSubmissionIdentity): WindowsReleaseOutcome {
  const { leaseEpoch: _epoch, leaseGeneration: _generation, ...identity } = disposition.attempt;
  if (!isDeepStrictEqual(identity, offer)) throw releaseError();
  return disposition;
}

export function assertPortableSelectionMayChange(stateDir: string): void {
  if (!exists(join(stateDir, WINDOWS_RELEASE_SUBMISSION_DIRECTORY))) return;
  const { state } = readWindowsReleaseDisposition(stateDir);
  if (state !== "none" && state !== "registered") throw releaseError();
}

export function classifyWindowsStageReceipt(receipt: WindowsStageReceipt | undefined, attempt: Attempt,
  descriptor: WindowsPackageDescriptor): WindowsReleaseOutcome {
  const held = { state: "held", attempt } as const;
  if (!receipt || !activity(receipt.activityId)) return held;
  const { activityId, errorCode, extendedErrorCode } = receipt;
  if (receipt.status === "error" && hresult(errorCode) && errorCode < 0 && hresult(extendedErrorCode)) {
    return { state: "failed", attempt, activityId, errorCode, extendedErrorCode };
  }
  if (receipt.status !== "completed" || errorCode !== 0 || extendedErrorCode !== 0
    || receipt.stagedPackageFullName !== attempt.packageFullName || !Array.isArray(receipt.registrations)
    || receipt.registrations.length > 1) return held;
  if (receipt.registrations.length === 0) return { state: "staged", attempt, activityId };
  const registration = receipt.registrations[0];
  if (!registration || typeof registration.healthy !== "boolean") return held;
  const registered = parseWindowsPackageFullName(registration.fullName);
  if (!registered) return held;
  if (registration.fullName !== attempt.packageFullName) {
    const { architecture, packageName, publisherId } = descriptor.package;
    if (registered.packageName !== packageName || registered.publisherId !== publisherId || registered.architecture !== architecture) return held;
  } else if (registration.healthy) {
    if (!windowsInventoryMatches(registration.files, descriptor.installed.files)) return held;
    return { state: "registered", attempt, activityId };
  }
  return { state: "staged", attempt, activityId };
}
