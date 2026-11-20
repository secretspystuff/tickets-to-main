import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CLAUDE_CLI_VERSION, startClaudeCliAssignment, type ClaudeObservation } from "../src/adapters/claude.ts";
import { runAssignment, type AssignmentRequest } from "../src/assignment-boundary.ts";
import type { Intent } from "../src/assignment-journal.ts";
import { ensurePrivateDirectory } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { parseLedger } from "../src/ledger.ts";
import { processNativeTransport, windowsOwnedNativeTransport, windowsProcessLauncher, type NativeEvents, type NativeExit,
  type NativeProcess, type NativeTransport, type OriginalGroup } from "../src/native-transport.ts";
import { claimWorkspace, prepareWorkspace } from "../src/workspace.ts";
import { removeDir } from "./helpers.ts";

type Scenario = "complete" | "wrong input" | "refused activation" | "refused preparation";
type JournalRow = Intent | { kind: "started" | "result"; id: string; sequence: number; requestDigest: string; at: number; outcome?: string };
const node = realpathSync(process.execPath);
const peer = fileURLToPath(new URL("./owned-claude-peer.fixture.mjs", import.meta.url));
const onWindows = { skip: process.platform !== "win32", timeout: 24_000 };
const unpublishable = { qualification: "unqualified-harness", publishable: false };
const cleanExit: NativeExit = { code: 0, signal: null, error: null };
const heldExit: NativeExit = { code: null, signal: null, error: "spawn" };
const unavailable: OriginalGroup = { state: "unavailable" };
const zero: OriginalGroup = { state: "verified", activeProcesses: 0 };
const id = (value: number) => value.toString(16).padStart(32, "0");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const prompt = "Read the fabricated answer.\nReturn only the fixture text.";
const answer = "fabricated local answer";
const model = "fixture-model", effort = "low";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The fabricated Claude peer did not answer.")), 8_000);
  });
  try { return await Promise.race([operation, expired]); }
  finally { clearTimeout(timer); }
}

function fixture(t: TestContext, scenario: Scenario) {
  assert.equal(process.version, "v24.18.0");
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-owned-claude-")));
  assert.equal(dirname(root), parent);
  const stateDir = join(root, "state"), workspace = join(root, "workspace"), temp = join(root, "tmp");
  const claimedPath = join(stateDir, "ledger.json"), journal = join(stateDir, "assignment-intents.jsonl");
  const answerPath = join(workspace, "answer.txt"), receivedPath = join(root, "received.bin");
  const permitWriter = join(workspace, "permit-writer"), writerDone = join(workspace, "writer-finished.txt");
  const dispose: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const close of dispose) await close();
    assert.equal(dirname(realpathSync(root)), parent);
    removeDir(root);
  });
  ensurePrivateDirectory(root);
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, workspace, () => false);
  claimWorkspace(stateDir, process.pid, () => true);
  mkdirSync(temp);
  writeFileSync(answerPath, answer, { flag: "wx" });
  const baseline = readFileSync(claimedPath);
  const request: AssignmentRequest = {
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input: prompt,
    binding: { board: id(2), repo: id(3), activation: id(4), connection: id(5), job: id(6), claim: id(7),
      requirements: id(8), candidate: id(9), policy: id(10), fence: 1 },
  };
  const env = { SystemRoot: process.env.SystemRoot, TEMP: temp, TMP: temp };
  const claimedExecutable = join(root, "fixture-tools", "claude.exe");
  const launcher = { executable: claimedExecutable, version: CLAUDE_CLI_VERSION };
  const rows = (): JournalRow[] => existsSync(journal)
    ? readFileSync(journal, "utf8").trimEnd().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const snapshot = () => ({ rows: rows(), ledger: parseLedger(readFileSync(claimedPath, "utf8"))! });
  const bytes = () => [readFileSync(journal), readFileSync(claimedPath)];
  const peerInput = () => existsSync(receivedPath) ? readFileSync(receivedPath) : null;
  const allowWriter = () => {
    if (!existsSync(permitWriter)) writeFileSync(permitWriter, "fabricated release", { flag: "wx" });
  };

  const flushes: JournalRow[] = [];
  const originalFlush = fs.fsyncSync;
  fs.fsyncSync = fd => {
    originalFlush(fd);
    if (!existsSync(journal)) return;
    const opened = fs.fstatSync(fd), file = fs.lstatSync(journal);
    if (opened.dev === file.dev && opened.ino === file.ino) {
      const durable = rows();
      if (durable.length > flushes.length) flushes.push(durable.at(-1)!);
    }
  };
  syncBuiltinESMExports();
  t.after(() => { fs.fsyncSync = originalFlush; syncBuiltinESMExports(); });

  function start(transport: NativeTransport) {
    return startClaudeCliAssignment({
      assignmentId: request.id, prompt: request.input, workspace, model, effort,
    }, transport, env, [], launcher);
  }

  type Snapshot = ReturnType<typeof snapshot>;
  type InputTrace = { operation: "write" | "eof"; text?: string; active: boolean; snapshot: Snapshot; flushed: JournalRow[] };
  const trace: InputTrace[] = [];
  const pipeTrace: Array<{ operation: "write" | "eof"; text?: string }> = [];
  const observedJobs: Array<{ exact: boolean; active: number | undefined }> = [];
  let prepared: Snapshot | undefined, activated: Snapshot | undefined, connected: ClaudeObservation | undefined;
  let finished: ClaudeObservation | undefined, pipeExit: NativeExit | undefined, actualArgv: readonly string[] | undefined;
  let release: Snapshot | undefined, releaseSample: OriginalGroup | undefined, drained: OriginalGroup | undefined;
  let rootClosedWith: OriginalGroup | undefined, heldAfterRoot: Snapshot | undefined;
  let atActivation: { bytes: ReturnType<typeof bytes>; snapshot: Snapshot } | undefined;
  let launches = 0, attaches = 0, legacy = 0, reconciled = 0, verified = false, closes = 0, aborted = 0;

  const run = () => runAssignment({
    stateDir, raw: JSON.stringify(request), secrets: [], now: () => 1000,
    adapter: {
      kind: "fabricated-harness",
      async readCurrent() {
        return { binding: request.binding, nextSequence: 1, authorized: true, seat: "member",
          confirmedWorkspace: workspace, writersContained: true };
      },
      async execute() { legacy++; throw new Error("Unexpected legacy execution."); },
      async reconcile() { reconciled++; throw new Error("Unexpected reconciliation."); },
    },
    owned: { async prepare(preparation) {
      if (scenario === "refused preparation") return null;
      assert.equal(preparation.workspace, workspace);
      const jobLauncher = windowsProcessLauncher();
      const suspended = deferred<void>(), permit = deferred<boolean>(), closed = deferred<NativeExit>();
      const peerMode = scenario === "wrong input" ? "wrong input" : "complete";
      let listener: NativeEvents | undefined;
      const child = windowsOwnedNativeTransport({
        async start(...args) {
          launches++;
          const launch = await jobLauncher.start(...args);
          if (!launch) return null;
          return {
            ...launch,
            pipe: {
              write(text) { pipeTrace.push({ operation: "write", text }); return launch.pipe.write(text); },
              endInput() { pipeTrace.push({ operation: "eof" }); launch.pipe.endInput(); },
            },
            async verify() {
              const membership = await launch.verify();
              verified = membership !== null && membership.job === launch.originalJob && membership.child === launch.exactChild;
              return membership;
            },
            async activate() {
              suspended.resolve();
              const permission = await permit.promise;
              atActivation = { bytes: bytes(), snapshot: snapshot() };
              return permission && launch.activate();
            },
            disposeBeforeInput() { aborted++; launch.disposeBeforeInput(); },
            async observe() {
              const result = await launch.observe();
              observedJobs.push({ exact: result?.job === launch.originalJob && result.complete === true, active: result?.activeProcesses });
              return result;
            },
          };
        },
      }).start([node, peer, peerMode, workspace], { cwd: workspace, env }, {
        spawned() { activated = snapshot(); listener?.spawned(); },
        stdout(chunk) { listener?.stdout(chunk); },
        stderr(chunk) { listener?.stderr(chunk); },
        inputError() { listener?.inputError(); },
        closed(exit) { pipeExit = exit; closed.resolve(exit); listener?.closed(exit); },
      });
      let disposal: Promise<void> | undefined;
      const close = () => disposal ??= (async () => {
        if (activated && scenario === "complete") allowWriter();
        child.endInput();
        permit.resolve(false);
        await bounded(closed.promise);
        child.closeObservation();
        assert.deepEqual(await child.observeOriginalGroup(), unavailable);
        closes++;
      })();
      dispose.push(close);

      assert.equal(await bounded(Promise.race([suspended.promise, closed.promise])), undefined, "the real Job must reach suspension");
      prepared = snapshot();
      assert.deepEqual(prepared.rows, [preparation.intent]);
      assert.deepEqual(flushes, [preparation.intent]);
      assert.equal(peerInput(), null);
      const bridge: NativeTransport = { start(argv, options, events) {
        attaches++;
        checkRecipe(argv, claimedExecutable);
        assert.equal(options.cwd, workspace);
        const { env: receivedEnv } = options;
        assert.deepEqual(Object.assign({}, receivedEnv), env);
        actualArgv = argv;
        listener = events;
        return {
          write(text) {
            trace.push({ operation: "write", text, active: !!activated, snapshot: snapshot(), flushed: [...flushes] });
            return child.write(text);
          },
          endInput() {
            trace.push({ operation: "eof", active: !!activated, snapshot: snapshot(), flushed: [...flushes] });
            child.endInput();
          },
        };
      } };
      return {
        original: { async observeOriginalGroup() {
          release = snapshot();
          releaseSample = await child.observeOriginalGroup();
          return releaseSample;
        } },
        async execute(assignment) {
          assert.deepEqual(assignment, { id: request.id, sequence: request.sequence, input: request.input, workspace });
          const handle = start(bridge);
          connected = handle.snapshot();
          permit.resolve(scenario !== "refused activation" && trace.length === 0);
          finished = await bounded(handle.closed);
          rootClosedWith = await child.observeOriginalGroup();
          if (finished.outcome !== "completed" || finished.resultText !== answer) {
            throw new Error("The fabricated terminal result was not established.");
          }
          if (scenario === "complete") {
            heldAfterRoot = snapshot();
            assert.deepEqual(rootClosedWith, { state: "verified", activeProcesses: 1 });
            assert.equal(existsSync(writerDone), false);
            allowWriter();
            drained = await bounded((async () => {
              for (let sample = await child.observeOriginalGroup();;) {
                if (sample.state !== "verified" || sample.activeProcesses === 0) return sample;
                await delay(25);
                sample = await child.observeOriginalGroup();
              }
            })());
          } else {
            drained = rootClosedWith;
          }
          assert.deepEqual(drained, zero);
          return { id: assignment.id, sequence: assignment.sequence, result: "completed", writersContained: true };
        },
        close,
      };
    } },
  });

  return { start, run, env, workspace, launcher, baseline, claimedPath, answerPath, writerDone, bytes,
    peerInput, snapshot, trace, pipeTrace, flushes, observedJobs,
    get launches() { return launches; }, get attaches() { return attaches; }, get legacy() { return legacy; },
    get reconciled() { return reconciled; }, get verified() { return verified; }, get closes() { return closes; },
    get aborted() { return aborted; },
    get prepared() { return prepared; }, get activated() { return activated; }, get connected() { return connected; },
    get finished() { return finished; }, get actualArgv() { return actualArgv; }, get pipeExit() { return pipeExit; },
    get release() { return release; }, get releaseSample() { return releaseSample; }, get drained() { return drained; },
    get rootClosedWith() { return rootClosedWith; }, get heldAfterRoot() { return heldAfterRoot; }, get atActivation() { return atActivation; },
  };
}

function checkRecipe(argv: readonly string[], executable: string): void {
  assert.equal(CLAUDE_CLI_VERSION, "2.1.317");
  assert.match(argv[8] ?? "", uuid);
  assert.deepEqual(argv, [executable, "--print", "--input-format", "stream-json", "--output-format",
    "stream-json", "--verbose", "--session-id", argv[8], "--model=" + model, "--effort=" + effort]);
}

function expectedLine(argv: readonly string[], { turnId: inputId }: ClaudeObservation): string {
  assert.match(inputId ?? "", uuid);
  return JSON.stringify({
    type: "user", uuid: inputId, session_id: argv[8], parent_tool_use_id: null, client_composed: true,
    message: { role: "user", content: prompt },
  }) + "\n";
}

const terminalRow = (intent: Intent, outcome: "completed" | "not-started") => ({
  kind: "result", id: intent.id, sequence: intent.sequence, requestDigest: intent.requestDigest, at: 1000, outcome,
});
const startedRow = (intent: Intent) => ({
  kind: "started", id: intent.id, sequence: intent.sequence, requestDigest: intent.requestDigest, at: 1000,
});

test("ordinary Claude transport sends the exact line and EOF to the fabricated peer without touching custody", onWindows, async t => {
  const f = fixture(t, "complete"), subprocess = processNativeTransport();
  let recipe: readonly string[] | undefined, launches = 0, exit: NativeExit | undefined;
  let peerProcess: NativeProcess | undefined;
  const closed = deferred<NativeExit>();
  const input: Array<{ operation: "write" | "eof"; text?: string }> = [];
  const handle = f.start({ start(argv, options, events) {
    launches++;
    checkRecipe(argv, f.launcher.executable);
    recipe = argv;
    const child = subprocess.start([node, peer, "ordinary", f.workspace], options, {
      ...events, closed(result) { exit = result; closed.resolve(result); events.closed(result); },
    });
    peerProcess = child;
    return { write(text) { input.push({ operation: "write", text }); return child.write(text); },
      endInput() { input.push({ operation: "eof" }); child.endInput(); } };
  } });
  let result: ClaudeObservation;
  try { result = await bounded(handle.closed); }
  finally {
    if (peerProcess && !exit) {
      peerProcess.endInput();
      await bounded(closed.promise);
    }
  }
  assert.equal(result.outcome, "completed");
  assert.equal(result.resultText, answer);
  assert.equal(result.writerState, "unknown");
  assert.ok(recipe);
  const line = expectedLine(recipe, result);
  assert.deepEqual(f.peerInput(), Buffer.from(line));
  assert.deepEqual(input, [{ operation: "write", text: line }, { operation: "eof" }]);
  assert.equal(launches, 1);
  assert.deepEqual(exit, cleanExit);
  assert.deepEqual(readFileSync(f.claimedPath), f.baseline);
  assert.deepEqual(f.snapshot().rows, []);
  assert.equal(readFileSync(f.answerPath, "utf8"), answer);
});

for (const scenario of ["complete", "wrong input"] as const) {
  test("owned Claude " + scenario + " waits for a durable start and same-Job activation before input or EOF", onWindows, async t => {
    const f = fixture(t, scenario);
    const outcome = await f.run();
    assert.equal(f.verified, true);
    assert.equal(f.launches, 1);
    assert.equal(f.attaches, 1);
    assert.equal(f.closes, 1);
    assert.equal(f.legacy, 0);
    assert.equal(f.reconciled, 0);
    assert.ok(f.prepared && f.atActivation);
    const intent = f.prepared.rows[0] as Intent;
    const started = startedRow(intent);
    assert.equal(intent.version, 4);
    assert.deepEqual(f.atActivation.snapshot.rows, [intent, started]);
    const bound = f.atActivation.snapshot.ledger.workspace;
    assert.match(bound?.claimGeneration ?? "", uuid);
    assert.equal(bound?.writerPid, process.pid);
    assert.deepEqual(f.atActivation.snapshot.ledger.boundWorkspaceIntents, [intent.id]);
    assert.deepEqual(f.flushes.slice(0, 2), [intent, started]);
    assert.deepEqual(f.trace.filter(event => !event.active).map(event => event.operation), [],
      "Claude must attempt neither write nor EOF before activation of the verified Job");
    assert.equal(f.connected?.outcome, "starting");
    assert.equal(f.aborted, 0);
    assert.ok(f.activated && f.finished && f.actualArgv);
    assert.deepEqual(f.prepared.ledger.workspace, { path: f.workspace, writerPid: process.pid, qualified: false });
    assert.deepEqual(bound, { ...f.prepared.ledger.workspace, claimGeneration: bound?.claimGeneration });
    assert.deepEqual(f.activated, f.atActivation.snapshot);
    const line = expectedLine(f.actualArgv, f.finished);
    const input = [{ operation: "write", text: line }, { operation: "eof" }];
    assert.deepEqual(f.trace.map(({ operation, text }) => text === undefined ? { operation } : { operation, text }), input);
    assert.deepEqual(f.pipeTrace, input);
    assert.deepEqual(f.peerInput(), Buffer.from(line));
    for (const event of f.trace) {
      assert.deepEqual(event.snapshot, f.activated);
      assert.deepEqual(event.flushed, [intent, started]);
    }
    assert.deepEqual(f.pipeExit, cleanExit);
    assert.equal(f.finished.writerState, "unknown");
    assert.ok(f.observedJobs.length > 0 && f.observedJobs.every(sample => sample.exact));
    assert.equal(readFileSync(f.answerPath, "utf8"), answer);

    if (scenario === "complete") {
      assert.deepEqual(outcome, { state: "completed", ...unpublishable });
      assert.equal(f.finished.outcome, "completed");
      assert.equal(f.finished.resultText, answer);
      assert.equal(f.finished.threadId, f.actualArgv[8]);
      assert.deepEqual(f.rootClosedWith, { state: "verified", activeProcesses: 1 });
      assert.deepEqual(f.heldAfterRoot, f.activated);
      assert.equal(readFileSync(f.writerDone, "utf8"), "fabricated late write");
      assert.deepEqual(f.drained, zero);
      assert.deepEqual(f.releaseSample, zero);
      const terminal = terminalRow(intent, "completed");
      assert.deepEqual(f.flushes, [intent, started, terminal]);
      assert.deepEqual(f.release, { rows: [intent, started, terminal], ledger: f.activated.ledger });
      const after = f.snapshot();
      assert.deepEqual(after.rows, f.release?.rows);
      assert.deepEqual(after.ledger.workspace, { path: f.workspace, writerPid: null, qualified: false });
      assert.equal(after.ledger.boundWorkspaceIntents, undefined);
    } else {
      assert.deepEqual(outcome, { state: "held", ...unpublishable });
      assert.equal(f.finished.outcome, "protocol-error");
      assert.deepEqual(f.rootClosedWith, zero);
      assert.equal(f.release, undefined);
      assert.deepEqual(f.snapshot(), f.activated);
      assert.deepEqual(f.flushes, [intent, started]);
    }
  });
}

test("refused owned Claude activation disposes the same Job before any input and preserves exact custody", onWindows, async t => {
  const f = fixture(t, "refused activation");
  assert.deepEqual(await f.run(), { state: "held", ...unpublishable });
  assert.deepEqual(f.pipeTrace, []);
  assert.equal(f.peerInput(), null);
  assert.equal(f.verified, true);
  assert.equal(f.launches, 1);
  assert.equal(f.attaches, 1);
  assert.equal(f.closes, 1);
  assert.equal(f.aborted, 1);
  assert.equal(f.legacy, 0);
  assert.equal(f.reconciled, 0);
  assert.equal(f.activated, undefined);
  assert.equal(f.finished?.outcome, "disconnected");
  assert.deepEqual(f.pipeExit, heldExit);
  assert.deepEqual(f.rootClosedWith, unavailable);
  assert.equal(f.release, undefined);
  assert.ok(f.atActivation);
  assert.deepEqual(f.bytes(), f.atActivation.bytes);
  const [intent, start, ...extra] = f.snapshot().rows;
  assert.equal(intent?.kind, "intent");
  assert.deepEqual(start, startedRow(intent as Intent));
  assert.deepEqual(extra, []);
  assert.deepEqual(f.flushes, [intent, start]);
  const { workspace, boundWorkspaceIntents } = f.snapshot().ledger;
  assert.equal(workspace?.writerPid, process.pid);
  assert.match(workspace?.claimGeneration ?? "", uuid);
  assert.deepEqual(boundWorkspaceIntents, [intent!.id]);
  assert.deepEqual(f.trace.map(event => event.operation), [], "refused activation must not prompt the adapter to write or end input");
});

test("refused owned Claude preparation starts no process and records only not-started", onWindows, async t => {
  const f = fixture(t, "refused preparation");
  assert.deepEqual(await f.run(), { state: "not-started", ...unpublishable });
  assert.equal(f.peerInput(), null);
  assert.deepEqual(f.trace, []);
  assert.deepEqual(f.pipeTrace, []);
  assert.equal(f.launches, 0);
  assert.equal(f.attaches, 0);
  assert.equal(f.legacy, 0);
  assert.equal(f.reconciled, 0);
  assert.equal(f.closes, 0);
  assert.equal(f.aborted, 0);
  assert.equal(f.release, undefined);
  assert.deepEqual(readFileSync(f.claimedPath), f.baseline);
  const [intent, terminal, ...extra] = f.snapshot().rows;
  assert.equal(intent?.kind, "intent");
  assert.deepEqual(terminal, terminalRow(intent as Intent, "not-started"));
  assert.deepEqual(extra, []);
  assert.deepEqual(f.flushes, [intent, terminal]);
});
