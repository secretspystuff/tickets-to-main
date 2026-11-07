import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertPrivateDirectory, StateError } from "./fs-safety.ts";

type Namespace = "ledger" | "release";
type Owner = { version: 1; namespace: Namespace; pid: number; nonce: string };
export type LeaseHooks = { onCheckpoint?: (phase: "observed-stale" | "claimed" | "release-marker-writing", epoch: bigint) => void };
export type LeaseState = "none" | "released" | "active" | "dead";

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw unavailable(); }
}

function unavailable(): StateError { return new StateError("The local state is busy or could not be locked safely. Its work was preserved."); }

function flushDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function write(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function read(path: string): Buffer {
  const listed = lstatSync(path);
  if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1 || listed.size > 1024 || (listed.mode & 0o077) !== 0) throw unavailable();
  return readFileSync(path);
}

function rootOf(stateDir: string, namespace: Namespace, create: boolean): string | null {
  if (!isAbsolute(stateDir) || (namespace !== "ledger" && namespace !== "release")) throw unavailable();
  if (!present(stateDir)) {
    if (!create) return null;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  assertPrivateDirectory(stateDir);
  const parent = join(stateDir, ".state-leases");
  const root = join(parent, namespace);
  for (const path of [parent, root]) {
    if (!present(path)) {
      if (!create) return null;
      mkdirSync(path, { mode: 0o700 });
      flushDirectory(path === parent ? stateDir : parent);
    }
    assertPrivateDirectory(path);
  }
  return root;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; return true; }
}

function latest(root: string, namespace: Namespace): { epoch: bigint; state: LeaseState } {
  let epoch = -1n;
  for (const name of readdirSync(root)) {
    if (!/^epoch-(?:0|[1-9][0-9]*)$/.test(name)) continue;
    const value = BigInt(name.slice(6));
    if (value > epoch) epoch = value;
  }
  if (epoch < 0n) return { epoch, state: "none" };
  const directory = join(root, `epoch-${epoch}`);
  assertPrivateDirectory(directory);
  if (readdirSync(directory).some((name) => name !== "owner.json" && name !== "released" && name !== "released.prepared")) throw unavailable();
  const bytes = read(join(directory, "owner.json"));
  const owner = JSON.parse(bytes.toString("utf8")) as Owner;
  if (owner === null || typeof owner !== "object" || Object.keys(owner).length !== 4 || owner.version !== 1
    || owner.namespace !== namespace || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || typeof owner.nonce !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner.nonce)) throw unavailable();
  const released = join(directory, "released");
  if (present(released)) {
    if (!read(released).equals(bytes)) throw unavailable();
    return { epoch, state: "released" };
  }
  return { epoch, state: alive(owner.pid) ? "active" : "dead" };
}

export function stateLeaseStatus(stateDir: string, namespace: Namespace): LeaseState {
  try {
    const root = rootOf(stateDir, namespace, false);
    return root === null ? "none" : latest(root, namespace).state;
  } catch { throw unavailable(); }
}

export function withStateLease<T>(stateDir: string, namespace: Namespace, operation: () => T, hooks: LeaseHooks = {}): T {
  let root: string;
  let previous: { epoch: bigint; state: LeaseState };
  try {
    root = rootOf(stateDir, namespace, true)!;
    previous = latest(root, namespace);
    if (previous.state === "active") throw unavailable();
  } catch { throw unavailable(); }
  if (previous.state === "dead") hooks.onCheckpoint?.("observed-stale", previous.epoch);
  const epoch = previous.epoch + 1n;
  const nonce = randomUUID();
  const candidate = join(root, `.claim-${nonce}`);
  const destination = join(root, `epoch-${epoch}`);
  const bytes = Buffer.from(JSON.stringify({ version: 1, namespace, pid: process.pid, nonce } satisfies Owner));
  mkdirSync(candidate, { mode: 0o700 });
  try {
    write(join(candidate, "owner.json"), bytes);
    flushDirectory(candidate);
    // Every published owner stays nonempty forever, so a stale contender cannot replace its directory by rename.
    renameSync(candidate, destination);
    flushDirectory(root);
  } catch {
    if (present(candidate)) {
      const path = join(candidate, "owner.json");
      if (present(path) && read(path).equals(bytes)) unlinkSync(path);
      rmdirSync(candidate);
    }
    throw unavailable();
  }
  try {
    hooks.onCheckpoint?.("claimed", epoch);
    return operation();
  } finally {
    if (!read(join(destination, "owner.json")).equals(bytes)) throw unavailable();
    const prepared = join(destination, "released.prepared");
    const fd = openSync(prepared, "wx", 0o600);
    try {
      const middle = Math.floor(bytes.length / 2);
      writeFileSync(fd, bytes.subarray(0, middle));
      fsyncSync(fd);
      hooks.onCheckpoint?.("release-marker-writing", epoch);
      writeFileSync(fd, bytes.subarray(middle));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    // An incomplete prepared marker grants no ownership transition; only the fully flushed atomic publication releases this epoch.
    if (!read(prepared).equals(bytes)) throw unavailable();
    renameSync(prepared, join(destination, "released"));
    flushDirectory(destination);
  }
}
