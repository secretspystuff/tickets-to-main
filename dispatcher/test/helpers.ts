import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunOptions, CommandRunner } from "../src/command.ts";
import type { Io } from "../src/cli.ts";
import { MemoryCustody } from "../src/custody.ts";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "tickets-to-main-"));
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
