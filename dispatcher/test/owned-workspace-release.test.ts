import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { completeAssignment, journalDigest, reserveAssignment, startAssignment, type Intent } from "../src/assignment-journal.ts";
import { run } from "../src/cli.ts";
import { assignmentDirectory } from "../src/directory-identity.ts";
import { install } from "../src/install.ts";
import { parseLedger, updateLedger } from "../src/ledger.ts";
import type { OriginalGroup, WindowsOwnedNativeProcess } from "../src/native-transport.ts";
import { currentProcessOwner } from "../src/process-identity.ts";
import { stateLeaseStatus, withStateLease } from "../src/state-lease.ts";
import * as workspace from "../src/workspace.ts";
import { io, removeDir, tempDir } from "./helpers.ts";

type OriginalObserver = Pick<WindowsOwnedNativeProcess, "observeOriginalGroup">;
type Bind = (stateDir: string, prepared: Intent, original: OriginalObserver) => object | null;
type Release = (authority: object) => Promise<{ state: "released" | "held" }>;
const held = { state: "held" } as const;
const released = { state: "released" } as const;
const zero: OriginalGroup = { state: "verified", activeProcesses: 0 };
const work = "fabricated work to preserve\n";

function ownedRelease() {
  const bind: unknown = Reflect.get(workspace, "bindOwnedWorkspaceClaim");
  const release: unknown = Reflect.get(workspace, "releaseOwnedWorkspaceClaim");
  assert.equal(typeof bind, "function", "missing internal owned claim binding");
  assert.equal(typeof release, "function", "missing internal owned release");
  return { bind: bind as Bind, release: release as Release };
}

function sandbox(t: TestContext) {
  const root = realpathSync(tempDir());
  t.after(() => removeDir(root));
  const state = join(root, "state"), requested = join(root, "checkout");
  install({ stateDir: state, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  workspace.prepareWorkspace(state, requested, () => false);
  const checkout = assignmentDirectory(requested);
  const owner = currentProcessOwner();
  workspace.claimWorkspace(state, owner.pid, () => true);
  const workPath = join(checkout.path, "work.txt");
  writeFileSync(workPath, work, { flag: "wx" });
  const ledger = join(state, "ledger.json"), journal = join(state, "assignment-intents.jsonl");
  const leaseRoot = join(state, ".state-leases", "ledger");
  const legacy = { path: checkout.path, writerPid: owner.pid, qualified: false } as const;
  function newIntent(sequence: number, directory = checkout): Intent {
    return {
      kind: "intent", version: 4, id: sequence.toString(16).padStart(32, "0"), sequence,
      requestDigest: journalDigest("fabricated request " + sequence), bindingDigest: journalDigest("fabricated binding " + sequence),
      workspaceDigest: journalDigest(directory.path), aliasDigest: journalDigest(directory.identity),
      scopeDigest: journalDigest("fabricated workspace scope"), at: 1000, ...owner,
    };
  }
  function prepare(intent: Intent, directory = checkout) {
    assert.equal(reserveAssignment(state, intent, journalDigest(directory.legacyPath), () => true).state, "new");
  }
  const snapshot = () => ({
    ledger: readFileSync(ledger), journal: existsSync(journal) ? readFileSync(journal) : null, work: readFileSync(workPath),
  });
  return { root, state, checkout, ledger, journal, leaseRoot, legacy, newIntent, prepare, snapshot };
}

type Sandbox = ReturnType<typeof sandbox>;
type JournalState = "prepared" | "started" | "completed" | "failed" | "not-started";

function bind(f: Sandbox, port: ReturnType<typeof ownedRelease>, original: OriginalObserver, state: JournalState = "completed", sequence = 1) {
  const intent = f.newIntent(sequence);
  f.prepare(intent);
  const authority = port.bind(f.state, intent, original);
  assert.ok(authority, "an exact current claim and prepared intent can be bound");
  if (state === "prepared") return authority;
  if (state !== "not-started") startAssignment(f.state, intent, 1001);
  if (state !== "started") completeAssignment(f.state, intent, state, 1002);
  return authority;
}

function verifiedZero(): OriginalObserver {
  return { observeOriginalGroup: async () => zero };
}

function delayedObservation(t: TestContext) {
  let observing!: () => void;
  let answer!: (sample: OriginalGroup) => void;
  const started = new Promise<void>(resolve => { observing = resolve; });
  const sample = new Promise<OriginalGroup>(resolve => { answer = resolve; });
  t.after(() => answer({ state: "unavailable" }));
  return { started, answer, observe: { observeOriginalGroup() { observing(); return sample; } } };
}

function traceRelease(f: Sandbox, sampled: () => number, onReaderLeaseReleased?: () => void) {
  const epochs = () => readdirSync(f.leaseRoot).filter(name => /^epoch-[0-9]+$/.test(name)
    && existsSync(join(f.leaseRoot, name, "owner.json")) && !existsSync(join(f.leaseRoot, name, "released")));
  const events: { action: "read journal" | "replace ledger"; epochs: string[]; samples: number }[] = [];
  const journalDescriptors = new Set<number>(), readerReleaseMarkers = new Set<string>();
  const { openSync: originalOpen, readFileSync: originalRead, closeSync: originalClose, renameSync: originalRename } = fs;
  let reading = true, replaced = false, contended = false;
  fs.openSync = (path, flags, mode) => {
    const fd = originalOpen(path, flags, mode);
    if (path === f.journal) journalDescriptors.add(fd);
    return fd;
  };
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, options: unknown) => {
    const bytes = Reflect.apply(originalRead, fs, [path, options]);
    if (reading && (path === f.journal || (typeof path === "number" && journalDescriptors.has(path)))) {
      const owners = epochs(), samples = sampled();
      events.push({ action: "read journal", epochs: owners, samples });
      if (samples === 1 && owners.length === 1) readerReleaseMarkers.add(join(f.leaseRoot, owners[0]!, "released"));
    }
    return bytes;
  }) as typeof fs.readFileSync;
  fs.closeSync = fd => {
    originalClose(fd);
    journalDescriptors.delete(fd);
  };
  fs.renameSync = (source, destination) => {
    originalRename(source, destination);
    if (destination === f.ledger) {
      events.push({ action: "replace ledger", epochs: epochs(), samples: sampled() });
      replaced = true;
    }
    if (onReaderLeaseReleased && !replaced && !contended && typeof destination === "string" && readerReleaseMarkers.has(destination)) {
      contended = true;
      reading = false;
      try { onReaderLeaseReleased(); }
      finally { reading = true; }
    }
  };
  syncBuiltinESMExports();
  return {
    events, stopReads() { reading = false; },
    restore() {
      fs.openSync = originalOpen;
      fs.readFileSync = originalRead;
      fs.closeSync = originalClose;
      fs.renameSync = originalRename;
      syncBuiltinESMExports();
    },
  };
}

test("legacy workspace release keeps its existing CLI contract", async t => {
  const f = sandbox(t);
  const console = io({ pidAlive: () => true });
  assert.equal(await run(["workspace", "release", "--state", f.state], console), 0);
  assert.equal(console.out, "Writer released.\n");
  assert.deepEqual(parseLedger(readFileSync(f.ledger, "utf8"))?.workspace, { ...f.legacy, writerPid: null });
  assert.equal(f.snapshot().journal, null);
  assert.equal(f.snapshot().work.toString(), work);
});

for (const outcome of ["completed", "failed"] as const) {
  test(`owned workspace release clears one current claim after durable ${outcome} and original Job drain`, async t => {
    const port = ownedRelease(), f = sandbox(t);
    let samples = 0;
    const authority = bind(f, port, { observeOriginalGroup: async () => {
      assert.equal(stateLeaseStatus(f.state, "ledger"), "released");
      samples++;
      return zero;
    } }, outcome);
    assert.equal(samples, 0, "binding cannot use a pre-launch sample for later release");
    const before = f.snapshot();
    const observed = traceRelease(f, () => samples);
    const trace = observed.events;
    try {
      assert.deepEqual(await port.release(authority), released);
      observed.stopReads();
      assert.equal(samples, 1);
      assert.deepEqual(parseLedger(readFileSync(f.ledger, "utf8"))?.workspace, { ...f.legacy, writerPid: null });
      assert.deepEqual(f.snapshot().journal, before.journal);
      assert.deepEqual(f.snapshot().work, before.work);
      const commits = trace.filter(event => event.action === "replace ledger");
      assert.equal(commits.length, 1);
      const commit = commits[0]!;
      assert.equal(commit.epochs.length, 1);
      assert.equal(commit.samples, 1);
      const epoch = commit.epochs[0]!;
      const matching = trace.slice(0, trace.indexOf(commit)).filter(event => event.action === "read journal" && event.samples === 1);
      assert.ok(matching.some(event => event.epochs.length === 1 && event.epochs[0] === epoch),
        "the decisive post-sample journal read and ledger replacement must share one lease");
      const ownerEpoch = join(f.leaseRoot, epoch);
      assert.deepEqual(readFileSync(join(ownerEpoch, "released")), readFileSync(join(ownerEpoch, "owner.json")));
      const after = f.snapshot();
      assert.deepEqual(await port.release(authority), held);
      assert.deepEqual(f.snapshot(), after);
      assert.equal(trace.filter(event => event.action === "replace ledger").length, 1);
    } finally {
      observed.restore();
    }
  });
}

function startContender(f: Sandbox) {
  const contender = f.newIntent(2);
  f.prepare(contender);
  startAssignment(f.state, contender, 1003);
  return f.snapshot();
}

test("the lease-gap fixture starts a competing intent when the journal reader releases first", t => {
  const f = sandbox(t);
  const initial = f.newIntent(1);
  f.prepare(initial);
  startAssignment(f.state, initial, 1001);
  completeAssignment(f.state, initial, "completed", 1002);
  const before = f.snapshot();
  let contender: ReturnType<Sandbox["snapshot"]> | undefined;
  const observed = traceRelease(f, () => 1, () => { contender = startContender(f); });
  try {
    withStateLease(f.state, "ledger", () => { readFileSync(f.journal); });
    assert.ok(contender, "the callback must enter after the first reader releases");
    assert.notDeepEqual(contender.journal, before.journal);
    assert.deepEqual(contender.ledger, before.ledger);
    assert.deepEqual(f.snapshot(), contender);
  } finally { observed.restore(); }
});

test("owned release holds if another assignment starts between the post-observation read and clear", async t => {
  const port = ownedRelease(), f = sandbox(t);
  let samples = 0;
  const authority = bind(f, port, { observeOriginalGroup: async () => { samples++; return zero; } });
  const before = f.snapshot();
  let contender: ReturnType<Sandbox["snapshot"]> | undefined;
  const observed = traceRelease(f, () => samples, () => { contender = startContender(f); });
  try {
    const result = await port.release(authority);
    observed.stopReads();
    if (contender) {
      assert.deepEqual(result, held);
      assert.deepEqual(f.snapshot(), contender);
      assert.equal(observed.events.filter(event => event.action === "replace ledger").length, 0);
    } else {
      assert.deepEqual(result, released);
      assert.deepEqual(f.snapshot().journal, before.journal);
      assert.equal(observed.events.filter(event => event.action === "replace ledger").length, 1);
    }
  } finally { observed.restore(); }
});

const failure = new Error("fabricated native observation failed");
const refusalSamples: Record<string, OriginalObserver["observeOriginalGroup"]> = {
  "live writer": async () => ({ state: "verified", activeProcesses: 1 }),
  "missing original Job observation": async () => ({ state: "unavailable" }),
  "invalid original Job count": async () => ({ state: "verified", activeProcesses: -1 }),
  "thrown observation": () => { throw failure; },
  "rejected observation": () => Promise.reject(failure),
};

for (const [name, observeOriginalGroup] of Object.entries(refusalSamples)) {
  test(`owned workspace release holds on ${name}`, async t => {
    const port = ownedRelease(), f = sandbox(t);
    let attempts = 0;
    const authority = bind(f, port, { observeOriginalGroup() { attempts++; return observeOriginalGroup(); } });
    const before = f.snapshot();
    assert.deepEqual(await port.release(authority), held);
    assert.equal(attempts, 1);
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const state of ["prepared", "started", "not-started", "missing journal", "truncated journal"] as const) {
  test(`original Job zero cannot release without the matching durable started result - ${state}`, async t => {
    const port = ownedRelease(), f = sandbox(t);
    const authority = bind(f, port, verifiedZero(), state === "missing journal" || state === "truncated journal" ? "completed" : state);
    if (state === "missing journal") unlinkSync(f.journal);
    if (state === "truncated journal") appendFileSync(f.journal, "fabricated incomplete record");
    const before = f.snapshot();
    assert.deepEqual(await port.release(authority), held);
    assert.deepEqual(f.snapshot(), before);
  });
}

test("a terminal result for a different workspace cannot release the bound claim", async t => {
  const port = ownedRelease(), f = sandbox(t);
  const authority = bind(f, port, verifiedZero(), "started");
  const otherPath = join(f.root, "other-checkout");
  mkdirSync(otherPath);
  const other = assignmentDirectory(otherPath);
  const foreign = f.newIntent(2, other);
  f.prepare(foreign, other);
  startAssignment(f.state, foreign, 1001);
  completeAssignment(f.state, foreign, "completed", 1002);
  const before = f.snapshot();
  assert.deepEqual(await port.release(authority), held);
  assert.deepEqual(f.snapshot(), before);
});

test("a previously completed intent in the same checkout cannot release a newer started intent", async t => {
  const port = ownedRelease(), f = sandbox(t);
  const first = bind(f, port, verifiedZero());
  assert.deepEqual(await port.release(first), released);
  workspace.claimWorkspace(f.state, f.legacy.writerPid, () => true);
  const second = bind(f, port, verifiedZero(), "started", 2);
  const before = f.snapshot();
  assert.deepEqual(await port.release(second), held);
  assert.deepEqual(f.snapshot(), before);
});

test("a caller cannot substitute a zero observation or copy a zero-capable claim binding", async t => {
  const port = ownedRelease(), f = sandbox(t);
  const authority = bind(f, port, verifiedZero());
  const before = f.snapshot();
  assert.deepEqual(await port.release({ ...authority }), held);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(await port.release(zero), held);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(await port.release(authority), released);
  assert.deepEqual(f.snapshot().journal, before.journal);
});

test("changing the observer object after binding cannot replace the original observation", async t => {
  const port = ownedRelease(), f = sandbox(t);
  const original: OriginalObserver = { observeOriginalGroup: async () => ({ state: "unavailable" }) };
  const authority = bind(f, port, original);
  original.observeOriginalGroup = async () => zero;
  const before = f.snapshot();
  assert.deepEqual(await port.release(authority), held);
  assert.deepEqual(f.snapshot(), before);
});

test("an in-flight original observation cannot clear a same-PID legacy replacement", { timeout: 15_000 }, async t => {
  const port = ownedRelease(), f = sandbox(t);
  const probe = delayedObservation(t);
  const authority = bind(f, port, probe.observe);
  const pending = port.release(authority);
  assert.equal(await Promise.race([probe.started, pending]), undefined, "the Job observation must be in flight");
  workspace.releaseWorkspace(f.state);
  workspace.claimWorkspace(f.state, f.legacy.writerPid, () => true);
  const replacement = f.snapshot();
  assert.deepEqual(parseLedger(replacement.ledger.toString("utf8"))?.workspace, f.legacy);
  probe.answer(zero);
  assert.deepEqual(await pending, held);
  assert.deepEqual(f.snapshot(), replacement);
});

test("observation of an old Job cannot clear a newly bound claim at the same path and PID", { timeout: 15_000 }, async t => {
  const port = ownedRelease(), f = sandbox(t);
  const probe = delayedObservation(t);
  const old = bind(f, port, probe.observe);
  const pending = port.release(old);
  assert.equal(await Promise.race([probe.started, pending]), undefined, "the old Job observation must be in flight");
  const superseded = f.snapshot().ledger;
  updateLedger(f.state, [], current => { current.workspace = { ...f.legacy }; });
  const next = bind(f, port, verifiedZero(), "completed", 2);
  const replacement = f.snapshot();
  assert.notDeepEqual(replacement.ledger, superseded);
  probe.answer(zero);
  assert.deepEqual(await pending, held);
  assert.deepEqual(f.snapshot(), replacement);
  assert.deepEqual(await port.release(next), released);
  assert.deepEqual(f.snapshot().journal, replacement.journal);
});

for (const change of ["remove terminal journal", "start newer workspace intent"] as const) {
  test(`owned workspace release rechecks the durable journal after observing the Job - ${change}`, { timeout: 15_000 }, async t => {
    const port = ownedRelease(), f = sandbox(t);
    const probe = delayedObservation(t);
    const authority = bind(f, port, probe.observe);
    const pending = port.release(authority);
    assert.equal(await Promise.race([probe.started, pending]), undefined, "the Job observation must be in flight");
    if (change === "remove terminal journal") unlinkSync(f.journal);
    else {
      const subsequent = f.newIntent(2);
      f.prepare(subsequent);
      startAssignment(f.state, subsequent, 1001);
    }
    const changed = f.snapshot();
    probe.answer(zero);
    assert.deepEqual(await pending, held);
    assert.deepEqual(f.snapshot(), changed);
  });
}

test("original Job zero cannot release a different directory now at the same path", async t => {
  const port = ownedRelease(), f = sandbox(t);
  const authority = bind(f, port, verifiedZero());
  const old = join(f.root, "preserved-checkout");
  fs.renameSync(f.checkout.path, old);
  mkdirSync(f.checkout.path, { mode: 0o700 });
  writeFileSync(join(f.checkout.path, "work.txt"), "replacement fixture\n", { flag: "wx" });
  assert.notEqual(assignmentDirectory(f.checkout.path).identity, f.checkout.identity);
  const before = f.snapshot();
  assert.deepEqual(await port.release(authority), held);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(readFileSync(join(old, "work.txt"), "utf8"), work);
});

test("an unprepared or foreign intent cannot bind the currently held workspace", t => {
  const port = ownedRelease(), f = sandbox(t);
  const before = f.snapshot();
  assert.equal(port.bind(f.state, f.newIntent(1), verifiedZero()), null);
  assert.deepEqual(f.snapshot(), before);
  const otherPath = join(f.root, "other-checkout");
  mkdirSync(otherPath);
  const other = assignmentDirectory(otherPath);
  const intent = f.newIntent(1, other);
  f.prepare(intent, other);
  const foreign = f.snapshot();
  assert.equal(port.bind(f.state, intent, verifiedZero()), null);
  assert.deepEqual(f.snapshot(), foreign);
});

test("matching identity does not permit binding an altered prepared assignment", t => {
  const port = ownedRelease(), f = sandbox(t);
  const prepared = f.newIntent(1);
  f.prepare(prepared);
  const before = f.snapshot();
  const mismatched = { ...prepared, bindingDigest: journalDigest("fabricated different binding") };
  assert.equal(port.bind(f.state, mismatched, verifiedZero()), null);
  assert.deepEqual(f.snapshot(), before);
  assert.ok(port.bind(f.state, prepared, verifiedZero()));
});

test("an exact prepared assignment cannot bind an unheld workspace", t => {
  const port = ownedRelease(), f = sandbox(t);
  workspace.releaseWorkspace(f.state);
  const prepared = f.newIntent(1);
  f.prepare(prepared);
  const before = f.snapshot();
  assert.equal(parseLedger(before.ledger.toString("utf8"))?.workspace?.writerPid, null);
  assert.equal(port.bind(f.state, prepared, verifiedZero()), null);
  assert.deepEqual(f.snapshot(), before);
});

test("a prepared intent cannot be rebound to a different original observer", async t => {
  const port = ownedRelease(), f = sandbox(t);
  const authority = bind(f, port, verifiedZero(), "prepared");
  const intent = f.newIntent(1);
  const before = f.snapshot();
  assert.equal(port.bind(f.state, intent, { observeOriginalGroup: async () => ({ state: "unavailable" }) }), null);
  assert.deepEqual(f.snapshot(), before);
  startAssignment(f.state, intent, 1001);
  completeAssignment(f.state, intent, "completed", 1002);
  assert.deepEqual(await port.release(authority), released);
});

for (const history of ["started", "completed"] as const) {
  test(`an unrelated Job cannot be bound retroactively to a ${history} intent`, t => {
    const port = ownedRelease(), f = sandbox(t);
    const intent = f.newIntent(1);
    f.prepare(intent);
    startAssignment(f.state, intent, 1001);
    if (history === "completed") completeAssignment(f.state, intent, "completed", 1002);
    const before = f.snapshot();
    assert.equal(port.bind(f.state, intent, verifiedZero()), null);
    assert.deepEqual(f.snapshot(), before);
  });
}
