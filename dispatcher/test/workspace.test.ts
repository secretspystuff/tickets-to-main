import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { SecretToolCustody, type SecretToolRunner, BOARD_KEY_ACCOUNT } from "../src/custody.ts";
import { parseLedger, updateLedger, type ToolRecord } from "../src/ledger.ts";
import { assertPrivateMode, harnessIo, io, removeDir, tempDir } from "./helpers.ts";

const FIXTURE = new URL("../fixtures/device-login.json", import.meta.url);

function persistentTool(): SecretToolRunner & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    run(argv, input) {
      const account = argv.at(-1) ?? "";
      if (argv[1] === "store") {
        values.set(account, input);
        return Promise.resolve({ code: 0, stdout: "" });
      }
      if (argv[1] === "lookup") {
        const secret = values.get(account);
        if (secret === undefined) return Promise.resolve({ code: 1, stdout: "" });
        return Promise.resolve({ code: 0, stdout: `${secret}\n` });
      }
      if (argv[1] === "clear") {
        values.delete(account);
        return Promise.resolve({ code: 0, stdout: "" });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    },
  };
}

async function approve(dir: string, custody: SecretToolCustody): Promise<void> {
  const context = harnessIo({ custody });
  await run(["install", "--state", dir], context);
  await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", fileURLToPath(FIXTURE)], context);
  const pending = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:00.000Z") });
  await run(["connect", "poll", "--state", dir, "--fixture", fileURLToPath(FIXTURE)], pending);
  const approved = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:06.000Z") });
  const code = await run(["connect", "poll", "--state", dir, "--fixture", fileURLToPath(FIXTURE)], approved);
  assert.equal(code, 0, approved.err);
}

test("a new process reads the key back from the keychain port", async () => {
  const dir = tempDir();
  const tool = persistentTool();
  const first = new SecretToolCustody(tool);
  try {
    await approve(dir, first);
    const second = new SecretToolCustody(tool);
    const status = harnessIo({ custody: second });
    const code = await run(["status", "--state", dir], status);
    assert.equal(code, 0);
    assert.match(status.out, /Signed in: yes/);
    assert.match(status.out, /Keychain: secret-tool, unqualified/);
    assert.equal(status.out.includes("tp_fixture_key_not_a_real_grant"), false);
    assert.equal(readFileSync(join(dir, "ledger.json"), "utf8").includes("tp_"), false);
    assert.equal(await second.get(BOARD_KEY_ACCOUNT), "tp_fixture_key_not_a_real_grant");
  } finally {
    removeDir(dir);
  }
});

test("a failed keychain clear leaves the connection waiting", async () => {
  const dir = tempDir();
  const values = new Map<string, string>();
  let clearAttempted = false;
  const tool: SecretToolRunner = {
    run(argv, input) {
      const account = argv.at(-1) ?? "";
      if (argv[1] === "store") {
        values.set(account, input);
        return Promise.resolve({ code: 0, stdout: "" });
      }
      if (argv[1] === "clear") {
        clearAttempted = true;
        return Promise.resolve({ code: 1, stdout: "" });
      }
      if (argv[1] === "lookup" && account === "device-code" && clearAttempted) {
        return Promise.resolve({ code: 1, stdout: "" });
      }
      if (argv[1] === "lookup") {
        const secret = values.get(account);
        return Promise.resolve(secret === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: `${secret}\n` });
      }
      return Promise.resolve({ code: 1, stdout: "" });
    },
  };
  const custody = new SecretToolCustody(tool);
  try {
    const context = harnessIo({ custody });
    await run(["install", "--state", dir], context);
    await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", fileURLToPath(FIXTURE)], context);
    await run(["connect", "poll", "--state", dir, "--fixture", fileURLToPath(FIXTURE)], harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:00.000Z") }));
    const failed = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:06.000Z") });
    const code = await run(["connect", "poll", "--state", dir, "--fixture", fileURLToPath(FIXTURE)], failed);
    assert.equal(code, 1);
    assert.match(failed.err, /did not remove the secret/);
    const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { connection: { phase: string } };
    assert.equal(ledger.connection.phase, "pending");
    assert.equal(values.has("device-code"), true);
    assert.equal(values.has("board-key"), false);
  } finally {
    removeDir(dir);
  }
});

test("an echoed clear during approval does not store the board key", async () => {
  const dir = tempDir();
  const values = new Map<string, string>();
  const tool: SecretToolRunner = {
    run(argv, input) {
      const account = argv.at(-1) ?? "";
      if (argv[1] === "store") {
        values.set(account, input);
        return Promise.resolve({ code: 0, stdout: "" });
      }
      if (argv[1] === "lookup") {
        const secret = values.get(account);
        return Promise.resolve(secret === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: `${secret}\n` });
      }
      if (argv[1] === "clear") return Promise.resolve({ code: 0, stdout: `${values.get(account) ?? ""}\n` });
      return Promise.resolve({ code: 1, stdout: "" });
    },
  };
  const custody = new SecretToolCustody(tool);
  try {
    const context = harnessIo({ custody });
    await run(["install", "--state", dir], context);
    await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", fileURLToPath(FIXTURE)], context);
    await run(["connect", "poll", "--state", dir, "--fixture", fileURLToPath(FIXTURE)], harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:00.000Z") }));
    const failed = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:06.000Z") });
    const code = await run(["connect", "poll", "--state", dir, "--fixture", fileURLToPath(FIXTURE)], failed);
    assert.equal(code, 1);
    assert.match(failed.err, /echoed a secret/);
    const ledger = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { connection: { phase: string } };
    assert.equal(ledger.connection.phase, "pending");
    assert.equal(values.has("board-key"), false);
    assert.equal(values.has("device-code"), true);
  } finally {
    removeDir(dir);
  }
});

test("an echoed clear is refused", async () => {
  const tool: SecretToolRunner = {
    run(argv) {
      if (argv[1] === "clear") return Promise.resolve({ code: 0, stdout: "tp_fixture_key_not_a_real_grant\n" });
      return Promise.resolve({ code: 1, stdout: "" });
    },
  };
  await assert.rejects(new SecretToolCustody(tool).delete("board-key"), /echoed a secret/);
});

test("a workspace stays outside the state directory and admits one live writer", async () => {
  const dir = tempDir();
  const workspace = tempDir();
  const scratch = tempDir();
  const alive = new Set<number>();
  try {
    const context = io({ pidAlive: (pid) => alive.has(pid) });
    await run(["install", "--state", dir], context);
    const inside = await run(["workspace", "prepare", "--state", dir, "--workspace", join(dir, "nested")], context);
    assert.equal(inside, 1);
    assert.match(context.err, /separate from the state directory/);
    assert.equal(readdirSync(dir).includes("nested"), false);
    const linked = join(scratch, "linked");
    mkdirSync(join(scratch, "target"));
    symlinkSync(join(scratch, "target"), linked, "junction");
    context.err = "";
    const link = await run(["workspace", "prepare", "--state", dir, "--workspace", linked], context);
    assert.equal(link, 1);
    assert.match(context.err, /link/);
    context.err = "";
    const prepared = await run(["workspace", "prepare", "--state", dir, "--workspace", workspace], context);
    assert.equal(prepared, 0, context.err);
    assert.match(context.out, /Workspace prepared\. It is unqualified\./);
    assertPrivateMode(workspace, 0o700);
    assert.equal(readdirSync(workspace).length, 0);
    alive.add(40);
    context.out = "";
    const claimed = await run(["workspace", "claim", "--state", dir, "--pid", "40"], context);
    assert.equal(claimed, 0, context.err);
    context.out = "";
    const blocked = await run(["workspace", "claim", "--state", dir, "--pid", "41"], context);
    assert.equal(blocked, 1);
    assert.match(context.err, /already holds/);
    const status = io({ pidAlive: (pid) => alive.has(pid) });
    await run(["status", "--state", dir], status);
    assert.match(status.out, /Workspace: prepared, unqualified/);
    assert.match(status.out, /Ready for an assignment: no/);
    alive.delete(40);
    const stopped = io({ pidAlive: () => false });
    await run(["status", "--state", dir], stopped);
    const statusAfterRootDisappeared = stopped.out;
    const replaced = await run(["workspace", "claim", "--state", dir, "--pid", "41"], stopped);
    assert.equal(replaced, 0, stopped.err);
    stopped.out = "";
    const released = await run(["workspace", "release", "--state", dir], stopped);
    assert.equal(released, 0);
    assert.match(stopped.out, /Writer released\./);
    const again = io();
    await run(["install", "--state", dir], again);
    const kept = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { workspace: { path: string; writerPid: null; qualified: false } };
    assert.equal(kept.workspace.path, realpathSync(workspace));
    assert.equal(kept.workspace.writerPid, null);
    assert.equal(kept.workspace.qualified, false);
    assert.match(status.out, /^Writer: unknown \(including helpers\)$/m);
    assert.match(status.out, /^Recorded writer PID: present \(process identity unverified\)$/m);
    assert.match(statusAfterRootDisappeared, /^Writer: unknown \(including helpers\)$/m);
    assert.match(statusAfterRootDisappeared, /^Recorded writer PID: absent$/m);
  } finally {
    removeDir(dir);
    removeDir(workspace);
    removeDir(scratch);
  }
});

test("workspace claim and preparation require a definite absence of the recorded PID", async t => {
  const recordedPid = 42017;
  const candidatePid = 42018;
  const latestPid = 42019;
  const diagnostic = "fabricated process diagnostic";
  const failures = {
    EIO: Object.assign(new Error(diagnostic), { code: "EIO" }),
    EPERM: Object.assign(new Error(diagnostic), { code: "EPERM" }),
    ESRCH: Object.assign(new Error(diagnostic), { code: "ESRCH" }),
    invalid: Object.assign(new Error(diagnostic), { code: "ERR_INVALID_ARG_TYPE" }),
    unknown: Object.assign(new Error(diagnostic), { code: "UNEXPECTED_PROCESS_ERROR" }),
    noCode: new Error(diagnostic),
    nonError: diagnostic,
  };
  type Failure = keyof typeof failures;
  type Scenario = {
    name: string;
    action: "claim" | "prepare";
    observations: [Failure, ...Failure[]];
    held: boolean;
    changeWriter?: true;
  };
  const unavailable = [
    { name: "I/O failure", failure: "EIO" },
    { name: "invalid observation", failure: "invalid" },
    { name: "unknown error code", failure: "unknown" },
    { name: "error without a code", failure: "noCode" },
    { name: "non-Error thrown value", failure: "nonError" },
  ] as const;
  const cases: Scenario[] = [
    { name: "claim holds when the recorded PID is present", action: "claim", observations: ["EPERM"], held: true },
    { name: "claim can replace a definitely absent PID", action: "claim", observations: ["ESRCH"], held: false },
    { name: "prepare holds when the recorded PID is present", action: "prepare", observations: ["EPERM"], held: true },
    { name: "prepare can replace an absent record after a second check", action: "prepare", observations: ["ESRCH", "ESRCH"], held: false },
    { name: "prepare observes the changed writer under the lease", action: "prepare", observations: ["ESRCH", "EPERM"], held: true, changeWriter: true },
    ...unavailable.flatMap(({ name, failure }): Scenario[] => [
      { name: `claim holds on ${name}`, action: "claim", observations: [failure], held: true },
      { name: `prepare preflight holds on ${name}`, action: "prepare", observations: [failure], held: true },
      { name: `prepare locked recheck holds on ${name}`, action: "prepare", observations: ["ESRCH", failure], held: true },
    ]),
  ];

  for (const entry of cases) {
    await t.test(entry.name, async probe => {
      const dir = tempDir();
      const scratch = tempDir();
      const workspace = join(scratch, "existing");
      const candidate = join(scratch, "candidate");
      const ledgerPath = join(dir, "ledger.json");
      const leaseRoot = join(dir, ".state-leases", "ledger");
      try {
        const setup = io();
        assert.equal(await run(["install", "--state", dir], setup), 0, setup.err);
        assert.equal(await run(["workspace", "prepare", "--state", dir, "--workspace", workspace], setup), 0, setup.err);
        assert.equal(await run(["workspace", "claim", "--state", dir, "--pid", String(recordedPid)], setup), 0, setup.err);
        let ledger = readFileSync(ledgerPath);
        assert.equal(parseLedger(ledger.toString("utf8"))?.workspace?.writerPid, recordedPid);
        const workFile = join(workspace, "local-work.txt");
        writeFileSync(workFile, "fabricated work to preserve\n");
        if (entry.held && entry.observations.length === 2) mkdirSync(candidate);
        const originalDirectories = readdirSync(scratch).sort();
        const originalEpochs = new Set(readdirSync(leaseRoot));
        const calls: { pid: number; signal: unknown; unreleasedOwners: unknown[] }[] = [];
        probe.mock.method(process, "kill", (pid: number, signal: unknown) => {
          const index = calls.length;
          const unreleasedOwners = readdirSync(leaseRoot)
            .filter(epoch => /^epoch-[0-9]+$/.test(epoch) && !originalEpochs.has(epoch))
            .flatMap(epoch => {
              const path = join(leaseRoot, epoch);
              const files = readdirSync(path);
              if (!files.includes("owner.json") || files.includes("released") || files.includes("released.prepared")) return [];
              const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
              return [{ pid: owner.pid, namespace: owner.namespace }];
            });
          calls.push({ pid, signal, unreleasedOwners });
          if (entry.changeWriter && index === 0) {
            updateLedger(dir, [], current => {
              assert.ok(current.workspace);
              current.workspace.writerPid = latestPid;
            });
            ledger = readFileSync(ledgerPath);
          }
          throw failures[entry.observations[index] ?? entry.observations.at(-1)!];
        });
        const args = entry.action === "claim" ? ["--pid", String(candidatePid)] : ["--workspace", candidate];
        const context = io();
        const exitCode = await run(["workspace", entry.action, "--state", dir, ...args], context);
        assert.equal(readFileSync(workFile, "utf8"), "fabricated work to preserve\n");
        assert.doesNotMatch(context.out + context.err, /fabricated process diagnostic/);

        const expectedCalls = entry.observations.map((_, index) => ({
          pid: entry.changeWriter && index > 0 ? latestPid : recordedPid,
          signal: 0,
          unreleasedOwners: entry.action === "claim" || index > 0 ? [{ pid: process.pid, namespace: "ledger" }] : [],
        }));
        if (entry.held) {
          assert.deepEqual({
            exitCode,
            ledgerPreserved: readFileSync(ledgerPath).equals(ledger),
            workspaceDirectories: readdirSync(scratch).sort(),
            calls,
          }, {
            exitCode: 1,
            ledgerPreserved: true,
            workspaceDirectories: originalDirectories,
            calls: expectedCalls,
          });
          assert.equal(context.out, "");
          assert.notEqual(context.err, "");
          if (entry.changeWriter) assert.equal(parseLedger(ledger.toString("utf8"))?.workspace?.writerPid, latestPid);
        } else {
          assert.deepEqual(calls, expectedCalls);
          assert.equal(exitCode, 0, context.err);
          assert.deepEqual(parseLedger(readFileSync(ledgerPath, "utf8"))?.workspace,
            entry.action === "claim"
              ? { path: realpathSync(workspace), writerPid: candidatePid, qualified: false }
              : { path: realpathSync(candidate), writerPid: null, qualified: false });
        }
      } finally {
        removeDir(dir);
        removeDir(scratch);
      }
    });
  }
});

test("status and health report the recorded PID separately from writer custody", async t => {
  const dir = tempDir();
  const workspace = tempDir();
  const ledgerPath = join(dir, "ledger.json");
  const writerPid = 42017;
  try {
    const setup = io();
    assert.equal(await run(["install", "--state", dir], setup), 0, setup.err);
    const installed = JSON.parse(readFileSync(ledgerPath, "utf8"));

    await t.test("no prepared workspace", async probe => {
      const observe = probe.mock.method(process, "kill", () => true);
      for (const command of ["status", "health"]) {
        const context = io();
        assert.equal(await run([command, "--state", dir], context), 0, context.err);
        assert.match(context.out, /^Workspace: none$/m);
        assert.match(context.out, /^Writer: none$/m);
      }
      assert.equal(observe.mock.callCount(), 0);
    });

    const documentedCli = {
      vendor: "codex", interfaceId: "cli", qualification: "documented", experimental: "unknown",
      version: null, limit: "fabricated documented interface",
    } satisfies ToolRecord;
    const cases = [
      { name: "no recorded PID", pid: null, error: null, observation: "none" },
      { name: "observed PID", pid: writerPid, error: null, observation: "present (process identity unverified)" },
      { name: "permission denied", pid: writerPid, error: "EPERM", observation: "present (process identity unverified)" },
      { name: "absent PID", pid: writerPid, error: "ESRCH", observation: "absent" },
      { name: "failed observation", pid: writerPid, error: "EIO", observation: "unavailable" },
    ] as const;

    for (const entry of cases) {
      await t.test(entry.name, async probe => {
        const bytes = Buffer.from(JSON.stringify({
          ...installed,
          tools: [documentedCli],
          workspace: { path: workspace, writerPid: entry.pid, qualified: false },
        }) + "\n");
        writeFileSync(ledgerPath, bytes);
        const stateEntries = readdirSync(dir);
        const calls: [pid: number, signal: unknown][] = [];
        probe.mock.method(process, "kill", (pid: number, signal: unknown) => {
          calls.push([pid, signal]);
          if (entry.error) throw Object.assign(new Error("fabricated process diagnostic"), { code: entry.error });
          return true;
        });
        const lines: string[][] = [];
        for (const command of ["status", "health"]) {
          const context = io();
          assert.equal(await run([command, "--state", dir], context), 0, context.err);
          assert.equal(context.err, "");
          lines.push(context.out.trimEnd().split("\n"));
        }
        assert.deepEqual(calls, entry.pid === null ? [] : [[entry.pid, 0], [entry.pid, 0]]);
        assert.deepEqual(readFileSync(ledgerPath), bytes);
        assert.deepEqual(readdirSync(dir), stateEntries);
        assert.deepEqual(readdirSync(workspace), []);
        assert.deepEqual(lines[0], lines[1]);
        for (const output of lines) {
          assert.ok(output.includes("Installed: yes"));
          assert.ok(output.includes("Signed in: no"));
          assert.ok(output.includes("Codex cli: documented"));
          assert.ok(output.includes("Codex app-server: undiscovered"));
          assert.ok(output.includes("Compatible: no"));
          assert.ok(output.includes("Ready for an assignment: no"));
          assert.ok(output.includes("Workspace: prepared, unqualified"));
          assert.ok(output.includes("Health: local record ok"));
          assert.ok(output.every(line => !line.includes("fabricated process diagnostic")));
          assert.deepEqual(output.filter(line => line.startsWith("Writer:") || line.startsWith("Recorded writer PID:")), [
            "Writer: unknown (including helpers)",
            `Recorded writer PID: ${entry.observation}`,
          ]);
        }
      });
    }
  } finally {
    removeDir(dir);
    removeDir(workspace);
  }
});

test("a ledger written before workspaces still loads", () => {
  const dir = tempDir();
  try {
    const body = {
      version: 1,
      install: {
        packageVersion: "0.1.0",
        platform: "early-linux-probe",
        arch: "x64",
        installedAt: "2026-10-25T00:00:00.000Z",
        startup: "not-registered",
        signedInstallers: "not-qualified",
      },
      connection: null,
      tools: [],
    };
    writeFileSync(join(dir, "ledger.json"), `${JSON.stringify(body)}\n`, { mode: 0o600 });
    chmodSync(join(dir, "ledger.json"), 0o600);
    const ledger = parseLedger(readFileSync(join(dir, "ledger.json"), "utf8"));
    assert.equal(ledger?.workspace, null);
    const qualified = structuredClone(body) as { workspace?: { path: string; writerPid: null; qualified: boolean } };
    qualified.workspace = { path: "/tmp/work", writerPid: null, qualified: true };
    assert.equal(parseLedger(JSON.stringify(qualified)), null);
  } finally {
    removeDir(dir);
  }
});
