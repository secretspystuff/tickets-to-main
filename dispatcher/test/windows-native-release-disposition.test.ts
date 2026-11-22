import assert from "node:assert/strict";
import { once } from "node:events";
import fs, { existsSync, readFileSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { Worker } from "node:worker_threads";
import * as installer from "../src/install.ts";
import type { InstallInput, VerifiedSelectedRelease } from "../src/install.ts";
import { loadLedger } from "../src/ledger.ts";
import { inspectPrivateJournal, withPrivateJournal } from "../src/private-journal.ts";
import {
  WINDOWS_ARCHIVE_FILE, WINDOWS_DESCRIPTOR_FILE, type ReleaseRequest, type ReleaseTrust,
  type WindowsPackageDescriptor, type WindowsPackageObservation, type WindowsPackagePolicy,
} from "../src/release-manifest.ts";
import { withReleaseLock } from "../src/release-store.ts";
import { observeStateLease } from "../src/state-lease.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { COMMIT, digest, fixture, snapshot } from "./release-test-fixtures.ts";

const SUBMISSION_DIRECTORY = "windows-release-submission";
const JOURNAL_NAME = "windows-release-submissions.jsonl";
const JOURNAL = join(SUBMISSION_DIRECTORY, JOURNAL_NAME);
const POLICY: WindowsPackagePolicy = {
  packageName: "Fabricated.NativeRelease",
  publisher: "CN=Fabricated Native Release",
  publisherId: "0123456789abc",
  applicationId: "Supervisor",
  signerSha256: "9".repeat(64),
};
const packageFullName = (version: string) => POLICY.packageName + "_" + version + "_x64__" + POLICY.publisherId;
const OLD = packageFullName("1.0.3.0");
const NEXT = packageFullName("1.0.4.0");
const APPX = Buffer.alloc(32, 17).toString("base64");
const ACTIVITY = "{12345678-0000-0000-0000-000000000001}";
const FAILURE_CODE = -2147467259;

type OfferInput = InstallInput & { release: ReleaseRequest };
type BoundOffer = {
  release: VerifiedSelectedRelease;
  descriptor: WindowsPackageDescriptor;
  archiveBytes: Uint8Array;
};
type Attempt = {
  release: VerifiedSelectedRelease;
  archiveSha256: string;
  appxDigest: string;
  packageFullName: string;
  leaseEpoch: string;
  leaseGeneration: string;
};
type NativeRegistration = { fullName: string; healthy: boolean; files: WindowsPackageDescriptor["installed"]["files"] };
type StageReceipt = {
  activityId: string;
  status: "completed";
  errorCode: 0;
  extendedErrorCode: 0;
  stagedPackageFullName: string;
  registrations: NativeRegistration[];
} | {
  activityId: string;
  status: "error";
  errorCode: number;
  extendedErrorCode: number;
  registrations: NativeRegistration[];
};
type Disposition = { state: "none" }
  | { state: "held"; attempt: Attempt }
  | { state: "staged" | "registered"; attempt: Attempt; activityId: string }
  | { state: "failed"; attempt: Attempt; activityId: string; errorCode: number; extendedErrorCode: number };
type Services = {
  releaseTrust: ReleaseTrust;
  publisherPolicy: WindowsPackagePolicy;
  observeWindowsOffer: (offer: BoundOffer) => WindowsPackageObservation;
  submitWindowsOffer: (offer: BoundOffer, appxDigest: string) => StageReceipt | undefined;
};
type NativeEntry = {
  submitWindowsRelease: (input: OfferInput, services: Services) => Disposition;
  readWindowsReleaseDisposition: (stateDir: string) => Disposition;
};

function nativeEntry(): NativeEntry {
  const candidate = installer as typeof installer & Partial<NativeEntry>;
  assert.equal(typeof candidate.submitWindowsRelease, "function", "Durable explicit Windows release submission is unavailable.");
  assert.equal(typeof candidate.readWindowsReleaseDisposition, "function", "Durable Windows release disposition is unavailable.");
  return candidate as NativeEntry;
}

function ownedState(t: TestContext): string {
  const path = tempDir();
  const root = realpathSync(tmpdir());
  assert.equal(dirname(realpathSync(path)), root);
  assert.match(basename(path), /^tickets-to-main-/);
  t.after(() => {
    assert.equal(dirname(realpathSync(path)), root);
    removeDir(path);
  });
  return path;
}

function offeredRelease(stateDir: string, previousSelection: boolean) {
  const sample = fixture(stateDir, "0.2.0");
  const releaseTrust = sample.services.releaseTrust!;
  const previous = previousSelection ? fixture(stateDir, "0.1.0") : undefined;
  const previousInput = previous?.signed();
  if (previous && previousInput) {
    const priorTrust = previous.services.releaseTrust!;
    releaseTrust.keys.set(previous.manifest.keyId, priorTrust.keys.get(previous.manifest.keyId)!);
    const installed = installer.install(previousInput, previous.services);
    assert.equal(installer.verifySelectedRelease(previous.input, installed.ledger, releaseTrust)?.version, "0.1.0");
  } else {
    assert.equal(existsSync(join(stateDir, "ledger.json")), false);
  }
  const bytes = Buffer.from("Fabricated archive input for the inert durable submission fixture\n");
  const { signerSha256, ...publisher } = POLICY;
  const identity = { ...publisher, fullName: NEXT, version: "1.0.4.0", architecture: "x64" };
  const roles = { supervisor: "Supervisor.exe", guardian: "Guardian.exe", interpreter: "node.exe", entry: "entry.mjs" };
  const files = [...Object.values(roles), "late.mjs"].map((path) => {
    const contents = Buffer.from("Fabricated installed payload " + path);
    return { path, size: contents.length, sha256: digest(contents) };
  });
  const descriptor: WindowsPackageDescriptor = {
    schema: 1,
    release: { version: "0.2.0", sourceCommit: COMMIT },
    archive: { path: WINDOWS_ARCHIVE_FILE, sha256: digest(bytes) },
    package: { ...identity, signerSha256 },
    installed: { ...roles, files },
  };
  const artifacts = [
    { path: WINDOWS_ARCHIVE_FILE, bytes },
    { path: WINDOWS_DESCRIPTOR_FILE, bytes: Buffer.from(JSON.stringify(descriptor)) },
  ];
  const request = sample.signed({
    ...sample.manifest,
    files: artifacts.map(({ path, bytes: data }) => ({ path, size: data.length, sha256: digest(data), executable: false })),
  }).release!;
  request.artifacts = artifacts;
  const input = { ...sample.input, release: request } satisfies OfferInput;
  const bound: BoundOffer = {
    release: { version: request.requestedVersion, manifestDigest: digest(request.manifestBytes), sourceCommit: request.sourceCommit },
    descriptor, archiveBytes: bytes,
  };
  const observation: WindowsPackageObservation = {
    archiveSha256: digest(bytes), appxDigest: APPX, windowsTrustStatus: 0, policySignerSha256: signerSha256,
    identity, applicationExecutable: roles.supervisor, files: structuredClone(files),
  };
  return { input, releaseTrust, bound, observation, previousInput, initialLedger: loadLedger(stateDir) };
}

function checkBoundOffer(actual: BoundOffer, expected: BoundOffer): void {
  assert.deepEqual(actual.release, expected.release);
  assert.deepEqual(actual.descriptor, expected.descriptor);
  assert.deepEqual(Buffer.from(actual.archiveBytes), Buffer.from(expected.archiveBytes));
}

function journalBytes(stateDir: string): Buffer {
  return readFileSync(join(stateDir, JOURNAL));
}

function inspectRows(bytes: Buffer): unknown[] {
  const text = bytes.toString("utf8");
  assert.ok(text.endsWith("\n"), "Durable rows must be framed completely.");
  return text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown);
}

function inertSubmission(offered: ReturnType<typeof offeredRelease>, receipt: StageReceipt | undefined) {
  const events: string[] = [];
  const attempts: Attempt[] = [];
  const intentBytes: Buffer[] = [];
  const { stateDir } = offered.input;
  const services: Services = {
    releaseTrust: offered.releaseTrust,
    publisherPolicy: POLICY,
    observeWindowsOffer(offer) {
      events.push("observe");
      checkBoundOffer(offer, offered.bound);
      return structuredClone(offered.observation);
    },
    submitWindowsOffer(offer, appxDigest) {
      events.push("submit");
      checkBoundOffer(offer, offered.bound);
      assert.equal(appxDigest, APPX);
      const lease = observeStateLease(stateDir, "release");
      assert.equal(lease.state, "active");
      assert.match(lease.generation!, /^[a-f0-9]{64}$/);
      assert.equal(observeStateLease(stateDir, "ledger").state, "active");
      const attempt: Attempt = {
        release: offer.release, archiveSha256: offered.observation.archiveSha256, appxDigest,
        packageFullName: NEXT, leaseEpoch: lease.epoch.toString(), leaseGeneration: lease.generation!,
      };
      const recorded = journalBytes(stateDir);
      assert.deepEqual(inspectRows(recorded), [{ phase: "intent", attempt }],
        "An exact, already-persisted intent must exist before the outward call.");
      attempts.push(attempt);
      intentBytes.push(recorded);
      return receipt && structuredClone(receipt);
    },
  };
  return { services, events, attempts, intentBytes };
}

function completeReceipt(fullName: string, files: NativeRegistration["files"], healthy = true): Extract<StageReceipt, { status: "completed" }> {
  return {
    activityId: ACTIVITY, status: "completed", errorCode: 0, extendedErrorCode: 0, stagedPackageFullName: NEXT,
    registrations: [{ fullName, healthy, files }],
  };
}

async function reopenWithFreshModuleState(offered: ReturnType<typeof offeredRelease>) {
  const input = offered.input;
  const releaseTrust = {
    ...offered.releaseTrust,
    keys: [...offered.releaseTrust.keys].map(([id, key]) => [id, key.export({ type: "spki", format: "der" })]),
  };
  const worker = new Worker(String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    const { createHash, createPublicKey } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const run = async () => {
      const { input, releaseTrust, publisherPolicy, observation, installModule, journalFile } = workerData;
      const api = await import(installModule);
      const journalSha256 = createHash("sha256").update(readFileSync(journalFile)).digest("hex");
      const read = api.readWindowsReleaseDisposition(input.stateDir);
      let submissions = 0;
      const outcome = api.submitWindowsRelease(input, {
        releaseTrust: { ...releaseTrust, keys: new Map(releaseTrust.keys.map(([id, bytes]) =>
          [id, createPublicKey({ format: "der", type: "spki", key: Buffer.from(bytes) })])) },
        publisherPolicy,
        observeWindowsOffer: () => observation,
        submitWindowsOffer: () => { submissions++; return undefined; },
      });
      parentPort.postMessage({ pid: process.pid, journalSha256, read, outcome, submissions });
    };
    void run().catch((error) => parentPort.postMessage({ error: error.message }));
  `, {
    eval: true,
    execArgv: ["--experimental-strip-types"],
    env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() },
    workerData: {
      input, releaseTrust, publisherPolicy: POLICY, observation: offered.observation,
      installModule: new URL("../src/install.ts", import.meta.url).href,
      journalFile: join(input.stateDir, JOURNAL),
    },
  });
  try {
    const [result] = await Promise.race([
      once(worker, "message"),
      once(worker, "exit").then(([code]) => { throw new Error(`Fixture isolate exited ${code} before returning its result.`); }),
    ]);
    return result as unknown;
  } finally { await worker.terminate(); }
}

function assertRetainedPortableBehavior(t: TestContext, offered: ReturnType<typeof offeredRelease>): void {
  const { stateDir, platform, arch, nowIso } = offered.input;
  const bootstrap = { stateDir, platform, arch, nowIso };
  const retained = snapshot(stateDir);
  const original = loadLedger(stateDir);
  assert.deepEqual(original, offered.initialLedger);
  assert.ok(original.ok);
  const originalLedger = original.ledger;
  const legacyServices = { releaseTrust: offered.releaseTrust };
  const expected = offered.previousInput?.release;
  assert.deepEqual(installer.verifySelectedRelease(bootstrap, originalLedger, offered.releaseTrust), expected && {
    version: expected.requestedVersion, manifestDigest: digest(expected.manifestBytes), sourceCommit: expected.sourceCommit,
  });

  assert.deepEqual(installer.recoverInstall(bootstrap, legacyServices).ledger, originalLedger);
  if (offered.previousInput) {
    assert.deepEqual(installer.install(offered.previousInput, legacyServices).ledger, originalLedger);
    assert.deepEqual(installer.install(bootstrap).ledger, originalLedger);
  }
  assert.deepEqual(snapshot(stateDir), retained);

  const alternate = fixture(stateDir, "0.3.0");
  const replacement = alternate.signed();
  const releaseTrust = {
    ...offered.releaseTrust,
    keys: new Map([...offered.releaseTrust.keys, ...alternate.services.releaseTrust!.keys]),
  };
  const independentState = ownedState(t);
  if (offered.previousInput) {
    installer.install({ ...offered.previousInput, stateDir: independentState }, { releaseTrust });
  } else {
    assert.ok(installer.install({ ...bootstrap, stateDir: independentState }).ledger.install);
  }
  const eligible = installer.install({ ...replacement, stateDir: independentState }, { releaseTrust });
  assert.equal(eligible.ledger.install?.packageVersion, "0.3.0");
  assert.equal(existsSync(join(independentState, JOURNAL)), false);

  function requireNoSelectionWrite(install: () => installer.InstallResult): void {
    let result;
    try { result = install(); }
    catch (error) { assert.ok(error instanceof Error); }
    if (result) assert.deepEqual(result.ledger, originalLedger);
    assert.deepEqual(snapshot(stateDir), retained);
  }

  requireNoSelectionWrite(() => installer.install(replacement, { releaseTrust }));
  if (!offered.previousInput) requireNoSelectionWrite(() => installer.install(bootstrap));
  assert.deepEqual(loadLedger(stateDir), original);
}

test("the existing release owner can flush an ordinary private journal row before returning", (t) => {
  const path = ownedState(t);
  const row = { purpose: "fabricated primitive control" };
  withReleaseLock(path, false, () => {
    assert.equal(observeStateLease(path, "release").state, "active");
    withPrivateJournal(path, "artifact-preparation.jsonl", () => [], (_history, append) => append(row));
    assert.deepEqual(inspectPrivateJournal(path, "artifact-preparation.jsonl", JSON.parse), row);
  });
  assert.equal(observeStateLease(path, "release").state, "released");
  assert.equal(existsSync(join(path, JOURNAL)), false);
});

for (const prior of [false, true]) {
  const phase = prior ? "over an existing portable selection" : "before first installation";
  test("a missing original result holds the single explicit submission in fresh module state " + phase, async (t) => {
    const offered = offeredRelease(ownedState(t), prior);
    const inert = inertSubmission(offered, undefined);
    const entry = nativeEntry();
    const outcome = entry.submitWindowsRelease(offered.input, inert.services);
    assert.deepEqual(inert.events, ["observe", "submit"]);
    assert.equal(inert.attempts.length, 1);
    assert.equal(inert.intentBytes.length, 1);
    const attempt = inert.attempts[0]!;
    const capturedIntent = inert.intentBytes[0]!;
    assert.deepEqual(outcome, { state: "held", attempt });
    assert.deepEqual(journalBytes(offered.input.stateDir), capturedIntent,
      "The retained state must still contain only the actual journal bytes observed before submission.");
    const retired = observeStateLease(offered.input.stateDir, "release");
    assert.equal(retired.state, "released");
    assert.equal(retired.epoch.toString(), attempt.leaseEpoch);
    assert.equal(retired.generation, attempt.leaseGeneration);
    const beforeReopen = snapshot(offered.input.stateDir);
    const reopened = await reopenWithFreshModuleState(offered);
    assert.deepEqual(reopened, { pid: process.pid, journalSha256: digest(capturedIntent), read: outcome, outcome, submissions: 0 });
    assert.deepEqual(snapshot(offered.input.stateDir), beforeReopen, "Reopening must preserve the durable hold and submit nothing.");
    assert.deepEqual(loadLedger(offered.input.stateDir), offered.initialLedger);
    assertRetainedPortableBehavior(t, offered);
    assert.deepEqual(entry.readWindowsReleaseDisposition(offered.input.stateDir), outcome);
    assert.deepEqual(journalBytes(offered.input.stateDir), capturedIntent);
  });

  for (const trust of ["manifest", "publisher"] as const) {
    test("explicit submission refuses an untrusted " + trust + " " + phase + " before any intent", (t) => {
      const offered = offeredRelease(ownedState(t), prior);
      const before = snapshot(offered.input.stateDir);
      if (trust === "manifest") offered.input.release.signatureBytes = Buffer.alloc(64);
      else offered.observation.windowsTrustStatus = 0x800b0109;
      const inert = inertSubmission(offered, undefined);
      const entry = nativeEntry();
      assert.throws(() => entry.submitWindowsRelease(offered.input, inert.services), /release operation could not finish safely/i);
      assert.deepEqual(inert.events, trust === "publisher" ? ["observe"] : []);
      assert.deepEqual(inert.attempts, []);
      assert.deepEqual(inert.intentBytes, []);
      assert.equal(existsSync(join(offered.input.stateDir, JOURNAL)), false);
      assert.deepEqual(snapshot(offered.input.stateDir), before);
    });
  }
}

test("a completed native stage with the former registration still current stays staged", (t) => {
  const offered = offeredRelease(ownedState(t), true);
  const inert = inertSubmission(offered, completeReceipt(OLD, []));
  const entry = nativeEntry();
  const staged = entry.submitWindowsRelease(offered.input, inert.services);
  assert.deepEqual(inert.events, ["observe", "submit"]);
  assert.deepEqual(staged, { state: "staged", attempt: inert.attempts[0]!, activityId: ACTIVITY });
  assert.deepEqual(entry.readWindowsReleaseDisposition(offered.input.stateDir), staged);
  assert.deepEqual(inspectRows(journalBytes(offered.input.stateDir)), [
    { phase: "intent", attempt: inert.attempts[0]! },
    { phase: "staged", attempt: inert.attempts[0]!, activityId: ACTIVITY },
  ]);
  assert.deepEqual(loadLedger(offered.input.stateDir), offered.initialLedger);
});

test("healthy exact registration and complete installed payload evidence records registered", (t) => {
  const offered = offeredRelease(ownedState(t), false);
  const inert = inertSubmission(offered, completeReceipt(NEXT, offered.bound.descriptor.installed.files));
  const entry = nativeEntry();
  const registered = entry.submitWindowsRelease(offered.input, inert.services);
  assert.deepEqual(inert.events, ["observe", "submit"]);
  assert.deepEqual(registered, { state: "registered", attempt: inert.attempts[0]!, activityId: ACTIVITY });
  assert.deepEqual(entry.readWindowsReleaseDisposition(offered.input.stateDir), registered);
  assert.deepEqual(inspectRows(journalBytes(offered.input.stateDir)), [
    { phase: "intent", attempt: inert.attempts[0]! },
    { phase: "registered", attempt: inert.attempts[0]!, activityId: ACTIVITY },
  ]);
  assert.deepEqual(loadLedger(offered.input.stateDir), offered.initialLedger);
});

test("a completed stage cannot promote a matching registration with incomplete inventory", (t) => {
  const offered = offeredRelease(ownedState(t), false);
  const files = offered.bound.descriptor.installed.files.filter((file) => file.path !== "late.mjs");
  const inert = inertSubmission(offered, completeReceipt(NEXT, files));
  const entry = nativeEntry();
  const outcome = entry.submitWindowsRelease(offered.input, inert.services);
  assert.deepEqual(inert.events, ["observe", "submit"]);
  assert.equal(outcome.state, "held");
  assert.deepEqual(entry.readWindowsReleaseDisposition(offered.input.stateDir), outcome);
  assert.deepEqual(loadLedger(offered.input.stateDir), offered.initialLedger);
});

test("a completed stage with the exact package registered but unhealthy remains staged", (t) => {
  const offered = offeredRelease(ownedState(t), true);
  const inert = inertSubmission(offered, completeReceipt(NEXT, offered.bound.descriptor.installed.files, false));
  const entry = nativeEntry();
  const outcome = entry.submitWindowsRelease(offered.input, inert.services);
  assert.deepEqual(inert.events, ["observe", "submit"]);
  assert.deepEqual(outcome, { state: "staged", attempt: inert.attempts[0]!, activityId: ACTIVITY });
  assert.deepEqual(entry.readWindowsReleaseDisposition(offered.input.stateDir), outcome);
  assert.deepEqual(inspectRows(journalBytes(offered.input.stateDir)), [
    { phase: "intent", attempt: inert.attempts[0]! },
    { phase: "staged", attempt: inert.attempts[0]!, activityId: ACTIVITY },
  ]);
  assert.deepEqual(loadLedger(offered.input.stateDir), offered.initialLedger);
});

test("a correlated error receipt records failure and the raw HRESULTs", (t) => {
  const offered = offeredRelease(ownedState(t), true);
  const errors = { activityId: ACTIVITY, errorCode: FAILURE_CODE, extendedErrorCode: FAILURE_CODE };
  const inert = inertSubmission(offered, {
    ...errors, status: "error", registrations: [{ fullName: OLD, healthy: true, files: [] }],
  });
  const entry = nativeEntry();
  const outcome = entry.submitWindowsRelease(offered.input, inert.services);
  assert.deepEqual(inert.events, ["observe", "submit"]);
  assert.deepEqual(outcome, { state: "failed", attempt: inert.attempts[0]!, ...errors });
  assert.deepEqual(entry.readWindowsReleaseDisposition(offered.input.stateDir), outcome);
  assert.deepEqual(inspectRows(journalBytes(offered.input.stateDir)), [
    { phase: "intent", attempt: inert.attempts[0]! },
    { phase: "failed", attempt: inert.attempts[0]!, ...errors },
  ]);
  assert.deepEqual(loadLedger(offered.input.stateDir), offered.initialLedger);
});

test("a different staged full name remains held despite matching healthy registration evidence", (t) => {
  const offered = offeredRelease(ownedState(t), false);
  const receipt = completeReceipt(NEXT, offered.bound.descriptor.installed.files);
  const inert = inertSubmission(offered, { ...receipt, stagedPackageFullName: OLD });
  const entry = nativeEntry();
  const outcome = entry.submitWindowsRelease(offered.input, inert.services);
  assert.deepEqual(inert.events, ["observe", "submit"]);
  assert.deepEqual(outcome, { state: "held", attempt: inert.attempts[0]! });
  assert.deepEqual(entry.readWindowsReleaseDisposition(offered.input.stateDir), outcome);
  assert.deepEqual(loadLedger(offered.input.stateDir), offered.initialLedger);
});

test("ordinary portable release selection proceeds without a native disposition journal", (t) => {
  const path = ownedState(t);
  const sample = fixture(path, "0.2.0");
  const input = sample.signed();
  const result = installer.install(input, sample.services);
  const selected = installer.verifySelectedRelease(input, result.ledger, sample.services.releaseTrust);
  assert.equal(selected?.version, "0.2.0");
  assert.equal(result.ledger.install?.signedInstallers, "not-qualified");
  assert.equal(result.ledger.install?.startup, "not-registered");
  assert.equal(existsSync(join(path, JOURNAL)), false);
});

function isPreparedIntentDirectory(path: fs.PathLike, stateDir: string): path is string {
  return typeof path === "string" && dirname(path) === stateDir
    && /^\.windows-release-intent-[a-f0-9-]{36}$/.test(basename(path));
}

test("failure writing the private draft leaves no published attempt and permits an ordinary retry", (t) => {
  const offered = offeredRelease(ownedState(t), false);
  const inert = inertSubmission(offered, undefined);
  const entry = nativeEntry();
  const { stateDir } = offered.input;
  const destination = join(stateDir, SUBMISSION_DIRECTORY);
  const open = fs.openSync;
  const write = fs.writeFileSync;
  let draft: { path: string; fd: number } | undefined;
  let partialDraftWrites = 0;
  const opening = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const [path, flags] = args;
    const fd = open(...args);
    if (flags === "wx" && typeof path === "string" && basename(path) === JOURNAL_NAME
      && isPreparedIntentDirectory(dirname(path), stateDir)) {
      draft = { path, fd };
    }
    return fd;
  });
  const writing = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (draft && args[0] === draft.fd) {
      const { fd, path } = draft;
      draft = undefined;
      const bytes = Buffer.from('{"phase":"in');
      write(fd, bytes);
      assert.deepEqual(readFileSync(path), bytes);
      assert.equal(existsSync(destination), false);
      assert.equal(observeStateLease(stateDir, "release").state, "active");
      assert.equal(observeStateLease(stateDir, "ledger").state, "active");
      partialDraftWrites++;
      throw new Error("Fixture draft write failed");
    }
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => entry.submitWindowsRelease(offered.input, inert.services), /release operation could not finish safely/i);
  } finally {
    writing.mock.restore();
    opening.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(partialDraftWrites, 1);
  assert.deepEqual(inert.events, ["observe"]);
  assert.deepEqual(loadLedger(stateDir), offered.initialLedger);
  assert.deepEqual(entry.readWindowsReleaseDisposition(stateDir), { state: "none" });
  assert.equal(existsSync(destination), false);
  const prior = observeStateLease(stateDir, "release");
  assert.equal(prior.state, "released");
  assert.equal(observeStateLease(stateDir, "ledger").state, "released");

  const retry = inertSubmission(offered, undefined);
  const outcome = entry.submitWindowsRelease(offered.input, retry.services);
  assert.deepEqual(retry.events, ["observe", "submit"]);
  assert.deepEqual(outcome, { state: "held", attempt: retry.attempts[0]! });
  assert.equal(retry.attempts[0]!.leaseEpoch, String(prior.epoch + 1n));
  assert.deepEqual(journalBytes(stateDir), retry.intentBytes[0]);
  assert.deepEqual(loadLedger(stateDir), offered.initialLedger);
});

test("an uncertain publication result leaves the complete original attempt held without an outward call", async (t) => {
  const offered = offeredRelease(ownedState(t), false);
  const inert = inertSubmission(offered, undefined);
  const entry = nativeEntry();
  const { stateDir } = offered.input;
  const destination = join(stateDir, SUBMISSION_DIRECTORY);
  const rename = fs.renameSync;
  let publication: {
    destinationWasAbsent: boolean;
    prepared: Buffer;
    release: ReturnType<typeof observeStateLease>;
    ledger: ReturnType<typeof observeStateLease>;
  } | undefined;
  const publishing = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to !== destination || !isPreparedIntentDirectory(from, stateDir)) return rename(from, to);
    const destinationWasAbsent = !existsSync(destination);
    const prepared = readFileSync(join(from, JOURNAL_NAME));
    const release = observeStateLease(stateDir, "release");
    const ledger = observeStateLease(stateDir, "ledger");
    rename(from, to);
    publication = { destinationWasAbsent, prepared, release, ledger };
    throw new Error("Fixture publication acknowledgment failed");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => entry.submitWindowsRelease(offered.input, inert.services), /release operation could not finish safely/i);
  } finally {
    publishing.mock.restore();
    syncBuiltinESMExports();
  }
  assert.ok(publication);
  assert.equal(publication.destinationWasAbsent, true);
  assert.equal(publication.release.state, "active");
  assert.equal(publication.ledger.state, "active");
  const leaseGeneration = publication.release.generation;
  assert.ok(leaseGeneration && /^[a-f0-9]{64}$/.test(leaseGeneration));
  const attempt: Attempt = {
    release: offered.bound.release,
    archiveSha256: digest(offered.bound.archiveBytes),
    appxDigest: APPX,
    packageFullName: NEXT,
    leaseEpoch: publication.release.epoch.toString(),
    leaseGeneration,
  };
  const expected = { state: "held", attempt };
  const expectedBytes = Buffer.from(JSON.stringify({ phase: "intent", attempt }) + "\n");
  const published = journalBytes(stateDir);
  assert.deepEqual(publication.prepared, expectedBytes);
  assert.deepEqual(published, publication.prepared);
  assert.deepEqual(inert.events, ["observe"]);
  assert.deepEqual(loadLedger(stateDir), offered.initialLedger);
  assert.deepEqual(entry.readWindowsReleaseDisposition(stateDir), expected);
  const before = snapshot(stateDir);
  const reopened = await reopenWithFreshModuleState(offered);
  assert.deepEqual(reopened, { pid: process.pid, journalSha256: digest(expectedBytes), read: expected, outcome: expected, submissions: 0 });
  assert.deepEqual(snapshot(stateDir), before);
});
