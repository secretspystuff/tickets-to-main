import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runAssignment, type AssignmentRequest, type CurrentAssignment, type AssignmentTerminal } from "../src/assignment-boundary.ts";

const id = (n: number) => n.toString(16).padStart(32, "0");
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "assignment-boundary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(workspace);
  const request: AssignmentRequest = {
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input: "Fabricated task data",
    binding: { board: id(2), repo: id(3), activation: id(4), connection: id(5), job: id(6), claim: id(7), requirements: id(8), candidate: id(9), policy: id(10), fence: 1 },
  };
  const current: CurrentAssignment = { binding: structuredClone(request.binding), nextSequence: 1, authorized: true, seat: "member", confirmedWorkspace: workspace, writersContained: true };
  const calls: unknown[] = [];
  let reads = 0;
  let now = 1000;
  let effects = async (value: unknown): Promise<AssignmentTerminal> => { calls.push(value); return terminal(); };
  let reconcile = async (): Promise<AssignmentTerminal | null> => null;
  let observe = () => structuredClone(current);
  let kind = "fabricated-harness";
  let secrets = ["fabricated-held-secret"];
  const terminal = (): AssignmentTerminal => ({ id: request.id, sequence: request.sequence, result: "completed", writersContained: true });
  const run = (raw = JSON.stringify(request)) => runAssignment({
    stateDir, raw, secrets, now: () => now,
    adapter: { kind: kind as "fabricated-harness", readCurrent: async () => { reads++; return observe(); }, execute: (value) => effects(value), reconcile: () => reconcile() },
  });
  return { root, stateDir, workspace, request, current, calls, run, terminal,
    get reads() { return reads; },
    set now(value: number) { now = value; },
    set kind(value: string) { kind = value; },
    set secrets(value: string[]) { secrets = value; },
    set effects(value: typeof effects) { effects = value; },
    set reconcile(value: typeof reconcile) { reconcile = value; },
    set observe(value: typeof observe) { observe = value; },
    journal: () => readFileSync(join(stateDir, "assignment-intents.jsonl"), "utf8"),
  };
}

function journalFlush(t: TestContext, stateDir: string, observe: () => void) {
  const original = fs.fsyncSync;
  fs.fsyncSync = (fd: number) => {
    const path = join(stateDir, "assignment-intents.jsonl");
    if (fs.existsSync(path) && fs.fstatSync(fd).ino === fs.lstatSync(path).ino) observe();
    original(fd);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.fsyncSync = original; syncBuiltinESMExports(); });
}

test("flush intent before dispatch; persist only identifiers and digests, never assignment text", async (t) => {
  const f = fixture(t);
  let flushed = false;
  let startFlushed = false;
  journalFlush(t, f.stateDir, () => { flushed = true; startFlushed ||= f.journal().includes('"kind":"started"'); });
  f.effects = async (value) => {
    assert.equal(flushed, true, "the intent file must be flushed before dispatch");
    assert.equal(startFlushed, true, "the start marker must be flushed before dispatch");
    f.calls.push(value);
    const journal = f.journal();
    const [intent, started] = journal.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(intent.kind, "intent");
    assert.equal(intent.id, f.request.id);
    assert.equal(intent.sequence, 1);
    assert.equal(intent.version, 2);
    assert.equal(started.kind, "started");
    assert.equal(started.id, intent.id);
    assert.equal(started.requestDigest, intent.requestDigest);
    assert.match(intent.requestDigest, /^[a-f0-9]{64}$/);
    assert.equal(intent.requestDigest, createHash("sha256").update(canonical(f.request)).digest("hex"));
    assert.equal(journal.includes(f.request.input), false);
    return f.terminal();
  };
  assert.equal((await f.run()).state, "completed");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0] as object).sort(), ["id", "input", "sequence", "workspace"]);
  assert.equal((f.calls[0] as { workspace: string }).workspace, f.workspace);
  assert.equal(f.journal().trim().split("\n").length, 3);
  const [intent, , result] = f.journal().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(result.id, intent.id);
  assert.equal(result.requestDigest, intent.requestDigest);
  assert.equal(result.sequence, intent.sequence);
  assert.ok(f.reads >= 3);
  const before = f.journal();
  await f.run();
  assert.equal(f.journal(), before);
});

for (const field of ["board", "repo", "activation", "connection", "job", "claim", "requirements", "candidate", "policy", "fence"] as const) {
  test(`forged or stale ${field} never dispatches`, async (t) => {
    const f = fixture(t);
    if (field === "fence") f.current.binding.fence++;
    else f.current.binding[field] = id(99);
    assert.equal((await f.run()).state, "held");
    assert.equal(f.calls.length, 0);
  });
}

test("viewer, revoked consent and uncontained writers cannot execute or replay success", async (t) => {
  for (const change of [(s: CurrentAssignment) => { s.seat = "viewer"; }, (s: CurrentAssignment) => { s.authorized = false; }, (s: CurrentAssignment) => { s.writersContained = false; }]) {
    const f = fixture(t);
    assert.equal((await f.run()).state, "completed");
    change(f.current);
    assert.equal((await f.run()).state, "held");
    assert.equal(f.calls.length, 1);
  }
});

test("duplicate delivery returns the recorded result; changed body and out-of-order sequence refuse", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).state, "completed");
  assert.equal((await f.run()).state, "completed");
  f.request.input = "Changed payload";
  assert.equal((await f.run()).state, "held");
  f.request.id = id(11); f.request.sequence = 3;
  assert.equal((await f.run()).state, "held");
  f.request.sequence = 1;
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 1);
});

test("ticket content cannot select a command, argv, cwd, executable or path", async (t) => {
  const f = fixture(t);
  for (const field of ["command", "argv", "cwd", "executable", "path"]) {
    assert.equal((await f.run(JSON.stringify({ ...f.request, [field]: "../../outside" }))).state, "refused");
  }
  f.request.operation = "shell.exec" as AssignmentRequest["operation"];
  assert.equal((await f.run()).state, "refused");
  assert.equal(f.calls.length, 0);
});

test("malformed, oversized, deep, secret-bearing and extra-key input refuses before authority lookup", async (t) => {
  const f = fixture(t);
  for (const raw of ["{", "null", "[]", "[".repeat(40000), JSON.stringify(f.request) + " ".repeat(32769), JSON.stringify({ ...f.request, input: "😀".repeat(5000) }), JSON.stringify({ ...f.request, extra: JSON.parse("[".repeat(40) + "0" + "]".repeat(40)) }), JSON.stringify({ ...f.request, input: "x".repeat(32769) }), JSON.stringify({ ...f.request, input: "fabricated-held-secret" }), JSON.stringify({ ...f.request, binding: { ...f.request.binding, authorized: true } }), JSON.stringify({ ...f.request, sequence: 1.5 })]) {
    assert.equal((await f.run(raw)).state, "refused");
  }
  assert.equal(f.reads, 0);
  assert.equal(f.calls.length, 0);
});

test("state nesting, missing and relative workspace mappings never reach the effect port", async (t) => {
  const f = fixture(t);
  for (const path of [f.stateDir, f.root, join(f.stateDir, "nested"), "../elsewhere", join(f.root, "missing")]) {
    f.current.confirmedWorkspace = path;
    assert.equal((await f.run()).state, "held");
  }
  assert.equal(f.calls.length, 0);
});

test("JSON escaping and percent encoding cannot hide held secrets or credential shapes", async (t) => {
  const f = fixture(t);
  for (const secret of ['held"value', "held\\value", "held\nvalue", "held%20value"]) {
    f.secrets = [secret];
    for (const input of [secret, encodeURIComponent(secret)]) {
      f.request.input = input;
      assert.equal((await f.run()).state, "refused");
    }
  }
  f.secrets = [];
  f.request.input = "prefix\nghp_" + "x".repeat(36);
  assert.equal((await f.run()).state, "refused");
  assert.equal(f.reads, 0);
  assert.equal(f.calls.length, 0);
});

test("ordinary percent text reaches the adapter unchanged, including mixed escapes", async (t) => {
  for (const input of ["Raise coverage to 90% this week", "100%", "50%-off", "ok %41", "90% and %41", "bad %FF and %E2%82%AC"]) {
    const f = fixture(t);
    f.request.input = input;
    assert.equal((await f.run()).state, "completed");
    assert.equal((f.calls[0] as { input: string }).input, input);
  }
});

test("stray percent signs cannot hide encoded secrets and credential shapes", async (t) => {
  const f = fixture(t);
  const secret = "fabricated-held-secret";
  const encoded = [...secret].map((char) => "%" + char.charCodeAt(0).toString(16)).join("");
  for (const input of ["90% " + encoded, "%FF " + encoded, "50%-off " + encodeURIComponent(encoded), "90% %67hp_" + "x".repeat(36)]) {
    f.request.input = input;
    assert.equal((await f.run()).state, "refused");
  }
  assert.equal(f.reads, 0);
  assert.equal(f.calls.length, 0);
});

test("duplicate journal keys, including escaped keys, hold without changing history", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).state, "completed");
  const original = f.journal();
  for (const key of ['"outcome"', '"outc\\u006fme"']) {
    const data = original.replace('"outcome":"completed"', `${key}:"failed","outcome":"completed"`);
    writeFileSync(join(f.stateDir, "assignment-intents.jsonl"), data);
    assert.equal((await f.run()).state, "held");
    assert.equal(f.journal(), data);
  }
  assert.equal(f.calls.length, 1);
});

test("authority changes after intent release unstarted work; changes after effect stay uncertain", async (t) => {
  for (const at of [2, 3]) {
    const f = fixture(t);
    f.observe = () => { if (f.reads === at) f.current.binding.fence++; return structuredClone(f.current); };
    assert.equal((await f.run()).state, at === 2 ? "not-started" : "held");
    assert.equal(f.calls.length, at === 2 ? 0 : 1);
    const results = f.journal().trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.kind === "result");
    assert.deepEqual(results.map((row) => row.outcome), at === 2 ? ["not-started"] : []);
    f.request.binding = structuredClone(f.current.binding);
    f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
    assert.equal((await f.run()).state, at === 2 ? "completed" : "held");
    assert.equal(f.calls.length, 1);
  }
});

test("one failed authority read records no execution, replays that fact, and releases the next assignment", async (t) => {
  const f = fixture(t);
  f.observe = () => { if (f.reads === 2) throw new Error("temporary network failure"); return structuredClone(f.current); };
  assert.equal((await f.run()).state, "not-started");
  assert.equal((await f.run()).state, "not-started");
  assert.equal(f.calls.length, 0);
  f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
  assert.equal((await f.run()).state, "completed");
  assert.equal((await f.run()).state, "completed");
  assert.equal(f.calls.length, 1);
});

test("one workspace cannot retire another workspace's active preparation in the same process", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let reads = 0;
  const current = structuredClone(f.current);
  const first = runAssignment({ stateDir: f.stateDir, raw: JSON.stringify(f.request), secrets: [], now: () => 1000,
    adapter: { kind: "fabricated-harness", readCurrent: async () => { if (++reads === 2) { ready(); await waiting; } return current; },
      execute: async (value) => { f.calls.push(value); return { id: id(1), sequence: 1, result: "completed", writersContained: true }; }, reconcile: async () => null } });
  await entered;
  const other = join(f.root, "other"); mkdirSync(other);
  f.current.confirmedWorkspace = other; f.current.binding.connection = id(12);
  f.request.binding = structuredClone(f.current.binding); f.request.id = id(11);
  try { assert.equal((await f.run()).state, "completed"); }
  finally { release(); }
  assert.equal((await first).state, "completed");
  assert.equal(f.calls.length, 2);
  assert.equal(f.journal().includes('"outcome":"not-started"'), false);
});

for (const command of ["continue", "crash"]) {
  test(`prepared controller ownership survives a competitor, then ${command} releases next work`, async (t) => {
    const f = fixture(t);
    const marker = join(f.root, "effects");
    const child = spawn(process.execPath, [fileURLToPath(new URL("./assignment-prepared-fixture.ts", import.meta.url)), f.stateDir, JSON.stringify(f.request), JSON.stringify(f.current), marker], { stdio: ["pipe", "pipe", "pipe"] });
    const done = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const before = f.journal();
    assert.deepEqual(before.trim().split("\n").map((line) => JSON.parse(line).kind), ["intent"]);
    try {
      assert.equal((await f.run()).state, "held");
      f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
      assert.equal((await f.run()).state, "held");
      assert.equal(f.calls.length, 0);
      assert.equal(f.journal(), before);
    } finally { child.stdin.end(command); }
    assert.equal(await done, command === "crash" ? 74 : 0);
    assert.equal((await f.run()).state, "completed");
    assert.equal((await f.run()).state, "completed");
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(marker), command === "continue");
    const result = f.journal().trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.id === id(1) && row.kind === "result");
    assert.equal(result.outcome, command === "crash" ? "not-started" : "completed");
  });
}

test("legacy intents without a start marker remain uncertain; legacy terminal records still replay", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).state, "completed");
  const [intent, , result] = f.journal().trim().split("\n").map((line) => JSON.parse(line));
  delete intent.version;
  const legacy = JSON.stringify(intent) + "\n";
  const path = join(f.stateDir, "assignment-intents.jsonl");
  writeFileSync(path, legacy + JSON.stringify(result) + "\n");
  assert.equal((await f.run()).state, "completed");
  writeFileSync(path, legacy);
  assert.equal((await f.run()).state, "held");
  f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
  assert.equal((await f.run()).state, "held");
  assert.equal(f.journal(), legacy);
  assert.equal(f.calls.length, 1);
});

test("ambiguous start history and contradictory terminals preserve bytes and hold", async (t) => {
  const f = fixture(t);
  await f.run();
  const [intent, started, result] = f.journal().trim().split("\n").map((line) => JSON.parse(line));
  for (const rows of [
    [{ ...intent, version: 3 }], [intent, result], [started],
    [intent, { ...started, id: id(99) }], [intent, { ...started, sequence: 2 }],
    [intent, { ...started, requestDigest: "a".repeat(64) }], [intent, { ...started, extra: true }],
    [intent, started, started], [intent, { ...result, outcome: "not-started" }, started],
    [intent, started, result, { ...result, outcome: "not-started" }],
  ]) {
    const data = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
    writeFileSync(join(f.stateDir, "assignment-intents.jsonl"), data);
    assert.equal((await f.run()).state, "held");
    assert.equal(f.journal(), data);
  }
  assert.equal(f.calls.length, 1);
});

test("a start-marker flush failure before execute records non-execution when storage recovers", async (t) => {
  const f = fixture(t);
  let failed = false;
  journalFlush(t, f.stateDir, () => {
    if (!failed && f.journal().includes('"kind":"started"')) { failed = true; throw new Error("one failed start flush"); }
  });
  assert.equal((await f.run()).state, "not-started");
  assert.equal(failed, true);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run()).state, "not-started");
  f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
  assert.equal((await f.run()).state, "completed");
  assert.equal(f.calls.length, 1);
});

test("overlapping duplicate and next assignments cannot launch a second writer", async (t) => {
  const f = fixture(t);
  let unblock!: () => void;
  const wait = new Promise<void>((resolve) => { unblock = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  f.effects = async (value) => { f.calls.push(value); started(); await wait; return f.terminal(); };
  const first = f.run(); await entered;
  assert.equal((await f.run()).state, "held");
  f.current.nextSequence = 2;
  assert.equal((await f.run(JSON.stringify({ ...f.request, id: id(11), sequence: 2 }))).state, "held");
  f.current.nextSequence = 1;
  unblock(); assert.equal((await first).state, "completed");
  assert.equal(f.calls.length, 1);
});

test("missing, foreign or uncontained terminal evidence stays uncertain and never reruns", async (t) => {
  for (const terminal of [null, { id: id(99), sequence: 1, result: "completed", writersContained: true }, { id: id(1), sequence: 2, result: "completed", writersContained: true }, { id: id(1), sequence: 1, result: "completed", writersContained: false }]) {
    const f = fixture(t);
    f.effects = async (value) => { f.calls.push(value); return terminal as AssignmentTerminal; };
    assert.equal((await f.run()).state, "held");
    assert.equal((await f.run()).state, "held");
    assert.equal(f.calls.length, 1);
  }
});

test("uncertain outcomes reconcile read-only, including beyond reply retention", async (t) => {
  const f = fixture(t);
  f.effects = async (value) => { f.calls.push(value); throw new Error("fabricated-held-secret"); };
  assert.equal((await f.run()).state, "held");
  f.now = 1000 + 25 * 60 * 60 * 1000;
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 1);
  f.reconcile = async () => f.terminal();
  assert.equal((await f.run()).state, "completed");
  assert.equal(f.calls.length, 1);
  assert.equal(f.journal().includes("fabricated-held-secret"), false);
});

test("an unresolved assignment holds a valid next one; a contained result releases it without rewriting history", async (t) => {
  const f = fixture(t);
  f.effects = async (value) => { f.calls.push(value); throw new Error("uncertain"); };
  await f.run();
  const first = JSON.stringify(f.request);
  const originalTerminal = f.terminal();
  f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 1);
  f.current.nextSequence = 1;
  f.reconcile = async () => originalTerminal;
  assert.equal((await f.run(first)).state, "completed");
  const before = f.journal();
  f.current.nextSequence = 2;
  f.effects = async (value) => { f.calls.push(value); return f.terminal(); };
  assert.equal((await f.run()).state, "completed");
  assert.equal(f.calls.length, 2);
  assert.ok(f.journal().startsWith(before));
});

test("a new valid assignment after a real controller crash cannot bypass unresolved work", async (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./assignment-crash-fixture.ts", import.meta.url)), f.stateDir, JSON.stringify(f.request), JSON.stringify(f.current)], { encoding: "utf8" });
  assert.equal(child.status, 73, child.stderr);
  f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 0);
});

test("a controller paused after reading an empty journal cannot overwrite a competing admission", async (t) => {
  const f = fixture(t);
  const path = join(f.stateDir, "assignment-intents.jsonl");
  writeFileSync(path, "", { mode: 0o600 });
  const marker = join(f.root, "effects");
  const release = join(f.root, "release");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./assignment-race-fixture.ts", import.meta.url)), f.stateDir, JSON.stringify(f.request), JSON.stringify(f.current), marker, release], { stdio: ["ignore", "pipe", "pipe"] });
  const done = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const other = spawnSync(process.execPath, [fileURLToPath(new URL("./assignment-crash-fixture.ts", import.meta.url)), f.stateDir, JSON.stringify(f.request), JSON.stringify(f.current)], { encoding: "utf8" });
  writeFileSync(release, "go");
  const firstCode = await done;
  assert.equal([firstCode, other.status].filter((code) => code === 73).length, 1);
  assert.deepEqual(f.journal().trim().split("\n").map((line) => JSON.parse(line).kind), ["intent", "started"]);
});

test("reconciliation rechecks authority and workspace after the read-only observation", async (t) => {
  const bindingChanges = ["board", "repo", "activation", "connection", "job", "claim", "requirements", "candidate", "policy"] as const;
  for (const change of [(s: CurrentAssignment) => { s.authorized = false; }, (s: CurrentAssignment) => { s.seat = "viewer"; }, (s: CurrentAssignment) => { s.binding.fence++; }, (s: CurrentAssignment) => { s.confirmedWorkspace = "/changed"; }, ...bindingChanges.map((key) => (s: CurrentAssignment) => { s.binding[key] = id(99); })]) {
    const f = fixture(t);
    f.effects = async () => { throw new Error("uncertain"); };
    assert.equal((await f.run()).state, "held");
    f.reconcile = async () => { change(f.current); return f.terminal(); };
    assert.equal((await f.run()).state, "held");
    assert.deepEqual(f.journal().trim().split("\n").map((line) => JSON.parse(line).kind), ["intent", "started"]);
  }
});

test("foreign, malformed and uncontained reconciliation leaves the intent unresolved", async (t) => {
  for (const terminal of [null, {}, { id: id(99), sequence: 1, result: "completed", writersContained: true }, { id: id(1), sequence: 2, result: "completed", writersContained: true }, { id: id(1), sequence: 1, result: "completed", writersContained: false }]) {
    const f = fixture(t);
    f.effects = async () => { throw new Error("uncertain"); };
    await f.run();
    f.reconcile = async () => terminal as AssignmentTerminal;
    assert.equal((await f.run()).state, "held");
    assert.deepEqual(f.journal().trim().split("\n").map((line) => JSON.parse(line).kind), ["intent", "started"]);
  }
});

test("intent and result flush failures never acknowledge unflushed success or repeat execution", async (t) => {
  for (const phase of ["intent", "result"]) {
    await t.test(phase, async (sub) => {
      const f = fixture(sub);
      let broken = true;
      journalFlush(sub, f.stateDir, () => { if (broken && f.journal().includes(`"kind":"${phase}"`)) throw new Error("disk flush failed"); });
      assert.equal((await f.run()).state, "held");
      assert.equal(f.calls.length, phase === "intent" ? 0 : 1);
      assert.equal((await f.run()).state, "held");
      assert.equal(f.calls.length, phase === "intent" ? 0 : 1);
      broken = false;
      assert.equal((await f.run()).state, phase === "intent" ? "not-started" : "completed");
      assert.equal(f.calls.length, phase === "intent" ? 0 : 1);
      f.request.id = id(11); f.request.sequence = 2; f.current.nextSequence = 2;
      assert.equal((await f.run()).state, "completed");
      assert.equal((await f.run()).state, "completed");
      assert.equal(f.calls.length, phase === "intent" ? 1 : 2);
    });
  }
});

test("an intent flush failure releases the workspace for another scope when storage recovers", async (t) => {
  const f = fixture(t);
  let broken = true;
  journalFlush(t, f.stateDir, () => { if (broken && f.journal().includes('"kind":"intent"')) throw new Error("flush failed"); });
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 0);
  broken = false;
  f.request.id = id(11); f.request.binding.connection = id(12);
  f.current.binding = structuredClone(f.request.binding);
  assert.equal((await f.run()).state, "completed");
  assert.equal(f.calls.length, 1);
  const rows = f.journal().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.find((row) => row.id === id(1) && row.kind === "result")?.outcome, "not-started");
});

for (const parent of [false, true]) {
  test(`unrelated workspace link is refused: ${parent ? "linked parent" : "direct link"}`, async (t) => {
    const f = fixture(t);
    const target = join(f.root, "unrelated"); mkdirSync(target);
    const child = join(target, "child"); mkdirSync(child);
    const alias = join(f.root, "alias"); symlinkSync(target, alias, "junction");
    f.current.confirmedWorkspace = parent ? join(alias, "child") : alias;
    assert.equal((await f.run()).state, "held");
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(join(f.stateDir, "assignment-intents.jsonl")), false);
    f.current.confirmedWorkspace = parent ? child : target;
    assert.equal((await f.run()).state, "completed", "the unrelated real directory is otherwise admissible");
    assert.equal(f.calls.length, 1);
  });
}

test("symlinked workspace and journal never redirect writes or effects", async (t) => {
  const f = fixture(t);
  const alias = join(f.root, "alias");
  symlinkSync(f.stateDir, alias, "junction");
  f.current.confirmedWorkspace = alias;
  assert.equal((await f.run()).state, "held");
  f.current.confirmedWorkspace = f.workspace;
  const sentinel = join(f.root, "sentinel"); writeFileSync(sentinel, "", { mode: 0o600 });
  symlinkSync(sentinel, join(f.stateDir, "assignment-intents.jsonl"));
  assert.equal((await f.run()).state, "held");
  assert.equal(readFileSync(sentinel, "utf8"), "");
  assert.equal(f.calls.length, 0);
});

test("an existing workspace substituted between reads cannot receive the assignment", async (t) => {
  const f = fixture(t);
  const other = join(f.root, "other"); mkdirSync(other);
  f.observe = () => { if (f.reads === 2) f.current.confirmedWorkspace = other; return structuredClone(f.current); };
  assert.equal((await f.run()).state, "not-started");
  assert.equal(f.calls.length, 0);
});

test("every outcome is unqualified and unpublishable; a live adapter is refused", async (t) => {
  const f = fixture(t);
  for (const raw of [JSON.stringify(f.request), "null"]) {
    const result = await f.run(raw);
    assert.equal(result.qualification, "unqualified-harness");
    assert.equal(result.publishable, false);
  }
  f.kind = "served";
  assert.equal((await f.run()).state, "refused");
  assert.equal(f.calls.length, 1);
});

test("two real controllers racing before intent cannot both dispatch", async (t) => {
  const f = fixture(t);
  const marker = join(f.root, "effects");
  const start = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./assignment-crash-fixture.ts", import.meta.url)), f.stateDir, JSON.stringify(f.request), JSON.stringify(f.current), marker], { stdio: ["pipe", "pipe", "pipe"] });
    const ready = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const done = new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
    return { child, ready, done };
  };
  const a = start(); const b = start();
  await Promise.all([a.ready, b.ready]);
  a.child.stdin.end("go"); b.child.stdin.end("go");
  const codes = await Promise.all([a.done, b.done]);
  assert.equal(codes.filter((code) => code === 73).length, 1);
  assert.equal(readFileSync(marker, "utf8"), "effect\n");
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 0);
});

test("duplicate JSON keys and encoded duplicate keys are refused", async (t) => {
  const f = fixture(t);
  const raw = JSON.stringify(f.request);
  for (const key of ['"operation"', '"oper\\u0061tion"']) {
    assert.equal((await f.run(raw.replace('"operation":', `${key}:"shell.exec","operation":`))).state, "refused");
  }
  assert.equal(f.reads, 0);
});

test("changed confirmed workspace, forged result digest and result without intent are held", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).state, "completed");
  const original = f.journal();
  const rows = original.trim().split("\n").map((line) => JSON.parse(line));
  const path = join(f.stateDir, "assignment-intents.jsonl");
  rows[2].requestDigest = createHash("sha256").update("different request").digest("hex");
  for (const data of [rows.map((row) => JSON.stringify(row)).join("\n") + "\n", JSON.stringify(rows[2]) + "\n", JSON.stringify(rows[0]) + "\n" + JSON.stringify({ ...rows[0], sequence: 2 }) + "\n"]) {
    writeFileSync(path, data);
    assert.equal((await f.run()).state, "held");
    assert.equal(f.journal(), data);
  }
  writeFileSync(path, original);
  const other = join(f.root, "other"); mkdirSync(other);
  f.current.confirmedWorkspace = other;
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 1);
});

test("a malformed or truncated journal preserves all bytes and blocks execution", async (t) => {
  const f = fixture(t);
  const path = join(f.stateDir, "assignment-intents.jsonl");
  writeFileSync(path, '{"kind":"intent"', { mode: 0o600 });
  chmodSync(path, 0o600);
  const before = readFileSync(path);
  assert.equal((await f.run()).state, "held");
  assert.deepEqual(readFileSync(path), before);
  assert.equal(f.calls.length, 0);
});

test("real controller exit after the flushed intent recovers without issuing another effect", async (t) => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./assignment-crash-fixture.ts", import.meta.url)), f.stateDir, JSON.stringify(f.request), JSON.stringify(f.current)], { encoding: "utf8" });
  assert.equal(child.status, 73, child.stderr);
  assert.deepEqual(f.journal().trim().split("\n").map((line) => JSON.parse(line).kind), ["intent", "started"]);
  assert.equal((await f.run()).state, "held");
  assert.equal(f.calls.length, 0);
  f.reconcile = async () => f.terminal();
  assert.equal((await f.run()).state, "completed");
  assert.equal(f.calls.length, 0);
});
