import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { SecretToolCustody, type SecretToolRunner, BOARD_KEY_ACCOUNT } from "../src/custody.ts";
import { parseLedger } from "../src/ledger.ts";
import { harnessIo, io, removeDir, tempDir } from "./helpers.ts";

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
  await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], context);
  const pending = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:00.000Z") });
  await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], pending);
  const approved = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:06.000Z") });
  const code = await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], approved);
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
    await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], context);
    await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:00.000Z") }));
    const failed = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:06.000Z") });
    const code = await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], failed);
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
    await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], context);
    await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:00.000Z") }));
    const failed = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:06.000Z") });
    const code = await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], failed);
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
    symlinkSync(join(scratch, "target"), linked);
    context.err = "";
    const link = await run(["workspace", "prepare", "--state", dir, "--workspace", linked], context);
    assert.equal(link, 1);
    assert.match(context.err, /link/);
    context.err = "";
    const prepared = await run(["workspace", "prepare", "--state", dir, "--workspace", workspace], context);
    assert.equal(prepared, 0, context.err);
    assert.match(context.out, /Workspace prepared\. It is unqualified\./);
    assert.equal((lstatSync(workspace).mode & 0o777), 0o700);
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
    assert.match(status.out, /Writer: running/);
    assert.match(status.out, /Ready for an assignment: no/);
    alive.delete(40);
    const stopped = io({ pidAlive: () => false });
    await run(["status", "--state", dir], stopped);
    assert.match(stopped.out, /Writer: stopped/);
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
  } finally {
    removeDir(dir);
    removeDir(workspace);
    removeDir(scratch);
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
