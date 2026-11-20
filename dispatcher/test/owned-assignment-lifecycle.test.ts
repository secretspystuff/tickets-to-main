import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  | "start flush" | "interrupted" | "wrong terminal" | "revoked after execution" | "result flush" | "witness lost"
  | "state changed during staging" | "state changed during bind" | "state changed during start" | "state changed during terminal"
  | "opt-in withdrawn" | "close rejected" | "missing journal";
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
  let output = "", inputErrors = 0, activations = 0, exits = 0;
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
    spawned() {}, stderr() {}, inputError() { inputErrors++; }, closed(result) { exits++; closed.resolve(result); },
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
    owned, dispose, closed: closed.promise, get activations() { return activations; }, get exits() { return exits; },
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
  const f = space(t, mode === "wrong writer" || mode === "close rejected");
  const { flushes, faults, started } = observeFlushes(t, f, mode);
  const snapshot = () => ({ ledger: readFileSync(f.ledger), journal: f.journalText() });
  const savedJournal = `${f.journal}.saved`;
  let atStateChange: ReturnType<typeof snapshot> | undefined;
  let stateChangeArmed = false;
  let changedInEpoch: string | undefined;
  let mismatchObservations = 0;
  let atJournalLoss: ReturnType<typeof snapshot> | undefined;
  if (mode.startsWith("state changed")) {
    const { lstatSync: lstat, renameSync: rename } = fs;
    const leaseRoot = join(f.base.stateDir, ".state-leases", "ledger");
    fs.renameSync = (source, destination) => {
      rename(source, destination);
      if (!stateChangeArmed || atStateChange || typeof source !== "string" || typeof destination !== "string"
        || dirname(source) !== leaseRoot || !basename(source).startsWith(".claim-")
        || dirname(destination) !== leaseRoot || !/^epoch-\d+$/.test(basename(destination))) return;
      changedInEpoch = destination;
      atStateChange = snapshot();
    };
    assert.equal(Reflect.set(fs, "lstatSync", (...args: Parameters<typeof lstat>) => {
      const info = lstat(...args);
      if (atStateChange && args[0] === f.base.stateDir && info && typeof info.ino === "bigint") {
        if (!changedInEpoch || !existsSync(join(changedInEpoch, "released"))) mismatchObservations++;
        info.ino += 1n;
      }
      return info;
    }), true);
    syncBuiltinESMExports();
    t.after(() => { fs.renameSync = rename; Reflect.set(fs, "lstatSync", lstat); syncBuiltinESMExports(); });
  }
  const events: Trace[] = [];
  const record = (event: string) => events.push({ event, kinds: f.rows().map(r => r.kind),
    writer: f.claim()?.writerPid, generation: f.claim()?.claimGeneration, flushes: [...flushes] });
  const closing = deferred<void>(), permitClose = deferred<void>();
  t.after(() => permitClose.resolve());
  let fallback = 0, reconciliations = 0, replaced = false, disposed = 0, withdrawn = false, substitutePreparations = 0;
  let replacement: Buffer | undefined;
  let staged: Awaited<ReturnType<typeof stage>> | undefined;
  const input: OwnedInput = {
    ...f.base, adapter: {
      kind: "fabricated-harness",
      async readCurrent() {
        if (mode === "opt-in withdrawn" && !withdrawn) {
          input.owned.prepare = async () => { substitutePreparations++; throw new Error("fabricated substitute preparer"); };
          assert.equal(Reflect.deleteProperty(input, "owned"), true);
          withdrawn = true;
        }
        const bound = f.claim()?.claimGeneration !== undefined;
        if (mode === "state changed during start" && bound) stateChangeArmed = true;
        const revoked = (mode === "revoked" && bound)
          || (mode === "revoked after execution" && events.some(event => event.event === "root closed"));
        if (mode === "claim replaced" && bound && !replaced) {
          claimWorkspace(f.base.stateDir, f.owner, () => true);
          replaced = true;
        }
        if (mode === "missing journal" && bound && !atJournalLoss) {
          atJournalLoss = snapshot();
          renameSync(f.journal, savedJournal);
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
      if (mode === "state changed during staging") atStateChange = snapshot();
      if (mode === "state changed during bind") stateChangeArmed = true;
      return {
        original: { observeOriginalGroup() { record("sample"); return child.owned.observeOriginalGroup(); } },
        async execute(value) {
          record("execute");
          assert.ok(!mode.startsWith("state changed") || mode === "state changed during terminal",
            "a different state directory cannot authorize native input");
          assert.equal(value.workspace, f.workspace);
          await child.execute(value.input);
          record("root closed");
          assert.deepEqual(readFileSync(f.marker), Buffer.from(f.request.input));
          if (mode === "state changed during terminal") stateChangeArmed = true;
          if (mode === "interrupted") throw new Error("fabricated interruption after local start");
          if (mode === "witness lost") child.owned.closeObservation();
          const result = f.receipt(value);
          return mode === "wrong terminal" ? { ...result, id: id(20) } : result;
        },
        async close() {
          record("close");
          closing.resolve();
          if (gateClose) await permitClose.promise;
          if (mode === "close rejected") throw new Error("fabricated disposal acknowledgement unavailable");
          await child.dispose();
          assert.deepEqual(await child.owned.observeOriginalGroup(), { state: "unavailable" });
          disposed++;
        },
      };
    } },
  };
  return { ...f, events, faults, started, snapshot, savedJournal, get stateChange() { return atStateChange; },
    get changedInEpoch() { return changedInEpoch; }, get mismatchObservations() { return mismatchObservations; },
    get journalLoss() { return atJournalLoss; }, get withdrawn() { return withdrawn; }, get substitutePreparations() { return substitutePreparations; },
    closing: closing.promise, permitClose: () => permitClose.resolve(),
    run: () => runAssignment(input), get disposed() { return disposed; }, get replacement() { return replacement; },
    get fallback() { return fallback; }, get reconciliations() { return reconciliations; },
    get replaced() { return replaced; },
    get activations() { return staged?.activations ?? 0; },
    get childExits() { return staged?.exits ?? 0; },
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

for (const mode of ["state changed during staging", "state changed during bind", "state changed during start", "state changed during terminal"] as const) {
  test(`owned runner preserves the journal and ledger when ${mode}`, onWindows, async t => {
    const f = ownedCase(t, mode);
    const result = await f.run();
    assert.ok(f.stateChange, "the state continuity observation must change at the intended barrier");
    if (mode !== "state changed during staging") {
      assert.ok(f.changedInEpoch, "the guard must encounter a changed state inside the expected ledger lease");
      const owner = readFileSync(join(f.changedInEpoch, "owner.json"));
      assert.equal(JSON.parse(owner.toString("utf8")).pid, process.pid);
      assert.deepEqual(readFileSync(join(f.changedInEpoch, "released")), owner);
      assert.ok(f.mismatchObservations > 0, "the lost state instance must be observed while that epoch is held");
    }
    assert.deepEqual(result, { state: "held", ...unqualified });
    const executed = mode === "state changed during terminal";
    const alreadyBound = executed || mode === "state changed during start";
    assert.equal(parseLedger(f.stateChange.ledger.toString("utf8"))?.workspace?.claimGeneration !== undefined, alreadyBound);
    assert.deepEqual(f.stateChange.journal.trim().split("\n").map(line => JSON.parse(line).kind), executed ? ["intent", "started"] : ["intent"]);
    assert.deepEqual(f.events.map(event => event.event), ["prepared", "suspended",
      ...(executed ? ["execute", "resume", "root closed"] : []), "close"]);
    assert.deepEqual(f.rows().map(row => row.kind), executed ? ["intent", "started"] : ["intent"]);
    assert.deepEqual(f.snapshot(), f.stateChange);
    assert.equal(f.activations, executed ? 1 : 0);
    assert.equal(existsSync(f.marker), executed);
    assert.equal(f.disposed, 1);
    assert.equal(f.fallback, 0);
  });
}

test("an owned opt-in stays selected when its input property is withdrawn during admission", onWindows, async t => {
  const f = ownedCase(t, "opt-in withdrawn");
  assert.deepEqual(await f.run(), { state: "completed", ...unqualified });
  assert.equal(f.withdrawn, true);
  assert.equal(f.substitutePreparations, 0);
  assert.deepEqual(f.events.map(event => event.event), ["prepared", "suspended", "execute", "resume", "root closed", "sample", "close"]);
  assert.deepEqual(f.rows().map(row => row.kind), ["intent", "started", "result"]);
  assert.equal(f.claim()?.writerPid, null);
  assert.equal(f.fallback, 0);
  assert.equal(f.activations, 1);
  assert.equal(f.disposed, 1);
});

test("an owned disposal rejection holds the workspace and prevents handoff or replay", onWindows, async t => {
  const f = ownedCase(t, "close rejected");
  const result = await f.run();
  assert.deepEqual(f.events.map(event => event.event), ["prepared", "suspended", "close"]);
  assert.equal(f.childExits, 0, "the staged fixture is still awaiting cleanup");
  assert.equal(f.claim()?.writerPid, f.owner);
  assert.equal(f.disposed, 0);
  assert.equal(f.activations, 0);
  assert.equal(existsSync(f.marker), false);
  const before = f.snapshot();
  const replay = await f.run();
  const later = { ...f.request, id: id(21), sequence: 2 };
  let nextReads = 0, nextWork = 0;
  const other: OwnedInput = {
    ...f.base, raw: JSON.stringify(later),
    adapter: {
      kind: "fabricated-harness",
      async readCurrent() {
        nextReads++;
        return { binding: later.binding, nextSequence: later.sequence, authorized: true, seat: "member",
          confirmedWorkspace: f.workspace, writersContained: true };
      },
      async execute() { nextWork++; throw new Error("unexpected successor execution"); },
      async reconcile() { nextWork++; return null; },
    },
    owned: { async prepare() { nextWork++; throw new Error("unexpected successor preparation"); } },
  };
  const successorResult = await runAssignment(other);
  assert.deepEqual({ result, replay, successorResult, nextReads, nextWork }, {
    result: { state: "held", ...unqualified }, replay: { state: "held", ...unqualified },
    successorResult: { state: "held", ...unqualified }, nextReads: 1, nextWork: 0,
  });
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.events.map(event => event.event), ["prepared", "suspended", "close"]);
  assert.equal(f.fallback, 0);
  assert.equal(f.reconciliations, 0);
  assert.equal(f.disposals.length, 1);
  await f.disposals[0]!();
  assert.equal(f.childExits, 1, "test cleanup must close the exact staged fixture once");
});

test("an owned start refusal preserves a missing prepared journal and its saved bytes", onWindows, async t => {
  const f = ownedCase(t, "missing journal");
  assert.deepEqual(await f.run(), { state: "held", ...unqualified });
  assert.ok(f.journalLoss, "the journal must be moved aside after the exact claim is bound");
  assert.equal(existsSync(f.journal), false);
  assert.equal(readFileSync(f.savedJournal, "utf8"), f.journalLoss.journal);
  assert.deepEqual(readFileSync(f.ledger), f.journalLoss.ledger);
  assert.deepEqual(f.events.map(event => event.event), ["prepared", "suspended", "close"]);
  assert.equal(f.started.length, 0);
  assert.equal(f.activations, 0);
  assert.equal(f.disposed, 1);
  assert.equal(f.fallback, 0);
  assert.equal(existsSync(f.marker), false);
});
