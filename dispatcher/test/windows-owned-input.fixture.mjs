import { appendFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";

const cwd = realpathSync(process.cwd());
const parent = realpathSync(tmpdir());
const fixture = dirname(cwd);
if (process.platform !== "win32" || process.argv.length !== 2 || basename(cwd) !== "workspace"
  || dirname(fixture) !== parent || !basename(fixture).startsWith("ttm-owned-transport-")) process.exit(1);

process.stdin.on("data", (bytes) => appendFileSync("received.bin", bytes));
process.stdout.write("reader-ready\n");
