import { spawn } from "node:child_process";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cwd = realpathSync(process.cwd());
const parent = realpathSync(tmpdir());
const fixture = dirname(cwd);
const mode = process.argv[2];
if (process.platform !== "win32" || process.argv.length > 3 || ![undefined, "parent", "reader"].includes(mode) || basename(cwd) !== "workspace"
  || dirname(fixture) !== parent || !basename(fixture).startsWith("ttm-owned-transport-")) process.exit(1);

async function waitFor(path) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("The fixture did not release its pipe.");
    await pause(10);
  }
}

if (mode === "reader") {
  writeFileSync("reader-started", "", { flag: "wx" });
  await waitFor("finish-reader");
} else if (mode === "parent") {
  const reader = spawn(realpathSync(process.execPath), [fileURLToPath(import.meta.url), "reader"], {
    cwd, stdio: [0, "ignore", "ignore"], windowsHide: true, shell: false, detached: true,
  });
  reader.unref();
  await waitFor("reader-started");
  process.stdout.write("reader-ready\n");
  await waitFor("finish-parent");
} else {
  process.stdin.on("data", (bytes) => appendFileSync("received.bin", bytes));
  process.stdout.write("reader-ready\n");
}
