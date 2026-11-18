import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, lstatSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunOptions, CommandRunner } from "../src/command.ts";
import type { Io } from "../src/cli.ts";
import { MemoryCustody } from "../src/custody.ts";
import { assertPrivateAccess, ensurePrivateDirectory } from "../src/fs-safety.ts";

export function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "tickets-to-main-"));
  if (process.platform === "win32") ensurePrivateDirectory(path);
  return path;
}

export function differentBirth(birth: string): string {
  return birth.startsWith("darwin:") ? birth.replace(/[0-9]{4}$/, (year) => String(Number(year) - 1)) : birth + "0";
}

export function assertPrivateMode(path: string, mode: number): void {
  if (process.platform === "win32") assert.doesNotThrow(() => assertPrivateAccess(path));
  else assert.equal(lstatSync(path).mode & 0o777, mode);
}

export function makePublic(path: string, mode = 0o755): void {
  if (process.platform !== "win32") { chmodSync(path, mode); return; }
  const dir = lstatSync(path).isDirectory();
  const result = spawnSync(join(process.env.SystemRoot!, "System32", "icacls.exe"),
    [path, "/grant:r", dir ? "*S-1-1-0:(OI)(CI)RX" : "*S-1-1-0:R"], { encoding: "utf8", windowsHide: true, shell: false });
  assert.equal(result.status, 0, "the adverse fixture must grant Everyone read access");
}

export function fileSymlink(target: string, path: string): void {
  try { symlinkSync(target, path, "file"); return; }
  catch (error) { if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
  // WSL creates the actual file reparse point when Windows denies the developer-mode privilege.
  const mounted = (value: string) => {
    assert.match(value, /^[A-Za-z]:[\\/]/);
    return "/mnt/" + value[0]!.toLowerCase() + value.slice(2).replaceAll("\\", "/");
  };
  const result = spawnSync("wsl.exe", ["--exec", "/bin/ln", "-s", "--", mounted(target), mounted(path)], { encoding: "utf8", windowsHide: true, shell: false });
  assert.equal(result.status, 0, "the fixture requires an actual file symlink");
  assert.equal(lstatSync(path).isSymbolicLink(), true);
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function io(overrides: Partial<Io> = {}): Io & { out: string; err: string } {
  const state = { out: "", err: "" };
  const value: Io & { out: string; err: string } = {
    stdout: (line) => {
      state.out += line;
    },
    stderr: (line) => {
      state.err += line;
    },
    env: {},
    platform: "linux",
    arch: "x64",
    homedir: "/home/fixture",
    hostname: "fixture-computer",
    now: () => Date.parse("2026-10-25T00:00:00.000Z"),
    runner: { run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }) },
    secretTool: false,
    custody: new MemoryCustody(),
    get out() {
      return state.out;
    },
    set out(value: string) {
      state.out = value;
    },
    get err() {
      return state.err;
    },
    set err(value: string) {
      state.err = value;
    },
    ...overrides,
  };
  return value;
}

/** Fixture connections stay behind the test switch, even when a custody double is injected. */
export function harnessIo(overrides: Partial<Io> = {}) {
  return io({ ...overrides, env: { TICKETS_TO_MAIN_TEST_CUSTODY: "1", ...overrides.env } });
}

export function scriptedRunner(handler: (argv: readonly string[], options: CommandRunOptions) => CommandResult): CommandRunner & { calls: { argv: readonly string[]; options: CommandRunOptions }[] } {
  const calls: { argv: readonly string[]; options: CommandRunOptions }[] = [];
  return {
    calls,
    run(argv, options) {
      calls.push({ argv, options });
      return Promise.resolve(handler(argv, options));
    },
  };
}
