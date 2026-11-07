import { homedir, hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommandRunner } from "./command.ts";
import { processRunner } from "./command.ts";
import { refuseUnserved, showCatalog } from "./coordination.ts";
import { connectPoll, connectStart } from "./connect.ts";
import { discoverCodex, type CodexInterfaceId } from "./adapters/codex.ts";
import { CODEX_INTERFACE_RULE } from "./adapters/codex.ts";
import {
  processSecretTool,
  secretToolPresent,
  type Custody,
} from "./custody.ts";
import { openCustody } from "./custody.ts";
import { rememberCodex } from "./discover.ts";
import { install } from "./install.ts";
import { loadLedger, saveLedger } from "./ledger.ts";
import { computerName } from "./platform.ts";
import { renderStatus, statusOf } from "./status.ts";
import { claimWorkspace, prepareWorkspace, processAlive, releaseWorkspace } from "./workspace.ts";

export type Io = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  arch: string;
  homedir: string;
  hostname: string;
  now: () => number;
  runner: CommandRunner;
  secretTool: boolean;
  custody?: Custody;
  pidAlive?: (pid: number) => boolean;
};

export const USAGE = [
  "tickets-to-main install [--state <dir>]",
  "tickets-to-main connect start [--state <dir>] [--computer <name>] [--fixture <path>]",
  "tickets-to-main connect poll [--state <dir>] [--fixture <path>]",
  "tickets-to-main coordination show",
  "tickets-to-main coordination send <command>",
  "tickets-to-main status [--state <dir>]",
  "tickets-to-main health [--state <dir>]",
  "tickets-to-main tool discover codex --interface cli|app-server [--state <dir>]",
  "tickets-to-main workspace prepare --workspace <dir> [--state <dir>]",
  "tickets-to-main workspace claim [--pid <id>] [--state <dir>]",
  "tickets-to-main workspace release [--state <dir>]",
].join("\n");

function write(io: Io, lines: string[]): void {
  io.stdout(`${lines.join("\n")}\n`);
}

function valueAfter(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

function withoutFlags(argv: string[], names: readonly string[]): string[] {
  const skip = new Set<number>();
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index < 0) continue;
    skip.add(index);
    skip.add(index + 1);
  }
  return argv.filter((_, index) => !skip.has(index));
}

function stateDir(io: Io, argv: string[]): string {
  const chosen = valueAfter(argv, "--state") ?? io.env.TICKETS_TO_MAIN_STATE ?? join(io.homedir, ".tickets-to-main");
  if (!isAbsolute(chosen)) throw new Error("The state directory must be an absolute path.");
  return chosen;
}

function custodyFor(io: Io): Custody {
  if (io.custody) return io.custody;
  return openCustody(io.env, io.secretTool, processSecretTool(), io.platform);
}

function computer(io: Io, argv: string[]): string {
  const chosen = valueAfter(argv, "--computer") ?? io.hostname;
  const name = computerName(chosen);
  if (!name) throw new Error("The computer name must be 1 to 64 letters, numbers, dots, underscores or hyphens.");
  return name;
}

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const command = argv[0];
    if (command === "install") return await runInstall(argv.slice(1), io);
    if (command === "status") return await runStatus(argv.slice(1), io);
    if (command === "health") return await runHealth(argv.slice(1), io);
    if (command === "connect") return await runConnect(argv.slice(1), io);
    if (command === "coordination") return runCoordination(argv.slice(1), io);
    if (command === "tool") return await runTool(argv.slice(1), io);
    if (command === "workspace") return await runWorkspace(argv.slice(1), io);
    write(io, [USAGE]);
    return command === undefined || command === "--help" || command === "help" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tickets to Main could not finish.";
    io.stderr(`${message}\n`);
    return 1;
  }
}

async function runInstall(argv: string[], io: Io): Promise<number> {
  const rest = withoutFlags(argv, ["--state"]);
  if (rest.length > 0) throw new Error(USAGE);
  const result = install({
    stateDir: stateDir(io, argv),
    platform: io.platform,
    arch: io.arch,
    nowIso: new Date(io.now()).toISOString(),
  });
  write(io, result.lines);
  return 0;
}

async function runStatus(argv: string[], io: Io): Promise<number> {
  const rest = withoutFlags(argv, ["--state"]);
  if (rest.length > 0) throw new Error(USAGE);
  const snapshot = await statusOf(stateDir(io, argv), custodyFor(io), io.pidAlive ?? processAlive);
  write(io, snapshot.lines);
  return snapshot.exitCode;
}

async function runHealth(argv: string[], io: Io): Promise<number> {
  const code = await runStatus(argv, io);
  return code === 0 ? 0 : 1;
}

function runCoordination(argv: string[], io: Io): number {
  const action = argv[0];
  if (action === "show" && argv.length === 1) {
    write(io, showCatalog().lines);
    return 0;
  }
  if (action === "send" && argv.length === 2) {
    const command = argv[1];
    if (command === undefined) throw new Error(USAGE);
    write(io, refuseUnserved(command).lines);
    return 1;
  }
  throw new Error(USAGE);
}

async function runConnect(argv: string[], io: Io): Promise<number> {
  const action = argv[0];
  const flags = argv.slice(1);
  const rest = withoutFlags(flags, ["--state", "--computer", "--fixture"]);
  if (rest.length > 0) throw new Error(USAGE);
  const dir = stateDir(io, flags);
  const custody = custodyFor(io);
  const allowFixture = io.env.TICKETS_TO_MAIN_TEST_CUSTODY === "1";
  if (action === "start") {
    const result = await connectStart({
      stateDir: dir,
      computer: computer(io, flags),
      fixturePath: valueAfter(flags, "--fixture"),
      allowFixture,
      custody,
      nowIso: new Date(io.now()).toISOString(),
    });
    write(io, result.lines);
    return result.exitCode;
  }
  if (action === "poll") {
    const result = await connectPoll({
      stateDir: dir,
      fixturePath: valueAfter(flags, "--fixture"),
      allowFixture,
      custody,
      nowMs: io.now(),
    });
    write(io, result.lines);
    return result.exitCode;
  }
  throw new Error(USAGE);
}

function alive(io: Io): (pid: number) => boolean {
  return io.pidAlive ?? processAlive;
}

function writerPid(argv: string[]): number {
  const text = valueAfter(argv, "--pid");
  if (text === null) return process.pid;
  if (!/^[1-9][0-9]{0,9}$/.test(text)) throw new Error("The writer id is not usable.");
  return Number(text);
}

async function runWorkspace(argv: string[], io: Io): Promise<number> {
  const action = argv[0];
  const flags = argv.slice(1);
  if (action === "prepare") {
    const rest = withoutFlags(flags, ["--state", "--workspace"]);
    if (rest.length > 0) throw new Error(USAGE);
    const workspace = valueAfter(flags, "--workspace");
    if (!workspace) throw new Error("Missing value for --workspace.");
    write(io, prepareWorkspace(stateDir(io, flags), workspace, alive(io)));
    return 0;
  }
  if (action === "claim") {
    const rest = withoutFlags(flags, ["--state", "--pid"]);
    if (rest.length > 0) throw new Error(USAGE);
    write(io, claimWorkspace(stateDir(io, flags), writerPid(flags), alive(io)));
    return 0;
  }
  if (action === "release") {
    const rest = withoutFlags(flags, ["--state"]);
    if (rest.length > 0) throw new Error(USAGE);
    write(io, releaseWorkspace(stateDir(io, flags)));
    return 0;
  }
  throw new Error(USAGE);
}

async function runTool(argv: string[], io: Io): Promise<number> {
  if (argv[0] !== "discover" || argv[1] !== "codex") throw new Error(USAGE);
  const flags = argv.slice(2);
  const rest = withoutFlags(flags, ["--state", "--interface"]);
  if (rest.length > 0) throw new Error(USAGE);
  const interfaceId = valueAfter(flags, "--interface");
  if (interfaceId !== "cli" && interfaceId !== "app-server") throw new Error("Codex cli and Codex app-server are separate interfaces. Pass --interface cli or --interface app-server.");
  const dir = stateDir(io, flags);
  const loaded = loadLedger(dir);
  if (!loaded.ok || !loaded.ledger.install) throw new Error("Tickets to Main is not installed. Run tickets-to-main install.");
  const discovery = await discoverCodex(interfaceId as CodexInterfaceId, io.runner);
  rememberCodex(loaded.ledger, discovery);
  saveLedger(dir, loaded.ledger, []);
  const label = discovery.claim.qualification === "documented"
    ? "documented"
    : discovery.claim.qualification;
  const experimental = discovery.claim.experimental === true ? " experimental" : "";
  write(io, [
    `Codex ${interfaceId}: ${label}${experimental}.`,
    CODEX_INTERFACE_RULE,
    "Ready for an assignment: no",
  ]);
  return 0;
}

export function defaultIo(): Io {
  return {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    homedir: homedir(),
    hostname: hostname(),
    now: () => Date.now(),
    runner: processRunner(),
    secretTool: process.platform === "linux" && secretToolPresent(),
  };
}
