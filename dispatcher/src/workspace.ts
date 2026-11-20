import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, rmdirSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { assignmentAllowsOwnedClaimUnderLease, journalDigest, type Intent } from "./assignment-journal.ts";
import { assignmentDirectory, directoryBirthTime, type DirectoryIdentity } from "./directory-identity.ts";
import { StateError, assertPrivateAccess, ensurePrivateDirectory } from "./fs-safety.ts";
import { loadLedger, updateLedger, type Ledger } from "./ledger.ts";
import type { WindowsOwnedNativeProcess } from "./native-transport.ts";
import { currentProcessOwner, observeRecordedPid } from "./process-identity.ts";

type OriginalObserver = Pick<WindowsOwnedNativeProcess, "observeOriginalGroup">;
type OwnedClaim = {
  state: DirectoryIdentity;
  stateBirth: bigint;
  checkout: DirectoryIdentity;
  checkoutBirth: bigint;
  generation: string;
  intent: Intent;
  observe: OriginalObserver["observeOriginalGroup"];
};
const ownedClaims = new WeakMap<object, OwnedClaim>();

function nested(parent: string, child: string): boolean {
  const root = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(root);
}

function requireInstalled(stateDir: string): Ledger {
  const loaded = loadLedger(stateDir);
  if (!loaded.ok) {
    throw new StateError(loaded.reason === "unsafe"
      ? "The state directory is not private. Nothing was saved."
      : "The local record could not be read.");
  }
  if (!loaded.ledger.install) throw new StateError("Tickets to Main is not installed. Run tickets-to-main install.");
  return loaded.ledger;
}

export function processAlive(pid: number): boolean {
  const observation = observeRecordedPid(pid);
  if (observation === "unavailable" || observation === "none") {
    throw new StateError("The recorded writer could not be checked. Its workspace was preserved.");
  }
  return observation === "present";
}

function separateDirectory(stateDir: string, workspace: string): string {
  if (!isAbsolute(stateDir) || !isAbsolute(workspace)) {
    throw new StateError("The workspace path must be absolute.");
  }
  const stateReal = realpathSync(stateDir);
  const requested = resolve(workspace);
  if (nested(stateReal, requested) || nested(requested, stateReal)) {
    throw new StateError("The workspace must be separate from the state directory. It was not prepared.");
  }
  let created = false;
  try {
    const listed = lstatSync(requested);
    if (listed.isSymbolicLink()) throw new StateError("The workspace is a link. It was not prepared.");
  } catch (error) {
    if (error instanceof StateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    created = true;
  }
  ensurePrivateDirectory(requested);
  const createdReal = realpathSync(requested);
  if (nested(stateReal, createdReal) || nested(createdReal, stateReal)) {
    if (created) {
      try {
        rmdirSync(createdReal);
      } catch {
        // The refused directory is left only when it cannot be removed.
      }
    }
    throw new StateError("The workspace must be separate from the state directory. It was not prepared.");
  }
  return createdReal;
}

function assertCurrentWorkspace(stateDir: string, path: string): void {
  const listed = lstatSync(path);
  if (listed.isSymbolicLink() || !listed.isDirectory()) {
    throw new StateError("The workspace is a link. The writer was not recorded.");
  }
  assertPrivateAccess(path);
  const stateReal = realpathSync(stateDir);
  const workspaceReal = realpathSync(path);
  if (nested(stateReal, workspaceReal) || nested(workspaceReal, stateReal)) {
    throw new StateError("The workspace must be separate from the state directory. The writer was not recorded.");
  }
}

export function prepareWorkspace(stateDir: string, workspace: string, pidAlive: (pid: number) => boolean): string[] {
  const ledger = requireInstalled(stateDir);
  const held = ledger.workspace?.writerPid;
  if (typeof held === "number" && pidAlive(held)) {
    throw new StateError("A writer already holds this workspace.");
  }
  const path = separateDirectory(stateDir, workspace);
  updateLedger(stateDir, [], (current) => {
    if (!current.install || (current.workspace?.writerPid !== null && current.workspace?.writerPid !== undefined && pidAlive(current.workspace.writerPid))) throw new StateError("A writer already holds this workspace.");
    current.workspace = { path, writerPid: null, qualified: false };
  });
  return ["Workspace prepared. It is unqualified."];
}

export function claimWorkspace(stateDir: string, pid: number, pidAlive: (pid: number) => boolean): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new StateError("The writer id is not usable.");
  updateLedger(stateDir, [], (ledger) => {
    if (!ledger.install) throw new StateError("Tickets to Main is not installed. Run tickets-to-main install.");
    const workspace = ledger.workspace;
    if (!workspace) throw new StateError("No workspace is prepared.");
    assertCurrentWorkspace(stateDir, workspace.path);
    if (workspace.writerPid !== null && workspace.writerPid !== pid && pidAlive(workspace.writerPid)) throw new StateError("A writer already holds this workspace.");
    ledger.workspace = { path: workspace.path, writerPid: pid, qualified: false };
  });
  return ["Writer recorded. The workspace is unqualified."];
}

export function releaseWorkspace(stateDir: string): string[] {
  updateLedger(stateDir, [], (ledger) => {
    if (!ledger.install) throw new StateError("Tickets to Main is not installed. Run tickets-to-main install.");
    if (!ledger.workspace) throw new StateError("No workspace is prepared.");
    ledger.workspace = { path: ledger.workspace.path, writerPid: null, qualified: false };
  });
  return ["Writer released."];
}

export function bindOwnedWorkspaceClaim(stateDir: string, prepared: Intent, original: OriginalObserver): object | null {
  try {
    const intent = structuredClone(prepared);
    const owner = currentProcessOwner();
    if (intent.version !== 4 || intent.pid !== owner.pid || !owner.birth || intent.birth !== owner.birth) return null;
    const state = assignmentDirectory(stateDir);
    const stateBirth = directoryBirthTime(state);
    const generation = randomUUID();
    const observe = original.observeOriginalGroup.bind(original);
    let claim: OwnedClaim | undefined;
    updateLedger(state.path, [], ledger => {
      const current = ledger.workspace;
      if (!ledger.install || !current || current.writerPid !== intent.pid || current.claimGeneration !== undefined
        || directoryBirthTime(state) !== stateBirth) return;
      assertCurrentWorkspace(state.path, current.path);
      const checkout = assignmentDirectory(current.path);
      if (checkout.path !== current.path || journalDigest(checkout.path) !== intent.workspaceDigest
        || journalDigest(checkout.identity) !== intent.aliasDigest
        || !assignmentAllowsOwnedClaimUnderLease(state.path, intent, "prepared")) return;
      const checkoutBirth = directoryBirthTime(checkout);
      ledger.workspace = { ...current, claimGeneration: generation };
      claim = { state, stateBirth, checkout, checkoutBirth, generation, intent, observe };
    });
    if (!claim) return null;
    const authority = Object.freeze({});
    ownedClaims.set(authority, claim);
    return authority;
  } catch { return null; }
}

export async function releaseOwnedWorkspaceClaim(authority: object): Promise<{ state: "released" | "held" }> {
  const claim = ownedClaims.get(authority);
  if (!claim) return { state: "held" };
  try {
    const sample = await claim.observe();
    if (sample?.state !== "verified" || !Object.is(sample.activeProcesses, 0)) return { state: "held" };
    let cleared = false;
    updateLedger(claim.state.path, [], ledger => {
      const current = ledger.workspace;
      if (!ledger.install || !current || current.path !== claim.checkout.path || current.writerPid !== claim.intent.pid
        || current.claimGeneration !== claim.generation || directoryBirthTime(claim.state) !== claim.stateBirth) return;
      assertCurrentWorkspace(claim.state.path, current.path);
      const checkout = assignmentDirectory(current.path);
      if (checkout.path !== claim.checkout.path || checkout.identity !== claim.checkout.identity
        || directoryBirthTime(checkout) !== claim.checkoutBirth
        || !assignmentAllowsOwnedClaimUnderLease(claim.state.path, claim.intent, "terminal")) return;
      ledger.workspace = { path: current.path, writerPid: null, qualified: false };
      cleared = true;
    });
    if (cleared) {
      ownedClaims.delete(authority);
      return { state: "released" };
    }
  } catch { /* Unavailable observation or local evidence supplies no release authority. */ }
  return { state: "held" };
}
