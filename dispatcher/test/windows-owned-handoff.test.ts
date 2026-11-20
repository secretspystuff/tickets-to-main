import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { processAlive } from "../src/workspace.ts";

const repo = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const controller = fileURLToPath(new URL("./windows-owned-handoff.fixture.ts", import.meta.url));
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

  function launch(file: string, args: string[], input?: string) {
    const child = spawn(realpathSync(process.execPath), ["--experimental-strip-types", file, ...args], {
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
      const tracked = ["writer-pid", "reader-pid", "broker-pid"].filter(name => existsSync(marker(name))).map(pid);
      await until(() => tracked.every(processId => !processAlive(processId)), "Owned fixture process did not exit.");
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
    start: () => launch(controller, ["controller", root, String(process.pid)]),
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

async function atRootClose(f: Fixture, initial: ReturnType<Fixture["start"]>) {
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
  assert.deepEqual(JSON.parse(before[1].toString()).workspace, { path: f.workspace, writerPid: initial.child.pid, qualified: false });
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
  const f = fixture(t), initial = f.start();
  const { before, writer, intent } = await atRootClose(f, initial);
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
