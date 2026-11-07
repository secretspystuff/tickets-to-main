import { mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, sep } from "node:path";
import { canonical, evidenceBinds, selectedGateSatisfied } from "../../src/lib/ttm-protocol.ts";
import type { CommandRunner } from "./command.ts";
import { assertPrivateDirectory } from "./fs-safety.ts";
import { loadLedger, updateLedger } from "./ledger.ts";
import {
  copyCheckAttemptRecord, gitObjectId, publicCheckResult, redactCheckText, validCheckSnapshot, validCheckTerminal,
  type CheckAttemptRecord, type CheckDetail, type CheckState, type CurrentCheckSnapshot, type CheckTerminal,
} from "./check-attempt-record.ts";

export type { CheckAttemptRecord, CheckBinding, CheckDetail, CheckState, CheckTerminal, CurrentCheckSnapshot, PublicCheckResult, SelectedCheck } from "./check-attempt-record.ts";
export type CheckAttemptRequest = { jobId: string; attemptId: string; snapshot: CurrentCheckSnapshot };
export type CheckExecuteInput = { attemptId: string; checkId: string; argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; candidateCommit: string };
export type CheckObservation = { stdout: string; stderr: string; terminal: CheckTerminal | null; coveredMemberIds: string[] };
export type HarnessCheckExecutor = { kind: "fabricated-harness"; execute(input: CheckExecuteInput): Promise<CheckObservation> };
export type CheckAttemptInput = {
  stateDir: string;
  workspace: string;
  request: CheckAttemptRequest;
  env?: NodeJS.ProcessEnv;
  gitRunner: CommandRunner;
  now(): number;
  secrets: readonly string[];
  readCurrent(): Promise<CurrentCheckSnapshot>;
  executor: HarnessCheckExecutor;
};
export type CheckAttemptResult = Pick<CheckAttemptRecord, "state" | "publicResult" | "qualification" | "publishable" | "checks" | "outstandingHostChecks">;

function outcome(state: CheckState): CheckAttemptResult {
  return { state, publicResult: publicCheckResult(state), qualification: "unqualified-harness", publishable: false, checks: [], outstandingHostChecks: [] };
}

function equal(left: unknown, right: unknown): boolean {
  const value = canonical(left);
  return value !== null && value === canonical(right);
}

function safeInput(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === "string") return redactCheckText(value, secrets) === value;
  if (Array.isArray(value)) return value.every((entry) => safeInput(entry, secrets));
  if (value !== null && typeof value === "object") return Object.entries(value).every(([key, entry]) => safeInput(key, secrets) && safeInput(entry, secrets));
  return value === null || typeof value === "number" || typeof value === "boolean";
}

function validBuild(snapshot: CurrentCheckSnapshot): boolean {
  const review = snapshot.buildReview;
  return review !== null && review.result === "passed" && review.candidateCommit === snapshot.candidateCommit
    && evidenceBinds(review.binding, snapshot.binding).ok;
}

function validSelection(snapshot: CurrentCheckSnapshot): boolean {
  const checks = snapshot.profile.checks;
  if (snapshot.profile.mode === "none") return checks.length === 0;
  if (checks.length === 0) return false;
  const members = new Set(snapshot.memberIds);
  const byId = new Map(checks.map((check) => [check.id, check]));
  const visiting = new Set<string>();
  const complete = new Set<string>();
  const visit = (id: string): boolean => {
    if (complete.has(id)) return true;
    const check = byId.get(id);
    if (!check || visiting.has(id)) return false;
    visiting.add(id);
    if (!check.dependsOn.every(visit)) return false;
    visiting.delete(id);
    complete.add(id);
    return true;
  };
  return checks.every((check) => check.memberIds.every((member) => members.has(member)) && visit(check.id))
    && snapshot.memberIds.every((member) => checks.some((check) => check.memberIds.includes(member)));
}

function orderedChecks(snapshot: CurrentCheckSnapshot) {
  const ordered: typeof snapshot.profile.checks = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    const check = snapshot.profile.checks.find((entry) => entry.id === id)!;
    visited.add(id);
    for (const dependency of check.dependsOn) visit(dependency);
    ordered.push(check);
  };
  for (const check of snapshot.profile.checks) visit(check.id);
  return ordered;
}

async function currentBoundary(input: CheckAttemptInput, captured: CurrentCheckSnapshot): Promise<CheckState | null> {
  try {
    const current = structuredClone(await input.readCurrent());
    if (!validCheckSnapshot(current) || !safeInput(current, input.secrets)) return "unavailable";
    if (!current.authorized) return "held";
    if (!evidenceBinds(current.binding, captured.binding).ok || !equal(current, captured)) return "stale";
    if (!validBuild(current) || !validSelection(current)) return "held";
    return null;
  } catch {
    return "unavailable";
  }
}

async function gitRead(input: CheckAttemptInput, workspace: string, args: string[]) {
  return input.gitRunner.run(["git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd: workspace, timeoutMs: 30000,
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

async function workspaceEffectLock(input: CheckAttemptInput, workspace: string): Promise<string | null> {
  try {
    const top = await gitRead(input, workspace, ["rev-parse", "--show-toplevel"]);
    if (top.error || top.code !== 0 || realpathSync(top.stdout.trim()) !== workspace) return null;
    const directory = await gitRead(input, workspace, ["rev-parse", "--absolute-git-dir"]);
    if (directory.error || directory.code !== 0 || !isAbsolute(directory.stdout.trim())) return null;
    const identity = createHash("sha256").update(workspace).digest("hex");
    return join(realpathSync(directory.stdout.trim()), `tickets-to-main-check-${identity}.lock`);
  } catch {
    return null;
  }
}

async function candidateUnchanged(input: CheckAttemptInput, workspace: string, snapshot: CurrentCheckSnapshot): Promise<boolean> {
  const run = (args: string[]) => gitRead(input, workspace, args);
  try {
    const top = await run(["rev-parse", "--show-toplevel"]);
    if (top.error || top.code !== 0 || realpathSync(top.stdout.trim()) !== workspace) return false;
    const head = await run(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (head.error || head.code !== 0 || head.stdout.trim() !== snapshot.candidateCommit) return false;
    const base = await run(["rev-parse", "--verify", snapshot.baseCommit + "^{commit}"]);
    if (base.error || base.code !== 0 || base.stdout.trim() !== snapshot.baseCommit) return false;
    const status = await run(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
    return !status.error && status.code === 0 && status.stdout.length === 0;
  } catch {
    return false;
  }
}

function checkEnvironment(parent: NodeJS.ProcessEnv, secrets: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    const value = parent[name];
    if (value !== undefined && redactCheckText(value, secrets) === value && !value.includes("\0")) environment[name] = value;
  }
  return environment;
}

function initialRecord(request: CheckAttemptRequest, startedAt: number): CheckAttemptRecord {
  return {
    version: 1, jobId: request.jobId, attemptId: request.attemptId, snapshot: structuredClone(request.snapshot),
    qualification: "unqualified-harness", publishable: false, state: "running", publicResult: "running",
    checks: request.snapshot.profile.checks.map((check) => ({
      id: check.id, state: "unrun", publicResult: "unavailable", sourceId: request.snapshot.profile.sourceId,
      coveredMemberIds: [], stdout: "", stderr: "", terminal: null,
    })),
    outstandingHostChecks: [...request.snapshot.requiredHostChecks], startedAt, completedAt: null,
  };
}

function flushRecord(input: CheckAttemptInput, record: CheckAttemptRecord): void {
  const saved = copyCheckAttemptRecord(record);
  updateLedger(input.stateDir, input.secrets, (ledger) => {
    if (!ledger.install) throw new Error("The private record is unavailable.");
    const attempts = ledger.checkAttempts ?? [];
    const index = attempts.findIndex((attempt) => attempt.attemptId === record.attemptId);
    if (index === -1) attempts.push(saved);
    else attempts[index] = saved;
    ledger.checkAttempts = attempts;
  });
}

function finish(record: CheckAttemptRecord, state: CheckState, now: number): CheckAttemptRecord {
  return { ...record, state, publicResult: publicCheckResult(state), completedAt: Math.max(now, record.startedAt) };
}

function observedCheck(input: CheckAttemptInput, request: CheckAttemptRequest, check: CheckDetail, observation: unknown): CheckDetail {
  const selected = request.snapshot.profile.checks.find((entry) => entry.id === check.id)!;
  const value = observation !== null && typeof observation === "object" ? observation as Record<string, unknown> : {};
  const redact = (text: unknown) => typeof text === "string" ? redactCheckText(text, input.secrets).slice(0, 1048576) : "";
  const detail: CheckDetail = { ...check, stdout: redact(value.stdout), stderr: redact(value.stderr), state: "unavailable", publicResult: "unavailable" };
  let state: CheckState = "unavailable";
  if (value.terminal === null) state = "interrupted";
  else if (validCheckTerminal(value.terminal)) {
    const terminal = value.terminal;
    if (terminal.attemptId === request.attemptId && terminal.checkId === selected.id
      && terminal.sourceId === request.snapshot.profile.sourceId && terminal.candidateCommit === request.snapshot.candidateCommit) {
      detail.terminal = structuredClone(terminal);
      const coverage = value.coveredMemberIds;
      const covered = Array.isArray(coverage) && coverage.every((member): member is string => typeof member === "string" && selected.memberIds.includes(member))
        && new Set(coverage).size === coverage.length;
      detail.coveredMemberIds = covered ? [...coverage] : [];
      if (terminal.writerCustody !== "contained") state = "held";
      else if (terminal.error) state = "unavailable";
      else if (terminal.signal !== null || terminal.code === null) state = "interrupted";
      else if (terminal.code !== 0) state = "failed";
      else if (!covered || !selected.memberIds.every((member) => detail.coveredMemberIds.includes(member))) state = "held";
      else state = "passed";
    }
  }
  return { ...detail, state, publicResult: publicCheckResult(state) };
}

function combinedState(checks: CheckDetail[]): CheckState {
  if (checks.some((check) => check.state === "failed")) return "failed";
  for (const state of ["stale", "held", "unavailable", "interrupted", "unrun"] as const) if (checks.some((check) => check.state === state)) return state === "unrun" ? "held" : state;
  return checks.length > 0 && checks.every((check) => selectedGateSatisfied(check.publicResult)) ? "passed" : "held";
}

export async function runCheckAttempt(input: CheckAttemptInput): Promise<CheckAttemptResult> {
  let request: CheckAttemptRequest;
  let startedAt: number;
  let workspace: string;
  try {
    request = structuredClone({ jobId: input.request.jobId, attemptId: input.request.attemptId, snapshot: input.request.snapshot });
    if (!/^[a-f0-9]{32}$/.test(request.jobId) || !/^[a-f0-9]{32}$/.test(request.attemptId)
      || !validCheckSnapshot(request.snapshot) || !safeInput(request, input.secrets)) return outcome("held");
    if (input.executor.kind !== "fabricated-harness" || !gitObjectId(request.snapshot.candidateCommit) || !gitObjectId(request.snapshot.baseCommit)) return outcome("unavailable");
    startedAt = input.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !isAbsolute(input.workspace) || !isAbsolute(input.stateDir)) return outcome("unavailable");
    workspace = realpathSync(input.workspace);
    assertPrivateDirectory(input.stateDir);
    const state = realpathSync(input.stateDir);
    if (workspace === state || workspace.startsWith(state + sep) || state.startsWith(workspace + sep)) return outcome("held");
  } catch {
    return outcome("unavailable");
  }
  const lock = await workspaceEffectLock(input, workspace);
  if (lock === null) return outcome("unavailable");
  try { mkdirSync(lock, { mode: 0o700 }); } catch { return outcome("held"); }
  let record: CheckAttemptRecord | null = null;
  let containment: "not-started" | "unknown" | "observed-contained" = "not-started";
  try {
    const loaded = loadLedger(input.stateDir);
    if (!loaded.ok || !loaded.ledger.install) return outcome("unavailable");
    const previous = loaded.ledger.checkAttempts?.find((attempt) => attempt.attemptId === request.attemptId);
    if (previous && (previous.jobId !== request.jobId || !equal(previous.snapshot, request.snapshot))) return outcome("held");
    const admitted = await currentBoundary(input, request.snapshot);
    if (admitted) return outcome(admitted);
    if (!await candidateUnchanged(input, workspace, request.snapshot)) return outcome("stale");
    if (previous) {
      const replayBoundary = await currentBoundary(input, request.snapshot);
      if (replayBoundary) return outcome(replayBoundary);
      return previous.state === "running" ? outcome("held") : copyCheckAttemptRecord(previous);
    }
    record = initialRecord(request, startedAt);
    flushRecord(input, record);
    if (request.snapshot.profile.mode === "none") {
      const boundary = await currentBoundary(input, request.snapshot);
      const unchanged = await candidateUnchanged(input, workspace, request.snapshot);
      record = finish(record, boundary ?? (unchanged ? "not_required" : "stale"), input.now());
      flushRecord(input, record);
      return copyCheckAttemptRecord(record);
    }
    for (const selected of orderedChecks(request.snapshot)) {
      const index = record.checks.findIndex((check) => check.id === selected.id);
      const check = record.checks[index]!;
      if (selected.dependsOn.some((dependency) => record!.checks.find((entry) => entry.id === dependency)?.state !== "passed")) continue;
      const before = await currentBoundary(input, request.snapshot);
      if (before || !await candidateUnchanged(input, workspace, request.snapshot)) {
        record = finish(record, before ?? "stale", input.now());
        flushRecord(input, record);
        return copyCheckAttemptRecord(record);
      }
      record.checks[index] = { ...check, state: "running", publicResult: "running" };
      flushRecord(input, record);
      let observed: CheckDetail;
      containment = "unknown";
      try {
        observed = observedCheck(input, request, check, await input.executor.execute({
          attemptId: request.attemptId, checkId: selected.id, argv: [...selected.argv], cwd: workspace,
          env: checkEnvironment(input.env ?? {}, input.secrets), candidateCommit: request.snapshot.candidateCommit,
        }));
      } catch {
        observed = { ...check, state: "unavailable", publicResult: "unavailable" };
      }
      if (observed.terminal?.writerCustody === "contained") containment = "observed-contained";
      const after = await currentBoundary(input, request.snapshot);
      const unchanged = await candidateUnchanged(input, workspace, request.snapshot);
      record.checks[index] = observed;
      if (after || !unchanged) {
        const state = after ?? "stale";
        record.checks[index] = { ...observed, state, publicResult: publicCheckResult(state) };
        record = finish(record, state, input.now());
        flushRecord(input, record);
        return copyCheckAttemptRecord(record);
      }
      if (["held", "unavailable", "interrupted"].includes(observed.state)) {
        record = finish(record, observed.state, input.now());
        flushRecord(input, record);
        return copyCheckAttemptRecord(record);
      }
      flushRecord(input, record);
    }
    record = finish(record, combinedState(record.checks), input.now());
    flushRecord(input, record);
    return copyCheckAttemptRecord(record);
  } catch {
    return outcome("unavailable");
  } finally {
    // Returning a result cannot establish that an unobserved writer or helper has stopped.
    if (containment !== "unknown") {
      try { rmdirSync(lock); } catch { /* Failed cleanup must not make uncertain ownership look free. */ }
    }
  }
}
