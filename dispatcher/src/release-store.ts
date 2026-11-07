import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { withStateLease } from "./state-lease.ts";
import { assertPrivateDirectory, writePrivateFile } from "./fs-safety.ts";
import { MANIFEST_FILE, MAX_MANIFEST_BYTES, SIGNATURE_FILE, releaseError, sha256, type ReleaseManifest, type ReleaseServices } from "./release-manifest.ts";

export function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw releaseError(); }
}

export function assertRealPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw releaseError();
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (!exists(current)) break;
    const listed = lstatSync(current);
    if (listed.isSymbolicLink() || !listed.isDirectory()) throw releaseError();
  }
}

export function assertReleaseRoot(stateDir: string): void {
  assertRealPath(stateDir);
  if (exists(stateDir)) assertPrivateDirectory(stateDir);
  const root = join(stateDir, "releases");
  if (exists(root)) {
    assertPrivateDirectory(root);
    if (realpathSync(root) !== root) throw releaseError();
  }
}

export function flushDirectory(path: string): void {
  // Directory fsync is not supported by the Windows Node filesystem API; that platform remains unqualified.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function writeReleaseFile(path: string, bytes: Uint8Array, executable = false): void {
  const fd = openSync(path, "wx", executable ? 0o700 : 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

export function readReleaseFile(path: string, limit: number): Buffer {
  const listed = lstatSync(path);
  if (!listed.isFile() || listed.isSymbolicLink() || listed.nlink !== 1 || listed.size > limit || (listed.mode & 0o077) !== 0) throw releaseError();
  return readFileSync(path);
}

export function readReleaseMetadata(directory: string): { manifestBytes: Buffer; signatureBytes: Buffer } {
  assertPrivateDirectory(directory);
  return { manifestBytes: readReleaseFile(join(directory, MANIFEST_FILE), MAX_MANIFEST_BYTES), signatureBytes: readReleaseFile(join(directory, SIGNATURE_FILE), 64) };
}

export function verifyReleaseTree(directory: string, manifest: ReleaseManifest, manifestBytes: Uint8Array, signatureBytes: Uint8Array): void {
  assertPrivateDirectory(directory);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const directories = new Set<string>();
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
  }
  const found = new Set<string>();
  const walk = (base: string, prefix: string): void => {
    assertPrivateDirectory(base);
    for (const name of readdirSync(base)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const path = join(base, name);
      const listed = lstatSync(path);
      if (listed.isSymbolicLink()) throw releaseError();
      if (listed.isDirectory()) {
        if (!directories.has(relative)) throw releaseError();
        walk(path, relative);
      } else if (relative === MANIFEST_FILE || relative === SIGNATURE_FILE) {
        const bytes = relative === MANIFEST_FILE ? manifestBytes : signatureBytes;
        if (!readReleaseFile(path, relative === MANIFEST_FILE ? MAX_MANIFEST_BYTES : 64).equals(Buffer.from(bytes))) throw releaseError();
        found.add(relative);
      } else {
        const file = expected.get(relative);
        if (!file || !listed.isFile() || listed.size !== file.size || sha256(readReleaseFile(path, file.size)) !== file.sha256
          || (process.platform !== "win32" && ((listed.mode & 0o100) !== 0) !== file.executable)) throw releaseError();
        found.add(relative);
      }
    }
  };
  walk(directory, "");
  if (found.size !== expected.size + 2 || !found.has(MANIFEST_FILE) || !found.has(SIGNATURE_FILE)
    || manifest.files.some((file) => !found.has(file.path))) throw releaseError();
}

type StageIntent = { version: 1; id: string; manifestDigest: string; phase: "writing" | "cleanup" | "complete" };
export type OwnedStage = { directory: string; marker: StageIntent; manifest: ReleaseManifest; manifestBytes: Buffer; signatureBytes: Buffer };
const INTENT_FILE = "intent.json";
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function intentsRoot(stateDir: string): string { return join(stateDir, ".release-intents"); }
function intentDirectory(stateDir: string, id: string): string {
  if (!ID.test(id)) throw releaseError();
  return join(intentsRoot(stateDir), id);
}
function stagePath(stateDir: string, id: string): string { return join(stateDir, "releases", ".stage-" + id); }

function updateIntent(stateDir: string, marker: StageIntent, phase: StageIntent["phase"]): void {
  const directory = intentDirectory(stateDir, marker.id);
  assertPrivateDirectory(directory);
  writePrivateFile(join(directory, INTENT_FILE), JSON.stringify({ ...marker, phase }) + "\n");
  flushDirectory(directory);
}

function prepareIntent(stateDir: string, id: string, manifestBytes: Uint8Array, signatureBytes: Uint8Array): void {
  const root = intentsRoot(stateDir);
  if (!exists(root)) mkdirSync(root, { mode: 0o700 });
  assertPrivateDirectory(root);
  const prepared = join(root, ".prepare-" + id);
  mkdirSync(prepared, { mode: 0o700 });
  const marker: StageIntent = { version: 1, id, manifestDigest: sha256(manifestBytes), phase: "writing" };
  writeReleaseFile(join(prepared, INTENT_FILE), Buffer.from(JSON.stringify(marker)));
  writeReleaseFile(join(prepared, MANIFEST_FILE), manifestBytes);
  writeReleaseFile(join(prepared, SIGNATURE_FILE), signatureBytes);
  flushDirectory(prepared);
  renameSync(prepared, intentDirectory(stateDir, id));
  flushDirectory(root);
  flushDirectory(stateDir);
}

function writeArtifact(path: string, bytes: Buffer, executable: boolean, services: ReleaseServices): void {
  const fd = openSync(path, "wx", executable ? 0o700 : 0o600);
  const writeUntil = (from: number, end: number): void => {
    for (let offset = from; offset < end;) {
      const written = writeSync(fd, bytes, offset, end - offset);
      if (written < 1) throw releaseError();
      offset += written;
    }
  };
  try {
    const middle = Math.max(1, Math.floor(bytes.length / 2));
    if (bytes.length > 1) {
      writeUntil(0, middle);
      fsyncSync(fd);
      services.onReleaseFileCheckpoint?.("file-writing", path);
      writeUntil(middle, bytes.length);
    } else writeUntil(0, bytes.length);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function stageRelease(stateDir: string, manifest: ReleaseManifest, manifestBytes: Uint8Array, signatureBytes: Uint8Array, artifacts: Map<string, Buffer>, services: ReleaseServices): string {
  const root = join(stateDir, "releases");
  if (!exists(root)) mkdirSync(root, { mode: 0o700 });
  assertReleaseRoot(stateDir);
  const id = randomUUID();
  // Signed ownership survives before any stage file can be partly written or later removed.
  prepareIntent(stateDir, id, manifestBytes, signatureBytes);
  const stage = stagePath(stateDir, id);
  mkdirSync(stage, { mode: 0o700 });
  for (const file of manifest.files) {
    const path = join(stage, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeArtifact(path, artifacts.get(file.path)!, file.executable, services);
  }
  writeReleaseFile(join(stage, MANIFEST_FILE), manifestBytes);
  writeReleaseFile(join(stage, SIGNATURE_FILE), signatureBytes);
  const flush = (directory: string): void => {
    for (const name of readdirSync(directory)) if (lstatSync(join(directory, name)).isDirectory()) flush(join(directory, name));
    flushDirectory(directory);
  };
  flush(stage);
  flushDirectory(root);
  return stage;
}

export function publishRelease(stage: string, destination: string): void {
  if (exists(destination)) throw releaseError();
  renameSync(stage, destination);
  flushDirectory(dirname(destination));
  const stateDir = dirname(dirname(stage));
  const id = stage.slice(stage.lastIndexOf(".stage-") + 7);
  const marker = JSON.parse(readReleaseFile(join(intentDirectory(stateDir, id), INTENT_FILE), 1024).toString("utf8")) as StageIntent;
  updateIntent(stateDir, marker, "complete");
}

export function verifyPartialStage(stateDir: string, intent: OwnedStage): void {
  const path = stagePath(stateDir, intent.marker.id);
  if (!exists(path)) return;
  assertPrivateDirectory(path);
  const files = new Map(intent.manifest.files.map((file) => [file.path, file.size]));
  files.set(MANIFEST_FILE, MAX_MANIFEST_BYTES);
  files.set(SIGNATURE_FILE, 64);
  const directories = new Set<string>();
  for (const file of intent.manifest.files) {
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
  }
  const walk = (directory: string, prefix: string): void => {
    assertPrivateDirectory(directory);
    for (const name of readdirSync(directory)) {
      const relative = prefix ? prefix + "/" + name : name;
      const actual = join(directory, name);
      const entry = lstatSync(actual);
      if (entry.isSymbolicLink()) throw releaseError();
      if (entry.isDirectory()) {
        if (!directories.has(relative)) throw releaseError();
        walk(actual, relative);
      } else {
        const limit = files.get(relative);
        if (limit === undefined || !entry.isFile() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0 || entry.size > limit) throw releaseError();
      }
    }
  };
  walk(path, "");
}

export function ownedStageIntents(stateDir: string): Array<{ directory: string; marker: StageIntent; manifestBytes: Buffer; signatureBytes: Buffer }> {
  const root = intentsRoot(stateDir);
  if (!exists(root)) return [];
  assertRealPath(root);
  assertPrivateDirectory(root);
  const intents = [];
  for (const name of readdirSync(root)) {
    if (!ID.test(name)) continue;
    const directory = intentDirectory(stateDir, name);
    assertPrivateDirectory(directory);
    if (readdirSync(directory).some((entry) => ![INTENT_FILE, INTENT_FILE + ".tmp", MANIFEST_FILE, SIGNATURE_FILE].includes(entry))) throw releaseError();
    const value: unknown = JSON.parse(readReleaseFile(join(directory, INTENT_FILE), 1024).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw releaseError();
    const marker = value as StageIntent;
    if (Object.keys(marker).length !== 4 || marker.version !== 1 || marker.id !== name || typeof marker.manifestDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(marker.manifestDigest) || !["writing", "cleanup", "complete"].includes(marker.phase)) throw releaseError();
    if (marker.phase === "complete") continue;
    const metadata = readReleaseMetadata(directory);
    if (sha256(metadata.manifestBytes) !== marker.manifestDigest) throw releaseError();
    intents.push({ directory, marker, ...metadata });
  }
  return intents;
}

export function cleanupOwnedStage(stateDir: string, intent: OwnedStage, services: ReleaseServices): void {
  verifyPartialStage(stateDir, intent);
  updateIntent(stateDir, intent.marker, "cleanup");
  const path = stagePath(stateDir, intent.marker.id);
  if (exists(path)) {
    const directories = new Set<string>();
    for (const file of intent.manifest.files) {
      const parts = file.path.split("/");
      for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
      const actual = join(path, file.path);
      if (exists(actual)) {
        assertRealPath(dirname(actual));
        unlinkSync(actual);
        flushDirectory(dirname(actual));
        services.onReleaseFileCheckpoint?.("cleanup-file-deleted", actual);
      }
    }
    for (const name of [MANIFEST_FILE, SIGNATURE_FILE]) if (exists(join(path, name))) unlinkSync(join(path, name));
    for (const directory of [...directories].sort((a, b) => b.split("/").length - a.split("/").length)) if (exists(join(path, directory))) rmdirSync(join(path, directory));
    rmdirSync(path);
    flushDirectory(dirname(path));
  }
  // Retaining the authenticated intent avoids creating a new interruption window while deleting its ownership proof.
  updateIntent(stateDir, intent.marker, "complete");
}

export function withReleaseLock<T>(stateDir: string, _recover: boolean, operation: () => T): T {
  assertReleaseRoot(stateDir);
  return withStateLease(stateDir, "release", operation);
}
