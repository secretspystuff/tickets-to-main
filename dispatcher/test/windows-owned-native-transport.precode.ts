import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import * as transport from "../src/native-transport.ts";
import type { NativeEvents, NativeExit, NativeProcess, NativeTransport } from "../src/native-transport.ts";
import { install } from "../src/install.ts";
import { claimWorkspace, prepareWorkspace, processAlive } from "../src/workspace.ts";

type Membership = { job: object; child: object } | null;
type GroupSample = { job: object; activeProcesses: number; complete: boolean } | null;
type Custody = { state: "verified"; activeProcesses: number } | { state: "unavailable" };
type Launch = {
  originalJob: object;
  exactChild: object;
  pipe: NativeProcess;
  verify(): Promise<Membership>;
  activate(): Promise<boolean>;
  observe(): Promise<GroupSample>;
  disposeBeforeInput(): void;
};
type Launcher = { start(...parameters: Parameters<NativeTransport["start"]>): Launch | null | Promise<Launch | null> };
type OwnedNativeProcess = NativeProcess & { observeOriginalGroup(): Promise<Custody> };
interface OwnedNativeTransport extends NativeTransport {
  start(...parameters: Parameters<NativeTransport["start"]>): OwnedNativeProcess;
}

const early = "fabricated early input\n";
const allowed = "fabricated accepted input\n";
const unavailable = { state: "unavailable" } as const;
const cleanExit = { code: 0, signal: null, error: null } as const;
const heldExit = { code: null, signal: null, error: "spawn" } as const;
const platform = { skip: process.platform !== "win32", timeout: 20_000 };
const nextTurn = () => new Promise<void>(resolve => { setImmediate(resolve); });
type Failure = "throw" | "reject";
type Stage = "verify" | "activate" | "observe";

function fail(how: Failure): Promise<never> {
  const error = new Error("fabricated internal failure");
  if (how === "throw") throw error;
  return Promise.reject(error);
}

function recordUnhandled(t: TestContext) {
  const rejections: unknown[] = [];
  const record = (error: unknown) => { rejections.push(error); };
  process.on("unhandledRejection", record);
  t.after(async () => {
    await nextTurn();
    process.off("unhandledRejection", record);
    assert.deepEqual(rejections, [], "operation failure cannot leak an unhandled rejection");
  });
}

function ownedFactory(): (launcher: Launcher) => OwnedNativeTransport {
  const exported: unknown = Reflect.get(transport, "windowsOwnedNativeTransport");
  assert.equal(typeof exported, "function", "the Windows-owned NativeTransport entry point is missing");
  return exported as (launcher: Launcher) => OwnedNativeTransport;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture(t: TestContext) {
  assert.equal(process.version, "v24.18.0");
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-owned-transport-")));
  assert.equal(dirname(root), parent);
  assert.match(basename(root), /^ttm-owned-transport-/);
  const cwd = join(root, "workspace"), stateDir = join(root, "state");
  const marker = join(cwd, "received.bin"), ledger = join(stateDir, "ledger.json");
  const argv = [realpathSync(process.execPath), fileURLToPath(new URL("./windows-owned-input.fixture.mjs", import.meta.url))];
  const options = { cwd, env: { SystemRoot: process.env.SystemRoot, TEMP: parent, TMP: parent } };
  const ready = deferred<void>();
  const pipesClosed = deferred<NativeExit>();
  const readerExits: NativeExit[] = [];
  let output = "";
  let owned: NativeProcess | undefined;
  t.after(async () => {
    owned?.endInput();
    if (owned) await pipesClosed.promise;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(cwd);
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, cwd, processAlive);
  claimWorkspace(stateDir, process.pid, processAlive);
  const claimed = readFileSync(ledger);

  function startReader(events: NativeEvents): NativeProcess {
    assert.equal(owned, undefined, "the fixture reader is single-use");
    owned = transport.processNativeTransport().start(argv, options, {
      ...events,
      stdout(chunk) {
        output += chunk;
        if (output.includes("reader-ready\n")) ready.resolve();
        events.stdout(chunk);
      },
      closed(exit) { readerExits.push(exit); pipesClosed.resolve(exit); events.closed(exit); },
    });
    return owned;
  }

  return { argv, options, marker, ready, startReader, pipesClosed, readerExits,
    checkClaim: () => assert.deepEqual(readFileSync(ledger), claimed),
  };
}

function closing(t: TestContext, f: ReturnType<typeof fixture>) {
  const first = deferred<void>();
  const reports: { exit: NativeExit; readerCloses: number }[] = [];
  let expected: { exit: NativeExit; readerCloses: number } | undefined;
  t.after(async () => {
    await nextTurn();
    if (expected) assert.deepEqual(reports, [expected]);
  });
  return {
    reports,
    closed(exit: NativeExit) { reports.push({ exit, readerCloses: f.readerExits.length }); first.resolve(); },
    async expectOnce(exit: NativeExit, readerLaunched: boolean) {
      expected = { exit, readerCloses: Number(readerLaunched) };
      await first.promise;
      if (readerLaunched) await f.pipesClosed.promise;
      await nextTurn();
      assert.deepEqual(f.readerExits, readerLaunched ? [cleanExit] : []);
      assert.deepEqual(reports, [expected]);
    },
  };
}

function setup(t: TestContext, factory: ReturnType<typeof ownedFactory>, options: {
  activationSucceeds?: boolean; failure?: { stage: Stage; how: Failure };
} = {}) {
  const f = fixture(t);
  recordUnhandled(t);
  const end = closing(t, f);
  const verified = deferred<Membership>();
  const activating = deferred<void>();
  const active = deferred<boolean>();
  const released = deferred<void>();
  const job = {}, child = {};
  const trace = { ready: 0, activations: 0, disposed: 0, pipeEnds: 0, writes: [] as string[], launches: 0, stages: [] as Stage[] };
  let sample: GroupSample = { job, activeProcesses: 1, complete: true };
  function atStage<T>(stage: Stage, control: () => Promise<T>): Promise<T> {
    trace.stages.push(stage);
    return options.failure?.stage === stage ? fail(options.failure.how) : control();
  }
  const owned = factory({
    start(argv, options, events) {
      trace.launches++;
      assert.deepEqual(argv, f.argv);
      assert.deepEqual(options, f.options);
      const reader = f.startReader(events);
      return {
        originalJob: job, exactChild: child,
        pipe: {
          write(text) { trace.writes.push(text); return reader.write(text); },
          endInput() { trace.pipeEnds++; reader.endInput(); },
        },
        verify: () => atStage("verify", () => verified.promise),
        activate() {
          trace.activations++;
          activating.resolve();
          return atStage("activate", () => active.promise);
        },
        observe: () => atStage("observe", async () => sample),
        disposeBeforeInput() { trace.disposed++; reader.endInput(); },
      };
    },
  }).start(f.argv, f.options, {
    spawned() { trace.ready++; released.resolve(); },
    stdout() {}, stderr() {}, inputError() { assert.fail("unexpected fixture input error"); },
    closed: end.closed,
  });
  if (options.activationSucceeds === false) active.resolve(false);
  return { ...f, owned, activating, active, verified, released, end, job, child, trace,
    observe(sampled: GroupSample) { sample = sampled; },
  };
}

test("the pinned benign reader records exact stdin only in its fabricated workspace", platform, async t => {
  const f = fixture(t);
  const child = f.startReader({ spawned() {}, stdout() {}, stderr() {}, inputError() { assert.fail(); }, closed() {} });
  await f.ready.promise;
  assert.equal(existsSync(f.marker), false);
  assert.equal(child.write(allowed), true);
  child.endInput();
  assert.deepEqual(await f.pipesClosed.promise, cleanExit);
  assert.deepEqual(readFileSync(f.marker), Buffer.from(allowed));
  f.checkClaim();
});

test("owned transport gates input until exact membership and activation, with separate group evidence", platform, async t => {
  const f = setup(t, ownedFactory());
  assert.equal(f.owned.write(early), false);
  await f.ready.promise;
  assert.equal(f.trace.ready, 0);
  assert.equal(f.trace.activations, 0);
  assert.equal(f.trace.disposed, 0);
  assert.equal(f.trace.launches, 1);
  assert.deepEqual(f.trace.writes, []);
  assert.equal(f.owned.write(early), false);
  assert.deepEqual(await f.owned.observeOriginalGroup(), unavailable);
  f.verified.resolve({ child: f.child, job: f.job });
  await f.activating.promise;
  assert.equal(f.owned.write(early), false);
  assert.equal(f.trace.ready, 0);
  assert.deepEqual(await f.owned.observeOriginalGroup(), unavailable);
  f.active.resolve(true);
  await f.released.promise;
  assert.equal(f.trace.ready, 1);
  assert.equal(f.trace.activations, 1);
  f.observe({ job: f.job, activeProcesses: 4, complete: true });
  assert.deepEqual(await f.owned.observeOriginalGroup(), { state: "verified", activeProcesses: 4 });
  assert.deepEqual(f.end.reports, []);
  assert.equal(f.owned.write(allowed), true);
  f.owned.endInput();
  await f.end.expectOnce(cleanExit, true);
  f.observe({ job: f.job, activeProcesses: 2, complete: true });
  assert.deepEqual(await f.owned.observeOriginalGroup(), { state: "verified", activeProcesses: 2 });
  assert.deepEqual(f.trace.writes, [allowed]);
  assert.deepEqual(readFileSync(f.marker), Buffer.from(allowed));
  for (const sample of [null, { job: {}, activeProcesses: 0, complete: true }, { job: f.job, activeProcesses: 0, complete: false },
    { job: f.job, activeProcesses: -1, complete: true }]) {
    f.observe(sample);
    assert.deepEqual(await f.owned.observeOriginalGroup(), unavailable);
    f.checkClaim();
  }
  f.observe({ job: f.job, activeProcesses: 0, complete: true });
  assert.deepEqual(await f.owned.observeOriginalGroup(), { state: "verified", activeProcesses: 0 });
  f.checkClaim();
});

test("a complete zero sample can arrive while the transport still has an open pipe", platform, async t => {
  const f = setup(t, ownedFactory());
  await f.ready.promise;
  f.verified.resolve({ child: f.child, job: f.job });
  f.active.resolve(true);
  await f.released.promise;
  f.observe({ job: f.job, activeProcesses: 0, complete: true });
  assert.deepEqual(await f.owned.observeOriginalGroup(), { state: "verified", activeProcesses: 0 });
  assert.deepEqual(f.readerExits, []);
  assert.deepEqual(f.end.reports, []);
  assert.equal(f.trace.pipeEnds, 0);
  assert.equal(f.trace.disposed, 0);
  assert.deepEqual(f.trace.writes, []);
  assert.equal(existsSync(f.marker), false);
  f.checkClaim();
  f.owned.endInput();
  await f.end.expectOnce(cleanExit, true);
  f.checkClaim();
});

for (const fault of ["unavailable", "foreign job", "foreign child", "activation refused"] as const) {
  test(`owned transport exposes zero input for ${fault}`, platform, async t => {
    const f = setup(t, ownedFactory(), { activationSucceeds: false });
    await f.ready.promise;
    assert.equal(f.owned.write(early), false);
    f.verified.resolve(fault === "unavailable" ? null : {
      job: fault === "foreign job" ? {} : f.job, child: fault === "foreign child" ? {} : f.child,
    });
    await f.end.expectOnce(heldExit, true);
    assert.equal(f.owned.write(allowed), false);
    assert.equal(f.trace.ready, 0);
    assert.equal(f.trace.activations, fault === "activation refused" ? 1 : 0);
    assert.equal(f.trace.disposed, 1);
    assert.equal(f.trace.launches, 1);
    assert.deepEqual(f.trace.writes, []);
    assert.deepEqual(await f.owned.observeOriginalGroup(), unavailable);
    assert.equal(existsSync(f.marker), false);
    f.checkClaim();
  });
}

for (const how of ["missing", "throw", "reject"] as const) {
  test(`Windows launcher start ${how} never falls back to a generic native process`, platform, async t => {
    const factory = ownedFactory();
    const f = fixture(t);
    recordUnhandled(t);
    const end = closing(t, f);
    let attempts = 0, ready = 0, ordinaryLaunches = 0;
    const ordinary = t.mock.method(childProcess, "spawn", () => {
      ordinaryLaunches++;
      throw new Error("ordinary spawn must not be called");
    });
    syncBuiltinESMExports();
    try {
      const child = factory({ start() { attempts++; return how === "missing" ? null : fail(how); } }).start(f.argv, f.options, {
        spawned() { ready++; }, stdout() { assert.fail(); }, stderr() {}, inputError() { assert.fail(); }, closed: end.closed,
      });
      assert.equal(child.write(early), false);
      await end.expectOnce(heldExit, false);
      assert.equal(child.write(allowed), false);
      assert.equal(attempts, 1);
      assert.equal(ordinaryLaunches, 0);
      assert.equal(ready, 0);
      assert.deepEqual(await child.observeOriginalGroup(), unavailable);
      assert.equal(existsSync(f.marker), false);
      f.checkClaim();
    } finally {
      ordinary.mock.restore();
      syncBuiltinESMExports();
    }
  });
}

const stages = ["verify", "activate", "observe"] as const;
for (const stage of stages) {
  for (const how of ["throw", "reject"] as const) {
    test(`owned transport ${stage} ${how} closes once without sending input`, platform, async t => {
      const f = setup(t, ownedFactory(), { failure: { stage, how } });
      assert.equal(f.owned.write(early), false);
      if (stage !== "verify") {
        await f.ready.promise;
        f.verified.resolve({ child: f.child, job: f.job });
      }
      if (stage === "observe") {
        f.active.resolve(true);
        await f.released.promise;
        assert.deepEqual(await f.owned.observeOriginalGroup(), unavailable);
      }
      await f.end.expectOnce(heldExit, true);
      assert.equal(f.owned.write(allowed), false);
      assert.equal(f.trace.ready, stage === "observe" ? 1 : 0);
      assert.deepEqual(f.trace.stages, stages.slice(0, stages.indexOf(stage) + 1));
      assert.deepEqual(f.trace.writes, []);
      assert.equal(existsSync(f.marker), false);
      f.checkClaim();
    });
  }
}
