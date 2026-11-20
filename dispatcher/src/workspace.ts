import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, rmdirSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { journalDigest, ownedTerminalUnderLease, preparedOwnedBindingsUnderLease, startAssignment, type Intent } from "./assignment-journal.ts";
import { isAppServerProcess, observeOwnedAppServerTerminal, type AppServerTerminalLineage, type CodexAssignmentHandle } from "./adapters/codex-app-server.ts";
import { assignmentDirectory, directoryBirthTime, type DirectoryIdentity } from "./directory-identity.ts";
import { StateError, assertPrivateAccess, ensurePrivateDirectory } from "./fs-safety.ts";
import { assertPublicRecord, loadLedger, updateLedger, type Ledger, type NativePredecessorRecord } from "./ledger.ts";
import { originalOwnedGroupObserver, type WindowsOwnedNativeProcess } from "./native-transport.ts";
import { currentProcessOwner, observeRecordedPid } from "./process-identity.ts";

type OriginalObserver = Pick<WindowsOwnedNativeProcess, "observeOriginalGroup">;
type AppServerPredecessorSource = { prompt: string; secrets: readonly string[]; readHandle(): CodexAssignmentHandle | null };
type OwnedClaim = {
  state: DirectoryIdentity;
  stateBirth: bigint;
  checkout: DirectoryIdentity;
  checkoutBirth: bigint;
  generation: string;
  intent: Intent;
  original: OriginalObserver;
  observe: OriginalObserver["observeOriginalGroup"];
  predecessor: { terminal(): AppServerTerminalLineage | null; secrets: readonly string[] } | null;
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

export function bindOwnedWorkspaceClaim(stateDir: string, prepared: Intent, original: OriginalObserver,
  stateIsCurrent?: () => boolean, appServer?: AppServerPredecessorSource): object | null {
  let committed: OwnedClaim | undefined;
  try {
    const intent = structuredClone(prepared);
    const owner = currentProcessOwner();
    if (intent.version !== 4 || intent.pid !== owner.pid || !owner.birth || intent.birth !== owner.birth) return null;
    const state = assignmentDirectory(stateDir);
    const stateBirth = directoryBirthTime(state);
    const generation = randomUUID();
    const observe = appServer ? originalOwnedGroupObserver(original) : original.observeOriginalGroup.bind(original);
    if (!observe) return null;
    const source = appServer && { prompt: appServer.prompt, secrets: [...appServer.secrets], readHandle: appServer.readHandle.bind(appServer) };
    let claim: OwnedClaim | undefined;
    updateLedger(state.path, [], ledger => {
      if (!ledger.install) throw new StateError("The recorded workspace is unavailable.");
      const current = ledger.workspace;
      if (!current || current.writerPid !== intent.pid || current.claimGeneration !== undefined
        || (stateIsCurrent && !stateIsCurrent()) || directoryBirthTime(state) !== stateBirth) return;
      assertCurrentWorkspace(state.path, current.path);
      const checkout = assignmentDirectory(current.path);
      if (checkout.path !== current.path || journalDigest(checkout.path) !== intent.workspaceDigest
        || journalDigest(checkout.identity) !== intent.aliasDigest) return;
      const bindings = preparedOwnedBindingsUnderLease(state.path, intent, ledger.boundWorkspaceIntents ?? []);
      if (!bindings) return;
      const checkoutBirth = directoryBirthTime(checkout);
      ledger.workspace = { ...current, claimGeneration: generation };
      ledger.boundWorkspaceIntents = bindings;
      const predecessor = source ? { secrets: source.secrets, terminal: () => observeOwnedAppServerTerminal(original,
        source.readHandle(), { assignmentId: intent.id, workspace: checkout.path, prompt: source.prompt }, source.secrets) } : null;
      claim = { state, stateBirth, checkout, checkoutBirth, generation, intent, original, observe, predecessor };
    }, () => { committed = claim; });
  } catch { /* A failed lease release does not discard a persisted original binding. */ }
  if (!committed) return null;
  const authority = Object.freeze({});
  ownedClaims.set(authority, committed);
  return authority;
}

function currentOwnedWorkspace(ledger: Ledger, claim: OwnedClaim): Ledger["workspace"] {
  if (!ledger.install) throw new StateError("The recorded workspace is unavailable.");
  const current = ledger.workspace;
  if (!current || current.path !== claim.checkout.path || current.writerPid !== claim.intent.pid
    || !ledger.boundWorkspaceIntents?.includes(claim.intent.id)
    || current.claimGeneration !== claim.generation || directoryBirthTime(claim.state) !== claim.stateBirth) return null;
  assertCurrentWorkspace(claim.state.path, current.path);
  const checkout = assignmentDirectory(current.path);
  return checkout.path === claim.checkout.path && checkout.identity === claim.checkout.identity
    && directoryBirthTime(checkout) === claim.checkoutBirth ? current : null;
}

export function startOwnedWorkspaceClaim(authority: object, at: number): void {
  const claim = ownedClaims.get(authority);
  if (!claim) throw new StateError("The recorded workspace is unavailable.");
  startAssignment(claim.state.path, claim.intent, at, () => {
    const loaded = loadLedger(claim.state.path);
    return loaded.ok && currentOwnedWorkspace(loaded.ledger, claim) !== null;
  });
}

export async function releaseOwnedWorkspaceClaim(authority: object): Promise<{ state: "released" | "held" }> {
  const claim = ownedClaims.get(authority);
  if (!claim) return { state: "held" };
  let committed = false;
  try {
    const sample = await claim.observe();
    if (sample?.state !== "verified" || !Object.is(sample.activeProcesses, 0)) return { state: "held" };
    updateLedger(claim.state.path, [], ledger => {
      const current = currentOwnedWorkspace(ledger, claim);
      if (!current) return;
      const terminal = ownedTerminalUnderLease(claim.state.path, claim.intent);
      if (!terminal) return;
      if (!claim.predecessor && isAppServerProcess(claim.original)) return;
      if (claim.predecessor) {
        const { id, sequence, requestDigest, bindingDigest, workspaceDigest, aliasDigest } = claim.intent;
        const lineage = claim.predecessor.terminal();
        if (!lineage || terminal.outcome !== "completed" || !aliasDigest) return;
        const receipt: NativePredecessorRecord = {
          assignmentId: id, sequence, requestDigest, bindingDigest, workspaceDigest, workspaceIdentityDigest: aliasDigest,
          workspaceBirthDigest: journalDigest(claim.checkoutBirth.toString()), claimGeneration: claim.generation,
          completedAt: terminal.at, nativeTerminal: lineage, originalJob: { state: "verified", activeProcesses: 0 },
        };
        assertPublicRecord(receipt, claim.predecessor.secrets);
        ledger.nativePredecessor = receipt;
      }
      ledger.workspace = { path: current.path, writerPid: null, qualified: false };
      const retained = (ledger.boundWorkspaceIntents ?? []).filter(id => id !== claim.intent.id);
      if (retained.length > 0) ledger.boundWorkspaceIntents = retained;
      else delete ledger.boundWorkspaceIntents;
    }, () => { committed = true; });
  } catch { /* A failed lease release does not undo a persisted claim clear. */ }
  if (!committed) return { state: "held" };
  ownedClaims.delete(authority);
  return { state: "released" };
}
