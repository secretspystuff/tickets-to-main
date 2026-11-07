import { join } from "node:path";
import { readdirSync } from "node:fs";
import { osLabel, osWords } from "./platform.ts";
import { emptyLedger, loadLedger, updateLedger, type Ledger } from "./ledger.ts";
import { stateLeaseStatus } from "./state-lease.ts";
import { PACKAGE_VERSION } from "./version.ts";
import {
  releaseDirectory, releaseError, releaseVersion, sha256, verifiedArtifacts, verifyManifest,
  type ReleaseManifest, type ReleaseRequest, type ReleaseServices,
} from "./release-manifest.ts";
import {
  assertReleaseRoot, exists, publishRelease, readReleaseMetadata,
  cleanupOwnedStage, ownedStageIntents, stageRelease, verifyPartialStage, verifyReleaseTree, withReleaseLock, type OwnedStage,
} from "./release-store.ts";

export type { ReleaseManifest, ReleaseServices } from "./release-manifest.ts";

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

function selectedRelease(input: InstallInput, ledger: Ledger, services: ReleaseServices): void {
  const selected = ledger.install?.release;
  if (!selected || !ledger.install) return;
  const directory = join(input.stateDir, selected.directory);
  const { manifestBytes, signatureBytes } = readReleaseMetadata(directory);
  if (sha256(manifestBytes) !== selected.manifestDigest || selected.directory !== releaseDirectory(ledger.install.packageVersion, selected.manifestDigest)
    || ledger.install.platform !== osLabel(input.platform) || ledger.install.arch !== input.arch) throw releaseError();
  const manifest = verifyManifest(manifestBytes, signatureBytes, services.releaseTrust, {
    version: ledger.install.packageVersion, platform: input.platform, arch: input.arch, dataVersion: ledger.version,
  });
  verifyReleaseTree(directory, manifest, manifestBytes, signatureBytes);
}

function sameSelection(a: Ledger, b: Ledger): boolean {
  return JSON.stringify(a.install) === JSON.stringify(b.install);
}

function installPrepared(input: InstallInput, services: ReleaseServices): InstallResult {
  const ledger = localLedger(input.stateDir);
  if (input.release === undefined) {
    // A bootstrap invocation cannot replace an explicitly selected release with its own package version.
    if (ledger.install?.release) return result(ledger);
    const saved = updateLedger(input.stateDir, [], (current) => {
      if (current.install?.release) return;
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
  if (!releaseVersion(request.requestedVersion) || typeof request.sourceCommit !== "string") throw releaseError();
  const manifestBytes = Buffer.from(request.manifestBytes);
  const signatureBytes = Buffer.from(request.signatureBytes);
  const manifest = verifyManifest(manifestBytes, signatureBytes, services.releaseTrust, {
    version: request.requestedVersion, sourceCommit: request.sourceCommit,
    platform: input.platform, arch: input.arch, dataVersion: ledger.version,
  });
  const artifacts = verifiedArtifacts(request, manifest);
  const manifestDigest = sha256(manifestBytes);
  const relative = releaseDirectory(manifest.version, manifestDigest);
  const destination = join(input.stateDir, relative);
  assertReleaseRoot(input.stateDir);
  selectedRelease(input, ledger, services);
  if (ledger.install?.packageVersion === manifest.version && ledger.install.release?.manifestDigest !== undefined
    && ledger.install.release.manifestDigest !== manifestDigest) throw releaseError();
  if (ledger.install?.release?.manifestDigest === manifestDigest) return result(ledger);
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
    const initial = localLedger(input.stateDir);
    if (!sameSelection(initial, ledger)) throw releaseError();
    selectedRelease(input, initial, services);
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
  selectedRelease(input, before, services);
  const stages = recoverableStages(input, before, services);
  const lease = stateLeaseStatus(input.stateDir, "release");
  if (lease === "active") throw releaseError();
  if (stages.length === 0 && lease !== "dead") return result(before);
  return withReleaseLock(input.stateDir, true, () => {
    assertReleaseRoot(input.stateDir);
    const ledger = localLedger(input.stateDir);
    if (!sameSelection(before, ledger)) throw releaseError();
    selectedRelease(input, ledger, services);
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
