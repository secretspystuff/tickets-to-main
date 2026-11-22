import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assignmentDirectory } from "./directory-identity.ts";
import { emptyLedger, ledgerPath, loadLedger } from "./ledger.ts";
import { releaseError } from "./release-manifest.ts";
import { assertReleaseRoot, exists } from "./release-store.ts";
import { observeStateLease, type LeaseObservation } from "./state-lease.ts";

type Dependencies = { observeWindowsOffer?: unknown; stageWindowsOffer?: unknown };
type Owners = { release: LeaseObservation; ledger: LeaseObservation };

function containingDirectory(path: string) {
  let confirmed = path;
  while (!exists(confirmed)) {
    const parent = dirname(confirmed);
    if (parent === confirmed) throw releaseError();
    confirmed = parent;
  }
  return assignmentDirectory(confirmed);
}

function readBoundary(stateDir: string) {
  assertReleaseRoot(stateDir);
  const releaseStore = join(stateDir, "releases");
  return {
    statePresent: exists(stateDir),
    containingDirectory: containingDirectory(stateDir),
    releaseDirectory: exists(releaseStore) ? assignmentDirectory(releaseStore) : null,
    ledgerPresent: exists(ledgerPath(stateDir)),
  };
}

function readLeases(stateDir: string, owners?: Owners) {
  const release = observeStateLease(stateDir, "release");
  const ledger = observeStateLease(stateDir, "ledger");
  if (owners) {
    if (release.state !== "active" || ledger.state !== "active" || !isDeepStrictEqual({ release, ledger }, owners)) throw releaseError();
  } else if (release.state === "active" || release.state === "dead"
    || ledger.state === "active" || ledger.state === "dead") throw releaseError();
  return { release, ledger };
}

export function readWindowsOfferFence(stateDir: string, dependencies: Dependencies, owners?: Owners) {
  const { observeWindowsOffer, stageWindowsOffer } = dependencies;
  if (typeof observeWindowsOffer !== "function" || typeof stageWindowsOffer !== "function") throw releaseError();
  const boundary = readBoundary(stateDir);
  const leases = readLeases(stateDir, owners);
  const loaded = loadLedger(stateDir);
  if (!loaded.ok && loaded.reason !== "missing") throw releaseError();
  const ledger = loaded.ok ? loaded.ledger : emptyLedger();
  if (!isDeepStrictEqual(readLeases(stateDir, owners), leases) || !isDeepStrictEqual(readBoundary(stateDir), boundary)
    || dependencies.observeWindowsOffer !== observeWindowsOffer
    || dependencies.stageWindowsOffer !== stageWindowsOffer) throw releaseError();
  const { version: dataVersion, install, workspace, boundWorkspaceIntents, nativePredecessor } = ledger;
  return {
    boundary, leases, dataVersion, install, workspace, boundWorkspaceIntents, nativePredecessor,
    observeWindowsOffer, stageWindowsOffer,
  };
}

export function windowsOfferClaimIsCurrent(stateDir: string, dependencies: Dependencies,
  expected: ReturnType<typeof readWindowsOfferFence>, owners: Owners): boolean {
  const actual = readWindowsOfferFence(stateDir, dependencies, owners);
  let boundary = expected.boundary;
  if (!boundary.statePresent) {
    const prior = boundary.containingDirectory;
    const current = actual.boundary.containingDirectory;
    if (!isDeepStrictEqual(assignmentDirectory(prior.path), prior)
      || !isDeepStrictEqual(current.ancestors.slice(-prior.ancestors.length), prior.ancestors)) return false;
    boundary = { ...boundary, statePresent: true, containingDirectory: current };
  }
  return isDeepStrictEqual(actual, { ...expected, boundary, leases: owners });
}
