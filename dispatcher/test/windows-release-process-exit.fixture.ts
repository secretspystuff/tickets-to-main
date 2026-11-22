import assert from "node:assert/strict";
import { createPublicKey, createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { readWindowsReleaseDisposition, recoverInstall, submitWindowsRelease, verifySelectedRelease, type InstallInput } from "../src/install.ts";
import { loadLedger } from "../src/ledger.ts";
import type { ReleaseRequest, ReleaseTrust, WindowsPackageObservation, WindowsPackagePolicy } from "../src/release-manifest.ts";
import { observeStateLease } from "../src/state-lease.ts";

export type ProcessExitOffer = {
  input: InstallInput & { release: ReleaseRequest };
  trust: Omit<ReleaseTrust, "keys"> & { keys: [string, Uint8Array][] };
  observation: WindowsPackageObservation;
  policy: WindowsPackagePolicy;
};

type Owner = ReturnType<typeof observeStateLease> & { pid: number };

export type ProcessExitWitness =
  | { phase: "published"; pid: number; bytes: Buffer; release: Owner; ledger: Owner; observations: number; submissions: number }
  | { phase: "reopened"; pid: number; bytes: Buffer; release: Owner; ledger: Owner; observations: number; submissions: number;
      disposition: ReturnType<typeof readWindowsReleaseDisposition>; ledgerRecord: ReturnType<typeof loadLedger>;
      selected: ReturnType<typeof verifySelectedRelease>; repeated: string; recovery: string };

const phase = process.argv[2];
assert.ok(phase === "published" || phase === "reopened");
const { input, trust, observation, policy } = deserialize(readFileSync(0)) as ProcessExitOffer;
const { stateDir } = input;
const canonical = realpathSync(stateDir);
assert.equal(dirname(canonical), realpathSync(tmpdir()));
assert.match(basename(canonical), /^tickets-to-main-/);

const releaseTrust: ReleaseTrust = {
  ...trust,
  keys: new Map(trust.keys.map(([id, key]) => [id, createPublicKey({ format: "der", type: "spki", key: Buffer.from(key) })])),
};
const journal = join(stateDir, "windows-release-submission", "windows-release-submissions.jsonl");
let observations = 0;
let submissions = 0;

function lease(namespace: "release" | "ledger"): Owner {
  const owner = observeStateLease(stateDir, namespace);
  const bytes = readFileSync(join(stateDir, ".state-leases", namespace, "epoch-" + owner.epoch, "owner.json"));
  const { pid } = JSON.parse(bytes.toString("utf8")) as { pid: number };
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(owner.generation, createHash("sha256").update(bytes).digest("hex"));
  return { ...owner, pid };
}

function witness(report: ProcessExitWitness): void {
  writeFileSync(1, serialize(report));
}

const services = {
  releaseTrust,
  publisherPolicy: policy,
  observeWindowsOffer() { observations++; return observation; },
  submitWindowsOffer() {
    submissions++;
    if (phase === "reopened") return undefined;
    const release = lease("release");
    const ledger = lease("ledger");
    assert.equal(release.state, "active");
    assert.equal(ledger.state, "active");
    assert.equal(release.pid, process.pid);
    assert.equal(ledger.pid, process.pid);
    witness({ phase, pid: process.pid, bytes: readFileSync(journal), release, ledger, observations, submissions });
    // Exiting here leaves the original owner records and omits any immediate receipt.
    process.exit(0);
  },
};

function refused(run: () => unknown): string {
  try { run(); }
  catch (error) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /release operation could not finish safely/i);
    return error.message;
  }
  assert.fail("Expected the ordinary entry to refuse retained uncertain state.");
}

if (phase === "published") {
  submitWindowsRelease(input, services);
  assert.fail("The fabricated owner did not reach its explicit exit.");
} else {
  const release = lease("release");
  const ledger = lease("ledger");
  const disposition = readWindowsReleaseDisposition(stateDir);
  const ledgerRecord = loadLedger(stateDir);
  assert.ok(ledgerRecord.ok);
  const selected = verifySelectedRelease(input, ledgerRecord.ledger, releaseTrust);
  const repeated = refused(() => submitWindowsRelease(input, services));
  const recovery = refused(() => recoverInstall(input, { releaseTrust }));
  witness({ phase, pid: process.pid, bytes: readFileSync(journal), release, ledger, observations, submissions,
    disposition, ledgerRecord, selected, repeated, recovery });
}
