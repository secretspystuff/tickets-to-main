import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateAccess, assertPrivateDirectory } from "./fs-safety.ts";
import { withStateLease } from "./state-lease.ts";

type Journal = "assignment-intents.jsonl" | "artifact-preparation.jsonl";
export type JournalWriteOptions = { existingOnly?: boolean; stateIsCurrent?: () => boolean };
const MAX_BYTES = 8 * 1024 * 1024;
const unavailable = () => new Error("The private journal is unavailable. Saved work was preserved.");

function withJournalFile<T>(stateDir: string, journal: Journal, mode: "inspect" | "read" | "append" | "append-existing",
  operation: (fd: number, created: boolean) => T): T {
  if (journal !== "assignment-intents.jsonl" && journal !== "artifact-preparation.jsonl") throw unavailable();
  const path = join(stateDir, journal);
  let exists = true;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) throw unavailable();
    assertPrivateAccess(path);
  } catch (error) {
    if (mode !== "append" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  const access = mode === "inspect" ? constants.O_RDONLY : mode === "read" ? constants.O_RDWR : constants.O_RDWR | constants.O_APPEND;
  const flags = access
    | (exists ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  try {
    const actual = fstatSync(fd);
    const listed = lstatSync(path);
    if (!actual.isFile() || listed.isSymbolicLink() || actual.ino !== listed.ino || actual.dev !== listed.dev
      || actual.nlink !== 1 || actual.size > MAX_BYTES) throw unavailable();
    assertPrivateAccess(path);
    return operation(fd, !exists);
  } finally { closeSync(fd); }
}

export function inspectPrivateJournal<History>(stateDir: string, journal: Journal, decode: (text: string) => History): History {
  assertPrivateDirectory(stateDir);
  return withJournalFile(stateDir, journal, "inspect", fd => decode(readFileSync(fd, "utf8")));
}

// The caller's ledger transaction keeps this history stable through the claim update.
export function readExistingPrivateJournalUnderLease<History>(stateDir: string, journal: Journal,
  decode: (text: string) => History): History {
  assertPrivateDirectory(stateDir);
  return withJournalFile(stateDir, journal, "read", fd => {
    const history = decode(readFileSync(fd, "utf8"));
    fsyncSync(fd);
    return history;
  });
}

export function withPrivateJournal<History, Entry, Result>(stateDir: string, journal: Journal,
  decode: (text: string) => History, operation: (history: History, append: (entry: Entry) => void) => Result,
  options?: JournalWriteOptions): Result {
  if (journal !== "assignment-intents.jsonl" && journal !== "artifact-preparation.jsonl") throw unavailable();
  assertPrivateDirectory(stateDir);
  return withStateLease(stateDir, "ledger", () => {
    if (options?.stateIsCurrent && !options.stateIsCurrent()) throw unavailable();
    return withJournalFile(stateDir, journal, options?.existingOnly ? "append-existing" : "append", (fd, created) => {
      const text = readFileSync(fd, "utf8");
      const history = decode(text);
      // A previous holder may have died after writing bytes but before their flush completed.
      fsyncSync(fd);
      if (created && process.platform !== "win32") {
        const directory = openSync(stateDir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      let length = Buffer.byteLength(text);
      return operation(history, entry => {
        const bytes = JSON.stringify(entry) + "\n";
        length += Buffer.byteLength(bytes);
        if (length > MAX_BYTES) throw unavailable();
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      });
    });
  });
}
