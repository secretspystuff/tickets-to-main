import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { runCodexCliAssignment } from "../src/adapters/codex.ts";
import type { NativeObservation } from "../src/adapters/native-result.ts";
import { runAssignment, type AssignmentRequest } from "../src/assignment-boundary.ts";
import { ensurePrivateDirectory } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { parseLedger } from "../src/ledger.ts";
import { processNativeTransport, windowsOwnedNativeTransport, windowsProcessLauncher, type NativeEvents, type NativeExit,
  type NativeTransport, type OriginalGroup } from "../src/native-transport.ts";
import { claimWorkspace, prepareWorkspace } from "../src/workspace.ts";
import { removeDir } from "./helpers.ts";
import { CLI_RESULT } from "./native-fixtures.ts";

type Scenario = "complete" | "wrong result" | "unsafe metadata" | "refused activation" | "refused preparation";
const executable = realpathSync(process.execPath);
const peer = fileURLToPath(new URL("./owned-cli-peer.fixture.mjs", import.meta.url));
const onWindows = { skip: process.platform !== "win32", timeout: 24_000 };
const unqualified = { qualification: "unqualified-harness", publishable: false };
const id = (value: number) => value.toString(16).padStart(32, "0");
const prompt = "Read the fabricated answer file.";
const answer = "fabricated local CLI answer";
const zero: OriginalGroup = { state: "verified", activeProcesses: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The fabricated CLI did not answer.")), 8_000);
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); }
}

function fixture(t: TestContext, scenario: Scenario) {
  assert.equal(process.version, "v24.18.0");
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-owned-cli-")));
  assert.equal(dirname(root), parent);
  const stateDir = join(root, "state"), workspace = join(root, "workspace"), temp = join(root, "tmp");
  const exitGate = join(root, "allow-exit");
  const allowExit = () => { if (!existsSync(exitGate)) writeFileSync(exitGate, "1", { flag: "wx" }); };
  const disposals: Array<() => Promise<void>> = [];
  t.after(async () => {
    allowExit();
    for (const dispose of disposals) await dispose();
    assert.equal(dirname(realpathSync(root)), parent);
    removeDir(root);
  });
  ensurePrivateDirectory(root);
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, workspace, () => false);
  claimWorkspace(stateDir, process.pid, () => true);
  mkdirSync(temp);
  const answerFile = join(workspace, "answer.txt");
  writeFileSync(answerFile, answer, { flag: "wx" });
  const request: AssignmentRequest = {
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input: prompt,
    binding: { board: id(2), repo: id(3), activation: id(4), connection: id(5), job: id(6),
      claim: id(7), requirements: id(8), candidate: id(9), policy: id(10), fence: 1 },
  };
  const journal = join(stateDir, "assignment-intents.jsonl"), ledger = join(stateDir, "ledger.json");
  const before = readFileSync(ledger);
  const bytes = () => [readFileSync(journal), readFileSync(ledger)];
  const snapshot = () => ({ rows: readFileSync(journal, "utf8").trimEnd().split("\n").map(line => JSON.parse(line)),
    ledger: parseLedger(readFileSync(ledger, "utf8"))! });
  const inputFile = join(root, "received.bin"), eofFile = join(root, "reached-eof");
  const env = { SystemRoot: process.env.SystemRoot, TEMP: temp, TMP: temp };
  const writes: { kind: "input" | "eof"; active: boolean; bytes: Buffer[] }[] = [];
  const pipe: ("input" | "eof")[] = [];
  const groupIdentity: boolean[] = [];
  let launches = 0, attaches = 0, legacy = 0, closes = 0, verified = false;
  let prepared: ReturnType<typeof snapshot> | undefined, activated: Buffer[] | undefined, activationAttempt: Buffer[] | undefined;
  let release: ReturnType<typeof snapshot> | undefined, live: OriginalGroup | undefined, drained: OriginalGroup | undefined;
  let observed: NativeObservation | undefined, exit: NativeExit | undefined;
  const run = () => runAssignment({
    stateDir, raw: JSON.stringify(request), secrets: [], now: () => 1000,
    adapter: {
      kind: "fabricated-harness",
      async readCurrent() { return { binding: request.binding, nextSequence: 1, authorized: true,
        seat: "member", confirmedWorkspace: workspace, writersContained: true }; },
      async execute() { legacy++; throw new Error("The owned CLI cannot use legacy execution."); },
      async reconcile() { throw new Error("Initial fixture cannot reconcile."); },
    },
    owned: { async prepare({ intent, workspace: current }) {
      if (scenario === "refused preparation") return null;
      assert.equal(current, workspace);
      const launcher = windowsProcessLauncher();
      const suspended = deferred<void>(), permit = deferred<boolean>(), closed = deferred<NativeExit>(), output = deferred<void>();
      let listener: NativeEvents | undefined, stdout = "";
      const child = windowsOwnedNativeTransport({ async start(...args) {
        launches++;
        const launch = await launcher.start(...args);
        if (!launch) return null;
        return { ...launch,
          async verify() {
            const proof = await launch.verify();
            verified = proof !== null && proof.job === launch.originalJob && proof.child === launch.exactChild;
            return proof;
          },
          async activate() {
            suspended.resolve();
            if (!await permit.promise) return false;
            activationAttempt = bytes();
            return scenario !== "refused activation" && launch.activate();
          },
          async observe() {
            const sample = await launch.observe();
            groupIdentity.push(sample?.job === launch.originalJob && sample.complete === true);
            return sample;
          },
          pipe: {
            write(text) { pipe.push("input"); return launch.pipe.write(text); },
            endInput() { pipe.push("eof"); launch.pipe.endInput(); },
          },
        };
      } }).start([executable, peer, scenario === "refused activation" ? "complete" : scenario, workspace], { cwd: workspace, env }, {
        spawned() { activated = bytes(); listener?.spawned(); },
        stdout(chunk) {
          listener?.stdout(chunk);
          stdout += chunk;
          if (stdout.includes('{"type":"turn.completed"}\n')) output.resolve();
        },
        stderr(chunk) { listener?.stderr(chunk); }, inputError() { listener?.inputError(); },
        closed(status) { exit = status; closed.resolve(status); listener?.closed(status); },
      });
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async () => {
        allowExit();
        child.endInput();
        permit.resolve(false);
        await bounded(closed.promise);
        child.closeObservation();
        assert.deepEqual(await child.observeOriginalGroup(), { state: "unavailable" });
        closes++;
      })();
      disposals.push(close);
      try {
        assert.equal(await bounded(Promise.race([suspended.promise, closed.promise])), undefined);
        prepared = snapshot();
        assert.deepEqual(prepared.rows, [intent]);
        assert.equal(existsSync(inputFile) || existsSync(eofFile), false);
      } catch (error) {
        await close();
        throw error;
      }
      const bridge: NativeTransport = { start(argv, options, events) {
        attaches++;
        assert.equal(attaches, 1);
        assert.deepEqual(argv, [executable, "exec", "--json", "-"]);
        assert.equal(options.cwd, workspace);
        assert.deepEqual({ ...options.env }, env);
        listener = events;
        return {
          write(text) { writes.push({ kind: "input", active: activated !== undefined, bytes: bytes() }); return child.write(text); },
          endInput() { writes.push({ kind: "eof", active: activated !== undefined, bytes: bytes() }); child.endInput(); },
        };
      } };
      return {
        original: { observeOriginalGroup() { release = snapshot(); return child.observeOriginalGroup(); } },
        async execute(assignment) {
          const cli = runCodexCliAssignment({ assignmentId: assignment.id, prompt: assignment.input, workspace: assignment.workspace,
            model: null, effort: null }, bridge, env, [], executable);
          permit.resolve(writes.length === 0);
          if (await bounded(Promise.race([output.promise.then(() => true), cli.then(() => false)]))) {
            live = await child.observeOriginalGroup();
            allowExit();
          }
          observed = await bounded(cli);
          drained = await child.observeOriginalGroup();
          if (observed.outcome !== "completed" || observed.resultText !== answer || observed.threadId !== "fixture-cli-thread"
            || drained.state !== "verified" || drained.activeProcesses !== 0) throw new Error("The CLI did not prove an exact result and drain.");
          return { id: assignment.id, sequence: assignment.sequence, result: "completed", writersContained: true };
        }, close,
      };
    } },
  });
  return { run, workspace, env, allowExit, inputFile, eofFile, answerFile, ledger, before, bytes, writes, pipe, snapshot, groupIdentity,
    get launches() { return launches; }, get attaches() { return attaches; }, get legacy() { return legacy; }, get closes() { return closes; },
    get verified() { return verified; }, get prepared() { return prepared; }, get activationAttempt() { return activationAttempt; },
    get activated() { return activated; }, get observed() { return observed; }, get exit() { return exit; },
    get release() { return release; }, get live() { return live; }, get drained() { return drained; } };
}

test("the same fabricated CLI runs on the existing plain process transport", onWindows, async t => {
  const f = fixture(t, "complete"), ordinary = processNativeTransport();
  f.allowExit();
  const result = await bounded(runCodexCliAssignment({ assignmentId: id(1), prompt, workspace: f.workspace, model: null, effort: null },
    { start(_argv, options, events) { return ordinary.start([executable, peer, "complete", f.workspace], options, events); } }, f.env, [], executable));
  assert.equal(result.outcome, "completed");
  assert.equal(result.resultText, answer);
  assert.equal(result.threadId, "fixture-cli-thread");
  assert.equal(result.helpers, "terminal-observed");
  assert.equal(result.observed.helperCompletion, undefined);
  assert.equal(result.writerState, "unknown");
  assert.equal(readFileSync(f.inputFile, "utf8"), prompt);
  assert.equal(existsSync(f.eofFile), true);
});

for (const scenario of ["complete", "wrong result", "unsafe metadata", "refused activation"] as const) {
  test(`owned CLI ${scenario} sends input and EOF only after actual activation`, onWindows, async t => {
    const f = fixture(t, scenario), result = await f.run();
    assert.equal(f.verified, true);
    assert.equal(f.launches, 1);
    assert.equal(f.attaches, 1);
    assert.equal(f.closes, 1);
    assert.equal(f.legacy, 0);
    assert.deepEqual(f.writes.filter(write => !write.active).map(write => write.kind), [],
      "the CLI must never attempt input or EOF while the original Job is suspended");
    assert.ok(f.prepared && f.activationAttempt);
    const [intent] = f.prepared.rows;
    const started = { kind: "started", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000 };
    const rows = f.activationAttempt[0]!.toString().trimEnd().split("\n").map(line => JSON.parse(line));
    const ledger = parseLedger(f.activationAttempt[1]!.toString("utf8"))!;
    const claim = ledger.workspace;
    assert.deepEqual(rows, [intent, started]);
    assert.ok(claim?.claimGeneration);
    assert.deepEqual(claim, { path: f.workspace, writerPid: process.pid, qualified: false, claimGeneration: claim.claimGeneration });
    assert.deepEqual(ledger.boundWorkspaceIntents, [intent.id]);
    if (scenario === "refused activation") {
      assert.deepEqual(result, { state: "held", ...unqualified });
      assert.equal(f.activated, undefined);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(f.pipe, []);
      assert.equal(existsSync(f.inputFile) || existsSync(f.eofFile), false);
      assert.equal(f.observed?.outcome, "disconnected");
      assert.deepEqual(f.exit, { code: null, signal: null, error: "spawn" });
      assert.equal(f.release, undefined);
      assert.deepEqual(f.bytes(), f.activationAttempt);
      return;
    }
    assert.deepEqual(f.activated, f.activationAttempt);
    assert.deepEqual(f.writes.map(write => write.kind), ["input", "eof"]);
    for (const write of f.writes) assert.deepEqual(write.bytes, f.activationAttempt);
    assert.deepEqual(f.pipe, ["input", "eof"]);
    assert.equal(readFileSync(f.inputFile, "utf8"), prompt);
    assert.equal(existsSync(f.eofFile), true);
    assert.equal(readFileSync(f.answerFile, "utf8"), answer);
    assert.equal(f.observed?.helpers, scenario === "unsafe metadata" ? "unknown" : "terminal-observed");
    assert.equal(f.observed?.observed.helperCompletion, undefined);
    assert.equal(f.observed?.writerState, "unknown");
    assert.deepEqual(f.exit, { code: 0, signal: null, error: null });
    assert.deepEqual(f.live, { state: "verified", activeProcesses: 1 });
    assert.deepEqual(f.drained, zero);
    if (scenario === "wrong result" || scenario === "unsafe metadata") {
      assert.deepEqual(result, { state: "held", ...unqualified });
      assert.equal(f.release, undefined);
      assert.deepEqual(f.groupIdentity, [true, true]);
      assert.deepEqual(f.bytes(), f.activationAttempt);
      if (scenario === "unsafe metadata") {
        assert.equal(JSON.stringify(f.observed).includes(prompt), false);
        assert.equal(f.observed?.outcome, "protocol-error");
        assert.equal(f.observed?.threadId, null);
        assert.equal(f.observed?.resultText, null);
        assert.equal(f.observed?.observed.assignment, undefined);
      } else {
        assert.equal(f.observed?.outcome, "completed");
        assert.equal(f.observed?.resultText, "other result");
      }
      return;
    }
    assert.equal(f.observed?.outcome, "completed");
    assert.deepEqual(result, { state: "completed", ...unqualified });
    assert.equal(f.observed?.resultText, answer);
    assert.equal(f.observed?.threadId, "fixture-cli-thread");
    const terminal = { kind: "result", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000, outcome: "completed" };
    assert.deepEqual(f.release, { rows: [intent, started, terminal], ledger });
    assert.deepEqual(f.snapshot().rows, f.release?.rows);
    assert.deepEqual(f.snapshot().ledger.workspace, { path: f.workspace, writerPid: null, qualified: false });
    assert.equal(f.snapshot().ledger.boundWorkspaceIntents, undefined);
    assert.deepEqual(f.groupIdentity, [true, true, true]);
  });
}

test("refused CLI preparation creates no process, input or EOF", onWindows, async t => {
  const f = fixture(t, "refused preparation");
  assert.deepEqual(await f.run(), { state: "not-started", ...unqualified });
  assert.equal(f.launches + f.closes + f.legacy + f.attaches, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.pipe, []);
  assert.equal(existsSync(f.inputFile) || existsSync(f.eofFile), false);
  assert.equal(f.release, undefined);
  assert.deepEqual(readFileSync(f.ledger), f.before);
  const [intent, terminal, ...remaining] = f.snapshot().rows;
  assert.equal(intent.kind, "intent");
  assert.deepEqual(terminal, { kind: "result", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000, outcome: "not-started" });
  assert.deepEqual(remaining, []);
});

test("unsupported CLI selections and held text remain refused before transport entry", async () => {
  let starts = 0;
  const unused: NativeTransport = { start() { starts++; throw new Error("Invalid assignment reached transport."); } };
  const request = { assignmentId: id(1), prompt, workspace: "C:\\fixture-workspace", model: null, effort: null };
  const held = "fixture-opaque-held-text";
  for (const input of [{ ...request, model: "fixture-model" }, { ...request, effort: "low" }, { ...request, prompt: held }]) {
    assert.equal((await runCodexCliAssignment(input, unused, {}, [held], executable)).outcome, "refused");
  }
  assert.equal(starts, 0);
});

test("delayed CLI readiness sends the validated prompt exactly once and preserves its redaction", async () => {
  const request = { assignmentId: id(1), prompt, workspace: "C:\\fixture-workspace", model: null, effort: null };
  const held = "fixture-opaque-held-text";
  const ready = deferred<NativeEvents>();
  const trace: string[] = [];
  const run = runCodexCliAssignment(request, { start(_argv, _options, events) {
    ready.resolve(events);
    return {
      write(text) { trace.push(text); return true; },
      endInput() {
        trace.push("EOF");
        queueMicrotask(() => {
          events.stdout(CLI_RESULT.replace("Ready.", prompt));
          events.closed({ code: 0, signal: null, error: null });
        });
      },
    };
  } }, {}, [held], executable);
  const events = await bounded(ready.promise);
  assert.deepEqual(trace, []);
  request.prompt = held;
  events.spawned();
  events.spawned();
  const result = await bounded(run);
  assert.deepEqual(trace, [prompt, "EOF"]);
  assert.equal(result.outcome, "completed");
  assert.equal(result.resultText, "[assignment input omitted]");
});

for (const phase of ["rejected write", "accepted write", "accepted EOF"] as const) {
  test(`synchronous CLI close during ${phase} settles from the exact input boundary`, async () => {
    const normal = phase === "accepted EOF";
    const request = { assignmentId: id(1), prompt, workspace: "C:\\fixture-workspace", model: null, effort: null };
    const trace: string[] = [];
    const result = await bounded(runCodexCliAssignment(request, { start(_argv, _options, events) {
      const close = () => {
        events.stdout(CLI_RESULT);
        events.closed({ code: 0, signal: null, error: null });
      };
      events.spawned();
      return {
        write(text) {
          trace.push(text);
          if (!normal) close();
          return phase !== "rejected write";
        },
        endInput() { trace.push("EOF"); close(); },
      };
    } }, {}, [], executable));
    assert.deepEqual(trace, normal ? [prompt, "EOF"] : [prompt]);
    assert.equal(result.outcome, normal ? "completed" : "disconnected");
    assert.equal(result.observed.assignment, normal ? "supported" : undefined);
    assert.equal(result.observed.streamResult, normal ? "supported" : undefined);
    assert.equal(result.writerState, "unknown");
  });
}
