import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateAccess, assertPrivateDirectory } from "./fs-safety.ts";
import { withStateLease } from "./state-lease.ts";

type Journal = "assignment-intents.jsonl" | "artifact-preparation.jsonl";
const MAX_BYTES = 8 * 1024 * 1024;
const unavailable = () => new Error("The private journal is unavailable. Saved work was preserved.");

export function withPrivateJournal<History, Entry, Result>(stateDir: string, journal: Journal,
  decode: (text: string) => History, operation: (history: History, append: (entry: Entry) => void) => Result): Result {
  if (journal !== "assignment-intents.jsonl" && journal !== "artifact-preparation.jsonl") throw unavailable();
  assertPrivateDirectory(stateDir);
  return withStateLease(stateDir, "ledger", () => {
    const path = join(stateDir, journal);
    let exists = true;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_BYTES) throw unavailable();
      assertPrivateAccess(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
    }
    const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | (exists ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const actual = fstatSync(fd);
      const listed = lstatSync(path);
      if (!actual.isFile() || listed.isSymbolicLink() || actual.ino !== listed.ino || actual.dev !== listed.dev
        || actual.nlink !== 1 || actual.size > MAX_BYTES) throw unavailable();
      assertPrivateAccess(path);
      const text = readFileSync(fd, "utf8");
      const history = decode(text);
      // A previous holder may have died after writing bytes but before their flush completed.
      fsyncSync(fd);
      if (!exists && process.platform !== "win32") {
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
    } finally { closeSync(fd); }
  });
}
