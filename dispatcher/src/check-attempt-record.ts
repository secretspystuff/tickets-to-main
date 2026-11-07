import { safeNativeText } from "./adapters/native-result.ts";
import { unfold } from "./secret-text.ts";

export type CheckState = "running" | "passed" | "failed" | "held" | "blocked" | "unavailable" | "interrupted" | "unrun" | "stale" | "not_required";
export type PublicCheckResult = "running" | "passed" | "failed" | "unavailable" | "not_required";
export type CheckBinding = { candidate_id: string; requirements_id: string; base_id: string; policy_id: string };
export type SelectedCheck = { id: string; argv: string[]; memberIds: string[]; dependsOn: string[] };
export type CurrentCheckSnapshot = {
  authorized: boolean;
  claimId: string;
  binding: CheckBinding;
  candidateCommit: string;
  baseCommit: string;
  evidenceRevision: string;
  buildReview: { id: string; result: "passed" | "failed"; candidateCommit: string; binding: CheckBinding } | null;
  profile: { id: string; revision: string; mode: "scripted" | "none"; sourceId: string; checks: SelectedCheck[] };
  memberIds: string[];
  requiredHostChecks: string[];
};
export type CheckTerminal = {
  attemptId: string;
  checkId: string;
  sourceId: string;
  candidateCommit: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error: "spawn" | null;
  writerCustody: "contained" | "unknown";
};
export type CheckDetail = {
  id: string;
  state: CheckState;
  publicResult: PublicCheckResult;
  sourceId: string;
  coveredMemberIds: string[];
  stdout: string;
  stderr: string;
  terminal: CheckTerminal | null;
};
export type CheckAttemptRecord = {
  version: 1;
  jobId: string;
  attemptId: string;
  snapshot: CurrentCheckSnapshot;
  qualification: "unqualified-harness";
  publishable: false;
  state: CheckState;
  publicResult: PublicCheckResult;
  checks: CheckDetail[];
  outstandingHostChecks: string[];
  startedAt: number;
  completedAt: number | null;
};

const STATES: readonly CheckState[] = ["running", "passed", "failed", "held", "blocked", "unavailable", "interrupted", "unrun", "stale", "not_required"];
const BINDING_KEYS = ["candidate_id", "requirements_id", "base_id", "policy_id"];

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function publicCheckResult(state: CheckState): PublicCheckResult {
  if (state === "passed" || state === "failed" || state === "running" || state === "not_required") return state;
  return "unavailable";
}

export function redactCheckText(value: string, secrets: readonly string[]): string {
  const decoded = unfold(value);
  return decoded === null ? "[unreadable text omitted]" : safeNativeText(decoded, secrets);
}

function text(value: unknown, max = 4096): value is string {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
    && redactCheckText(value, []) === value;
}

function label(value: unknown): value is string {
  return text(value, 200) && value.length > 0 && !/[\r\n\t]/.test(value);
}

function opaque(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function gitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function strings(value: unknown, validate: (entry: unknown) => boolean = label): value is string[] {
  return Array.isArray(value) && value.every(validate) && new Set(value).size === value.length;
}

function binding(value: unknown): value is CheckBinding {
  return exact(value, BINDING_KEYS) && BINDING_KEYS.every((key) => opaque(value[key]));
}

export function validCheckSnapshot(value: unknown): value is CurrentCheckSnapshot {
  if (!exact(value, ["authorized", "claimId", "binding", "candidateCommit", "baseCommit", "evidenceRevision", "buildReview", "profile", "memberIds", "requiredHostChecks"])) return false;
  if (typeof value.authorized !== "boolean" || !opaque(value.claimId) || !binding(value.binding)
    || !gitObjectId(value.candidateCommit) || !gitObjectId(value.baseCommit) || !opaque(value.evidenceRevision)
    || !strings(value.memberIds, opaque) || value.memberIds.length === 0 || !strings(value.requiredHostChecks)) return false;
  const review = value.buildReview;
  if (review !== null && (!exact(review, ["id", "result", "candidateCommit", "binding"]) || !opaque(review.id)
    || (review.result !== "passed" && review.result !== "failed") || !gitObjectId(review.candidateCommit) || !binding(review.binding))) return false;
  const profile = value.profile;
  if (!exact(profile, ["id", "revision", "mode", "sourceId", "checks"]) || !opaque(profile.id) || !opaque(profile.revision)
    || (profile.mode !== "scripted" && profile.mode !== "none") || !label(profile.sourceId) || !Array.isArray(profile.checks)) return false;
  const ids = new Set<string>();
  for (const check of profile.checks) {
    if (!exact(check, ["id", "argv", "memberIds", "dependsOn"]) || !label(check.id) || ids.has(check.id)
      || !Array.isArray(check.argv) || check.argv.length === 0 || typeof check.argv[0] !== "string" || check.argv[0].length === 0
      || !check.argv.every((arg) => text(arg))
      || !strings(check.memberIds, opaque) || check.memberIds.length === 0 || !strings(check.dependsOn)) return false;
    ids.add(check.id);
  }
  return true;
}

export function validCheckTerminal(value: unknown): value is CheckTerminal {
  return exact(value, ["attemptId", "checkId", "sourceId", "candidateCommit", "code", "signal", "error", "writerCustody"])
    && opaque(value.attemptId) && label(value.checkId) && label(value.sourceId) && gitObjectId(value.candidateCommit)
    && (value.code === null || (typeof value.code === "number" && Number.isSafeInteger(value.code)))
    && (value.signal === null || (typeof value.signal === "string" && /^SIG[A-Z0-9]{1,16}$/.test(value.signal)))
    && (value.error === null || value.error === "spawn") && (value.writerCustody === "contained" || value.writerCustody === "unknown");
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validCheckAttemptRecord(value: unknown): value is CheckAttemptRecord {
  if (!exact(value, ["version", "jobId", "attemptId", "snapshot", "qualification", "publishable", "state", "publicResult", "checks", "outstandingHostChecks", "startedAt", "completedAt"])) return false;
  if (value.version !== 1 || !opaque(value.jobId) || !opaque(value.attemptId) || !validCheckSnapshot(value.snapshot)
    || value.qualification !== "unqualified-harness" || value.publishable !== false
    || !STATES.includes(value.state as CheckState) || value.publicResult !== publicCheckResult(value.state as CheckState)
    || !Array.isArray(value.checks) || !strings(value.outstandingHostChecks) || !timestamp(value.startedAt)
    || (value.completedAt !== null && (!timestamp(value.completedAt) || value.completedAt < value.startedAt))
    || ((value.state === "running") !== (value.completedAt === null))) return false;
  const snapshot = value.snapshot;
  const details = value.checks;
  const outstandingHostChecks = value.outstandingHostChecks;
  const review = snapshot.buildReview;
  if (!snapshot.authorized || review === null || review.result !== "passed" || review.candidateCommit !== snapshot.candidateCommit
    || !BINDING_KEYS.every((key) => review.binding[key as keyof CheckBinding] === snapshot.binding[key as keyof CheckBinding])) return false;
  const seen = new Set<string>();
  for (const check of details) {
    if (!exact(check, ["id", "state", "publicResult", "sourceId", "coveredMemberIds", "stdout", "stderr", "terminal"])
      || !label(check.id) || seen.has(check.id) || !STATES.includes(check.state as CheckState)
      || check.publicResult !== publicCheckResult(check.state as CheckState) || !label(check.sourceId)
      || !strings(check.coveredMemberIds, opaque) || !text(check.stdout, 1048576) || !text(check.stderr, 1048576)
      || (check.terminal !== null && !validCheckTerminal(check.terminal))) return false;
    const selected = snapshot.profile.checks.find((entry) => entry.id === check.id);
    if (!selected || check.sourceId !== snapshot.profile.sourceId
      || !check.coveredMemberIds.every((member) => selected.memberIds.includes(member))) return false;
    const terminal = check.terminal;
    if (terminal !== null && (terminal.attemptId !== value.attemptId || terminal.checkId !== check.id
      || terminal.sourceId !== check.sourceId || terminal.candidateCommit !== snapshot.candidateCommit)) return false;
    const coveredMembers = check.coveredMemberIds;
    if (check.state === "passed" && (terminal === null || terminal.code !== 0 || terminal.signal !== null || terminal.error !== null
      || terminal.writerCustody !== "contained" || !selected.memberIds.every((member) => coveredMembers.includes(member)))) return false;
    if (check.state === "failed" && (terminal === null || terminal.code === null || terminal.code === 0
      || terminal.signal !== null || terminal.error !== null || terminal.writerCustody !== "contained")) return false;
    seen.add(check.id);
  }
  if (seen.size !== snapshot.profile.checks.length
    || !snapshot.requiredHostChecks.every((id) => outstandingHostChecks.includes(id))
    || outstandingHostChecks.length !== snapshot.requiredHostChecks.length) return false;
  if (value.state === "passed" && (snapshot.profile.mode !== "scripted" || details.length === 0
    || !details.every((check) => check.state === "passed"))) return false;
  if (value.state === "failed" && !details.some((check) => check.state === "failed")) return false;
  if (value.state === "not_required" && (snapshot.profile.mode !== "none" || details.length !== 0)) return false;
  return true;
}

// The exact schema prevents a caller from accidentally persisting its environment or transport handles.
export function copyCheckAttemptRecord(value: CheckAttemptRecord): CheckAttemptRecord {
  if (!validCheckAttemptRecord(value)) throw new Error("The check attempt record is not valid.");
  return structuredClone(value);
}
