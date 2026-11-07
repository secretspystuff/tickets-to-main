import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { install, type InstallInput, type ReleaseManifest, type ReleaseServices } from "../src/install.ts";
import { emptyLedger, loadLedger, saveLedger, type Ledger } from "../src/ledger.ts";
import type { CheckAttemptRecord } from "../src/check-attempt.ts";

export const NOW = "2026-11-07T12:00:00.000Z";
export const REPOSITORY = "https://github.com/fabricated-owner/tickets-to-main";
export const WORKFLOW = ".github/workflows/release.yml";
export const COMMIT = "a".repeat(40);
export const FILES = [
  { path: "bin/dispatcher.mjs", bytes: Buffer.from("export const fixture = 'release';\n"), executable: true },
  { path: "lib/runtime.json", bytes: Buffer.from('{"fixture":true}\n'), executable: false },
];

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fixture(stateDir: string, version = "0.2.0") {
  const pair = generateKeyPairSync("ed25519");
  const manifest: ReleaseManifest = {
    schema: 1,
    version,
    platform: "win32",
    arch: "x64",
    keyId: `fabricated-${digest(pair.publicKey.export({ type: "spki", format: "der" }))}`,
    provenance: { repository: REPOSITORY, workflow: WORKFLOW, ref: `refs/tags/v${version}`, sourceCommit: COMMIT },
    dataCompatibility: { min: 1, max: 1 },
    files: FILES.map((file) => ({ path: file.path, size: file.bytes.byteLength, sha256: digest(file.bytes), executable: file.executable })),
  };
  const services: ReleaseServices = {
    releaseTrust: {
      keys: new Map([[manifest.keyId, pair.publicKey]]),
      revokedKeyIds: [],
      repository: REPOSITORY,
      workflow: WORKFLOW,
    },
  };
  const input: InstallInput = { stateDir, platform: "win32", arch: "x64", nowIso: NOW };
  const signed = (value: ReleaseManifest = manifest, raw?: Uint8Array): InstallInput => {
    const manifestBytes = raw === undefined ? Buffer.from(JSON.stringify(value)) : Buffer.from(raw);
    return {
      ...input,
      release: {
        requestedVersion: version,
        sourceCommit: COMMIT,
        manifestBytes,
        signatureBytes: sign(null, manifestBytes, pair.privateKey),
        artifacts: FILES.map((file) => ({ path: file.path, bytes: Buffer.from(file.bytes) })),
      },
    };
  };
  return { input, manifest, services, signed };
}

export function snapshot(root: string): unknown {
  const listed = lstatSync(root);
  if (listed.isSymbolicLink()) return { link: readlinkSync(root) };
  if (listed.isDirectory()) {
    return { mode: listed.mode & 0o777, entries: Object.fromEntries(readdirSync(root).sort().map((name) => [name, snapshot(join(root, name))])) };
  }
  return { mode: listed.mode & 0o777, size: listed.size, digest: digest(readFileSync(root)) };
}

export function active(stateDir: string) {
  const loaded = loadLedger(stateDir);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("Fixture ledger unavailable.");
  assert.ok(loaded.ledger.install?.release);
  return loaded.ledger.install.release;
}

export function activeDirectory(stateDir: string): string {
  return join(stateDir, active(stateDir).directory);
}

export function installFixture(stateDir: string, version = "0.2.0") {
  const sample = fixture(stateDir, version);
  const result = install(sample.signed(), sample.services);
  assert.equal(result.ledger.install?.packageVersion, version);
  assert.equal(result.ledger.install?.signedInstallers, "not-qualified");
  assert.equal(result.ledger.install?.release?.qualified, false);
  assert.equal(result.ledger.install?.release?.manifestDigest, digest(sample.signed().release!.manifestBytes));
  return sample;
}

export function rejectedUnchanged(stateDir: string, input: InstallInput, services: ReleaseServices): void {
  const before = snapshot(stateDir);
  const checkpoints: string[] = [];
  assert.throws(() => install(input, {
    ...services,
    onReleaseCheckpoint: (phase, directory) => {
      checkpoints.push(phase);
      services.onReleaseCheckpoint?.(phase, directory);
    },
  }));
  assert.deepEqual(checkpoints, [], "Rejected input reached a release publication checkpoint.");
  assert.deepEqual(snapshot(stateDir), before, "Rejected release changed the existing state or installation.");
}

export function nonInstallState(stateDir: string): Record<string, unknown> {
  const { install: _install, ...rest } = JSON.parse(readFileSync(join(stateDir, "ledger.json"), "utf8")) as Record<string, unknown>;
  return rest;
}

export function assertNonInstallState(stateDir: string, expected: Record<string, unknown>): void {
  assert.deepEqual(nonInstallState(stateDir), expected, "Persisted non-install fields changed.");
  const loaded = loadLedger(stateDir);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("Fixture retained record unavailable.");
  const { install: _install, ...rest } = loaded.ledger;
  assert.deepEqual(rest, expected, "Reloading discarded retained non-install fields.");
}

export function seedRetainedLedger(stateDir: string): Record<string, unknown> {
  const ledger: Ledger & { checkAttempts: CheckAttemptRecord[] } = { ...emptyLedger(), checkAttempts: [failedCheckAttemptFixture()] };
  ledger.connection = {
    phase: "pending", fixture: true, protocolRevision: "waiting-on-t1", origin: "https://fabricated.invalid",
    computer: "fabricated-computer", userCode: "ABCD-EFGH", verificationUriComplete: "https://fabricated.invalid/consent",
    boardName: null, agentName: null, lastPollAt: null, fixturePollIndex: 0,
  };
  Object.assign(ledger.connection, {
    enrollmentId: "e".repeat(32),
    deliveryReceipt: { version: 1, scopeId: "f".repeat(64), enrollmentId: "e".repeat(32), bindingDigest: "b".repeat(64), credentialDigest: "c".repeat(64), boardName: "Fabricated board", agentName: "Fabricated agent" },
  });
  ledger.tools = [{ vendor: "codex", interfaceId: "cli", qualification: "unknown", experimental: "unknown", version: null, limit: "Fabricated retained limit" }];
  ledger.workspace = { path: "/fabricated/workspace", writerPid: null, qualified: false };
  saveLedger(stateDir, ledger, []);
  return nonInstallState(stateDir);
}

export function failedCheckAttemptFixture(): CheckAttemptRecord {
  const binding = { candidate_id: "1".repeat(32), requirements_id: "2".repeat(32), base_id: "3".repeat(32), policy_id: "4".repeat(32) };
  const candidateCommit = "a".repeat(40);
  const memberIds = ["5".repeat(32)];
  const attemptId = "6".repeat(32);
  return {
    version: 1,
    jobId: "7".repeat(32),
    attemptId,
    snapshot: {
      authorized: true, claimId: "8".repeat(32), binding,
      candidateCommit, baseCommit: "b".repeat(40), evidenceRevision: "9".repeat(32),
      buildReview: { id: "a".repeat(32), result: "passed", candidateCommit, binding: { ...binding } },
      profile: {
        id: "b".repeat(32), revision: "c".repeat(32), mode: "scripted", sourceId: "fabricated-executor",
        checks: [{ id: "behavior", argv: ["fabricated-check", "behavior"], memberIds, dependsOn: [] }],
      },
      memberIds, requiredHostChecks: [],
    },
    qualification: "unqualified-harness",
    publishable: false,
    state: "failed",
    publicResult: "failed",
    checks: [{
      id: "behavior", state: "failed", publicResult: "failed", sourceId: "fabricated-executor",
      coveredMemberIds: memberIds, stdout: "Fabricated historical failed check.", stderr: "",
      terminal: { attemptId, checkId: "behavior", sourceId: "fabricated-executor", candidateCommit, code: 1, signal: null, error: null, writerCustody: "contained" },
    }],
    outstandingHostChecks: [],
    startedAt: 1794009600000,
    completedAt: 1794009601000,
  };
}
