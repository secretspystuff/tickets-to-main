import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
type Launcher = { start(...parameters: Parameters<NativeTransport["start"]>): Launch | null };
type OwnedNativeProcess = NativeProcess & { observeOriginalGroup(): Promise<Custody> };
interface OwnedNativeTransport extends NativeTransport {
  start(...parameters: Parameters<NativeTransport["start"]>): OwnedNativeProcess;
}

const early = "fabricated early input\n";
const allowed = "fabricated accepted input\n";
const unavailable = { state: "unavailable" } as const;
const platform = { skip: process.platform !== "win32", timeout: 20_000 };

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
      closed(exit) { pipesClosed.resolve(exit); events.closed(exit); },
    });
    return owned;
  }

  return { argv, options, marker, ready, startReader, pipesClosed,
    checkClaim: () => assert.deepEqual(readFileSync(ledger), claimed),
  };
}

function setup(t: TestContext, factory: ReturnType<typeof ownedFactory>, activationSucceeds = true) {
  const f = fixture(t);
  const verified = deferred<Membership>();
  const activating = deferred<void>();
  const active = deferred<boolean>();
  const released = deferred<void>();
  const closed = deferred<NativeExit>();
  const job = {}, child = {};
  const trace = { ready: 0, activations: 0, disposed: 0, writes: [] as string[], launches: 0 };
  let sample: GroupSample = { job, activeProcesses: 1, complete: true };
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
          endInput() { reader.endInput(); },
        },
        verify: () => verified.promise,
        activate() { trace.activations++; activating.resolve(); return active.promise; },
        observe: async () => sample,
        disposeBeforeInput() { trace.disposed++; reader.endInput(); },
      };
    },
  }).start(f.argv, f.options, {
    spawned() { trace.ready++; released.resolve(); },
    stdout() {}, stderr() {}, inputError() { assert.fail("unexpected fixture input error"); },
    closed: closed.resolve,
  });
  if (!activationSucceeds) active.resolve(false);
  return { ...f, owned, activating, active, verified, released, closed, job, child, trace,
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
  assert.deepEqual(await f.pipesClosed.promise, { code: 0, signal: null, error: null });
  assert.deepEqual(readFileSync(f.marker), Buffer.from(allowed));
  f.checkClaim();
});

test("owned transport gates input until exact membership and activation, with separate group evidence", platform, async t => {
  const f = setup(t, ownedFactory());
  assert.equal(f.owned.write(early), false);
  await f.ready.promise;
  assert.deepEqual(f.trace, { ready: 0, activations: 0, disposed: 0, writes: [], launches: 1 });
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
  assert.deepEqual(await f.owned.observeOriginalGroup(), { state: "verified", activeProcesses: 1 });
  assert.equal(f.owned.write(allowed), true);
  f.owned.endInput();
  assert.deepEqual(await f.closed.promise, { code: 0, signal: null, error: null });
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

for (const fault of ["unavailable", "foreign job", "foreign child", "activation refused"] as const) {
  test(`owned transport exposes zero input for ${fault}`, platform, async t => {
    const f = setup(t, ownedFactory(), false);
    await f.ready.promise;
    assert.equal(f.owned.write(early), false);
    f.verified.resolve(fault === "unavailable" ? null : {
      job: fault === "foreign job" ? {} : f.job, child: fault === "foreign child" ? {} : f.child,
    });
    assert.deepEqual(await f.closed.promise, { code: null, signal: null, error: "spawn" });
    assert.equal(f.owned.write(allowed), false);
    assert.deepEqual(f.trace, { ready: 0, activations: fault === "activation refused" ? 1 : 0, disposed: 1, writes: [], launches: 1 });
    assert.deepEqual(await f.owned.observeOriginalGroup(), unavailable);
    assert.equal(existsSync(f.marker), false);
    f.checkClaim();
  });
}

test("an unavailable Windows launcher never falls back to a generic native process", platform, async t => {
  const factory = ownedFactory();
  const f = fixture(t);
  const closed = deferred<NativeExit>();
  let attempts = 0, ready = 0;
  const child = factory({ start() { attempts++; return null; } }).start(f.argv, f.options, {
    spawned() { ready++; }, stdout() { assert.fail(); }, stderr() {}, inputError() { assert.fail(); }, closed: closed.resolve,
  });
  assert.equal(child.write(early), false);
  assert.deepEqual(await closed.promise, { code: null, signal: null, error: "spawn" });
  assert.equal(attempts, 1);
  assert.equal(ready, 0);
  assert.deepEqual(await child.observeOriginalGroup(), unavailable);
  assert.equal(existsSync(f.marker), false);
  f.checkClaim();
});
