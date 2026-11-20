import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { processBirth } from "../src/process-identity.ts";
import { processAlive } from "../src/workspace.ts";

const repo = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const controller = fileURLToPath(new URL("./windows-owned-handoff.fixture.ts", import.meta.url));
const controllerProbe = new URL("./windows-owned-handoff-probe.fixture.ts", import.meta.url).href;
const recovery = fileURLToPath(new URL("./windows-job-recovery.fixture.ts", import.meta.url));
const platform = { skip: process.platform !== "win32", timeout: 40_000 };
const unqualified = { qualification: "unqualified-harness", publishable: false };

async function until(read: () => boolean, message: string) {
  const deadline = Date.now() + 12_000;
  while (!read()) {
    assert.ok(Date.now() < deadline, message);
    await pause(20);
  }
}

async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 10_000);
  });
  try { return await Promise.race([operation, expired]); }
  finally { clearTimeout(timer); }
}

function fixture(t: TestContext) {
  assert.equal(process.version, "v24.18.0");
  const root = realpathSync(mkdtempSync(join(repo, "ttm-job-drain-controller-loss-owned-")));
  assert.equal(dirname(root), repo);
  assert.match(basename(root), /^ttm-job-drain-controller-loss-owned-/);
  const workspace = join(root, "workspace"), state = join(root, "state"), control = join(root, "control"), tmp = join(root, "tmp");
  for (const dir of [workspace, control, tmp]) mkdirSync(dir);
  const files = [join(state, "assignment-intents.jsonl"), join(state, "ledger.json")];
  const marker = (name: string) => join(control, name);
  const signal = (name: string) => writeFileSync(marker(name), "1", { flag: "wx" });
  const pid = (name: string) => {
    const observed = Number(readFileSync(marker(name), "utf8"));
    assert.ok(Number.isSafeInteger(observed) && observed > 0 && observed !== process.pid);
    return observed;
  };
  const peers = new Set<ReturnType<typeof launch>>();
  const observedChildren = new Set<number>();

  function launch(file: string, args: string[], input?: string, probe = false) {
    const options = probe ? ["--import", controllerProbe] : [];
    const child = spawn(realpathSync(process.execPath), ["--experimental-strip-types", ...options, file, ...args], {
      cwd: root, env: { SystemRoot: process.env.SystemRoot, TEMP: tmp, TMP: tmp },
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stdin.on("error", () => {});
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, output }));
    });
    const peer = { child, result };
    peers.add(peer);
    void result.then(() => peers.delete(peer), () => peers.delete(peer));
    child.stdin.end(input);
    return peer;
  }

  function abort() {
    if (!existsSync(marker("abort"))) signal("abort");
  }

  t.after(async () => {
    abort();
    try {
      await bounded(Promise.allSettled([...peers].map(peer => peer.result)), "Fabricated peer did not close after abort.");
      const probedBrokers = readdirSync(control).filter(name => /^native-broker-[1-9][0-9]*$/.test(name))
        .map(name => JSON.parse(readFileSync(marker(name), "utf8")).pid as number);
      const tracked = new Set([...observedChildren, ...probedBrokers,
        ...["writer-pid", "reader-pid", "broker-pid"].filter(name => existsSync(marker(name))).map(pid)]);
      for (const processId of tracked) assert.ok(Number.isSafeInteger(processId) && processId > 0 && processId !== process.pid);
      await until(() => [...tracked].every(processId => !processAlive(processId)), "Owned fixture process did not exit.");
    } catch (error) {
      for (const { child } of peers) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
      }
      throw error;
    }
    assert.equal(dirname(realpathSync(root)), repo);
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
  });

  return {
    workspace, signal, marker, pid, abort, snapshot: () => files.map(file => readFileSync(file)) as [Buffer, Buffer],
    start: (probe = false) => launch(controller, ["controller", root, String(process.pid)], undefined,
      probe || existsSync(marker("owned-admission"))),
    trackChild: (child: number) => observedChildren.add(child),
    readProbe: (name: string) => JSON.parse(readFileSync(marker(name), "utf8")),
    nativeRecords: (kind: "launch" | "input") => readdirSync(control).filter(name => new RegExp(`^native-${kind}-[1-9][0-9]*$`).test(name)).sort(),
    async replay(next: boolean) {
      const peer = launch(recovery, ["recover", root, String(process.pid), "loss-origin"],
        JSON.stringify({ next, authorized: true, observation: null }));
      const report = await bounded(peer.result, "Read-only recovery did not exit.");
      assert.equal(report.code, 0);
      assert.equal(report.signal, null);
      return JSON.parse(report.output) as unknown;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

function onlyBrokerReader(broker: number): number {
  assert.ok(Number.isSafeInteger(broker) && broker > 0);
  const system = process.env.SystemRoot;
  assert.ok(system);
  const shell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = ${broker}" -Property ProcessId,Name | ForEach-Object { "$($_.ProcessId):$($_.Name)" }`],
  { encoding: "utf8", shell: false, windowsHide: true, env: { SystemRoot: system } });
  assert.equal(result.status, 0, "The fixture could not observe the broker's own direct child.");
  const executable = basename(process.execPath).toLowerCase();
  const rows = result.stdout.trim().split(/\r?\n/).filter(row => row.split(":")[1]?.toLowerCase() === executable);
  assert.equal(rows.length, 1);
  const [pid] = rows[0]!.split(":");
  assert.match(pid ?? "", /^[1-9][0-9]*$/);
  const reader = Number(pid);
  assert.ok(Number.isSafeInteger(reader) && reader !== broker);
  return reader;
}

async function atRootClose(f: Fixture, initial: ReturnType<Fixture["start"]>, owned = false) {
  await until(() => {
    assert.equal(initial.child.exitCode, null, "Controller exited before the root-close checkpoint.");
    return existsSync(f.marker("root-closed"));
  }, "The owned root did not close with a late writer.");
  assert.equal(readFileSync(f.marker("root-closed"), "utf8"), "original-job-active=1");
  assert.equal(readFileSync(join(f.workspace, "received.bin"), "utf8"), "Fabricated writer custody");
  assert.ok(!existsSync(join(f.workspace, "late.bin")));
  const writer = f.pid("writer-pid"), broker = f.pid("broker-pid"), reader = f.pid("reader-pid");
  assert.ok(initial.child.pid && new Set([initial.child.pid, writer, broker, reader]).size === 4);
  assert.equal(f.pid("writer-parent"), reader);
  assert.equal(processAlive(reader), false);
  assert.equal(processAlive(writer), true);
  assert.equal(processAlive(broker), true);
  const before = f.snapshot();
  const [intent, started, ...remaining] = before[0].toString().trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(intent.kind, "intent");
  assert.equal(intent.pid, initial.child.pid);
  assert.deepEqual(started, { kind: "started", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000 });
  assert.deepEqual(remaining, []);
  const ledger = JSON.parse(before[1].toString());
  const generation: unknown = ledger.workspace?.claimGeneration;
  const originalClaim = { path: f.workspace, writerPid: initial.child.pid, qualified: false };
  if (owned) {
    assert.ok(typeof generation === "string");
    assert.match(generation, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    assert.deepEqual(ledger.workspace, { ...originalClaim, claimGeneration: generation });
    assert.deepEqual(ledger.boundWorkspaceIntents, [intent.id]);
  } else assert.deepEqual(ledger.workspace, originalClaim);
  f.signal("attempt-handoff");
  await until(() => {
    assert.equal(initial.child.exitCode, null, "Controller accepted handoff while the late writer was live.");
    return existsSync(f.marker("handoff-held"));
  }, "The active Job did not produce a held handoff.");
  assert.deepEqual(f.snapshot(), before);
  return { before, writer, broker, intent };
}

async function finishWriter(f: Fixture, writer: number) {
  f.signal("write-once");
  await until(() => !processAlive(writer), "The late writer did not exit.");
  assert.equal(readFileSync(join(f.workspace, "late.bin"), "utf8"), "fabricated late write");
}

test("the owned launcher retains a live late writer at root close and completes only after original Job drain", platform, async t => {
  const f = fixture(t), initial = f.start(true);
  const { before, writer, broker, intent } = await atRootClose(f, initial);
  assert.deepEqual(f.nativeRecords("launch"), ["native-launch-1"]);
  assert.deepEqual(f.readProbe("native-broker-1"), { pid: broker });
  assert.equal(f.readProbe("native-verified-1"), true);
  assert.deepEqual(f.nativeRecords("input"), ["native-input-1"]);
  const legacyInput = f.readProbe("native-input-1");
  assert.equal(legacyInput.broker, broker);
  assert.equal(legacyInput.permitted, false);
  assert.deepEqual(legacyInput.rows, before[0].toString().trimEnd().split("\n").map(line => JSON.parse(line)));
  assert.deepEqual(await f.replay(false), { result: { state: "held", ...unqualified }, effects: 0, reconciliations: 0, readDigest: null });
  assert.deepEqual(f.snapshot(), before);
  await finishWriter(f, writer);
  assert.deepEqual(f.snapshot(), before);
  f.signal("observe-drained");
  const ended = await bounded(initial.result, "Controller did not exit after the original Job drained.");
  assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(ended.output), { state: "completed", ...unqualified });
  assert.equal(readFileSync(f.marker("drain-receipt"), "utf8"), "original-job-active=0");
  const after = f.snapshot();
  assert.deepEqual(after[1], before[1]);
  const result = { kind: "result", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000, outcome: "completed" };
  assert.deepEqual(after[0], Buffer.concat([before[0], Buffer.from(JSON.stringify(result) + "\n")]));
  assert.deepEqual(await f.replay(false), { result: { state: "completed", ...unqualified }, effects: 0, reconciliations: 0, readDigest: null });
  assert.deepEqual(f.snapshot(), after);
});

test("controller and broker loss leave a started intent and claim held even after the late writer exits", platform, async t => {
  const f = fixture(t), initial = f.start();
  const { before, writer, broker, intent } = await atRootClose(f, initial);
  f.signal("exit-controller");
  assert.deepEqual(await bounded(initial.result, "Controller did not reach intentional loss."), { code: 73, signal: null, output: "" });
  await until(() => !processAlive(broker), "The owned broker did not lose control.");
  assert.equal(processAlive(writer), true);
  const held = { state: "held", ...unqualified };
  const unchanged = { result: held, effects: 0, reconciliations: 1, readDigest: intent.requestDigest };
  assert.deepEqual(await f.replay(false), unchanged);
  assert.deepEqual(await f.replay(true), { result: held, effects: 0, reconciliations: 0, readDigest: null });
  assert.deepEqual(f.snapshot(), before);
  await finishWriter(f, writer);
  assert.deepEqual(await f.replay(false), unchanged);
  assert.deepEqual(f.snapshot(), before);
  assert.ok(!existsSync(f.marker("drain-receipt")));
});

test("a withheld transport close can be aborted without a terminal receipt or a changed claim", platform, async t => {
  const f = fixture(t);
  f.signal("withhold-close");
  const initial = f.start();
  await until(() => {
    assert.equal(initial.child.exitCode, null, "Controller exited before the withheld-close checkpoint.");
    return existsSync(f.marker("close-withheld"));
  }, "The transport close was not withheld.");
  const before = f.snapshot();
  assert.equal(processAlive(f.pid("writer-pid")), true);
  assert.equal(processAlive(f.pid("broker-pid")), true);
  f.abort();
  assert.deepEqual(await bounded(initial.result, "The waiting controller did not abort."), { code: 74, signal: null, output: "" });
  assert.deepEqual(f.snapshot(), before);
  assert.ok(!existsSync(f.marker("drain-receipt")));
});

test("the opted-in controller retains one Job from suspended preparation through the durable owned claim release", platform, async t => {
  const f = fixture(t);
  f.signal("owned-admission");
  const initial = f.start();
  await until(() => {
    assert.equal(initial.child.exitCode, null, "Controller exited before owned preparation.");
    assert.equal(existsSync(f.marker("reader-pid")), false, "The legacy reader started before owned preparation was admitted.");
    return existsSync(f.marker("owned-staged"));
  }, "The controller did not stage the verified child through owned preparation.");
  const [preparedBytes, preparedLedger] = f.snapshot();
  const [prepared, ...rest] = preparedBytes.toString().trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(prepared.kind, "intent");
  assert.equal(prepared.pid, initial.child.pid);
  assert.deepEqual(rest, []);
  assert.deepEqual(JSON.parse(preparedLedger.toString()).workspace, { path: f.workspace, writerPid: initial.child.pid, qualified: false });
  assert.equal(f.readProbe("native-probe-open"), true);
  assert.deepEqual(f.nativeRecords("launch"), ["native-launch-1"]);
  assert.deepEqual(f.readProbe("native-launch-1"), { broker: true });
  assert.equal(f.readProbe("native-verified-1"), true);
  const originalBroker = f.readProbe("native-broker-1").pid as number;
  assert.equal(processAlive(originalBroker), true);
  const originalReader = onlyBrokerReader(originalBroker);
  f.trackChild(originalReader);
  const brokerBirth = processBirth(originalBroker), readerBirth = processBirth(originalReader);
  assert.ok(brokerBirth && readerBirth && BigInt(readerBirth.slice(6)) >= BigInt(brokerBirth.slice(6)));
  assert.equal(existsSync(f.marker("native-resume-1")), false);
  assert.deepEqual(f.nativeRecords("input"), []);
  assert.equal(existsSync(f.marker("writer-pid")), false);
  assert.equal(existsSync(join(f.workspace, "received.bin")), false);
  writeFileSync(join(f.workspace, "work.txt"), "fabricated pre-existing work\n", { flag: "wx" });
  f.signal("allow-owned-start");
  await until(() => {
    assert.equal(initial.child.exitCode, null, "Controller exited before the staged reader requested input.");
    assert.equal(existsSync(join(f.workspace, "received.bin")), false, "Input reached the child before the durable check.");
    return existsSync(f.marker("owned-input-ready"));
  }, "The exact reader did not reach the owned input barrier.");
  const [startedBytes, startedLedger] = f.snapshot();
  const started = { kind: "started", id: prepared.id, sequence: 1, requestDigest: prepared.requestDigest, at: 1000 };
  assert.deepEqual(startedBytes, Buffer.concat([preparedBytes, Buffer.from(JSON.stringify(started) + "\n")]));
  const bound = JSON.parse(startedLedger.toString());
  assert.match(bound.workspace.claimGeneration, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.deepEqual(bound.workspace, { path: f.workspace, writerPid: initial.child.pid, qualified: false,
    claimGeneration: bound.workspace.claimGeneration });
  assert.deepEqual(bound.boundWorkspaceIntents, [prepared.id]);
  assert.equal(existsSync(f.marker("writer-pid")), false);
  assert.equal(f.pid("broker-pid"), originalBroker);
  assert.equal(f.pid("reader-pid"), originalReader);
  assert.equal(processBirth(originalBroker), brokerBirth);
  assert.equal(processBirth(originalReader), readerBirth);
  const expectedNativeWrite = { broker: originalBroker, permitted: true, rows: [prepared, started],
    workspace: bound.workspace, bindings: [prepared.id] };
  assert.deepEqual(f.readProbe("native-resume-1"), expectedNativeWrite);
  assert.deepEqual(f.nativeRecords("input"), []);
  f.signal("allow-owned-input");

  const { before, writer, broker, intent } = await atRootClose(f, initial, true);
  assert.deepEqual(intent, prepared);
  assert.equal(broker, originalBroker);
  assert.deepEqual(before, [startedBytes, startedLedger]);
  assert.deepEqual(f.nativeRecords("input"), ["native-input-1"]);
  assert.deepEqual(f.readProbe("native-input-1"), expectedNativeWrite);
  assert.deepEqual(await f.replay(false), { result: { state: "held", ...unqualified }, effects: 0, reconciliations: 0, readDigest: null });
  assert.deepEqual(f.snapshot(), before);
  await finishWriter(f, writer);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(existsSync(f.marker("release-observation")), false);

  f.signal("observe-drained");
  await until(() => {
    assert.equal(initial.child.exitCode, null, "Controller returned or lost the original observer before release.");
    return existsSync(f.marker("release-observation"));
  }, "The runner did not sample the retained original Job for owned release.");
  assert.equal(readFileSync(f.marker("drain-receipt"), "utf8"), "original-job-active=0");
  assert.equal(f.pid("broker-pid"), broker);
  assert.equal(processAlive(broker), true);
  assert.equal(processBirth(broker), brokerBirth);
  assert.deepEqual(f.nativeRecords("launch"), ["native-launch-1"]);
  const result = { kind: "result", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000, outcome: "completed" };
  const terminal = Buffer.concat([before[0], Buffer.from(JSON.stringify(result) + "\n")]);
  assert.deepEqual(f.snapshot(), [terminal, before[1]]);
  assert.equal(existsSync(f.marker("observer-closed")), false);

  f.signal("allow-release-observation");
  const ended = await bounded(initial.result, "Controller did not dispose the original Job after release.");
  assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(ended.output), { state: "completed", ...unqualified });
  assert.equal(existsSync(f.marker("observer-closed")), true);
  await until(() => !processAlive(broker), "The original observer broker did not exit after disposal.");
  const expectedLedger = JSON.parse(before[1].toString());
  expectedLedger.workspace = { path: f.workspace, writerPid: null, qualified: false };
  delete expectedLedger.boundWorkspaceIntents;
  const after = f.snapshot();
  assert.deepEqual(after[0], terminal);
  assert.deepEqual(JSON.parse(after[1].toString()), expectedLedger);
  assert.deepEqual(f.nativeRecords("launch"), ["native-launch-1"]);
  assert.deepEqual(f.nativeRecords("input"), ["native-input-1"]);
  assert.deepEqual(await f.replay(false), { result: { state: "completed", ...unqualified }, effects: 0, reconciliations: 0, readDigest: null });
  assert.deepEqual(f.snapshot(), after);
  assert.equal(readFileSync(join(f.workspace, "work.txt"), "utf8"), "fabricated pre-existing work\n");
});

test("the opted-in controller cannot fall back to a legacy launch when owned preparation is refused", platform, async t => {
  const f = fixture(t);
  f.signal("owned-admission");
  f.signal("refuse-owned-preparation");
  const initial = f.start();
  await until(() => {
    assert.deepEqual(f.nativeRecords("launch"), [], "Refused owned preparation made a native launch attempt.");
    assert.equal(existsSync(f.marker("reader-pid")), false, "Refused owned preparation fell through to the legacy reader.");
    return initial.child.exitCode !== null;
  }, "The controller did not produce its owned preparation refusal.");
  const ended = await bounded(initial.result, "Controller did not settle after owned preparation was refused.");
  assert.deepEqual({ code: ended.code, signal: ended.signal }, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(ended.output), { state: "not-started", ...unqualified });
  assert.equal(f.readProbe("native-probe-open"), true);
  assert.deepEqual(f.nativeRecords("launch"), []);
  assert.deepEqual(f.nativeRecords("input"), []);
  const after = f.snapshot();
  const [intent, result, ...rest] = after[0].toString().trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(intent.kind, "intent");
  assert.equal(intent.pid, initial.child.pid);
  assert.deepEqual(result, { kind: "result", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000, outcome: "not-started" });
  assert.deepEqual(rest, []);
  const ledger = JSON.parse(after[1].toString());
  assert.deepEqual(ledger.workspace, { path: f.workspace, writerPid: initial.child.pid, qualified: false });
  assert.equal(Object.hasOwn(ledger, "boundWorkspaceIntents"), false);
  for (const name of ["owned-staged", "owned-input-ready", "reader-pid", "broker-pid", "writer-pid", "release-observation", "observer-closed"]) {
    assert.equal(existsSync(f.marker(name)), false, `${name} was produced for refused preparation`);
  }
  for (const name of ["received.bin", "late.bin"]) assert.equal(existsSync(join(f.workspace, name)), false);
  assert.deepEqual(await f.replay(false), { result: { state: "not-started", ...unqualified }, effects: 0, reconciliations: 0, readDigest: null });
  assert.deepEqual(f.snapshot(), after);
});
