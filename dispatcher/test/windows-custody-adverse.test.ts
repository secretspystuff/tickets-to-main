import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT } from "../src/custody.ts";
import { WindowsCredentialCustody, createWindowsCredentialRunner, windowsCredentialLaunch, windowsCredentialScope, type WindowsCredentialHost, type WindowsCredentialRunner } from "../src/windows-custody.ts";

const SCOPE = "a".repeat(64);
const OTHER_SCOPE = "b".repeat(64);
const PREFIX = "TicketsToMain/dispatcher/v1/";
const OWNER = "Tickets to Main Dispatcher v1";
const SENTINEL = "fabricated-custody-sentinel-Ω-🔒";
const PIN = { executable: "C:\\Program Files\\TicketsToMain\\credential-helper.exe", sha256: "f".repeat(64), releaseVerified: true };

type Credential = { flags: number; type: number; target: string; persist: number; username: string; blob: string };
type Request = { operation: "read" | "write" | "delete"; target?: string; type?: number; flags: number; credential?: Credential };
type Reply = { code: number | null; stdout: string; stderr: string; error?: string };
const response = (value: unknown): Reply => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const target = (account: string, scope = SCOPE) => `${PREFIX}${scope}/${account}`;
function credential(account = BOARD_KEY_ACCOUNT, secret = SENTINEL, scope = SCOPE): Credential {
  return { flags: 0, type: 1, target: target(account, scope), persist: 2, username: OWNER, blob: Buffer.from(secret, "utf8").toString("base64") };
}
function store() {
  const entries = new Map<string, Credential>();
  const calls: Request[] = [];
  const runner: WindowsCredentialRunner = { async run(input) {
    const request = JSON.parse(input) as Request;
    calls.push(request);
    if (request.operation === "write") {
      entries.set(request.credential!.target, structuredClone(request.credential!));
      return response({ status: "written" });
    }
    if (request.operation === "delete") return response({ status: entries.delete(request.target!) ? "deleted" : "not-found" });
    const found = entries.get(request.target!);
    return response(found ? { status: "found", credential: structuredClone(found) } : { status: "not-found" });
  } };
  return { runner, entries, calls };
}
async function safeFailure(action: () => Promise<unknown>, hidden = SENTINEL): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(inspect(error, { depth: 8 }).includes(hidden), false);
    assert.equal(inspect(error, { depth: 8 }).includes(Buffer.from(hidden).toString("base64")), false);
    return true;
  });
}

test("Windows custody uses only exact owned generic entries with machine-local persistence and verified writes", async () => {
  const fixture = store();
  const custody = new WindowsCredentialCustody(fixture.runner, SCOPE);
  assert.deepEqual(custody.describe(), { kind: "windows-credential-manager", qualified: false });
  await custody.put(BOARD_KEY_ACCOUNT, SENTINEL);
  assert.deepEqual(fixture.calls.map((value) => value.operation), ["read", "write", "read"]);
  assert.deepEqual(fixture.calls[0], { operation: "read", target: target(BOARD_KEY_ACCOUNT), type: 1, flags: 0 });
  assert.deepEqual(fixture.calls[1], { operation: "write", flags: 0, credential: credential() });
  assert.equal(await new WindowsCredentialCustody(fixture.runner, SCOPE).get(BOARD_KEY_ACCOUNT), SENTINEL);
  await custody.put(DEVICE_CODE_ACCOUNT, "fabricated-device-sentinel");
  assert.equal(fixture.entries.size, 2);
  assert.equal(fixture.calls.every((value) => value.operation === "write" ? value.credential!.target.startsWith(`${PREFIX}${SCOPE}/`) : value.target!.startsWith(`${PREFIX}${SCOPE}/`)), true);
});

test("separate Dispatcher scopes never overwrite or remove each other's entries", async () => {
  const fixture = store();
  const first = new WindowsCredentialCustody(fixture.runner, SCOPE);
  const second = new WindowsCredentialCustody(fixture.runner, OTHER_SCOPE);
  await first.put(BOARD_KEY_ACCOUNT, SENTINEL);
  await second.put(BOARD_KEY_ACCOUNT, "other-fabricated-sentinel");
  await second.delete(BOARD_KEY_ACCOUNT);
  assert.equal(await first.get(BOARD_KEY_ACCOUNT), SENTINEL);
  assert.equal(await second.get(BOARD_KEY_ACCOUNT), null);
});

test("unknown accounts and malformed scopes are refused before any helper call", async () => {
  const fixture = store();
  for (const scope of ["", "*", "../foreign", "A".repeat(64), "x".repeat(64), SCOPE + "x"]) {
    assert.throws(() => new WindowsCredentialCustody(fixture.runner, scope));
  }
  const custody = new WindowsCredentialCustody(fixture.runner, SCOPE);
  for (const account of ["", "*", "../board-key", "github", "CODEX", "BOARD-KEY", "board-key\0other"]) {
    await safeFailure(() => custody.get(account));
    await safeFailure(() => custody.put(account, SENTINEL));
    await safeFailure(() => custody.delete(account));
  }
  assert.equal(fixture.calls.length, 0);
});

test("UTF-8 credentials preserve exact text, reject invalid Unicode, and enforce the OS byte limit", async () => {
  const fixture = store();
  const custody = new WindowsCredentialCustody(fixture.runner, SCOPE);
  const secret = " leading Ω\n🔒 trailing ";
  await custody.put(BOARD_KEY_ACCOUNT, secret);
  assert.equal(await custody.get(BOARD_KEY_ACCOUNT), secret);
  await custody.put(BOARD_KEY_ACCOUNT, "x".repeat(2560));
  for (const invalid of ["", "x".repeat(2561), "Ω".repeat(1281), "\ud800"]) {
    const before = fixture.calls.length;
    await safeFailure(() => custody.put(BOARD_KEY_ACCOUNT, invalid));
    assert.equal(fixture.calls.length, before);
  }
});

for (const change of [
  { target: "git:https://example.invalid" }, { type: 2 }, { persist: 3 }, { flags: 4 }, { username: "other-program" },
]) {
  test(`mismatched entry metadata ${JSON.stringify(change)} cannot be read, overwritten or deleted`, async () => {
    const fixture = store();
    fixture.entries.set(target(BOARD_KEY_ACCOUNT), { ...credential(), ...change });
    const custody = new WindowsCredentialCustody(fixture.runner, SCOPE);
    await safeFailure(() => custody.get(BOARD_KEY_ACCOUNT));
    await safeFailure(() => custody.put(BOARD_KEY_ACCOUNT, "new-fabricated-sentinel"));
    await safeFailure(() => custody.delete(BOARD_KEY_ACCOUNT));
    assert.equal(fixture.calls.every((call) => call.operation === "read"), true);
    assert.equal(fixture.entries.size, 1);
  });
}

for (const blob of ["!bad-base64!", "eA", Buffer.from([0xff]).toString("base64"), "", Buffer.alloc(2561, 65).toString("base64")]) {
  test(`malformed stored blob ${blob.length} bytes is refused without deleting the entry`, async () => {
    const fixture = store();
    fixture.entries.set(target(BOARD_KEY_ACCOUNT), { ...credential(), blob });
    const custody = new WindowsCredentialCustody(fixture.runner, SCOPE);
    await safeFailure(() => custody.get(BOARD_KEY_ACCOUNT));
    assert.equal(fixture.entries.size, 1);
    assert.equal(fixture.calls.some((call) => call.operation === "delete"), false);
  });
}

test("only explicit not-found is absence; access, session, native and helper errors fail closed", async () => {
  assert.equal(await new WindowsCredentialCustody({ run: async () => response({ status: "not-found" }) }, SCOPE).get(BOARD_KEY_ACCOUNT), null);
  for (const bad of [
    response({ status: "error", code: 5 }), response({ status: "error", code: 1312 }), response({ status: "error", code: 87 }),
    { code: 1, stdout: "", stderr: "" }, { code: null, stdout: "", stderr: "", error: SENTINEL },
    { code: 0, stdout: "", stderr: "" }, { code: 0, stdout: SENTINEL, stderr: "" },
  ]) {
    const custody = new WindowsCredentialCustody({ run: async () => bad }, SCOPE);
    await safeFailure(() => custody.get(BOARD_KEY_ACCOUNT));
    await safeFailure(() => custody.put(BOARD_KEY_ACCOUNT, SENTINEL));
    await safeFailure(() => custody.delete(BOARD_KEY_ACCOUNT));
  }
});

for (const bad of [
  "{broken}", "{}", "[]", "null", '"text"', '{"status":"not-found","unexpected":true}',
  '{"status":"not-found","code":5}', '{"status":"written"}', '{"status":"not-found"}\n{"status":"not-found"}',
]) {
  test(`unexpected helper reply ${bad.slice(0, 32)} is not accepted as missing`, async () => {
    const custody = new WindowsCredentialCustody({ run: async () => ({ code: 0, stdout: bad, stderr: "" }) }, SCOPE);
    await safeFailure(() => custody.get(BOARD_KEY_ACCOUNT));
  });
}

test("ownership-read echoes and raw native exceptions never escape through errors, including nested causes", async () => {
  const failures: WindowsCredentialRunner[] = [
    { run: async (input) => ({ code: 0, stdout: input, stderr: "" }) },
    { run: async () => ({ code: 0, stdout: JSON.stringify({ status: "not-found" }), stderr: SENTINEL }) },
    { run: async () => { throw new Error(SENTINEL, { cause: { secret: SENTINEL } }); } },
  ];
  for (const runner of failures) await safeFailure(() => new WindowsCredentialCustody(runner, SCOPE).put(BOARD_KEY_ACCOUNT, SENTINEL));
});

for (const operation of ["write", "delete"] as const) {
  for (const failure of ["echo", "stdout-error", "stderr-error", "exception"] as const) {
    test(`actual ${operation} ${failure} cannot leak a plaintext or encoded credential through errors`, async () => {
      const calls: Request[] = [];
      const encoded = Buffer.from(SENTINEL).toString("base64");
      const runner: WindowsCredentialRunner = { async run(input) {
        const call = JSON.parse(input) as Request;
        calls.push(call);
        if (call.operation === "read") return response(operation === "write" ? { status: "not-found" } : { status: "found", credential: credential() });
        assert.equal(call.operation, operation);
        if (operation === "write") assert.equal(call.credential!.blob, encoded);
        if (failure === "echo") return { code: 0, stdout: input, stderr: "" };
        if (failure === "stdout-error") return { code: 1, stdout: JSON.stringify({ error: SENTINEL, encoded }), stderr: "" };
        if (failure === "stderr-error") return { code: 1, stdout: "", stderr: SENTINEL + encoded };
        throw new Error(SENTINEL, { cause: { encoded, nested: new Error(SENTINEL) } });
      } };
      const custody = new WindowsCredentialCustody(runner, SCOPE);
      await safeFailure(() => operation === "write" ? custody.put(BOARD_KEY_ACCOUNT, SENTINEL) : custody.delete(BOARD_KEY_ACCOUNT));
      assert.deepEqual(calls.map((value) => value.operation), ["read", operation]);
      if (operation === "write") assert.equal(calls[1]!.credential!.blob, encoded);
    });
  }
}

test("write success requires exact post-write read-back and performs no automatic destructive rollback", async () => {
  for (const after of [response({ status: "not-found" }), response({ status: "found", credential: credential(BOARD_KEY_ACCOUNT, "different-fabricated-sentinel") }), response({ status: "error", code: 5 })]) {
    const calls: Request[] = [];
    const runner: WindowsCredentialRunner = { async run(input) {
      const call = JSON.parse(input) as Request;
      calls.push(call);
      if (calls.length === 1) return response({ status: "not-found" });
      return call.operation === "write" ? response({ status: "written" }) : after;
    } };
    await safeFailure(() => new WindowsCredentialCustody(runner, SCOPE).put(BOARD_KEY_ACCOUNT, SENTINEL));
    assert.deepEqual(calls.map((value) => value.operation), ["read", "write", "read"]);
  }
});

test("delete is scoped, verified, idempotent, and cannot accept a stale success", async () => {
  const fixture = store();
  const custody = new WindowsCredentialCustody(fixture.runner, SCOPE);
  await custody.put(BOARD_KEY_ACCOUNT, SENTINEL);
  fixture.calls.length = 0;
  await custody.delete(BOARD_KEY_ACCOUNT);
  assert.deepEqual(fixture.calls.map((value) => value.operation), ["read", "delete", "read"]);
  assert.equal(await custody.get(BOARD_KEY_ACCOUNT), null);
  await custody.delete(BOARD_KEY_ACCOUNT);
  for (const ack of ["deleted", "not-found"]) {
    const calls: Request[] = [];
    const runner: WindowsCredentialRunner = { async run(input) {
      const call = JSON.parse(input) as Request;
      calls.push(call);
      return call.operation === "delete" ? response({ status: ack }) : response({ status: "found", credential: credential() });
    } };
    await safeFailure(() => new WindowsCredentialCustody(runner, SCOPE).delete(BOARD_KEY_ACCOUNT));
    assert.deepEqual(calls.map((value) => value.operation), ["read", "delete", "read"]);
  }
});

test("state-directory scopes are stable, distinct and do not disclose checkout or user paths", () => {
  const scope = windowsCredentialScope("C:\\Users\\Fabricated\\.tickets-to-main");
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(scope.includes("Fabricated"), false);
  assert.equal(scope, windowsCredentialScope("c:/users/fabricated/.tickets-to-main"));
  assert.notEqual(scope, windowsCredentialScope("C:\\Users\\Fabricated\\other-state"));
  for (const path of ["relative", "/linux-path", "\\root-relative", "C:drive-relative", "C:\\path\0tail"]) assert.throws(() => windowsCredentialScope(path));
});

test("the helper launch uses a verified pinned path, no shell, and no inherited credentials or runtime hooks", () => {
  const parent = { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", PATH: "C:\\attacker-bin", TICKETS_PLEASE_TOKEN: SENTINEL, GH_TOKEN: SENTINEL, NODE_OPTIONS: SENTINEL, COR_ENABLE_PROFILING: "1", COR_PROFILER_PATH: "C:\\injected.dll", COMPLUS_ReadyToRun: "0" };
  const launch = windowsCredentialLaunch(PIN, parent);
  assert.ok(launch);
  assert.deepEqual(launch.argv, [PIN.executable]);
  assert.equal(launch.shell, false);
  assert.equal(launch.expectedSha256, PIN.sha256);
  assert.deepEqual(launch.env, { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });
  assert.equal(JSON.stringify(launch).includes(SENTINEL), false);
  for (const pin of [null, { ...PIN, releaseVerified: false }]) assert.equal(windowsCredentialLaunch(pin, parent), null);
  for (const pin of [{ ...PIN, executable: "credential-helper.exe" }, { ...PIN, executable: "C:\\helper.cmd" }, { ...PIN, sha256: "wrong" }]) assert.throws(() => windowsCredentialLaunch(pin, parent));
});

test("missing, unsigned and hash-mismatched helpers receive no secret input and have no fallback", async () => {
  for (const pin of [null, { ...PIN, releaseVerified: false }, PIN]) {
    const invocations: unknown[] = [];
    const host: WindowsCredentialHost = {
      async executableSha256() { return "0".repeat(64); },
      async invoke(launch, input) { invocations.push({ launch, input }); return response({ status: "written" }); },
    };
    const runner = createWindowsCredentialRunner(pin, { SystemRoot: "C:\\Windows" }, host);
    await safeFailure(() => runner.run(JSON.stringify({ operation: "write", flags: 0, credential: credential() })));
    assert.equal(invocations.length, 0);
  }
  const host: WindowsCredentialHost = {
    async executableSha256() { throw new Error("Synthetic missing binary"); },
    async invoke() { assert.fail("absent helper must not execute"); },
  };
  await safeFailure(() => createWindowsCredentialRunner(PIN, { SystemRoot: "C:\\Windows" }, host).run(JSON.stringify({ operation: "write", flags: 0, credential: credential() })));
});

test("the pinned helper gets the secret only on its input pipe and its hash is checked again before each call", async () => {
  const invocations: { launch: unknown; input: string }[] = [];
  let hash = PIN.sha256;
  const host: WindowsCredentialHost = {
    async executableSha256(executable) { assert.equal(executable, PIN.executable); return hash; },
    async invoke(launch, input) { invocations.push({ launch, input }); return response({ status: "written" }); },
  };
  const runner = createWindowsCredentialRunner(PIN, { SystemRoot: "C:\\Windows", TICKETS_PLEASE_TOKEN: SENTINEL }, host);
  const input = JSON.stringify({ operation: "write", flags: 0, credential: credential() });
  await runner.run(input);
  assert.equal(invocations.length, 1);
  assert.deepEqual(JSON.parse(invocations[0]!.input), JSON.parse(input));
  assert.equal(JSON.stringify(invocations[0]!.launch).includes(SENTINEL), false);
  assert.equal(JSON.stringify(invocations[0]!.launch).includes(Buffer.from(SENTINEL).toString("base64")), false);
  hash = "0".repeat(64);
  await safeFailure(() => runner.run(input));
  assert.equal(invocations.length, 1);
});
