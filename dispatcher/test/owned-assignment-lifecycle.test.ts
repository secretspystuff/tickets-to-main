import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runAssignment, type AssignmentAdapter, type AssignmentInput, type AssignmentRequest, type AssignmentTerminal } from "../src/assignment-boundary.ts";
import type { Intent } from "../src/assignment-journal.ts";
import { ensurePrivateDirectory } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { parseLedger, updateLedger } from "../src/ledger.ts";
import {
  windowsOwnedNativeTransport, windowsProcessLauncher, type NativeExit, type WindowsOwnedNativeProcess,
} from "../src/native-transport.ts";
import { claimWorkspace, prepareWorkspace } from "../src/workspace.ts";
import { removeDir } from "./helpers.ts";

type PreparedExecution = {
  original: Pick<WindowsOwnedNativeProcess, "observeOriginalGroup">;
  execute: AssignmentAdapter["execute"];
  close(): Promise<void>;
};
type OwnedInput = AssignmentInput & {
  owned: { prepare(input: { intent: Intent; workspace: string }): Promise<PreparedExecution> };
};
type Scenario = "complete" | "wrong writer" | "revoked" | "claim replaced" | "successor claim" | "prepare rejected"
  | "start flush" | "interrupted" | "wrong terminal" | "revoked after execution" | "result flush" | "witness lost";
type JournalRow = { kind: string; id: string; sequence: number; requestDigest: string; outcome?: string };
const onWindows = { skip: process.platform !== "win32", timeout: 24_000 };
const unqualified = { qualification: "unqualified-harness", publishable: false } as const;
const nativeExit = { code: 0, signal: null, error: null };
const successor = "11111111-1111-4111-8111-111111111111";
const id = (value: number) => value.toString(16).padStart(32, "0");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The owned fixture did not answer its barrier.")), 8_000);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { clearTimeout(timer); }
}

function space(t: TestContext, wrongWriter = false) {
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-owned-transport-")));
  assert.equal(dirname(root), parent);
  const stateDir = join(root, "state"), requested = join(root, "workspace");
  const disposals: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const dispose of disposals) await dispose();
    assert.equal(dirname(realpathSync(root)), parent);
    removeDir(root);
  });
  ensurePrivateDirectory(root);
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, requested, () => false);
  const workspace = realpathSync(requested);
  const owner = process.pid + Number(wrongWriter);
  claimWorkspace(stateDir, owner, () => true);
  writeFileSync(join(workspace, "work.txt"), "fabricated checkout\n", { flag: "wx" });
  const request: AssignmentRequest = {
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input: "fabricated owned runner input\n",
    binding: { board: id(2), repo: id(3), activation: id(4), connection: id(5), job: id(6), claim: id(7),
      requirements: id(8), candidate: id(9), policy: id(10), fence: 1 },
  };
  const ledger = join(stateDir, "ledger.json"), journal = join(stateDir, "assignment-intents.jsonl");
  const journalText = () => existsSync(journal) ? readFileSync(journal, "utf8") : "";
  const rows = () => journalText().trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as JournalRow);
  const local = () => parseLedger(readFileSync(ledger, "utf8"));
  const claim = () => local()?.workspace;
  const receipt = (execute: Parameters<AssignmentAdapter["execute"]>[0]): AssignmentTerminal => ({
    id: execute.id, sequence: execute.sequence, result: "completed", writersContained: true,
  });
  const base = { stateDir, raw: JSON.stringify(request), secrets: [], now: () => 1000 };
  return { parent, workspace, owner, request, ledger, journal, journalText, rows, local, claim, receipt, base, disposals,
    marker: join(workspace, "received.bin"), env: { SystemRoot: process.env.SystemRoot, TEMP: parent, TMP: parent } };
}

type Space = ReturnType<typeof space>;
type Trace = { event: string; kinds: string[]; writer: number | null | undefined; generation: string | undefined; flushes: string[] };

function observeFlushes(t: TestContext, f: Space, mode: Scenario) {
  const flushes: string[] = [], faults: string[] = [];
  const started: Array<{ writer: number | null | undefined; generation: string | undefined; bindings: string[] | undefined }> = [];
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => {
    const listed = existsSync(f.journal) ? fs.lstatSync(f.journal) : null;
    const opened = fs.fstatSync(fd);
    const kind = listed && opened.dev === listed.dev && opened.ino === listed.ino ? f.rows().at(-1)?.kind : undefined;
    if (kind === "started" && started.length === 0) {
      const ledger = f.local();
      started.push({ writer: ledger?.workspace?.writerPid, generation: ledger?.workspace?.claimGeneration,
        bindings: ledger?.boundWorkspaceIntents });
    }
    if (kind && !faults.length && ((mode === "start flush" && kind === "started") || (mode === "result flush" && kind === "result"))) {
      faults.push(kind);
      throw Object.assign(new Error("fabricated journal flush unavailable"), { code: "EIO" });
    }
    original(fd);
    if (kind) flushes.push(kind);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.fsyncSync = original; syncBuiltinESMExports(); });
  return { flushes, faults, started };
}

async function stage(f: Space, beforeResume: () => void) {
  const launcher = windowsProcessLauncher();
  const atResume = deferred<void>(), allowResume = deferred<boolean>();
  const ready = deferred<void>(), closed = deferred<NativeExit>();
  const argv = [realpathSync(process.execPath), fileURLToPath(new URL("./windows-owned-input.fixture.mjs", import.meta.url))];
  let output = "", inputErrors = 0, activations = 0;
  const owned = windowsOwnedNativeTransport({
    async start(...args) {
      const launch = await launcher.start(...args);
      if (!launch) return null;
      return { ...launch, async activate() {
        atResume.resolve();
        if (!await allowResume.promise) return false;
        beforeResume();
        activations++;
        return launch.activate();
      } };
    },
  }).start(argv, { cwd: f.workspace, env: f.env }, {
    spawned() {}, stderr() {}, inputError() { inputErrors++; }, closed: closed.resolve,
    stdout(chunk) { output += chunk; if (output.includes("reader-ready\n")) ready.resolve(); },
  });
  let disposal: Promise<void> | undefined;
  function dispose() {
    disposal ??= (async () => {
      owned.endInput();
      allowResume.resolve(false);
      await bounded(closed.promise);
      owned.closeObservation();
    })();
    return disposal;
  }
  f.disposals.push(dispose);
  assert.equal(await bounded(Promise.race([atResume.promise, closed.promise])), undefined,
    "existing Windows launcher must reach verified suspension");
  return {
    owned, dispose, closed: closed.promise, get activations() { return activations; },
    async execute(input: string) {
      allowResume.resolve(true);
      assert.equal(await bounded(Promise.race([ready.promise, closed.promise])), undefined);
      assert.equal(owned.write(input), true);
      owned.endInput();
      assert.deepEqual(await bounded(closed.promise), nativeExit);
      assert.equal(inputErrors, 0);
      assert.deepEqual(await owned.observeOriginalGroup(), { state: "verified", activeProcesses: 0 });
    },
  };
}

function ownedCase(t: TestContext, mode: Scenario, gateClose = false) {
  const f = space(t, mode === "wrong writer");
  const { flushes, faults, started } = observeFlushes(t, f, mode);
  const events: Trace[] = [];
  const record = (event: string) => events.push({ event, kinds: f.rows().map(r => r.kind),
    writer: f.claim()?.writerPid, generation: f.claim()?.claimGeneration, flushes: [...flushes] });
  const closing = deferred<void>(), permitClose = deferred<void>();
  t.after(() => permitClose.resolve());
  let fallback = 0, reconciliations = 0, replaced = false, disposed = 0;
  let replacement: Buffer | undefined;
  let staged: Awaited<ReturnType<typeof stage>> | undefined;
  const input: OwnedInput = {
    ...f.base, adapter: {
      kind: "fabricated-harness",
      async readCurrent() {
        const bound = f.claim()?.claimGeneration !== undefined;
        const revoked = (mode === "revoked" && bound)
          || (mode === "revoked after execution" && events.some(event => event.event === "root closed"));
        if (mode === "claim replaced" && bound && !replaced) {
          claimWorkspace(f.base.stateDir, f.owner, () => true);
          replaced = true;
        }
        if (mode === "successor claim" && bound && !replaced) {
          updateLedger(f.base.stateDir, [], ledger => {
            assert.ok(ledger.workspace?.claimGeneration);
            assert.notEqual(ledger.workspace.claimGeneration, successor);
            ledger.workspace.claimGeneration = successor;
          });
          replacement = readFileSync(f.ledger);
          replaced = true;
        }
        return { binding: f.request.binding, nextSequence: 1, authorized: !revoked, seat: "member",
          confirmedWorkspace: f.workspace, writersContained: true };
      },
      async execute() { fallback++; throw new Error("Owned work cannot use legacy execution."); },
      async reconcile() { reconciliations++; return null; },
    },
    owned: { async prepare(prepared) {
      record("prepared");
      assert.equal(prepared.workspace, f.workspace);
      assert.deepEqual(f.rows(), [prepared.intent], "the exact prepared intent must come from the runner");
      assert.ok(flushes.includes("intent"));
      assert.equal(f.claim()?.claimGeneration, undefined);
      if (mode === "prepare rejected") throw new Error("fabricated preparation refusal");
      const child = staged = await stage(f, () => {
        record("resume");
        assert.deepEqual(f.rows().map(row => row.kind), ["intent", "started"]);
        assert.ok(flushes.includes("started"));
        assert.ok(f.claim()?.claimGeneration);
        assert.equal(f.claim()?.writerPid, f.owner);
      });
      record("suspended");
      return {
        original: { observeOriginalGroup() { record("sample"); return child.owned.observeOriginalGroup(); } },
        async execute(value) {
          record("execute");
          assert.equal(value.workspace, f.workspace);
          await child.execute(value.input);
          record("root closed");
          assert.deepEqual(readFileSync(f.marker), Buffer.from(f.request.input));
          if (mode === "interrupted") throw new Error("fabricated interruption after local start");
          if (mode === "witness lost") child.owned.closeObservation();
          const result = f.receipt(value);
          return mode === "wrong terminal" ? { ...result, id: id(20) } : result;
        },
        async close() {
          record("close");
          closing.resolve();
          if (gateClose) await permitClose.promise;
          await child.dispose();
          assert.deepEqual(await child.owned.observeOriginalGroup(), { state: "unavailable" });
          disposed++;
        },
      };
    } },
  };
  return { ...f, events, faults, started, closing: closing.promise, permitClose: () => permitClose.resolve(),
    run: () => runAssignment(input), get disposed() { return disposed; }, get replacement() { return replacement; },
    get fallback() { return fallback; }, get reconciliations() { return reconciliations; },
    get replaced() { return replaced; },
    get activations() { return staged?.activations ?? 0; },
  };
}

test("legacy fabricated adapter order remains reserve, start, execute and terminal", onWindows, async t => {
  const f = space(t);
  let calls = 0;
  assert.deepEqual(await runAssignment({ ...f.base, adapter: {
    kind: "fabricated-harness",
    async readCurrent() { return { binding: f.request.binding, nextSequence: 1, authorized: true,
      seat: "member", confirmedWorkspace: f.workspace, writersContained: true }; },
    async execute(value) { calls++; assert.deepEqual(f.rows().map(row => row.kind), ["intent", "started"]); return f.receipt(value); },
    async reconcile() { assert.fail("new legacy assignment reconciled"); },
  } }), { state: "completed", ...unqualified });
  assert.equal(calls, 1);
  assert.deepEqual(f.rows().map(row => row.kind), ["intent", "started", "result"]);
  assert.deepEqual(f.claim(), { path: f.workspace, writerPid: f.owner, qualified: false });
});

test("the benign Windows fixture stages suspended and disposes without resuming or writing", onWindows, async t => {
  const f = space(t);
  assert.equal(process.version, "v24.18.0");
  const child = await stage(f, () => assert.fail("a suspended fixture resumed"));
  assert.deepEqual(await child.owned.observeOriginalGroup(), { state: "unavailable" });
  await child.dispose();
  assert.equal(child.activations, 0);
  assert.equal(existsSync(f.marker), false);
  assert.equal((await child.closed).error, "spawn");
  assert.equal(f.journalText(), "");
});

test("owned runner binds before durable start and clears only after durable terminal with the original Job retained", onWindows, async t => {
  const f = ownedCase(t, "complete");
  assert.deepEqual(await f.run(), { state: "completed", ...unqualified });
  assert.deepEqual(f.events.map(event => event.event), ["prepared", "suspended", "execute", "resume", "root closed", "sample", "close"]);
  const execute = f.events[2]!, sample = f.events[5]!, close = f.events[6]!;
  assert.deepEqual(execute.kinds, ["intent", "started"]);
  assert.ok(execute.generation);
  assert.deepEqual(f.started, [{ writer: f.owner, generation: execute.generation, bindings: [f.request.id] }]);
  assert.equal(sample.generation, execute.generation);
  assert.deepEqual(sample.kinds, ["intent", "started", "result"]);
  assert.ok(sample.flushes.includes("result"));
  assert.equal(sample.writer, f.owner);
  assert.equal(close.writer, null);
  assert.equal(close.generation, undefined);
  assert.equal(f.disposed, 1);
  assert.equal(f.activations, 1);
  assert.equal(f.fallback, 0);
  const journal = f.journalText(), events = f.events.length;
  assert.deepEqual(await f.run(), { state: "completed", ...unqualified });
  assert.equal(f.journalText(), journal);
  assert.equal(f.events.length, events);
  assert.equal(f.reconciliations, 0);
});

for (const mode of ["wrong writer", "revoked", "claim replaced", "successor claim", "start flush"] as const) {
  test(`owned runner closes a staged Job without activation when ${mode} prevents start`, onWindows, async t => {
    const f = ownedCase(t, mode, mode === "wrong writer");
    const run = f.run();
    let returned = false;
    void run.then(() => { returned = true; }, () => { returned = true; });
    if (mode === "wrong writer") {
      try {
        assert.equal(await bounded(Promise.race([f.closing.then(() => "closing"), run.then(() => "returned")])), "closing");
        await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.equal(returned, false, "runner must await native disposal before returning");
        assert.equal(f.disposed, 0);
      } finally { f.permitClose(); }
    }
    const result = await run;
    assert.ok(result.state === "held" || result.state === "not-started");
    assert.deepEqual(f.events.map(event => event.event), ["prepared", "suspended", "close"]);
    assert.equal(f.events.at(-1)?.writer, f.owner);
    assert.equal(f.events.at(-1)?.generation !== undefined, mode === "revoked" || mode === "start flush" || mode === "successor claim");
    assert.equal(f.replaced, mode === "claim replaced" || mode === "successor claim");
    if (mode === "successor claim") {
      assert.equal(f.claim()?.claimGeneration, successor);
      assert.deepEqual(readFileSync(f.ledger), f.replacement);
    }
    assert.equal(f.started.length, Number(mode === "start flush"));
    if (mode !== "start flush") assert.equal(f.rows().some(row => row.kind === "started"), false);
    assert.deepEqual(f.faults, mode === "start flush" ? ["started"] : []);
    assert.equal(f.activations, 0);
    assert.equal(f.disposed, 1);
    assert.equal(f.fallback, 0);
    assert.equal(existsSync(f.marker), false);
    assert.equal(f.rows().some(row => row.outcome === "completed"), false);
  });
}

test("owned prepare rejection cannot fall back to legacy execution", onWindows, async t => {
  const f = ownedCase(t, "prepare rejected");
  const before = readFileSync(f.ledger);
  assert.ok(["held", "not-started"].includes((await f.run()).state));
  assert.deepEqual(f.events.map(event => event.event), ["prepared"]);
  assert.equal(f.started.length, 0);
  assert.equal(f.rows().some(row => row.kind === "started"), false);
  assert.equal(f.fallback, 0);
  assert.equal(f.activations, 0);
  assert.equal(existsSync(f.marker), false);
  assert.deepEqual(readFileSync(f.ledger), before);
});

for (const mode of ["interrupted", "wrong terminal", "revoked after execution", "result flush", "witness lost"] as const) {
  test(`owned runner retains the claim when ${mode} prevents a safe durable release`, onWindows, async t => {
    const f = ownedCase(t, mode);
    assert.deepEqual(await f.run(), { state: mode === "witness lost" ? "completed" : "held", ...unqualified });
    const entries = ["prepared", "suspended", "execute", "resume", "root closed"];
    assert.deepEqual(f.events.map(event => event.event), [...entries, ...(mode === "witness lost" ? ["sample"] : []), "close"]);
    assert.equal(f.activations, 1);
    assert.equal(f.disposed, 1);
    assert.equal(f.fallback, 0);
    assert.equal(f.claim()?.writerPid, f.owner);
    assert.equal(f.claim()?.claimGeneration, f.events[2]?.generation);
    assert.deepEqual(f.faults, mode === "result flush" ? ["result"] : []);
    if (mode === "witness lost") {
      assert.ok(f.events[5]?.flushes.includes("result"));
      const snapshot = { ledger: readFileSync(f.ledger), journal: f.journalText() };
      const counts = () => ({ prepared: f.events.filter(event => event.event === "prepared").length,
        samples: f.events.filter(event => event.event === "sample").length, fallback: f.fallback,
        reconciliations: f.reconciliations, activations: f.activations, disposals: f.disposed });
      const before = counts();
      assert.deepEqual(await f.run(), { state: "completed", ...unqualified });
      assert.deepEqual({ ledger: readFileSync(f.ledger), journal: f.journalText() }, snapshot);
      assert.deepEqual(counts(), before);
    } else {
      assert.equal(f.events.at(-1)?.flushes.includes("result"), false);
      if (mode !== "result flush") assert.deepEqual(f.rows().map(row => row.kind), ["intent", "started"]);
    }
  });
}
