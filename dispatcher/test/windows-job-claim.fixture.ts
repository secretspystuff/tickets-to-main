import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StateError } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { loadLedger } from "../src/ledger.ts";
import { claimWorkspace, prepareWorkspace, processAlive, releaseWorkspace } from "../src/workspace.ts";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const [action, requested] = process.argv.slice(2);

function run(): string {
  if (process.platform !== "win32" || process.argv.length !== 4 || !requested) throw new Error("Unavailable.");
  const fixture = realpathSync(requested);
  if (dirname(fixture) !== root || !basename(fixture).startsWith("ttm-job-drain-") || realpathSync(process.cwd()) !== fixture) {
    throw new Error("Outside fixture.");
  }
  const state = join(fixture, "state");
  const workspace = join(fixture, "workspace");
  const owner = process.ppid;
  const writer = () => {
    const loaded = loadLedger(state);
    if (!loaded.ok || loaded.ledger.workspace?.path !== workspace || loaded.ledger.workspace.qualified) throw new Error("Wrong workspace.");
    return loaded.ledger.workspace.writerPid;
  };

  if (action === "prepare") {
    install({ stateDir: state, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
    prepareWorkspace(state, workspace, processAlive);
    claimWorkspace(state, owner, processAlive);
    if (writer() !== owner) throw new Error("Wrong owner.");
    return "owner-recorded";
  }
  if (action === "claim") {
    const before = writer();
    if (before !== null && before !== owner) throw new Error("Wrong owner.");
    try { claimWorkspace(state, process.pid, processAlive); }
    catch (error) {
      if (error instanceof StateError && error.message === "A writer already holds this workspace." && writer() === owner) return "held";
      throw error;
    }
    if (writer() !== process.pid) throw new Error("Wrong claimant.");
    return "claimed";
  }
  if (action === "release") {
    if (writer() !== owner) throw new Error("Wrong owner.");
    releaseWorkspace(state);
    if (writer() !== null) throw new Error("Release not recorded.");
    return "released";
  }
  throw new Error("Unknown fixture action.");
}

try { process.stdout.write(JSON.stringify({ outcome: run() })); }
catch { process.exitCode = 1; }
