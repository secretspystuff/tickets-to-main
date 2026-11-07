import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

/** The state directory itself must be a real directory, not a link. Parents may be links. */
export function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const listed = lstatSync(dir);
  if (listed.isSymbolicLink() || !listed.isDirectory()) {
    throw new StateError("The state directory is a link. Nothing was saved.");
  }
  chmodSync(dir, 0o700);
  const mode = lstatSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new StateError("The state directory is not private. Nothing was saved.");
}

export function assertPrivateDirectory(dir: string): void {
  const listed = lstatSync(dir);
  if (listed.isSymbolicLink() || !listed.isDirectory()) {
    throw new StateError("The state directory is a link. Nothing was saved.");
  }
  const mode = listed.mode & 0o777;
  if ((mode & 0o077) !== 0) throw new StateError("The state directory is not private. Nothing was saved.");
}

function replaceExistingLeaf(path: string): void {
  try {
    const listed = lstatSync(path);
    if (!listed.isSymbolicLink() && !listed.isFile()) {
      throw new StateError("The local record path is not a file. It was not saved.");
    }
    unlinkSync(path);
  } catch (error) {
    if (error instanceof StateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Write a file in place only when the destination is not a link. A planted temporary link is removed, not followed. */
export function writePrivateFile(path: string, text: string): void {
  ensurePrivateDirectory(dirname(path));
  try {
    if (lstatSync(path).isSymbolicLink()) throw new StateError("The local record is a link. It was not saved.");
  } catch (error) {
    if (error instanceof StateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.tmp`;
  replaceExistingLeaf(temporary);
  let fd: number;
  try {
    fd = openSync(temporary, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StateError("The local record path is not a file. It was not saved.");
    throw error;
  }
  try {
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
  const created = lstatSync(temporary);
  if (created.isSymbolicLink() || (created.mode & 0o077) !== 0) {
    unlinkSync(temporary);
    throw new StateError("The local record would be readable by other users. It was not saved.");
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
