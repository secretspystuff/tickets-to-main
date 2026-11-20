import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { install } from "../src/install.ts";
import { windowsOwnedNativeTransport, windowsProcessLauncher, type NativeExit } from "../src/native-transport.ts";
import { claimWorkspace, prepareWorkspace, processAlive } from "../src/workspace.ts";
import { windowsPrivacy } from "../src/windows-privacy.ts";

const platform = { skip: process.platform !== "win32", timeout: 20_000 };
const clean = { code: 0, signal: null, error: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function space(t: TestContext) {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-owned-transport-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  windowsPrivacy(root, "protect");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  return { root, cwd, env: { SystemRoot: process.env.SystemRoot, TEMP: parent, TMP: parent } };
}

test("Win32 puts the exact suspended child in the original Job and inherits only stdio", platform, t => {
  const { root, cwd, env } = space(t);
  assert.ok(env.SystemRoot);
  const compiler = ["Framework64", "Framework"].map(platform =>
    join(env.SystemRoot!, "Microsoft.NET", platform, "v4.0.30319", "csc.exe")).find(existsSync);
  assert.ok(compiler, "Win32 test compiler unavailable");
  const proof = join(root, "proof.exe");
  const launcher = fileURLToPath(new URL("../native/windows-owned-launcher.cs", import.meta.url));
  const fixture = fileURLToPath(new URL("./windows-owned-launcher.fixture.cs", import.meta.url));
  const options = { env, cwd, windowsHide: true, encoding: "utf8", timeout: 10_000 } as const;
  const compilation = spawnSync(compiler, ["/nologo", "/target:exe", "/main:WindowsOwnedLauncherProof",
    "/out:" + proof, launcher, fixture], options);
  assert.equal(compilation.status, 0, "native probe did not compile");
  const native = spawnSync(proof, [proof, cwd], options);
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.stdout.trim(), "original-job exact-child suspended input-empty stdio-only live=1 drained=0");
});

test("owned NativeTransport delivers only admitted bytes and retains the real Job beyond close", platform, async t => {
  assert.equal(process.version, "v24.18.0");
  const { root, cwd, env } = space(t);
  const stateDir = join(root, "state"), ledger = join(stateDir, "ledger.json");
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, cwd, processAlive);
  claimWorkspace(stateDir, process.pid, processAlive);
  const claimed = readFileSync(ledger);
  const argv = [realpathSync(process.execPath), fileURLToPath(new URL("./windows-owned-input.fixture.mjs", import.meta.url))];
  const exit = deferred<NativeExit>();
  const ready = deferred<void>();
  const reports: NativeExit[] = [];
  let output = "", spawned = 0, inputErrors = 0;
  const owned = windowsOwnedNativeTransport(windowsProcessLauncher()).start(argv, { cwd, env }, {
    spawned() { spawned++; },
    stdout(chunk) { output += chunk; if (output.includes("reader-ready\n")) ready.resolve(); },
    stderr() {},
    inputError() { inputErrors++; },
    closed(result) { reports.push(result); exit.resolve(result); },
  });
  try {
    assert.equal(owned.write("fabricated early input"), false);
    assert.deepEqual(await owned.observeOriginalGroup(), { state: "unavailable" });
    assert.equal(await Promise.race([ready.promise, exit.promise]), undefined);
    assert.equal(spawned, 1);
    const marker = join(cwd, "received.bin");
    assert.equal(existsSync(marker), false);
    assert.deepEqual(await owned.observeOriginalGroup(), { state: "verified", activeProcesses: 1 });
    assert.equal(owned.write("fabricated admitted input\n"), true);
    owned.endInput();
    assert.deepEqual(await exit.promise, clean);
    assert.deepEqual(reports, [clean]);
    assert.equal(inputErrors, 0);
    assert.deepEqual(readFileSync(marker), Buffer.from("fabricated admitted input\n"));
    assert.deepEqual(await owned.observeOriginalGroup(), { state: "verified", activeProcesses: 0 });
  } finally {
    owned.endInput();
    await exit.promise;
    owned.closeObservation();
  }
  assert.deepEqual(await owned.observeOriginalGroup(), { state: "unavailable" });
  assert.deepEqual(readFileSync(ledger), claimed);
});
