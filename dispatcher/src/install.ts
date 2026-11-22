import { join } from "node:path";
import {
  closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { osLabel, osWords } from "./platform.ts";
import { emptyLedger, loadLedger, updateLedger, type Ledger } from "./ledger.ts";
import { observeStateLease, stateLeaseStatus, withStateLease, type LeaseObservation } from "./state-lease.ts";
import { PACKAGE_VERSION } from "./version.ts";
import { WINDOWS_RELEASE_JOURNAL } from "./private-journal.ts";
import { assertPrivateAccess, assertPrivateDirectory } from "./fs-safety.ts";
import {
  MAX_MANIFEST_BYTES, WINDOWS_ARCHIVE_FILE, WINDOWS_DESCRIPTOR_FILE,
  releaseDirectory, releaseError, releaseVersion, sha256, verifiedArtifacts, verifyManifest,
  verifyWindowsPackageDescriptor, verifyWindowsPackageObservation,
  type ReleaseManifest, type ReleaseRequest, type ReleaseServices, type ReleaseTrust,
  type WindowsPackageDescriptor, type WindowsPackageObservation, type WindowsPackagePolicy,
} from "./release-manifest.ts";
import {
  assertReleaseRoot, exists, flushDirectory, publishRelease, readReleaseFile, readReleaseMetadata,
  cleanupOwnedStage, ownedStageIntents, stageRelease, verifyPartialStage, verifyReleaseTree, withReleaseLock, writeReleaseFile,
  WINDOWS_RELEASE_SUBMISSION_DIRECTORY, type OwnedStage,
} from "./release-store.ts";
import { readWindowsOfferFence, windowsOfferClaimIsCurrent } from "./windows-offer-fence.ts";
import {
  assertPortableSelectionMayChange, classifyWindowsStageReceipt, matchingWindowsDisposition, readWindowsReleaseDisposition,
  validWindowsReleaseAttempt, type WindowsReleaseJournalRow, type WindowsReleaseOutcome, type WindowsStageReceipt,
} from "./windows-release-disposition.ts";

export type { ReleaseManifest, ReleaseServices } from "./release-manifest.ts";
export { readWindowsReleaseDisposition } from "./windows-release-disposition.ts";

export type InstallInput = {
  stateDir: string;
  platform: NodeJS.Platform;
  arch: string;
  nowIso: string;
  release?: ReleaseRequest;
};

export type InstallResult = { ledger: Ledger; lines: string[] };

function localLedger(stateDir: string): Ledger {
  const loaded = loadLedger(stateDir);
  if (!loaded.ok && loaded.reason !== "missing") {
    throw new Error(loaded.reason === "unsafe"
      ? "The state directory is not private. Nothing was saved."
      : "The local record could not be read. Nothing was replaced.");
  }
  return loaded.ok ? loaded.ledger : emptyLedger();
}

function result(ledger: Ledger): InstallResult {
  const installed = ledger.install;
  return {
    ledger,
    lines: installed ? [
      `Installed ${installed.packageVersion}.`,
      `Operating system: ${osWords(installed.platform)}`,
      "Signed installers: unqualified.",
      "Startup: unregistered.",
    ] : ["No release is selected.", "Signed installers: unqualified.", "Startup: unregistered."],
  };
}

export type VerifiedSelectedRelease = { version: string; manifestDigest: string; sourceCommit: string };

type ReleaseTarget = Pick<InstallInput, "stateDir" | "platform" | "arch">;

function readVerifiedSelectedRelease(input: ReleaseTarget, ledger: Ledger, trust: ReleaseTrust | undefined) {
  const selected = ledger.install?.release;
  if (!selected || !ledger.install) return;
  const directory = join(input.stateDir, selected.directory);
  const { manifestBytes, signatureBytes } = readReleaseMetadata(directory);
  if (sha256(manifestBytes) !== selected.manifestDigest || selected.directory !== releaseDirectory(ledger.install.packageVersion, selected.manifestDigest)
    || ledger.install.platform !== osLabel(input.platform) || ledger.install.arch !== input.arch) throw releaseError();
  const manifest = verifyManifest(manifestBytes, signatureBytes, trust, {
    version: ledger.install.packageVersion, platform: input.platform, arch: input.arch, dataVersion: ledger.version,
  });
  verifyReleaseTree(directory, manifest, manifestBytes, signatureBytes);
  const selection = { version: manifest.version, manifestDigest: selected.manifestDigest, sourceCommit: manifest.provenance.sourceCommit };
  return { directory, manifest, selection };
}

export function verifySelectedRelease(input: ReleaseTarget, ledger: Ledger,
  trust: ReleaseTrust | undefined): VerifiedSelectedRelease | undefined {
  return readVerifiedSelectedRelease(input, ledger, trust)?.selection;
}

function readVerifiedMember(directory: string, file: ReleaseManifest["files"][number]): Buffer {
  const bytes = readReleaseFile(join(directory, file.path), file.size);
  if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw releaseError();
  return bytes;
}

export type SelectedWindowsPackageSnapshot = {
  selection: VerifiedSelectedRelease;
  descriptor: WindowsPackageDescriptor;
  archiveBytes: Uint8Array;
};

function windowsPackageMembers(manifest: ReleaseManifest) {
  const archives = manifest.files.filter((file) => /\.msix$/i.test(file.path));
  const archive = archives[0];
  const companion = manifest.files.find((file) => file.path === WINDOWS_DESCRIPTOR_FILE);
  if (archives.length !== 1 || archive?.path !== WINDOWS_ARCHIVE_FILE || archive.size === 0
    || !companion || companion.size > MAX_MANIFEST_BYTES) throw releaseError();
  return { archive, companion };
}

// A later native submission must establish its own current selection and submission authority.
export function prepareSelectedWindowsPackage(input: ReleaseTarget, expected: VerifiedSelectedRelease,
  trust: ReleaseTrust | undefined, policy: WindowsPackagePolicy): SelectedWindowsPackageSnapshot {
  if (input.platform !== "win32" || input.arch !== "x64") throw releaseError();
  return withReleaseLock(input.stateDir, false, () => {
    const selected = readVerifiedSelectedRelease(input, localLedger(input.stateDir), trust);
    if (!selected) throw releaseError();
    const { directory, manifest, selection } = selected;
    if (selection.version !== expected.version || selection.manifestDigest !== expected.manifestDigest
      || selection.sourceCommit !== expected.sourceCommit) throw releaseError();

    const { archive, companion } = windowsPackageMembers(manifest);
    const descriptor = verifyWindowsPackageDescriptor(readVerifiedMember(directory, companion), manifest, archive, policy);
    // Check the returned bytes against the signed member even after the complete tree was verified.
    const archiveBytes = readVerifiedMember(directory, archive);
    return { selection, descriptor, archiveBytes };
  });
}

function sameSelection(a: Ledger, b: Ledger): boolean {
  return JSON.stringify(a.install) === JSON.stringify(b.install);
}

function authenticateReleaseRequest(target: ReleaseTarget, request: ReleaseRequest,
  trust: ReleaseTrust | undefined, dataVersion: number) {
  const { requestedVersion, sourceCommit } = request;
  if (!releaseVersion(requestedVersion) || typeof sourceCommit !== "string") throw releaseError();
  const manifestBytes = Buffer.from(request.manifestBytes);
  const signatureBytes = Buffer.from(request.signatureBytes);
  const manifest = verifyManifest(manifestBytes, signatureBytes, trust, {
    version: requestedVersion, sourceCommit, platform: target.platform, arch: target.arch, dataVersion,
  });
  const artifacts = verifiedArtifacts(request, manifest);
  const manifestDigest = sha256(manifestBytes);
  return { manifest, manifestBytes, signatureBytes, artifacts, manifestDigest };
}

type OfferedWindowsPackage = {
  release: VerifiedSelectedRelease;
  descriptor: WindowsPackageDescriptor;
  archiveBytes: Uint8Array;
};

type WindowsOfferVerification = Pick<ReleaseServices, "releaseTrust"> & {
  publisherPolicy?: WindowsPackagePolicy;
  observeWindowsOffer?: (offer: OfferedWindowsPackage) => WindowsPackageObservation | undefined;
};

type WindowsReleaseServices<Receipt = undefined> = WindowsOfferVerification & {
  stageWindowsOffer?: (offer: OfferedWindowsPackage, appxDigest: string) => Receipt;
};

type WindowsSubmissionServices = WindowsOfferVerification & {
  submitWindowsOffer?: (offer: OfferedWindowsPackage, appxDigest: string) => WindowsStageReceipt | undefined;
};

function prepareWindowsReleaseOffer<Receipt>(input: ReleaseTarget & { release: ReleaseRequest }, services: WindowsReleaseServices<Receipt>) {
  const { stateDir, platform, arch, release: request } = input;
  const { releaseTrust, publisherPolicy, observeWindowsOffer, stageWindowsOffer } = services;
  if (platform !== "win32" || arch !== "x64" || !request || !publisherPolicy
    || typeof observeWindowsOffer !== "function" || typeof stageWindowsOffer !== "function") throw releaseError();
  const initial = readWindowsOfferFence(stateDir, services);
  if (initial.observeWindowsOffer !== observeWindowsOffer || initial.stageWindowsOffer !== stageWindowsOffer) throw releaseError();
  const { manifest, manifestBytes, signatureBytes, artifacts, manifestDigest } = authenticateReleaseRequest(
    { stateDir, platform, arch }, request, releaseTrust, initial.dataVersion,
  );
  const { archive, companion } = windowsPackageMembers(manifest);
  const archiveBytes = artifacts.get(archive.path)!;
  const descriptorBytes = artifacts.get(companion.path)!;
  const descriptor = verifyWindowsPackageDescriptor(descriptorBytes, manifest, archive, publisherPolicy);
  const release = { version: manifest.version, manifestDigest, sourceCommit: manifest.provenance.sourceCommit };
  const offer = { release, descriptor, archiveBytes };
  // The observer receives its own copy so that staging can use the authenticated bytes and descriptor.
  const appxDigest = verifyWindowsPackageObservation(observeWindowsOffer(structuredClone(offer)), descriptor);

  function verifyCurrentTrust() {
    const currentPolicy = services.publisherPolicy;
    if (!currentPolicy) throw releaseError();
    verifyManifest(manifestBytes, signatureBytes, services.releaseTrust, {
      version: release.version, sourceCommit: release.sourceCommit, platform, arch, dataVersion: initial.dataVersion,
    });
    verifyWindowsPackageDescriptor(descriptorBytes, manifest, archive, currentPolicy);
  }
  verifyCurrentTrust();
  if (!isDeepStrictEqual(readWindowsOfferFence(stateDir, services), initial)) throw releaseError();

  const evidence = {
    release: { ...release }, archiveSha256: archive.sha256, appxDigest,
    packageFullName: descriptor.package.fullName, signerSha256: descriptor.package.signerSha256,
  };
  return { offer, stageWindowsOffer, evidence, fence: initial, verifyCurrentTrust };
}

export function installWindowsRelease(input: ReleaseTarget & { release: ReleaseRequest }, services: WindowsReleaseServices) {
  let prepared;
  const { stateDir } = input;
  try {
    prepared = prepareWindowsReleaseOffer(input, services);
    if (readWindowsReleaseDisposition(stateDir).state !== "none") throw releaseError();
  }
  catch { throw releaseError(); }
  prepared.stageWindowsOffer(prepared.offer, prepared.evidence.appxDigest);
  return prepared.evidence;
}

function sameEntry(actual: BigIntStats, expected: BigIntStats): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function publishWindowsIntent(stateDir: string, intent: Buffer, assertOwners: () => void) {
  const directory = join(stateDir, WINDOWS_RELEASE_SUBMISSION_DIRECTORY);
  const draft = join(stateDir, ".windows-release-intent-" + randomUUID());
  const draftFile = join(draft, WINDOWS_RELEASE_JOURNAL);
  mkdirSync(draft, { mode: 0o700 });
  const folder = lstatSync(draft, { bigint: true });
  try {
    assertPrivateDirectory(draft);
    writeReleaseFile(draftFile, intent);
    const original = lstatSync(draftFile, { bigint: true });
    if (!readReleaseFile(draftFile, intent.length).equals(intent)) throw releaseError();
    flushDirectory(draft);
    assertOwners();
    // Both leases serialize publishers. A complete destination always contains the original intent.
    if (exists(directory)) throw releaseError();
    renameSync(draft, directory);
    flushDirectory(stateDir);
    return { directory, folder, original };
  } catch (error) {
    try {
      const remaining = lstatSync(draft, { bigint: true });
      if (remaining.isDirectory() && !remaining.isSymbolicLink() && sameEntry(remaining, folder)) {
        if (exists(draftFile)) unlinkSync(draftFile);
        rmdirSync(draft);
      }
    } catch { /* An unpublished draft can remain private without acting as an intent. */ }
    throw error;
  }
}

function recordNewWindowsSubmission(stateDir: string, owners: { release: LeaseObservation; ledger: LeaseObservation },
  attempt: WindowsReleaseJournalRow["attempt"], descriptor: WindowsPackageDescriptor,
  submit: () => WindowsStageReceipt | undefined): WindowsReleaseOutcome {
  const expectedDescriptor = structuredClone(descriptor);
  const intent = Buffer.from(JSON.stringify({ phase: "intent", attempt }) + "\n");
  function assertOwners() {
    if (!isDeepStrictEqual(observeStateLease(stateDir, "release"), owners.release)
      || !isDeepStrictEqual(observeStateLease(stateDir, "ledger"), owners.ledger)) throw releaseError();
  }
  const { directory, folder, original } = publishWindowsIntent(stateDir, intent, assertOwners);
  const path = join(directory, WINDOWS_RELEASE_JOURNAL);
  const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
  function assertOriginalIntent() {
    assertOwners();
    assertPrivateDirectory(directory);
    const published = lstatSync(directory, { bigint: true });
    const actual = fstatSync(fd, { bigint: true });
    const listed = lstatSync(path, { bigint: true });
    if (!sameEntry(published, folder) || !actual.isFile() || listed.isSymbolicLink() || actual.nlink !== 1n
      || !sameEntry(actual, listed) || !sameEntry(actual, original) || actual.size !== BigInt(intent.length)) throw releaseError();
    assertPrivateAccess(path);
    const bytes = Buffer.alloc(intent.length);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.equals(intent)) throw releaseError();
  }
  function append(row: Exclude<WindowsReleaseJournalRow, { phase: "intent" }>) {
    assertOriginalIntent();
    writeFileSync(fd, JSON.stringify(row) + "\n");
    fsyncSync(fd);
  }
  try {
    assertOriginalIntent();
    let outcome: WindowsReleaseOutcome;
    try { outcome = classifyWindowsStageReceipt(submit(), attempt, expectedDescriptor); }
    catch { outcome = { state: "held", attempt }; }
    if (outcome.state === "failed") {
      const { state: phase, ...result } = outcome;
      append({ phase, ...result });
    } else if (outcome.state !== "held") {
      append({ phase: outcome.state, attempt, activityId: outcome.activityId });
    }
    return outcome;
  } finally { closeSync(fd); }
}

export function submitWindowsRelease(input: ReleaseTarget & { release: ReleaseRequest }, services: WindowsSubmissionServices) {
  const { stateDir } = input;
  const { releaseTrust, publisherPolicy, observeWindowsOffer, submitWindowsOffer } = services;
  const configured = { releaseTrust, publisherPolicy, observeWindowsOffer, stageWindowsOffer: submitWindowsOffer };
  const dependenciesAreCurrent = () => services.releaseTrust === releaseTrust && services.publisherPolicy === publisherPolicy
    && services.observeWindowsOffer === observeWindowsOffer && services.submitWindowsOffer === submitWindowsOffer;
  try {
    const prepared = prepareWindowsReleaseOffer(input, configured);
    if (!dependenciesAreCurrent()) throw releaseError();
    const { signerSha256: _signer, ...identity } = prepared.evidence;
    const retained = readWindowsReleaseDisposition(stateDir);
    if (retained.state !== "none") return matchingWindowsDisposition(retained, identity);

    const { release: expectedRelease, ledger: expectedLedger } = prepared.fence.leases;
    return withStateLease(stateDir, "release", release => withStateLease(stateDir, "ledger", ledger => {
      if (!dependenciesAreCurrent() || !release.generation) throw releaseError();
      prepared.verifyCurrentTrust();
      const owners = { release, ledger };
      if (!windowsOfferClaimIsCurrent(stateDir, configured, prepared.fence, owners)) throw releaseError();
      const attempt = { ...identity, leaseEpoch: release.epoch.toString(), leaseGeneration: release.generation };
      if (!validWindowsReleaseAttempt(attempt)) throw releaseError();
      return recordNewWindowsSubmission(stateDir, owners, attempt, prepared.offer.descriptor,
        () => prepared.stageWindowsOffer(prepared.offer, identity.appxDigest));
    }, { expected: expectedLedger }), { expected: expectedRelease });
  } catch { throw releaseError(); }
}

function installPrepared(input: InstallInput, services: ReleaseServices): InstallResult {
  const ledger = localLedger(input.stateDir);
  if (input.release === undefined) {
    // A bootstrap invocation cannot replace an explicitly selected release with its own package version.
    if (ledger.install?.release) return result(ledger);
    assertPortableSelectionMayChange(input.stateDir);
    const saved = updateLedger(input.stateDir, [], (current) => {
      if (current.install?.release) return;
      assertPortableSelectionMayChange(input.stateDir);
      current.install = {
        packageVersion: PACKAGE_VERSION,
        platform: osLabel(input.platform), arch: input.arch,
        installedAt: current.install?.installedAt ?? input.nowIso,
        startup: "not-registered", signedInstallers: "not-qualified",
      };
    });
    return result(saved);
  }

  const request = input.release;
  const { manifest, manifestBytes, signatureBytes, artifacts, manifestDigest } =
    authenticateReleaseRequest(input, request, services.releaseTrust, ledger.version);
  const relative = releaseDirectory(manifest.version, manifestDigest);
  const destination = join(input.stateDir, relative);
  assertReleaseRoot(input.stateDir);
  verifySelectedRelease(input, ledger, services.releaseTrust);
  if (ledger.install?.packageVersion === manifest.version && ledger.install.release?.manifestDigest !== undefined
    && ledger.install.release.manifestDigest !== manifestDigest) throw releaseError();
  if (ledger.install?.release?.manifestDigest === manifestDigest) return result(ledger);
  assertPortableSelectionMayChange(input.stateDir);
  const releaseRoot = join(input.stateDir, "releases");
  if (exists(releaseRoot)) {
    for (const name of readdirSync(releaseRoot)) {
      const match = /^(.*)-([a-f0-9]{64})$/.exec(name);
      if (!match || match[1] !== manifest.version || name === relative.slice("releases/".length)) continue;
      const metadata = readReleaseMetadata(join(releaseRoot, name));
      verifyManifest(metadata.manifestBytes, metadata.signatureBytes, services.releaseTrust, {
        version: manifest.version, platform: input.platform, arch: input.arch, dataVersion: ledger.version,
      });
      throw releaseError();
    }
  }
  // A previously published complete release can be selected again by an explicit compatible rollback.
  if (exists(destination)) verifyReleaseTree(destination, manifest, manifestBytes, signatureBytes);
  return withReleaseLock(input.stateDir, false, () => {
    assertPortableSelectionMayChange(input.stateDir);
    const initial = localLedger(input.stateDir);
    if (!sameSelection(initial, ledger)) throw releaseError();
    verifySelectedRelease(input, initial, services.releaseTrust);
    let directory = destination;
    if (!exists(destination)) {
      const stage = stageRelease(input.stateDir, manifest, manifestBytes, signatureBytes, artifacts, services);
      services.onReleaseCheckpoint?.("staged", stage);
      assertReleaseRoot(input.stateDir);
      verifyManifest(manifestBytes, signatureBytes, services.releaseTrust, {
        version: request.requestedVersion, sourceCommit: request.sourceCommit, platform: input.platform, arch: input.arch, dataVersion: initial.version,
      });
      verifyReleaseTree(stage, manifest, manifestBytes, signatureBytes);
      publishRelease(stage, destination);
      directory = destination;
    }
    services.onReleaseCheckpoint?.("published", directory);
    assertReleaseRoot(input.stateDir);
    verifyManifest(manifestBytes, signatureBytes, services.releaseTrust, {
      version: request.requestedVersion, sourceCommit: request.sourceCommit, platform: input.platform, arch: input.arch, dataVersion: initial.version,
    });
    verifyReleaseTree(directory, manifest, manifestBytes, signatureBytes);
    const latest = updateLedger(input.stateDir, [], (current) => {
      if (!sameSelection(initial, current)) throw releaseError();
      current.install = {
        packageVersion: manifest.version, platform: osLabel(input.platform), arch: input.arch,
        installedAt: current.install?.installedAt ?? input.nowIso,
        startup: "not-registered", signedInstallers: "not-qualified",
        release: { directory: relative, manifestDigest, qualified: false },
      };
    });
    services.onReleaseCheckpoint?.("committed", directory);
    return result(latest);
  });
}

function recoverableStages(input: InstallInput, ledger: Ledger, services: ReleaseServices): OwnedStage[] {
  const stages = [];
  for (const owned of ownedStageIntents(input.stateDir)) {
    let version: unknown;
    try { version = (JSON.parse(owned.manifestBytes.toString("utf8")) as Record<string, unknown>).version; }
    catch { throw releaseError(); }
    if (!releaseVersion(version)) throw releaseError();
    const manifest = verifyManifest(owned.manifestBytes, owned.signatureBytes, services.releaseTrust, {
      version, platform: input.platform, arch: input.arch, dataVersion: ledger.version,
    });
    const stage = { ...owned, manifest };
    verifyPartialStage(input.stateDir, stage);
    stages.push(stage);
  }
  return stages;
}

function recoverPrepared(input: InstallInput, services: ReleaseServices): InstallResult {
  assertReleaseRoot(input.stateDir);
  const before = localLedger(input.stateDir);
  verifySelectedRelease(input, before, services.releaseTrust);
  const stages = recoverableStages(input, before, services);
  const lease = stateLeaseStatus(input.stateDir, "release");
  if (lease === "active") throw releaseError();
  if (stages.length === 0 && lease !== "dead") return result(before);
  assertPortableSelectionMayChange(input.stateDir);
  return withReleaseLock(input.stateDir, true, () => {
    assertPortableSelectionMayChange(input.stateDir);
    assertReleaseRoot(input.stateDir);
    const ledger = localLedger(input.stateDir);
    if (!sameSelection(before, ledger)) throw releaseError();
    verifySelectedRelease(input, ledger, services.releaseTrust);
    for (const stage of recoverableStages(input, ledger, services)) cleanupOwnedStage(input.stateDir, stage, services);
    return result(ledger);
  });
}

export function install(input: InstallInput, services: ReleaseServices = {}): InstallResult {
  try { return installPrepared(input, services); }
  catch (error) { if (input.release === undefined) throw error; throw releaseError(); }
}

export function recoverInstall(input: InstallInput, services: ReleaseServices = {}): InstallResult {
  try { return recoverPrepared(input, services); }
  catch { throw releaseError(); }
}
