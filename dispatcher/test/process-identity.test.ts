import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { nativeProcessHost, processBirth, processOwnerAlive, type ProcessHost } from "../src/process-identity.ts";

const boot = "11111111-2222-3333-4444-555555555555";
function linux(birth = "123"): ProcessHost {
  return { platform: "linux", alive: () => true,
    read: (path) => path.endsWith("boot_id") ? boot + "\n" : path.split("/")[2] + " (name with ) in it) " + ["S", ...Array(18).fill("0"), birth, "0"].join(" "),
    run: () => { throw new Error("unexpected command"); } };
}

test("Linux birth identity includes boot and field-22 start ticks after the final command parenthesis", () => {
  assert.equal(processBirth(42, linux()), "linux:" + boot + ":123");
  assert.equal(processOwnerAlive({ pid: 42, birth: "linux:" + boot + ":122" }, false, linux()), false);
  assert.equal(processOwnerAlive({ pid: 42, birth: "linux:" + boot + ":123" }, false, linux()), true);
});

test("unknown process identity and legacy live PIDs hold; definitely dead PIDs release", () => {
  const host = { ...linux(), read: () => { throw new Error("permission denied"); } };
  assert.equal(processOwnerAlive({ pid: 42, birth: "old" }, false, host), true);
  assert.equal(processOwnerAlive({ pid: 42 }, false, linux()), true);
  assert.equal(processOwnerAlive({ pid: 42, birth: "old" }, false, { ...host, alive: () => false }), false);
  assert.equal(processBirth(42, { ...linux(), read: () => "malformed" }), null);
  assert.equal(processBirth(42, { ...linux(), platform: "darwin" }), null);
  assert.equal(processOwnerAlive({ pid: 42, birth: "old" }, false, { ...linux(), platform: "darwin" }), true);
});

test("Windows process query has a fixed executable, validated numeric PID and no inherited secret environment", (t) => {
  if (process.platform !== "win32") return;
  const original = childProcess.spawnSync;
  const calls: unknown[][] = [];
  childProcess.spawnSync = ((...args: unknown[]) => {
    calls.push(args);
    return { status: 0, stdout: "638992123456789012\n", stderr: "" };
  }) as typeof original;
  syncBuiltinESMExports();
  t.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  assert.equal(processBirth(-1), null);
  assert.equal(processBirth(1.5), null);
  assert.equal(processBirth(42), "win32:638992123456789012");
  assert.equal(calls.length, 1);
  const [file, argv, options] = calls[0]! as [string, string[], Record<string, unknown>];
  assert.equal(file, process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(argv.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(argv[4]!, /GetProcessById\(42\)/);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.env, { SystemRoot: process.env.SystemRoot });
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});

test("Windows birth observation uses exact ticks and refuses failed or malformed answers", () => {
  const calls: unknown[] = [];
  const host: ProcessHost = { platform: "win32", alive: () => true, read: () => "",
    run: (pid) => { calls.push(pid); return "638992123456789012\r\n"; } };
  assert.equal(processBirth(42, host), "win32:638992123456789012");
  assert.deepEqual(calls, [42]);
  for (const value of ["", "0", "-1", "123\n456", "not found"]) assert.equal(processBirth(42, { ...host, run: () => value }), null);
});

test("macOS second-precision ps start time releases only a definite mismatch", () => {
  const line = "Mon Nov 16 20:54:03 2026\n";
  const host: ProcessHost = { platform: "darwin", alive: () => true, read: () => "", run: () => line };
  assert.equal(processBirth(42, host), "darwin:Mon Nov 16 20:54:03 2026");
  assert.equal(processOwnerAlive({ pid: 42, birth: "darwin:Mon Nov 16 20:54:03 2026" }, false, host), true);
  assert.equal(processOwnerAlive({ pid: 42, birth: "darwin:Mon Nov 16 20:54:02 2026" }, false, host), false);
  for (const value of ["", "permission denied", "Mon Nov 16 20:54:03 2026\nTue Nov 17 20:54:03 2026", "Mon Nov 99 99:99:99 2026"]) {
    assert.equal(processBirth(42, { ...host, run: () => value }), null);
    assert.equal(processOwnerAlive({ pid: 42, birth: "darwin:Mon Nov 16 20:54:02 2026" }, false, { ...host, run: () => value }), true);
  }
  assert.equal(processOwnerAlive({ pid: 42, birth: "darwin:Mon Nov 16 20:54:02 2026" }, false,
    { ...host, run: () => { throw new Error("ps failed"); } }), true);
});

test("macOS native command uses fixed ps lstart arguments and an exact UTC C-locale environment", (context) => {
  const original = childProcess.spawnSync;
  const calls: unknown[][] = [];
  childProcess.spawnSync = ((...args: unknown[]) => {
    calls.push(args);
    return { status: 0, stdout: "Mon Nov 16 20:54:03 2026\n", stderr: "" };
  }) as typeof original;
  syncBuiltinESMExports();
  context.after(() => { childProcess.spawnSync = original; syncBuiltinESMExports(); });
  const host = nativeProcessHost("darwin");
  assert.equal(processBirth(-1, host), null);
  assert.equal(processBirth(1.5, host), null);
  assert.equal(processBirth(42, host), "darwin:Mon Nov 16 20:54:03 2026");
  assert.equal(calls.length, 1);
  const [file, argv, options] = calls[0]! as [string, string[], Record<string, unknown>];
  assert.equal(file, "/bin/ps");
  assert.deepEqual(argv, ["-o", "lstart=", "-p", "42"]);
  assert.deepEqual(options.env, { LC_ALL: "C", TZ: "UTC" });
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});

test("current-process dormant ownership applies only with its matching birth identity", () => {
  const host = linux();
  assert.equal(processOwnerAlive({ pid: process.pid, birth: "linux:" + boot + ":123" }, true, host), false);
  assert.equal(processOwnerAlive({ pid: process.pid, birth: "linux:" + boot + ":123" }, false, host), true);
  assert.equal(processOwnerAlive({ pid: process.pid, birth: "old" }, false, host), false);
});

test("native current process observation is stable, and known start mismatches identify PID reuse", () => {
  const birth = processBirth(process.pid);
  if (process.platform === "linux" || process.platform === "win32") assert.ok(birth);
  assert.equal(processBirth(process.pid), birth);
  assert.equal(processOwnerAlive({ pid: process.pid, ...(birth ? { birth } : {}) }), true);
  if (birth) assert.equal(processOwnerAlive({ pid: process.pid, birth: birth + "0" }), false);
});
