import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, linkSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runArtifactPreparation } from "../src/artifact-preparation.ts";
import { runCheckAttempt, type CheckAttemptRecord } from "../src/check-attempt.ts";
import { processRunner } from "../src/command.ts";
import { assignmentDirectory } from "../src/directory-identity.ts";
import { assertPrivateDirectory } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { updateLedger } from "../src/ledger.ts";
import { prepareWorkspace } from "../src/workspace.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { failedCheckAttemptFixture } from "./release-test-fixtures.ts";

const unsafe = "synthetic-held-artifact-value";
const journalName = "artifact-preparation.jsonl";
type Input = Parameters<typeof runArtifactPreparation>[0];
type Request = Input["request"];
type Current = ReturnType<Input["context"]["readCurrent"]>;

function batch(content = "fabricated artifact", secretValues: string[] | null = [unsafe]) {
  const bytes = Buffer.from(content);
  const name = "fabricated-candidate.txt";
  return {
    expected: [{ name, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }],
    artifacts: [{ name, bytes }], secrets: secretValues,
  };
}

function git(workspace: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: workspace, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(result.status, 0, `Fabricated repository setup failed at ${args[0]}.`);
  return result.stdout.trim();
}

function fixture(t: TestContext, repository = false) {
  const stateDir = tempDir();
  const workspace = realpathSync(tempDir());
  t.after(() => { removeDir(stateDir); removeDir(workspace); });
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: "2026-11-18T08:00:00.000Z" });
  prepareWorkspace(stateDir, workspace, () => false);
  const first = failedCheckAttemptFixture();
  if (repository) {
    git(workspace, "init", "--quiet", "--initial-branch=fabricated-work");
    git(workspace, "config", "--local", "user.name", "Fabricated Fixture");
    git(workspace, "config", "--local", "user.email", "fixture@fixture.invalid");
    writeFileSync(join(workspace, "behavior.txt"), "fabricated base\n");
    git(workspace, "add", "behavior.txt");
    git(workspace, "commit", "--quiet", "-m", "Fabricated base");
    first.snapshot.baseCommit = git(workspace, "rev-parse", "HEAD");
    writeFileSync(join(workspace, "behavior.txt"), "fabricated candidate\n");
    git(workspace, "add", "behavior.txt");
    git(workspace, "commit", "--quiet", "-m", "Fabricated candidate");
    first.snapshot.candidateCommit = git(workspace, "rev-parse", "HEAD");
    first.snapshot.buildReview!.candidateCommit = first.snapshot.candidateCommit;
  } else {
    writeFileSync(join(workspace, "behavior.txt"), "fabricated retained work\n");
  }
  let now = 100;
  function store(row: CheckAttemptRecord): void {
    updateLedger(stateDir, [], ledger => {
      const rows = ledger.checkAttempts ?? [];
      ledger.checkAttempts = [...rows.filter(item => item.attemptId !== row.attemptId), row];
    });
  }
  function receipt(id: string, startedAt: number, completedAt = startedAt + 1, jobId = first.jobId): CheckAttemptRecord {
    const row = structuredClone(first);
    row.attemptId = id.repeat(32);
    row.jobId = jobId;
    row.startedAt = startedAt;
    row.completedAt = completedAt;
    row.state = "passed";
    row.publicResult = "passed";
    row.checks[0]!.state = "passed";
    row.checks[0]!.publicResult = "passed";
    row.checks[0]!.terminal!.attemptId = row.attemptId;
    row.checks[0]!.terminal!.candidateCommit = row.snapshot.candidateCommit;
    row.checks[0]!.terminal!.code = 0;
    store(row);
    return row;
  }
  function request(row: CheckAttemptRecord, stopSequence?: number): Request {
    const identity = { jobId: row.jobId, checkAttemptId: row.attemptId };
    return stopSequence === undefined ? { ...identity, action: "prepare" } : { ...identity, action: "after-fix", stopSequence };
  }
  function current(row: CheckAttemptRecord, afterFixStopSequence: number | null = null): Current {
    return { jobId: row.jobId, checkAttemptId: row.attemptId, workspace, snapshot: structuredClone(row.snapshot), afterFixStopSequence };
  }
  function run(row: CheckAttemptRecord, artifacts: unknown = batch(), stopSequence?: number, authority = current(row), kind = "fabricated-harness") {
    const ledgerPath = join(stateDir, "ledger.json");
    const workPath = join(workspace, "behavior.txt");
    const previousLedger = readFileSync(ledgerPath);
    const previousWork = readFileSync(workPath);
    const previousArtifacts = structuredClone(artifacts);
    const result = runArtifactPreparation({ stateDir, request: request(row, stopSequence), artifacts,
      context: { kind, now: () => now, readCurrent: () => authority } } as Input);
    assertResult(result);
    assert.deepEqual(readFileSync(ledgerPath), previousLedger);
    assert.deepEqual(readFileSync(workPath), previousWork);
    assert.deepEqual(structuredClone(artifacts), previousArtifacts);
    return result;
  }
  const journal = join(stateDir, journalName);
  return { stateDir, workspace, first, receipt, store, request, current, run, journal, setNow: (value: number) => { now = value; } };
}

function assertResult(result: ReturnType<typeof runArtifactPreparation>): void {
  assert.deepEqual(Reflect.ownKeys(result).sort(), ["publishable", "qualification", "reason", "state", "stopSequence"]);
  assert.equal(result.publishable, false);
  assert.equal(result.qualification, "unqualified-harness");
  assert.ok(["prepared", "stopped", "held", "resumed", "unavailable"].includes(result.state));
  assert.ok([null, "secret-detected", "incomplete-scan", "scan-interrupted", "authorization-required", "local-state-unavailable"].includes(result.reason));
  assert.ok(result.stopSequence === null || Number.isSafeInteger(result.stopSequence) && result.stopSequence > 0);
  assert.equal(JSON.stringify(result).includes(unsafe), false);
}

function mismatchedAuthorities(current: Current, otherWorkspace: string, otherPassingAttemptId: string): Current[] {
  const changedSnapshot = (change: (snapshot: Current["snapshot"]) => void) => {
    const next = structuredClone(current);
    change(next.snapshot);
    return next;
  };
  return [
    { ...current, workspace: otherWorkspace },
    { ...current, jobId: "a".repeat(32) },
    { ...current, checkAttemptId: otherPassingAttemptId },
    changedSnapshot(snapshot => { snapshot.authorized = false; }),
    changedSnapshot(snapshot => { snapshot.evidenceRevision = "f".repeat(32); }),
    changedSnapshot(snapshot => { snapshot.candidateCommit = "c".repeat(40); snapshot.buildReview!.candidateCommit = snapshot.candidateCommit; }),
    changedSnapshot(snapshot => { snapshot.baseCommit = "e".repeat(40); }),
    changedSnapshot(snapshot => { snapshot.claimId = "c".repeat(32); }),
    changedSnapshot(snapshot => { snapshot.binding.policy_id = "d".repeat(32); snapshot.buildReview!.binding.policy_id = snapshot.binding.policy_id; }),
  ];
}

function events(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trimEnd().split("\n").map(line => {
    const row = JSON.parse(line) as Record<string, unknown>;
    assert.ok(["artifact.intent", "artifact.checked", "runner.stopped", "runner.resumed"].includes(String(row.kind)));
    const fixed = ["kind", "sequence", "at"];
    if (row.kind === "artifact.intent") {
      fixed.push("jobDigest", "workspaceDigest");
      assert.match(String(row.jobDigest), /^[a-f0-9]{64}$/);
      assert.match(String(row.workspaceDigest), /^[a-f0-9]{64}$/);
    }
    if (row.kind === "runner.stopped") {
      fixed.push("reason");
      assert.ok(["secret-detected", "incomplete-scan", "scan-interrupted"].includes(String(row.reason)));
    }
    assert.deepEqual(Reflect.ownKeys(row).sort(), fixed.sort());
    assert.ok(typeof row.sequence === "number" && Number.isSafeInteger(row.sequence) && row.sequence > 0);
    assert.ok(typeof row.at === "number" && Number.isSafeInteger(row.at) && row.at >= 0);
    return row;
  });
}

function child(stateDir: string, request: Request, current: Current, crash: boolean, now = 100) {
  const url = new URL("../src/artifact-preparation.ts", import.meta.url).href;
  const script = `
import { createHash } from "node:crypto";
import { runArtifactPreparation } from ${JSON.stringify(url)};
const [stateDir, request, current, mode, now] = process.argv.slice(1);
const bytes = Buffer.from("fabricated restart artifact");
const name = "fabricated-restart.txt";
const clean = { expected: [{ name, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }],
  artifacts: [{ name, bytes }], secrets: [] };
const input = mode === "crash" ? new Proxy({}, { ownKeys() { process.exit(37); } }) : clean;
const result = runArtifactPreparation({ stateDir, request: JSON.parse(request), artifacts: input,
  context: { kind: "fabricated-harness", now: () => Number(now), readCurrent: () => JSON.parse(current) } });
process.stdout.write(JSON.stringify(result));`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script, stateDir, JSON.stringify(request), JSON.stringify(current), crash ? "crash" : "read", String(now)], { encoding: "utf8" });
}

test("a detected artifact secret persists across a new process and blocks a queued passing receipt", async t => {
  const f = fixture(t, true);
  const snapshot = f.first.snapshot;
  const checked = await runCheckAttempt({ stateDir: f.stateDir, workspace: f.workspace,
    request: { jobId: f.first.jobId, attemptId: f.first.attemptId, snapshot }, secrets: [], env: {},
    gitRunner: processRunner(), now: () => 90, readCurrent: async () => structuredClone(snapshot),
    executor: { kind: "fabricated-harness", execute: async input => ({ stdout: "", stderr: "", coveredMemberIds: [...snapshot.memberIds],
      terminal: { attemptId: input.attemptId, checkId: input.checkId, sourceId: snapshot.profile.sourceId,
        candidateCommit: snapshot.candidateCommit, code: 0, signal: null, error: null, writerCustody: "contained" } }) },
  });
  assert.equal(checked.state, "passed");
  assert.equal(checked.publishable, false);
  const originalLedger = readFileSync(join(f.stateDir, "ledger.json"));
  assert.equal(f.run(f.first).state, "prepared");
  const proposed = batch(unsafe);
  const proposedBefore = structuredClone(proposed);
  const stopped = f.run(f.first, proposed);
  assert.deepEqual(structuredClone(proposed), proposedBefore);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.reason, "secret-detected");
  assert.equal(typeof stopped.stopSequence, "number");
  const raw = readFileSync(f.journal);
  const restored = child(f.stateDir, f.request(f.first), f.current(f.first), false);
  assert.equal(restored.status, 0);
  assert.deepEqual(JSON.parse(restored.stdout), stopped);
  assert.deepEqual(readFileSync(f.journal), raw);
  assert.deepEqual(readFileSync(join(f.stateDir, "ledger.json")), originalLedger);
  assert.equal(git(f.workspace, "status", "--porcelain"), "");
  assert.equal(git(f.workspace, "remote"), "");
  assert.equal(raw.includes(unsafe), false);
  assert.equal(raw.includes("fabricated-candidate.txt"), false);
  assert.equal(raw.includes(f.workspace), false);
  assert.equal(raw.includes(JSON.stringify(f.workspace).slice(1, -1)), false);
  assert.equal(raw.includes(f.first.attemptId), false);
  assert.deepEqual(events(f.journal).map(row => row.kind), ["artifact.intent", "artifact.checked", "artifact.intent", "runner.stopped"]);
});

test("an incomplete scan also stops and no normal retry can clear it", t => {
  const f = fixture(t);
  const queued = f.receipt("a", 90);
  const stopped = f.run(queued, batch("readable but unverifiable", null));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.reason, "incomplete-scan");
  const before = readFileSync(f.journal);
  const restored = child(f.stateDir, f.request(queued), f.current(queued), false);
  assert.equal(restored.status, 0);
  assert.deepEqual(JSON.parse(restored.stdout), stopped);
  const later = f.receipt("b", 105);
  const anotherJob = f.receipt("d", 106, 107, "c".repeat(32));
  f.setNow(110);
  assert.deepEqual(f.run(later), stopped);
  assert.deepEqual(f.run(anotherJob), stopped);
  assert.deepEqual(readFileSync(f.journal), before);
});

test("only fresh same-job and same-workspace after-fix authority resumes an exact stop", t => {
  const f = fixture(t);
  const queued = f.receipt("a", 90);
  const stopped = f.run(queued, batch(unsafe));
  assert.equal(stopped.state, "stopped");
  assert.ok(stopped.stopSequence !== null);
  const stop = stopped.stopSequence;
  const before = readFileSync(f.journal);
  const active = f.receipt("b", 105);
  const other = f.receipt("c", 106, 107, "d".repeat(32));
  const startedBeforeStop = f.receipt("e", 99, 108);
  const future = f.receipt("0", 106, 200);
  const queuedWhileStopped = f.receipt("1", 110);
  const failed = failedCheckAttemptFixture();
  failed.attemptId = "2".repeat(32);
  failed.checks[0]!.terminal!.attemptId = failed.attemptId;
  failed.startedAt = 107;
  failed.completedAt = 108;
  f.store(failed);
  const host = f.receipt("3", 107);
  host.snapshot.requiredHostChecks = ["fabricated-outstanding-host-check"];
  host.outstandingHostChecks = [...host.snapshot.requiredHostChecks];
  f.store(host);
  const noChecks = f.receipt("4", 109);
  noChecks.snapshot.profile.mode = "none";
  noChecks.snapshot.profile.checks = [];
  noChecks.checks = [];
  noChecks.state = "not_required";
  noChecks.publicResult = "not_required";
  f.store(noChecks);
  const unapprovedNoChecks = f.current(noChecks, stop);
  unapprovedNoChecks.snapshot.authorized = false;
  f.setNow(120);
  assert.deepEqual(f.run(active, batch(), stop), stopped);
  assert.deepEqual(f.run(active, batch(), stop + 1, f.current(active, stop + 1)), stopped);
  assert.deepEqual(f.run(active, batch(), stop, f.current(active, stop + 1)), stopped);
  assert.deepEqual(f.run(active, batch(), stop + 1, f.current(active, stop)), stopped);
  assert.deepEqual(f.run(queued, batch(), stop, f.current(queued, stop)), stopped);
  assert.deepEqual(f.run(startedBeforeStop, batch(), stop, f.current(startedBeforeStop, stop)), stopped);
  assert.deepEqual(f.run(future, batch(), stop, f.current(future, stop)), stopped);
  assert.deepEqual(f.run(other, batch(), stop, f.current(other, stop)), stopped);
  const receiptForWrongJob = { ...other, jobId: queued.jobId };
  assert.deepEqual(f.run(receiptForWrongJob, batch(), stop, f.current(receiptForWrongJob, stop)), stopped);
  assert.deepEqual(f.run(failed, batch(), stop, f.current(failed, stop)), stopped);
  assert.deepEqual(f.run(failed, batch(), stop, f.current(active, stop)), stopped);
  assert.deepEqual(f.run(host, batch(), stop, f.current(host, stop)), stopped);
  const missing = { ...active, attemptId: "5".repeat(32) };
  assert.deepEqual(f.run(missing, batch(), stop, f.current(missing, stop)), stopped);
  assert.deepEqual(f.run(noChecks, batch(), stop, unapprovedNoChecks), stopped);
  assert.equal(f.run(active, batch(), stop, f.current(active, stop), "live").state, "unavailable");
  const anotherWorkspace = realpathSync(tempDir());
  t.after(() => removeDir(anotherWorkspace));
  for (const authority of mismatchedAuthorities(f.current(active, stop), anotherWorkspace, queuedWhileStopped.attemptId)) {
    assert.deepEqual(f.run(active, batch(), stop, authority), stopped);
  }
  assert.deepEqual(f.run(active, batch(unsafe), stop, f.current(active, stop)), stopped);
  assert.deepEqual(f.run(active, batch("fabricated", null), stop, f.current(active, stop)), stopped);
  let observations = 0;
  const lost = runArtifactPreparation({ stateDir: f.stateDir, request: f.request(active, stop), artifacts: batch(),
    context: { kind: "fabricated-harness", now: () => 120, readCurrent: () => f.current(active, ++observations === 1 ? stop : null) } });
  assert.deepEqual(lost, stopped);
  assert.ok(observations >= 2);
  let bytesObserved = false;
  const revokingScan = batch();
  revokingScan.artifacts[0] = new Proxy(revokingScan.artifacts[0]!, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "bytes") bytesObserved = true;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const revokedDuringScan = runArtifactPreparation({ stateDir: f.stateDir, request: f.request(active, stop), artifacts: revokingScan,
    context: { kind: "fabricated-harness", now: () => 120, readCurrent: () => f.current(active, bytesObserved ? null : stop) } });
  assert.equal(bytesObserved, true);
  assert.deepEqual(revokedDuringScan, stopped);
  assert.deepEqual(readFileSync(f.journal), before);

  let competing: ReturnType<typeof runArtifactPreparation> | undefined;
  const priorLedger = readFileSync(join(f.stateDir, "ledger.json"));
  const priorWork = readFileSync(join(f.workspace, "behavior.txt"));
  const repaired = batch("fabricated clean resolution");
  const priorRepair = structuredClone(repaired);
  const resumed = runArtifactPreparation({ stateDir: f.stateDir, request: f.request(queuedWhileStopped, stop), artifacts: repaired,
    context: { kind: "fabricated-harness", now: () => 120, readCurrent() {
      competing ??= f.run(queuedWhileStopped, batch(), stop, f.current(queuedWhileStopped, stop));
      return f.current(queuedWhileStopped, stop);
    } } });
  assertResult(resumed);
  assert.equal(resumed.state, "resumed");
  assert.equal(competing?.state, "unavailable");
  assert.deepEqual(readFileSync(join(f.stateDir, "ledger.json")), priorLedger);
  assert.deepEqual(readFileSync(join(f.workspace, "behavior.txt")), priorWork);
  assert.deepEqual(structuredClone(repaired), priorRepair);
  assert.deepEqual(events(f.journal).map(row => row.kind), ["artifact.intent", "runner.stopped", "runner.resumed"]);
  const after = readFileSync(f.journal);
  assert.equal(after.subarray(0, before.length).equals(before), true);
  assert.equal(f.run(active, batch(), stop, f.current(active, stop)).state, "held");
  assert.equal(f.run(active).state, "held");
  assert.equal(f.run(queuedWhileStopped).state, "held");
  const staleAfterRestart = child(f.stateDir, f.request(queued), f.current(queued), false, 121);
  assert.equal(staleAfterRestart.status, 0);
  assert.equal(JSON.parse(staleAfterRestart.stdout).state, "held");
  assert.deepEqual(readFileSync(f.journal), after);
  const fresh = f.receipt("f", 121);
  f.setNow(130);
  const freshAfterRestart = child(f.stateDir, f.request(fresh), f.current(fresh), false, 130);
  assert.equal(freshAfterRestart.status, 0);
  const prepared = JSON.parse(freshAfterRestart.stdout);
  assertResult(prepared);
  assert.equal(prepared.state, "prepared");
  const nextStop = f.run(fresh, batch(unsafe));
  assert.equal(nextStop.state, "stopped");
  assert.notEqual(nextStop.stopSequence, stop);
  const freshNext = f.receipt("d", 131);
  f.setNow(140);
  assert.deepEqual(f.run(freshNext, batch(), stop, f.current(freshNext, stop)), nextStop);
});

test("a same-path replacement cannot resume the original checkout's stop", t => {
  const f = fixture(t, true);
  const original = assignmentDirectory(f.workspace);
  const moved = realpathSync(tempDir());
  t.after(() => removeDir(moved));
  const originalLocation = join(moved, "original");
  const replacementLocation = join(moved, "replacement");
  const emptyReplacement = realpathSync(tempDir());
  t.after(() => removeDir(emptyReplacement));
  const stopped = f.run(f.receipt("a", 90), batch(unsafe));
  assert.equal(stopped.state, "stopped");
  assert.ok(stopped.stopSequence !== null);
  const before = readFileSync(f.journal);
  const work = readFileSync(join(f.workspace, "behavior.txt"));
  function assertCheckout(path: string, identity: string) {
    assert.equal(assignmentDirectory(path).identity, identity);
    assert.equal(git(path, "rev-parse", "HEAD"), f.first.snapshot.candidateCommit);
    assert.equal(git(path, "status", "--porcelain"), "");
    assert.equal(git(path, "remote"), "");
    assert.deepEqual(readFileSync(join(path, "behavior.txt")), work);
  }
  assertCheckout(f.workspace, original.identity);

  renameSync(f.workspace, originalLocation);
  renameSync(emptyReplacement, f.workspace);
  cpSync(join(originalLocation, ".git"), join(f.workspace, ".git"), { recursive: true, errorOnExist: true, force: false });
  cpSync(join(originalLocation, "behavior.txt"), join(f.workspace, "behavior.txt"), { errorOnExist: true, force: false });
  const replacement = assignmentDirectory(f.workspace);
  assert.equal(replacement.path, original.path);
  assert.notEqual(replacement.identity, original.identity);
  assertPrivateDirectory(f.workspace);
  assertCheckout(f.workspace, replacement.identity);
  const fresh = f.receipt("b", 105);
  const authority = f.current(fresh, stopped.stopSequence);
  const recovery = f.request(fresh, stopped.stopSequence);
  const attempted = child(f.stateDir, recovery, authority, false, 120);
  assert.equal(attempted.status, 0);
  assert.deepEqual(JSON.parse(attempted.stdout), stopped);
  assert.deepEqual(readFileSync(f.journal), before);
  assertCheckout(originalLocation, original.identity);
  assertCheckout(f.workspace, replacement.identity);

  renameSync(f.workspace, replacementLocation);
  renameSync(originalLocation, f.workspace);
  assert.deepEqual(assignmentDirectory(f.workspace), original);
  const restored = child(f.stateDir, recovery, authority, false, 120);
  assert.equal(restored.status, 0);
  assert.equal(JSON.parse(restored.stdout).state, "resumed");
  assert.deepEqual(events(f.journal).map(row => row.kind), ["artifact.intent", "runner.stopped", "runner.resumed"]);
  assertCheckout(f.workspace, original.identity);
  assertCheckout(replacementLocation, replacement.identity);
});

test("a fresh process holds an interrupted scan before preparing anything else", t => {
  const f = fixture(t);
  const queued = f.receipt("a", 90);
  const died = child(f.stateDir, f.request(queued), f.current(queued), true);
  assert.equal(died.status, 37);
  assert.deepEqual(events(f.journal).map(row => row.kind), ["artifact.intent"]);
  const result = child(f.stateDir, f.request(queued), f.current(queued), false);
  assert.equal(result.status, 0);
  const stopped = JSON.parse(result.stdout);
  assertResult(stopped);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.reason, "scan-interrupted");
  assert.equal(typeof stopped.stopSequence, "number");
  assert.deepEqual(events(f.journal).map(row => row.kind), ["artifact.intent", "runner.stopped"]);
  assert.deepEqual(f.run(queued, batch(), stopped.stopSequence, f.current(queued, stopped.stopSequence)), stopped);
});

test("malformed history and redirected persistence hold, preserving existing bytes", t => {
  const f = fixture(t);
  const queued = f.receipt("a", 90);
  assert.equal(f.run(queued, batch(unsafe)).state, "stopped");
  const stoppedHistory = readFileSync(f.journal);
  appendFileSync(f.journal, JSON.stringify({ kind: "runner.resumed", sequence: 2, at: 100 }) + "\n");
  const wrongSequence = readFileSync(f.journal);
  assert.equal(f.run(queued).state, "unavailable");
  assert.deepEqual(readFileSync(f.journal), wrongSequence);
  writeFileSync(f.journal, stoppedHistory);
  appendFileSync(f.journal, '{"kind":"runner.resumed"');
  const broken = readFileSync(f.journal);
  assert.equal(f.run(queued).state, "unavailable");
  assert.equal(f.run(queued, batch(), 1, f.current(queued, 1)).state, "unavailable");
  assert.deepEqual(readFileSync(f.journal), broken);

  const redirected = fixture(t);
  const redirectedQueued = redirected.receipt("a", 90);
  const victim = join(redirected.stateDir, "fabricated-victim.txt");
  writeFileSync(victim, "fabricated prior work\n", { mode: 0o600 });
  linkSync(victim, redirected.journal);
  assert.equal(redirected.run(redirectedQueued, batch(unsafe)).state, "unavailable");
  assert.equal(readFileSync(victim, "utf8"), "fabricated prior work\n");
});

test("receipt identity, independent authority and a fabricated caller are needed to prepare", t => {
  const f = fixture(t);
  const ready = f.receipt("a", 90);
  const alternative = f.receipt("e", 95);
  assert.equal(f.run(ready, batch(), undefined, f.current(ready), "live").state, "unavailable");
  const wrongWorkspace = realpathSync(tempDir());
  t.after(() => removeDir(wrongWorkspace));
  for (const authority of mismatchedAuthorities(f.current(ready), wrongWorkspace, alternative.attemptId)) {
    assert.equal(f.run(ready, batch(unsafe), undefined, authority).state, "held");
  }
  const mismatched = { ...ready, jobId: "b".repeat(32) };
  assert.equal(f.run(mismatched).state, "held");
  const missing = { ...ready, attemptId: "c".repeat(32) };
  assert.equal(f.run(missing).state, "held");
  const host = f.receipt("b", 91);
  host.snapshot.requiredHostChecks = ["fabricated-outstanding-host-check"];
  host.outstandingHostChecks = [...host.snapshot.requiredHostChecks];
  updateLedger(f.stateDir, [], ledger => { ledger.checkAttempts = ledger.checkAttempts!.map(row => row.attemptId === host.attemptId ? host : row); });
  assert.equal(f.run(host).state, "held");
  const failed = failedCheckAttemptFixture();
  failed.startedAt = 92;
  failed.completedAt = 93;
  f.store(failed);
  assert.equal(f.run(failed).state, "held");
  assert.equal(f.run(failed, batch(unsafe), undefined, f.current(ready)).state, "held");
  let nested: ReturnType<typeof runArtifactPreparation> | undefined;
  const outer = runArtifactPreparation({ stateDir: f.stateDir, request: f.request(ready), artifacts: batch(),
    context: { kind: "fabricated-harness", now: () => 100, readCurrent() {
      nested = f.run(ready);
      return f.current(ready);
    } } });
  assert.equal(nested?.state, "unavailable");
  assert.equal(outer.state, "prepared");
  assertResult(outer);
  assert.equal(f.run(alternative).state, "prepared");
  assert.deepEqual(events(f.journal).map(row => row.kind), ["artifact.intent", "artifact.checked", "artifact.intent", "artifact.checked"]);
});

test("an explicitly approved no-checks receipt can prepare only the fabricated result", t => {
  const f = fixture(t);
  const ready = f.receipt("a", 90);
  ready.snapshot.profile.mode = "none";
  ready.snapshot.profile.checks = [];
  ready.checks = [];
  ready.state = "not_required";
  ready.publicResult = "not_required";
  f.store(ready);
  const unapproved = f.current(ready);
  unapproved.snapshot.authorized = false;
  assert.equal(f.run(ready, batch(), undefined, unapproved).state, "held");
  assert.equal(f.run(ready).state, "prepared");
});
