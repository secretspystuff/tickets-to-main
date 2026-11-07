import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadLedger, saveLedger, updateLedger } from "../src/ledger.ts";
import { recoverInstall } from "../src/install.ts";
import { withStateLease } from "../src/state-lease.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { assertNonInstallState, installFixture, nonInstallState, seedRetainedLedger, snapshot } from "./release-test-fixtures.ts";

const ledgerModule = new URL("../src/ledger.ts", import.meta.url).href;
const leaseModule = new URL("../src/state-lease.ts", import.meta.url).href;

function child(source: string, args: string[]) {
  const process = spawn(globalThis.process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, ...args], {
    stdio: "pipe", env: { PATH: globalThis.process.env.PATH ?? "", SystemRoot: globalThis.process.env.SystemRoot ?? "" },
  });
  const lines: string[] = [];
  const waiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let pending = "";
  let stderr = "";
  let closed = false;
  process.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  process.stdout.on("data", (data: Buffer) => {
    pending += data.toString();
    for (;;) {
      const index = pending.indexOf("\n");
      if (index < 0) break;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      lines.push(line);
      waiters.get(line)?.resolve();
      waiters.delete(line);
    }
  });
  process.on("error", (error) => { for (const waiter of waiters.values()) waiter.reject(error); });
  process.on("close", (code) => {
    closed = true;
    for (const waiter of waiters.values()) waiter.reject(new Error(`Synthetic transaction child ended ${code}: ${stderr}`));
  });
  const exited = once(process, "close");
  return {
    process,
    lines,
    wait(line: string): Promise<void> {
      if (lines.includes(line)) return Promise.resolve();
      if (closed) return Promise.reject(new Error(`Synthetic child already ended: ${stderr}`));
      return new Promise((resolve, reject) => { waiters.set(line, { resolve, reject }); });
    },
    resume() { process.stdin.write("x"); },
    async done(code = 0) { const result = await exited; assert.equal(result[0], code, stderr); },
  };
}

const barrier = `
  import { readSync } from 'node:fs';
  const wait = () => readSync(0, Buffer.alloc(1), 0, 1, null);
  const say = (value) => process.stdout.write(value + String.fromCharCode(10));
`;

test("stale saveLedger refuses rather than overwriting any newer supported record field", () => {
  const dir = tempDir();
  try {
    const retained = seedRetainedLedger(dir);
    const stale = loadLedger(dir);
    assert.equal(stale.ok, true);
    if (!stale.ok || !stale.ledger.connection) throw new Error("Fixture state unavailable.");
    updateLedger(dir, [], (current) => { current.workspace = { path: "/fabricated/new-workspace", writerPid: null, qualified: false }; });
    const expected = nonInstallState(dir);
    stale.ledger.connection.computer = "stale-writer";
    assert.throws(() => saveLedger(dir, stale.ledger, []));
    assertNonInstallState(dir, expected);
    assert.deepEqual(expected.checkAttempts, retained.checkAttempts);
  } finally { removeDir(dir); }
});

test("forced cross-process stale load/save cannot erase a completed transaction", async (t) => {
  const dir = tempDir();
  try {
    seedRetainedLedger(dir);
    const a = child(`${barrier}
      import { loadLedger, saveLedger } from ${JSON.stringify(ledgerModule)};
      const loaded = loadLedger(process.argv[1]);
      if (!loaded.ok || !loaded.ledger.connection) process.exit(81);
      loaded.ledger.connection.computer = 'stale-process';
      say('loaded'); wait();
      try { saveLedger(process.argv[1], loaded.ledger, []); say('overwrote'); process.exitCode = 82; }
      catch { say('refused'); }
    `, [dir]);
    t.after(() => { a.process.kill(); });
    await a.wait("loaded");
    const b = child(`
      import { updateLedger } from ${JSON.stringify(ledgerModule)};
      updateLedger(process.argv[1], [], (current) => { current.workspace = { path: '/fabricated/new-workspace', writerPid: null, qualified: false }; });
    `, [dir]);
    t.after(() => { b.process.kill(); });
    await b.done();
    const expected = nonInstallState(dir);
    a.resume();
    await a.wait("refused");
    await a.done();
    assertNonInstallState(dir, expected);
  } finally { removeDir(dir); }
});

test("short shared transactions serialize two processes without losing unrelated fields", async (t) => {
  const dir = tempDir();
  try {
    seedRetainedLedger(dir);
    const a = child(`${barrier}
      import { updateLedger } from ${JSON.stringify(ledgerModule)};
      updateLedger(process.argv[1], [], (current) => { current.connection.computer = 'new-computer'; say('locked'); wait(); });
      say('saved');
    `, [dir]);
    t.after(() => { a.process.kill(); });
    await a.wait("locked");
    const b = child(`${barrier}
      import { updateLedger } from ${JSON.stringify(ledgerModule)};
      try { updateLedger(process.argv[1], [], (current) => { current.workspace.path = '/fabricated/new-workspace'; }); say('entered'); process.exitCode = 83; }
      catch { say('held'); }
      wait();
      updateLedger(process.argv[1], [], (current) => { current.workspace.path = '/fabricated/new-workspace'; });
      say('saved');
    `, [dir]);
    t.after(() => { b.process.kill(); });
    await b.wait("held");
    assert.equal(b.lines.includes("entered"), false);
    a.resume();
    await a.wait("saved");
    await a.done();
    b.resume();
    await b.wait("saved");
    await b.done();
    const state = loadLedger(dir);
    assert.equal(state.ok && state.ledger.connection?.computer, "new-computer");
    assert.equal(state.ok && state.ledger.workspace?.path, "/fabricated/new-workspace");
    assert.equal(state.ok && state.ledger.checkAttempts?.length, 1);
  } finally { removeDir(dir); }
});

test("two stale-owner observers cannot remove or replace the newer process lease", async (t) => {
  const dir = tempDir();
  try {
    seedRetainedLedger(dir);
    const crashed = child(`
      import { withStateLease } from ${JSON.stringify(leaseModule)};
      withStateLease(process.argv[1], 'release', () => process.exit(73));
    `, [dir]);
    t.after(() => { crashed.process.kill(); });
    await crashed.done(73);
    const a = child(`${barrier}
      import { withStateLease } from ${JSON.stringify(leaseModule)};
      let observed = false;
      try {
        withStateLease(process.argv[1], 'release', () => { say('entered'); process.exitCode = 84; }, {
          onCheckpoint: (phase) => { if (phase === 'observed-stale' && !observed) { observed = true; say('stale'); wait(); } },
        });
      } catch { say('held'); }
    `, [dir]);
    t.after(() => { a.process.kill(); });
    await a.wait("stale");
    const b = child(`${barrier}
      import { withStateLease } from ${JSON.stringify(leaseModule)};
      withStateLease(process.argv[1], 'release', () => { say('owned'); wait(); });
    `, [dir]);
    t.after(() => { b.process.kill(); });
    await b.wait("owned");
    const held = snapshot(dir);
    a.resume();
    await a.wait("held");
    await a.done();
    assert.equal(a.lines.includes("entered"), false);
    assert.deepEqual(snapshot(dir), held, "A stale observer changed the current owner's files.");
    b.resume();
    await b.done();
    withStateLease(dir, "release", () => { assert.deepEqual(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")).connection.computer, "fabricated-computer"); });
  } finally { removeDir(dir); }
});

for (const namespace of ["ledger", "release"] as const) {
  test(`partial inert completion marker in ${namespace} never blocks a new transaction or installation recovery`, async (t) => {
    const dir = tempDir();
    try {
      seedRetainedLedger(dir);
      const sample = installFixture(dir);
      const retained = nonInstallState(dir);
      const beforeLedger = readFileSync(join(dir, "ledger.json"));
      const crashed = child(`
        import { withStateLease } from ${JSON.stringify(leaseModule)};
        withStateLease(process.argv[1], process.argv[2], () => {}, {
          onCheckpoint: (phase) => { if (phase === 'release-marker-writing') process.exit(73); },
        });
      `, [dir, namespace]);
      t.after(() => { crashed.process.kill(); });
      await crashed.done(73);
      assert.deepEqual(readFileSync(join(dir, "ledger.json")), beforeLedger);
      assertNonInstallState(dir, retained);
      const root = join(dir, ".state-leases", namespace);
      const epochs = readdirSync(root).filter((name) => /^epoch-[0-9]+$/.test(name)).sort((a, b) => Number(BigInt(a.slice(6)) - BigInt(b.slice(6))));
      const current = join(root, epochs.at(-1)!);
      const owner = readFileSync(join(current, "owner.json"));
      const prepared = readFileSync(join(current, "released.prepared"));
      assert.ok(prepared.length > 0 && prepared.length < owner.length, "The process must actually leave a partial inert completion marker.");
      assert.equal(existsSync(join(current, "released")), false, "Incomplete completion bytes must never be published as authoritative.");
      if (namespace === "ledger") {
        updateLedger(dir, [], (record) => { record.workspace!.path = "/fabricated/after-crash"; });
        (retained.workspace as { path: string }).path = "/fabricated/after-crash";
      } else {
        recoverInstall(sample.input, sample.services);
        assert.deepEqual(readFileSync(join(dir, "ledger.json")), beforeLedger);
        const recovered = snapshot(dir);
        recoverInstall(sample.input, sample.services);
        assert.deepEqual(snapshot(dir), recovered);
      }
      assertNonInstallState(dir, retained);
      assert.deepEqual(readFileSync(join(current, "released.prepared")), prepared, "Recovery must not remove or rewrite another immutable owner's partial marker.");
    } finally { removeDir(dir); }
  });
}
