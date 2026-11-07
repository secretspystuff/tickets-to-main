import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runCheckAttempt } from "../src/check-attempt.ts";
import { processRunner } from "../src/command.ts";
import { install, recoverInstall } from "../src/install.ts";
import { loadLedger, saveLedger } from "../src/ledger.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { assertNonInstallState, failedCheckAttemptFixture, fixture, installFixture, nonInstallState, seedRetainedLedger, snapshot } from "./release-test-fixtures.ts";

const checkout = fileURLToPath(new URL("../..", import.meta.url));

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  assert.equal(result.status, 0, `Fabricated repository setup failed at ${args[0]}.`);
  return result.stdout.trim();
}

test("actual check controller history survives signed replacement, compatible rollback and authenticated recovery", async () => {
  const directory = tempDir();
  const stateDir = join(directory, "state");
  const workspace = join(directory, "workspace");
  try {
    mkdirSync(stateDir, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    git(workspace, "init", "--quiet", "--initial-branch=fixture-work");
    for (const key of ["user.name", "user.email"]) git(workspace, "config", key, git(checkout, "config", key));
    writeFileSync(join(workspace, "behavior.txt"), "fabricated base\n");
    git(workspace, "add", "behavior.txt");
    git(workspace, "commit", "--quiet", "-m", "Fabricated installation integration base");
    const baseCommit = git(workspace, "rev-parse", "HEAD");
    writeFileSync(join(workspace, "behavior.txt"), "fabricated candidate\n");
    git(workspace, "add", "behavior.txt");
    git(workspace, "commit", "--quiet", "-m", "Fabricated installation integration candidate");
    const candidateCommit = git(workspace, "rev-parse", "HEAD");
    seedRetainedLedger(stateDir);
    const current = installFixture(stateDir, "0.2.0");
    const loaded = loadLedger(stateDir);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) throw new Error("Fixture state unavailable.");
    loaded.ledger.workspace = { path: workspace, writerPid: null, qualified: false };
    saveLedger(stateDir, loaded.ledger, []);
    const snapshot = failedCheckAttemptFixture().snapshot;
    snapshot.candidateCommit = candidateCommit;
    snapshot.baseCommit = baseCommit;
    snapshot.buildReview!.candidateCommit = candidateCommit;
    let executions = 0;
    const result = await runCheckAttempt({
      stateDir, workspace, request: { jobId: "d".repeat(32), attemptId: "e".repeat(32), snapshot },
      gitRunner: processRunner(), now: () => 1794009602000, secrets: [], env: {},
      readCurrent: async () => structuredClone(snapshot),
      executor: { kind: "fabricated-harness", execute: async (input) => {
        executions++;
        return {
          stdout: "Fabricated controller execution completed.", stderr: "", coveredMemberIds: [...snapshot.memberIds],
          terminal: { attemptId: input.attemptId, checkId: input.checkId, sourceId: snapshot.profile.sourceId, candidateCommit, code: 0, signal: null, error: null, writerCustody: "contained" },
        };
      } },
    });
    assert.equal(executions, 1);
    assert.equal(result.state, "passed");
    assert.equal(result.qualification, "unqualified-harness");
    assert.equal(result.publishable, false);
    const afterChecks = loadLedger(stateDir);
    assert.equal(afterChecks.ok && afterChecks.ledger.checkAttempts?.length, 2);
    const retained = nonInstallState(stateDir);
    const replacement = fixture(stateDir, "0.3.0");
    replacement.services.releaseTrust!.keys.set(current.manifest.keyId, current.services.releaseTrust!.keys.get(current.manifest.keyId)!);
    install(replacement.signed(), replacement.services);
    assertNonInstallState(stateDir, retained);
    const rollback = { ...current.services, releaseTrust: { ...current.services.releaseTrust!, keys: new Map(replacement.services.releaseTrust!.keys) } };
    install(current.signed(), rollback);
    assertNonInstallState(stateDir, retained);
    recoverInstall(current.input, rollback);
    assertNonInstallState(stateDir, retained);
    const afterRecovery = readFileSync(join(stateDir, "ledger.json"));
    recoverInstall(current.input, rollback);
    assert.deepEqual(readFileSync(join(stateDir, "ledger.json")), afterRecovery);
    assertNonInstallState(stateDir, retained);
  } finally { removeDir(directory); }
});

test("an overlapping installer cannot replace the selected release or alter another installer's staging files", () => {
  const dir = tempDir();
  try {
    seedRetainedLedger(dir);
    const old = installFixture(dir, "0.1.0");
    const sample = fixture(dir, "0.2.0");
    sample.services.releaseTrust!.keys.set(old.manifest.keyId, old.services.releaseTrust!.keys.get(old.manifest.keyId)!);
    const competing = fixture(dir, "0.3.0");
    competing.services.releaseTrust!.keys.set(old.manifest.keyId, old.services.releaseTrust!.keys.get(old.manifest.keyId)!);
    let reached = false;
    sample.services.onReleaseCheckpoint = (phase) => {
      if (phase !== "staged") return;
      reached = true;
      const before = snapshot(dir);
      assert.throws(() => install(competing.signed(), competing.services));
      assert.deepEqual(snapshot(dir), before);
    };
    install(sample.signed(), sample.services);
    assert.equal(reached, true);
  } finally { removeDir(dir); }
});

test("selection preserves a supported record update written after release publication", () => {
  const dir = tempDir();
  try {
    const retained = seedRetainedLedger(dir);
    const sample = fixture(dir);
    let reached = false;
    sample.services.onReleaseCheckpoint = (phase) => {
      if (phase !== "published") return;
      reached = true;
      const loaded = loadLedger(dir);
      assert.equal(loaded.ok, true);
      if (!loaded.ok || !loaded.ledger.connection) throw new Error("Fixture connection unavailable.");
      loaded.ledger.connection.computer = "fabricated-new-computer";
      saveLedger(dir, loaded.ledger, []);
      retained.connection = structuredClone(loaded.ledger.connection);
    };
    install(sample.signed(), sample.services);
    assert.equal(reached, true);
    assertNonInstallState(dir, retained);
  } finally { removeDir(dir); }
});
