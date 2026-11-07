import { lstatSync, realpathSync, rmdirSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { StateError, ensurePrivateDirectory } from "./fs-safety.ts";
import { loadLedger, saveLedger, type Ledger } from "./ledger.ts";

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

/** True when the process exists. EPERM still means it exists. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  if ((listed.mode & 0o077) !== 0) throw new StateError("The workspace is not private. The writer was not recorded.");
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
  ledger.workspace = { path, writerPid: null, qualified: false };
  saveLedger(stateDir, ledger, []);
  return ["Workspace prepared. It is unqualified."];
}

export function claimWorkspace(stateDir: string, pid: number, pidAlive: (pid: number) => boolean): string[] {
  if (!Number.isInteger(pid) || pid <= 0) throw new StateError("The writer id is not usable.");
  const ledger = requireInstalled(stateDir);
  const workspace = ledger.workspace;
  if (!workspace) throw new StateError("No workspace is prepared.");
  assertCurrentWorkspace(stateDir, workspace.path);
  if (workspace.writerPid !== null && workspace.writerPid !== pid && pidAlive(workspace.writerPid)) {
    throw new StateError("A writer already holds this workspace.");
  }
  ledger.workspace = { path: workspace.path, writerPid: pid, qualified: false };
  saveLedger(stateDir, ledger, []);
  return ["Writer recorded. The workspace is unqualified."];
}

export function releaseWorkspace(stateDir: string): string[] {
  const ledger = requireInstalled(stateDir);
  if (!ledger.workspace) throw new StateError("No workspace is prepared.");
  ledger.workspace = { path: ledger.workspace.path, writerPid: null, qualified: false };
  saveLedger(stateDir, ledger, []);
  return ["Writer released."];
}
