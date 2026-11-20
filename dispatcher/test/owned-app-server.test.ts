import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { CODEX_APP_SERVER_SCHEMA_VERSION, startCodexAppServerAssignment, type CodexAssignmentHandle } from "../src/adapters/codex-app-server.ts";
import type { NativeObservation } from "../src/adapters/native-result.ts";
import { runAssignment, type AssignmentRequest } from "../src/assignment-boundary.ts";
import { journalDigest } from "../src/assignment-journal.ts";
import { assignmentDirectory, directoryBirthTime } from "../src/directory-identity.ts";
import { ensurePrivateDirectory } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { parseLedger, type LoadResult } from "../src/ledger.ts";
import { JsonLines, processNativeTransport, windowsOwnedNativeTransport, windowsProcessLauncher, type NativeEvents, type NativeExit, type NativeTransport,
  type OriginalGroup } from "../src/native-transport.ts";
import { claimWorkspace, prepareWorkspace } from "../src/workspace.ts";
import { removeDir } from "./helpers.ts";

type PeerMode = "complete" | "other completion" | "private identity" | "wrong workspace" | "invalid initialize" | "wrong turn" | "wrong thread" | "interrupt"
  | "missing turn reply" | "rejected turn reply" | "foreign turn reply" | "matching late reply" | "abnormal exit";
type Scenario = Exclude<PeerMode, "private identity"> | "refused preparation" | "refused activation" | "observer closed before release"
  | "cached original zero" | "echoed identity" | "embedded identity" | "held identity" | "foreign callbacks" | "public pipe rewrite"
  | "prestarted turn";
type PredecessorTerminal = "exact" | "missing" | "absent reader" | "unmarked" | "unmarked observer wrapper" | (() => CodexAssignmentHandle);
const executable = realpathSync(process.execPath);
const peer = fileURLToPath(new URL("./owned-app-server-peer.fixture.mjs", import.meta.url));
const onWindows = { skip: process.platform !== "win32", timeout: 24_000 };
const noPublication = { qualification: "unqualified-harness", publishable: false };
const id = (value: number) => value.toString(16).padStart(32, "0");
const prompt = "Read the fabricated answer file.";
const privateIdentity = "fixture-private-identity";
const answer = "fabricated local answer";
const zero: OriginalGroup = { state: "verified", activeProcesses: 0 };

function dialogue(workspace: string, scenario: PeerMode): unknown[] {
  const expected: unknown[] = [{ id: 1, method: "initialize", params: { clientInfo: { name: "tickets_to_main", version: "0.1.0" } } }];
  if (scenario !== "invalid initialize") {
    expected.push({ method: "initialized" }, { id: 2, method: "thread/start", params: { cwd: workspace, model: "fixture-model" } });
  }
  if (scenario === "complete" || scenario === "wrong turn" || scenario === "wrong thread" || scenario === "interrupt") {
    expected.push({ id: 3, method: "turn/start", params: { threadId: "fixture-thread", input: [{ type: "text", text: prompt }], effort: "low" } });
  }
  if (scenario === "interrupt") {
    expected.push({ id: 4, method: "turn/interrupt", params: { threadId: "fixture-thread", turnId: "fixture-turn" } });
  }
  return expected;
}

function terminalLineage(observation: NativeObservation | undefined): unknown {
  assert.ok(observation);
  return Reflect.get(observation, "appServerTerminalLineage") ?? null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>) {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The fabricated app-server did not answer.")), 8_000);
  });
  try { return await Promise.race([operation, expired]); }
  finally { clearTimeout(timer); }
}

async function until(ready: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 8_000;
  while (!await ready()) {
    assert.ok(Date.now() < deadline, message);
    await pause(20);
  }
}

function fixture(t: TestContext, scenario: Scenario, predecessor: PredecessorTerminal = "exact") {
  assert.equal(process.version, "v24.18.0");
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-owned-app-server-")));
  assert.equal(dirname(root), parent);
  const exposesIdentity = scenario === "echoed identity" || scenario === "embedded identity" || scenario === "held identity";
  const threadId = exposesIdentity ? privateIdentity : scenario === "other completion" ? "other-fixture-thread" : "fixture-thread";
  const turnId = scenario === "other completion" || scenario === "foreign callbacks" ? "other-fixture-turn" : "fixture-turn";
  const inputPrompt = scenario === "echoed identity" ? privateIdentity : scenario === "embedded identity" ? `Review ${privateIdentity} today` : prompt;
  const stateDir = join(root, "state"), workspace = join(root, "workspace"), temp = join(root, "tmp");
  const allowWrite = join(root, "allow-write"), abortWriter = join(root, "abort-writer");
  const lateMarker = join(workspace, "late-marker.txt");
  const disposals: Array<() => Promise<void>> = [];
  t.after(async () => {
    if (scenario === "interrupt" && !existsSync(allowWrite)) writeFileSync(abortWriter, "abort", { flag: "wx" });
    for (const dispose of disposals) await dispose();
    assert.equal(dirname(realpathSync(root)), parent);
    removeDir(root);
  });
  ensurePrivateDirectory(root);
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, workspace, () => false);
  claimWorkspace(stateDir, process.pid, () => true);
  mkdirSync(temp);
  mkdirSync(join(root, "other-workspace"));
  const answerFile = join(workspace, "answer.txt");
  writeFileSync(answerFile, answer, { flag: "wx" });
  const request: AssignmentRequest = {
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input: inputPrompt,
    binding: { board: id(2), repo: id(3), activation: id(4), connection: id(5), job: id(6),
      claim: id(7), requirements: id(8), candidate: id(9), policy: id(10), fence: 1 },
  };
  const readRecords = (path: string) => existsSync(path)
    ? readFileSync(path, "utf8").trimEnd().split("\n").map(line => JSON.parse(line)) : [];
  const journal = join(stateDir, "assignment-intents.jsonl"), ledger = join(stateDir, "ledger.json");
  const snapshot = () => ({ rows: readRecords(journal), ledger: parseLedger(readFileSync(ledger, "utf8"))! });
  const bytes = () => [readFileSync(journal), readFileSync(ledger)];
  const before = readFileSync(ledger);
  const received = () => readRecords(join(root, "requests.jsonl"));
  const env = { SystemRoot: process.env.SystemRoot, TEMP: temp, TMP: temp };
  const beforeActivation: string[] = [];
  const writes: Array<{ value: unknown; snapshot: ReturnType<typeof snapshot> }> = [];
  const groupIdentity: boolean[] = [];
  let launches = 0, legacy = 0, verified = false, attach = 0, closes = 0;
  let publicWrites = 0;
  let nativeHandle: CodexAssignmentHandle | null = null;
  let settled: NativeObservation | undefined, connected: NativeObservation | undefined, finished: NativeObservation | undefined;
  let prepared: ReturnType<typeof snapshot> | undefined, activated: ReturnType<typeof snapshot> | undefined;
  let release: ReturnType<typeof snapshot> | undefined, drained: OriginalGroup | undefined, live: OriginalGroup | undefined;
  let priorSample: OriginalGroup | undefined;
  let afterInterruptedClose: OriginalGroup | undefined;
  let releaseBytes: ReturnType<typeof bytes> | undefined, releaseGroup: OriginalGroup | undefined;
  let exit: NativeExit | undefined;
  let activationAttempt: ReturnType<typeof bytes> | undefined;
  const declaresAppServer = predecessor !== "unmarked" && predecessor !== "unmarked observer wrapper";
  const run = (operation: string = request.operation) => runAssignment({
    stateDir, raw: JSON.stringify({ ...request, operation }), secrets: scenario === "held identity" ? [privateIdentity] : [], now: () => 1000,
    adapter: {
      kind: "fabricated-harness",
      async readCurrent() { return { binding: request.binding, nextSequence: 1, authorized: true,
        seat: "member", confirmedWorkspace: workspace, writersContained: true }; },
      async execute() { legacy++; throw new Error("Unexpected legacy execution."); },
      async reconcile() { throw new Error("Unexpected reconciliation."); },
    },
    owned: { ...(declaresAppServer && { nativeInterface: { vendor: "codex", interfaceId: "app-server" } as const }), async prepare(input) {
      if (scenario === "refused preparation") return null;
      assert.equal(input.workspace, workspace);
      const launcher = windowsProcessLauncher();
      let peerMode: PeerMode;
      if (exposesIdentity) peerMode = "private identity";
      else if (scenario === "refused activation" || scenario === "observer closed before release" || scenario === "cached original zero"
        || scenario === "foreign callbacks" || scenario === "public pipe rewrite" || scenario === "prestarted turn") peerMode = "complete";
      else peerMode = scenario;
      const suspended = deferred<void>(), permit = deferred<boolean>(), closed = deferred<NativeExit>();
      let receiver: NativeEvents | undefined;
      const rewritten = new JsonLines(value => {
        receiver?.stdout(JSON.stringify(value).replaceAll('"fixture-turn"', '"other-fixture-turn"') + "\n");
      }, () => assert.fail("The fabricated callback stream is malformed."));
      const child = windowsOwnedNativeTransport({
        async start(...args) {
          launches++;
          const launch = await launcher.start(...args);
          if (!launch) return null;
          return { ...launch, pipe: {
            write(text) {
              const value = JSON.parse(text);
              if (!activated) beforeActivation.push(value.method);
              writes.push({ value, snapshot: snapshot() });
              return launch.pipe.write(text);
            },
            endInput() { launch.pipe.endInput(); },
          }, async activate() {
            suspended.resolve();
            if (!await permit.promise) return false;
            activationAttempt = bytes();
            if (scenario === "refused activation") return false;
            return launch.activate();
          }, async verify() {
            const membership = await launch.verify();
            verified = membership !== null && membership.job === launch.originalJob && membership.child === launch.exactChild;
            return membership;
          }, async observe() {
            const observed = await launch.observe();
            groupIdentity.push(observed?.job === launch.originalJob && observed.complete === true);
            return observed;
          } };
        },
      }).start([executable, peer, peerMode, workspace], { cwd: workspace, env }, {
        spawned() { activated = snapshot(); receiver?.spawned(); },
        stdout(chunk) { if (receiver) rewritten.push(chunk); }, stderr() {}, inputError() { receiver?.inputError(); },
        closed(status) {
          exit = { ...status };
          closed.resolve(exit);
          if (scenario === "abnormal exit") status.code = 0;
          if (receiver) { rewritten.finish(); receiver.closed(status); }
        },
      });
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async () => {
        child.endInput();
        permit.resolve(false);
        try {
          await bounded(closed.promise);
          if (scenario === "interrupt" && activated) {
            await until(async () => {
              drained = await child.observeOriginalGroup();
              return drained.state === "verified" && drained.activeProcesses === 0;
            }, "The original Job did not drain after interruption.");
          }
        } finally {
          child.closeObservation();
        }
        assert.deepEqual(await child.observeOriginalGroup(), { state: "unavailable" });
        closes++;
      })();
      const observe = child.observeOriginalGroup.bind(child);
      child.observeOriginalGroup = async () => {
        const seen = snapshot();
        const atRelease = !closing && !release && seen.rows.at(-1)?.kind === "result";
        if (atRelease) {
          release = seen;
          releaseBytes = bytes();
        }
        const observed = await observe();
        const sample = atRelease && scenario === "cached original zero" && priorSample ? priorSample : observed;
        if (atRelease) releaseGroup = sample;
        return sample;
      };
      disposals.push(close);
      try {
        assert.equal(await bounded(Promise.race([suspended.promise, closed.promise])), undefined);
        prepared = snapshot();
        assert.deepEqual(prepared.rows, [input.intent]);
        assert.deepEqual(received(), []);
      } catch (error) {
        await close();
        throw error;
      }
      if (scenario === "public pipe rewrite") {
        const write = child.write.bind(child);
        child.write = text => {
          publicWrites++;
          const value = JSON.parse(text);
          if (value.method === "turn/start") value.params.input = [{ type: "text", text: "A different fabricated assignment" }];
          return write(JSON.stringify(value) + "\n");
        };
      }
      const bridge: NativeTransport = { start(argv, options, events) {
        assert.deepEqual(argv, [executable, "app-server"]);
        assert.equal(options.cwd, workspace);
        assert.deepEqual({ ...options.env }, env);
        receiver = events;
        return child;
      } };
      async function execute(assignment: Pick<AssignmentRequest, "id" | "sequence" | "input"> & { workspace: string }) {
        attach++;
        assert.equal(attach, 1);
        const handle = startCodexAppServerAssignment({ assignmentId: assignment.id, prompt: assignment.input,
          workspace: assignment.workspace, model: "fixture-model", effort: "low" }, scenario === "foreign callbacks" ? bridge : child, env, [],
        { executable, version: CODEX_APP_SERVER_SCHEMA_VERSION });
        nativeHandle = handle;
        connected = handle.snapshot();
        assert.deepEqual(connected.argv, [executable, "app-server"]);
        if (connected.outcome !== "starting" || beforeActivation.length !== 0) throw new Error("The adapter wrote before owned activation.");
        permit.resolve(true);
        if (scenario === "interrupt") {
          await until(() => handle.snapshot().outcome === "running", "The app-server did not start the fabricated turn.");
          assert.equal(handle.interrupt(), true);
          assert.equal(handle.interrupt(), false);
        }
        settled = await bounded(handle.settled);
        live = await child.observeOriginalGroup();
        handle.closeInput();
        finished = await bounded(handle.closed);
        const afterClose = await child.observeOriginalGroup();
        if (scenario === "interrupt") afterInterruptedClose = afterClose;
        else drained = afterClose;
        if (finished.outcome !== "completed" || settled.outcome !== "completed" || settled.resultText !== answer || settled.threadId !== threadId
          || settled.turnId !== turnId || afterClose.state !== "verified" || afterClose.activeProcesses !== 0) {
          throw new Error("The original Job or app-server did not provide exact terminal evidence.");
        }
        if (scenario === "observer closed before release" || scenario === "cached original zero") {
          priorSample = afterClose;
          child.closeObservation();
        }
        return { id: assignment.id, sequence: assignment.sequence, result: "completed" as const, writersContained: true };
      }
      const earlier = scenario === "prestarted turn" ? await execute({ ...request, workspace }) : null;
      return {
        ...(predecessor !== "absent reader" && declaresAppServer && { nativePredecessor: { readHandle() {
          if (typeof predecessor === "function") return predecessor();
          return predecessor === "exact" ? nativeHandle : null;
        } } }),
        original: predecessor === "unmarked observer wrapper" ? { observeOriginalGroup: () => child.observeOriginalGroup() } : child,
        async execute(assignment) { return earlier ?? execute(assignment); },
        close,
      };
    } },
  });
  return { run, workspace, answerFile, env, snapshot, bytes, received, before, ledger, writes, beforeActivation, groupIdentity,
    lateMarker, allowLateWrite: () => writeFileSync(allowWrite, "write", { flag: "wx" }),
    get publicWrites() { return publicWrites; },
    get nativeHandle() { return nativeHandle; },
    get launches() { return launches; }, get legacy() { return legacy; }, get verified() { return verified; }, get attach() { return attach; },
    get closes() { return closes; }, get prepared() { return prepared; }, get activated() { return activated; },
    get activationAttempt() { return activationAttempt; },
    get connected() { return connected; }, get settled() { return settled; }, get finished() { return finished; }, get exit() { return exit; }, get release() { return release; },
    get releaseBytes() { return releaseBytes; }, get releaseGroup() { return releaseGroup; },
    get live() { return live; }, get drained() { return drained; }, get afterInterruptedClose() { return afterInterruptedClose; } };
}

test("the same fabricated peer completes the app-server handshake on the existing process transport", onWindows, async t => {
  const f = fixture(t, "complete"), subprocess = processNativeTransport();
  const handle = startCodexAppServerAssignment({ assignmentId: id(1), prompt, workspace: f.workspace,
    model: "fixture-model", effort: "low" }, { start(_argv, options, events) {
    return subprocess.start([executable, peer, "complete", f.workspace], options, events);
  } }, f.env, [], { executable, version: CODEX_APP_SERVER_SCHEMA_VERSION });
  try {
    const result = await bounded(handle.settled);
    assert.equal(result.outcome, "completed");
    assert.equal(result.resultText, answer);
    assert.deepEqual(f.received(), dialogue(f.workspace, "complete"));
  } finally {
    handle.closeInput();
    await bounded(handle.closed);
  }
  assert.equal((await handle.closed).outcome, "completed");
});

for (const scenario of ["complete", "wrong workspace", "invalid initialize", "wrong turn", "wrong thread", "observer closed before release"] as const) {
  test(`owned app-server ${scenario} uses the first post-activation handshake`, onWindows, async t => {
    const f = fixture(t, scenario);
    const result = await f.run();
    assert.equal(f.verified, true);
    assert.equal(f.launches, 1);
    assert.equal(f.attach, 1);
    assert.equal(f.closes, 1);
    assert.deepEqual(f.beforeActivation, [], "initialize must never be attempted while the verified Job is suspended");
    assert.equal(f.connected?.outcome, "starting");
    assert.equal(terminalLineage(f.connected), null);
    assert.ok(f.prepared && f.activated);
    const [intent] = f.prepared.rows;
    assert.deepEqual(f.prepared.ledger.workspace, { path: f.workspace, writerPid: process.pid, qualified: false });
    const started = { kind: "started", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000 };
    assert.deepEqual(f.activated.rows, [intent, started]);
    const workspace = f.activated.ledger.workspace;
    assert.ok(workspace?.claimGeneration);
    assert.deepEqual(workspace, { ...f.prepared.ledger.workspace, claimGeneration: workspace.claimGeneration });
    assert.deepEqual(f.activated.ledger.boundWorkspaceIntents, [intent.id]);
    const expected = dialogue(f.workspace, scenario === "observer closed before release" ? "complete" : scenario);
    assert.deepEqual(f.received(), expected);
    assert.deepEqual(f.writes.map(write => write.value), expected);
    for (const write of f.writes) assert.deepEqual(write.snapshot, f.activated);
    assert.deepEqual(f.live, { state: "verified", activeProcesses: 1 });
    assert.deepEqual(f.drained, zero);
    assert.deepEqual(f.exit, { code: 0, signal: null, error: null });
    assert.equal(f.finished?.outcome, f.settled?.outcome);
    assert.equal(f.legacy, 0);
    assert.equal(readFileSync(f.answerFile, "utf8"), answer);
    if (scenario === "complete" || scenario === "observer closed before release") {
      assert.deepEqual(result, { state: "completed", ...noPublication });
      assert.equal(f.settled?.outcome, "completed");
      assert.equal(f.settled?.resultText, answer);
      assert.equal(f.settled?.vendor, "codex");
      assert.equal(f.settled?.interfaceId, "app-server");
      assert.equal(f.settled?.threadId, "fixture-thread");
      assert.equal(f.settled?.turnId, "fixture-turn");
      assert.equal(f.settled?.writerState, "unknown");
      const terminal = { kind: "result", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000, outcome: "completed" };
      assert.deepEqual(f.release, { rows: [intent, started, terminal], ledger: f.activated.ledger });
      const after = f.snapshot();
      assert.deepEqual(after.rows, f.release?.rows);
      if (scenario === "complete") {
        assert.deepEqual(f.releaseGroup, zero);
        assert.deepEqual(after.ledger.workspace, { path: f.workspace, writerPid: null, qualified: false });
        assert.equal(after.ledger.boundWorkspaceIntents, undefined);
        assert.deepEqual(f.groupIdentity, [true, true, true]);
        const lineage = { vendor: "codex", interfaceId: "app-server", threadId: "fixture-thread", turnId: "fixture-turn" };
        assert.deepEqual([terminalLineage(f.settled), terminalLineage(f.finished)], [lineage, lineage],
          "only the correlated successful native terminal can report exact app-server lineage");
      } else {
        assert.deepEqual(f.releaseGroup, { state: "unavailable" });
        assert.deepEqual(f.groupIdentity, [true, true]);
        assert.deepEqual(after.ledger, f.activated.ledger);
        const atRelease = f.releaseBytes;
        assert.ok(atRelease);
        assert.deepEqual(f.bytes(), atRelease);

        assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
        assert.deepEqual(f.bytes(), atRelease);
        assert.deepEqual(f.received(), expected);
        assert.deepEqual(f.writes.map(write => write.value), expected);
        assert.equal(f.launches, 1);
        assert.equal(f.attach, 1);
        assert.equal(f.closes, 1);
        assert.equal(f.legacy, 0);
      }
    } else {
      assert.deepEqual(result, { state: "held", ...noPublication });
      assert.equal(f.settled?.outcome, scenario === "wrong workspace" ? "refused" : "protocol-error");
      assert.equal(f.release, undefined);
      assert.deepEqual(f.snapshot(), f.activated);
      assert.deepEqual(f.groupIdentity, [true, true]);
      if (scenario === "wrong thread" || scenario === "wrong turn") {
        assert.equal(f.settled?.interfaceId, "app-server");
        assert.equal(f.settled?.threadId, "fixture-thread");
        assert.equal(f.settled?.turnId, "fixture-turn");
      }
      assert.deepEqual([terminalLineage(f.settled), terminalLineage(f.finished)], [null, null]);
    }
  });
}

function reopenLedger(f: ReturnType<typeof fixture>): LoadResult {
  const module = new URL("../src/ledger.ts", import.meta.url).href;
  const source = `import { loadLedger } from ${JSON.stringify(module)};
    process.stdout.write(JSON.stringify(loadLedger(process.argv[1])));`;
  const inspected = spawnSync(executable, ["--experimental-strip-types", "--input-type=module", "--eval", source, dirname(f.ledger)], {
    cwd: f.workspace, env: f.env, encoding: "utf8", timeout: 8_000, windowsHide: true,
  });
  assert.ifError(inspected.error);
  assert.equal(inspected.status, 0, inspected.stderr);
  return JSON.parse(inspected.stdout) as LoadResult;
}

function exactPredecessor(f: ReturnType<typeof fixture>) {
  assert.ok(f.activated && f.release);
  const [intent, , terminal] = f.release.rows;
  const claimGeneration = f.activated.ledger.workspace?.claimGeneration;
  assert.ok(claimGeneration);
  assert.equal(terminal.outcome, "completed");
  const nativeTerminal = terminalLineage(f.finished);
  assert.deepEqual(nativeTerminal, { vendor: "codex", interfaceId: "app-server", threadId: "fixture-thread", turnId: "fixture-turn" });
  return {
    assignmentId: intent.id, sequence: intent.sequence, requestDigest: intent.requestDigest, bindingDigest: intent.bindingDigest,
    workspaceDigest: intent.workspaceDigest, workspaceIdentityDigest: intent.aliasDigest,
    workspaceBirthDigest: journalDigest(directoryBirthTime(assignmentDirectory(f.workspace)).toString()),
    claimGeneration, completedAt: terminal.at, nativeTerminal, originalJob: zero,
  };
}

function traceReleaseWrites(t: TestContext, f: ReturnType<typeof fixture>, failReplace = false) {
  const attempted: unknown[] = [];
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === f.ledger && f.releaseGroup?.state === "verified") {
      attempted.push(JSON.parse(readFileSync(source, "utf8")));
      if (failReplace) throw new Error("The fixture stopped before replacing the ledger.");
    }
    rename(source, destination);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
  return attempted;
}

test("a fresh process reads the exact app-server predecessor only after the original Job drains and its claim clears", onWindows, async t => {
  const f = fixture(t, "complete", "exact");
  const attempted = traceReleaseWrites(t, f);
  assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
  assert.equal(f.verified, true);
  assert.deepEqual(f.live, { state: "verified", activeProcesses: 1 });
  assert.deepEqual(f.releaseGroup, zero);
  assert.deepEqual(f.groupIdentity, [true, true, true]);
  assert.ok(f.release && f.releaseBytes);
  assert.equal(Reflect.get(f.release.ledger, "nativePredecessor"), undefined);
  const after = reopenLedger(f);
  assert.ok(after.ok);
  assert.deepEqual(after.ledger.workspace, { path: f.workspace, writerPid: null, qualified: false });
  assert.equal(after.ledger.boundWorkspaceIntents, undefined);
  assert.deepEqual(Reflect.get(after.ledger, "nativePredecessor"), exactPredecessor(f));
  assert.deepEqual(attempted, [after.ledger]);
  assert.deepEqual(f.bytes()[0], f.releaseBytes[0]);
  const saved = f.bytes();
  assert.deepEqual(await f.run("native.resume"), { state: "refused", ...noPublication });
  assert.equal(f.launches, 1);
  assert.deepEqual(f.bytes(), saved);

  claimWorkspace(dirname(f.ledger), process.pid, () => true);
  const retained = reopenLedger(f);
  assert.ok(retained.ok);
  assert.equal(retained.ledger.workspace?.writerPid, process.pid);
  assert.deepEqual(retained.ledger.nativePredecessor, after.ledger.nativePredecessor);
  assert.deepEqual(f.bytes()[0], saved[0]);
});

test("reopening after a failed predecessor replacement preserves the original claim and durable terminal", onWindows, async t => {
  const f = fixture(t, "complete", "exact");
  const attempted = traceReleaseWrites(t, f, true);
  await f.run();
  assert.deepEqual(f.releaseGroup, zero);
  assert.equal(attempted.length, 1);
  assert.equal(f.finished?.outcome, "completed");
  assert.ok(f.release && f.releaseBytes);
  assert.equal(f.release.rows[2]?.outcome, "completed");
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger, f.release.ledger);
  assert.equal(Reflect.get(reopened.ledger, "nativePredecessor"), undefined);
  assert.deepEqual(f.bytes(), f.releaseBytes);
  assert.deepEqual(await f.run("native.resume"), { state: "refused", ...noPublication });
  assert.equal(f.launches, 1);
  assert.deepEqual(f.bytes(), f.releaseBytes);
});

test("a completed turn begun before durable claim start cannot supply predecessor evidence", onWindows, async t => {
  const f = fixture(t, "prestarted turn");
  assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
  const turn = f.writes.find(({ value }) => Reflect.get(value as object, "method") === "turn/start");
  assert.ok(turn);
  assert.deepEqual(turn.snapshot.rows.map(row => row.kind), ["intent"]);
  assert.equal(turn.snapshot.ledger.workspace?.claimGeneration, undefined);
  assert.equal(f.finished?.outcome, "completed");
  assert.deepEqual(f.drained, zero);
  assert.ok(f.release && f.releaseBytes);
  assert.equal(f.release.rows[2]?.outcome, "completed");
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger, f.release.ledger);
  assert.equal(reopened.ledger.nativePredecessor, undefined);
  assert.deepEqual(f.bytes(), f.releaseBytes);
});

test("checkout turnover during predecessor handle resolution preserves the durable claim", onWindows, async t => {
  let changed = false;
  const f = fixture(t, "complete", () => {
    const handle = f.nativeHandle;
    assert.ok(handle);
    const original = assignmentDirectory(f.workspace);
    const parent = dirname(f.workspace);
    assert.equal(dirname(realpathSync(parent)), realpathSync(tmpdir()));
    assert.equal(realpathSync(f.workspace), f.workspace);
    const moved = join(parent, "original-workspace");
    assert.equal(existsSync(moved), false);
    fs.renameSync(f.workspace, moved);
    mkdirSync(f.workspace);
    assert.notEqual(assignmentDirectory(f.workspace).identity, original.identity);
    assert.equal(readFileSync(join(moved, "answer.txt"), "utf8"), answer);
    changed = true;
    return handle;
  });
  assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
  assert.equal(changed, true);
  assert.equal(f.finished?.outcome, "completed");
  assert.deepEqual(f.releaseGroup, zero);
  assert.ok(f.release && f.releaseBytes);
  assert.equal(f.release.rows[2]?.outcome, "completed");
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger, f.release.ledger);
  assert.equal(reopened.ledger.nativePredecessor, undefined);
  assert.deepEqual(f.bytes(), f.releaseBytes);
});

for (const evidence of ["missing", "absent reader", "unmarked", "unmarked observer wrapper"] as const) {
  test(`a fresh process sees the original hold when prepared predecessor evidence is ${evidence}`, onWindows, async t => {
    const f = fixture(t, "complete", evidence);
    await f.run();
    assert.equal(f.finished?.outcome, "completed");
    assert.deepEqual(f.drained, zero);
    assert.ok(f.activated);
    const before = f.bytes();
    const after = reopenLedger(f);
    assert.ok(after.ok);
    assert.deepEqual(after.ledger, f.activated.ledger);
    assert.equal(Reflect.get(after.ledger, "nativePredecessor"), undefined);
    assert.deepEqual(f.bytes(), before);
  });
}

test("substituting a foreign app-server predecessor handle keeps the original assignment held after restart", onWindows, async t => {
  const foreign = fixture(t, "other completion");
  assert.deepEqual(await foreign.run(), { state: "completed", ...noPublication });
  const foreignHandle = foreign.nativeHandle;
  assert.ok(foreignHandle);
  assert.deepEqual(terminalLineage(await foreignHandle.closed), {
    vendor: "codex", interfaceId: "app-server", threadId: "other-fixture-thread", turnId: "other-fixture-turn",
  });
  assert.deepEqual(foreign.groupIdentity, [true, true, true]);
  assert.deepEqual(foreign.releaseGroup, zero);

  const f = fixture(t, "complete", () => foreignHandle);
  await f.run();
  assert.ok(f.activated && foreign.activated && f.nativeHandle !== foreignHandle);
  assert.equal(f.activated.rows[0].id, foreign.activated.rows[0].id);
  assert.equal(f.activated.rows[0].requestDigest, foreign.activated.rows[0].requestDigest);
  assert.notEqual(f.activated.rows[0].aliasDigest, foreign.activated.rows[0].aliasDigest);
  assert.notEqual(f.activated.ledger.workspace?.claimGeneration, foreign.activated.ledger.workspace?.claimGeneration);
  assert.deepEqual(terminalLineage(f.finished), { vendor: "codex", interfaceId: "app-server", threadId: "fixture-thread", turnId: "fixture-turn" });
  assert.deepEqual(f.drained, zero);
  const saved = f.bytes();
  const after = reopenLedger(f);
  assert.ok(after.ok);
  assert.deepEqual(after.ledger, f.activated.ledger);
  assert.equal(Reflect.get(after.ledger, "nativePredecessor"), undefined);
  assert.deepEqual(f.bytes(), saved);
});

test("callback-fed app-server events cannot mint a predecessor for the original staged process", onWindows, async t => {
  const f = fixture(t, "foreign callbacks");
  assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
  assert.equal(f.finished?.turnId, "other-fixture-turn");
  assert.deepEqual(f.releaseGroup, zero);
  assert.deepEqual(f.groupIdentity, [true, true, true]);
  assert.ok(f.activated && f.releaseBytes);
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger, f.activated.ledger);
  assert.equal(reopened.ledger.nativePredecessor, undefined);
  assert.deepEqual(f.bytes(), f.releaseBytes);
});

test("the staged app-server uses its private input when the public child write is replaced", onWindows, async t => {
  const f = fixture(t, "public pipe rewrite");
  assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
  assert.equal(f.publicWrites, 0);
  assert.deepEqual(f.received(), dialogue(f.workspace, "complete"));
  assert.deepEqual(f.writes.map(write => write.value), f.received());
  assert.deepEqual(f.releaseGroup, zero);
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger.nativePredecessor, exactPredecessor(f));
});

test("a change to the general exit callback cannot hide the original app-server exit", onWindows, async t => {
  const f = fixture(t, "abnormal exit");
  assert.deepEqual(await f.run(), { state: "held", ...noPublication });
  assert.equal(f.settled?.outcome, "completed");
  assert.equal(f.finished?.outcome, "disconnected");
  assert.deepEqual(f.exit, { code: 17, signal: null, error: null });
  assert.deepEqual(f.drained, zero);
  assert.ok(f.activated);
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger, f.activated.ledger);
  assert.deepEqual(f.snapshot(), f.activated);
});

for (const scenario of ["missing turn reply", "rejected turn reply", "foreign turn reply", "matching late reply"] as const) {
  test(`an earlier native terminal needs a successful matching turn reply for a predecessor with ${scenario}`, onWindows, async t => {
    const f = fixture(t, scenario);
    assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
    assert.equal(f.finished?.outcome, "completed");
    assert.deepEqual(f.releaseGroup, zero);
    assert.ok(f.activated && f.releaseBytes);
    const reopened = reopenLedger(f);
    assert.ok(reopened.ok);
    if (scenario === "matching late reply") {
      assert.deepEqual(reopened.ledger.nativePredecessor, exactPredecessor(f));
      assert.equal(reopened.ledger.workspace?.writerPid, null);
    } else {
      assert.deepEqual(reopened.ledger, f.activated.ledger);
      assert.equal(reopened.ledger.nativePredecessor, undefined);
      assert.deepEqual(f.bytes(), f.releaseBytes);
    }
  });
}

test("a fresh process preserves the saved hold after the original observer disappears before release", onWindows, async t => {
  const f = fixture(t, "observer closed before release", "exact");
  await f.run();
  assert.equal(f.finished?.outcome, "completed");
  assert.deepEqual(f.drained, zero);
  assert.deepEqual(f.releaseGroup, { state: "unavailable" });
  assert.ok(f.activated && f.releaseBytes);
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger, f.activated.ledger);
  assert.equal(Reflect.get(reopened.ledger, "nativePredecessor"), undefined);
  assert.deepEqual(f.bytes(), f.releaseBytes);
});

test("an earlier verified zero cannot stand in for the closed original observer at predecessor release", onWindows, async t => {
  const f = fixture(t, "cached original zero");
  await f.run();
  assert.equal(f.finished?.outcome, "completed");
  assert.deepEqual(f.drained, zero);
  assert.deepEqual(f.releaseGroup, zero);
  assert.deepEqual(f.groupIdentity, [true, true]);
  assert.ok(f.activated && f.releaseBytes);
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.ledger, f.activated.ledger);
  assert.equal(reopened.ledger.nativePredecessor, undefined);
  assert.deepEqual(f.bytes(), f.releaseBytes);
});

for (const scenario of ["echoed identity", "embedded identity", "held identity"] as const) {
  test(`the native predecessor never saves the ${scenario} from a completed native turn`, onWindows, async t => {
    const f = fixture(t, scenario);
    await f.run();
    assert.equal(f.finished?.outcome, "completed");
    assert.equal(f.finished?.threadId, privateIdentity);
    assert.deepEqual(f.releaseGroup, zero);
    assert.ok(f.activated && f.releaseBytes);
    const reopened = reopenLedger(f);
    assert.ok(reopened.ok);
    assert.equal(reopened.ledger.nativePredecessor, undefined);
    assert.deepEqual(reopened.ledger, f.activated.ledger);
    assert.deepEqual(f.bytes(), f.releaseBytes);
    for (const saved of f.bytes()) assert.equal(saved.includes(privateIdentity), false);
  });
}

test("a fresh process can read a legacy saved workspace without inventing a predecessor", onWindows, t => {
  const f = fixture(t, "complete");
  const reopened = reopenLedger(f);
  assert.ok(reopened.ok);
  assert.equal(Reflect.get(reopened.ledger, "nativePredecessor"), undefined);
  assert.equal(reopened.ledger.workspace?.writerPid, process.pid);
  assert.deepEqual(readFileSync(f.ledger), f.before);
  assert.equal(f.launches, 0);
});

test("malformed or foreign saved predecessors never clear a retained claim on restart and replay", onWindows, async t => {
  const f = fixture(t, "observer closed before release");
  await f.run();
  assert.ok(f.releaseBytes && f.activated);
  assert.deepEqual(f.releaseGroup, { state: "unavailable" });
  assert.deepEqual(f.bytes(), f.releaseBytes);
  const exact = exactPredecessor(f);
  for (const [name, record] of [
    ["malformed original Job sample", { ...exact, originalJob: { state: "verified", activeProcesses: 1 } }],
    ["different durable request and claim", { ...exact, requestDigest: "a".repeat(64), claimGeneration: "e88cb191-c360-4aa5-8c8e-b63722617e84" }],
  ] as const) {
    await t.test(name, async () => {
      writeFileSync(f.ledger, JSON.stringify({ ...f.activated!.ledger, nativePredecessor: record }) + "\n");
      const before = f.bytes();
      const reopened = reopenLedger(f);
      if (reopened.ok) {
        assert.deepEqual(reopened.ledger.workspace, f.activated!.ledger.workspace);
        assert.deepEqual(reopened.ledger.boundWorkspaceIntents, f.activated!.ledger.boundWorkspaceIntents);
        assert.equal(Reflect.get(reopened.ledger, "nativePredecessor"), undefined);
      }
      await f.run();
      assert.deepEqual(await f.run("native.resume"), { state: "refused", ...noPublication });
      assert.equal(f.launches, 1);
      assert.deepEqual(f.bytes(), before);
    });
  }
});

test("a fresh process refuses a released predecessor after its durable journal terminal disappears or changes", onWindows, async t => {
  const f = fixture(t, "complete");
  assert.deepEqual(await f.run(), { state: "completed", ...noPublication });
  const released = reopenLedger(f);
  assert.ok(released.ok);
  assert.deepEqual(released.ledger.nativePredecessor, exactPredecessor(f));
  assert.equal(released.ledger.workspace?.writerPid, null);
  assert.equal(released.ledger.boundWorkspaceIntents, undefined);
  const journal = join(dirname(f.ledger), "assignment-intents.jsonl");
  const backup = join(dirname(f.ledger), "original-journal");
  const [oldJournal, oldLedger] = f.bytes();
  fs.renameSync(journal, backup);
  try {
    assert.deepEqual(reopenLedger(f), { ok: false, reason: "unreadable" });
    assert.equal(existsSync(journal), false);
    assert.deepEqual(readFileSync(backup), oldJournal);
    assert.deepEqual(readFileSync(f.ledger), oldLedger);
  } finally {
    fs.renameSync(backup, journal);
  }
  const [intent, started, terminal] = f.snapshot().rows;
  const changed = [intent, started, { ...terminal, at: terminal.at + 1 }].map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(journal, changed);
  assert.deepEqual(reopenLedger(f), { ok: false, reason: "unreadable" });
  assert.deepEqual(f.bytes(), [Buffer.from(changed), oldLedger]);
  assert.equal(f.launches, 1);
});

test("an acknowledged app-server interruption leaves the exact workspace claim held through a late writer", onWindows, async t => {
  const f = fixture(t, "interrupt");
  const run = f.run();
  await until(() => f.afterInterruptedClose !== undefined, "The interrupted app-server did not close with its original Job still observable.");

  const expected = dialogue(f.workspace, "interrupt");
  assert.deepEqual(f.received(), expected);
  assert.deepEqual(f.writes.map(write => write.value), expected);
  assert.ok(f.verified && f.activated);
  assert.equal(f.launches, 1);
  assert.equal(f.attach, 1);
  assert.deepEqual(f.beforeActivation, []);
  for (const write of f.writes) assert.deepEqual(write.snapshot, f.activated);
  for (const observation of [f.settled, f.finished]) {
    assert.ok(observation);
    assert.equal(observation.outcome, "interrupted");
    assert.equal(observation.interruptRequest, "acknowledged");
    assert.equal(observation.threadId, "fixture-thread");
    assert.equal(observation.turnId, "fixture-turn");
    assert.equal(observation.writerState, "unknown");
    assert.equal(observation.resultText, null);
    assert.equal(terminalLineage(observation), null);
  }
  assert.deepEqual(f.live, { state: "verified", activeProcesses: 2 });
  assert.deepEqual(f.exit, { code: 0, signal: null, error: null });
  assert.deepEqual(f.afterInterruptedClose, { state: "verified", activeProcesses: 1 });
  assert.equal(existsSync(f.lateMarker), false);
  assert.equal(f.release, undefined);
  assert.equal(f.activated.rows.length, 2);
  assert.equal(f.activated.ledger.workspace?.writerPid, process.pid);
  assert.ok(f.activated.ledger.workspace?.claimGeneration);
  assert.deepEqual(f.activated.ledger.boundWorkspaceIntents, [f.activated.rows[0].id]);
  assert.deepEqual(f.snapshot(), f.activated);
  const held = f.bytes();

  f.allowLateWrite();
  assert.deepEqual(await bounded(run), { state: "held", ...noPublication });
  assert.equal(readFileSync(f.lateMarker, "utf8"), "fabricated late write");
  assert.deepEqual(f.drained, zero);
  assert.ok(f.groupIdentity.length >= 3 && f.groupIdentity.every(Boolean));
  assert.equal(f.release, undefined);
  assert.deepEqual(f.bytes(), held);

  assert.deepEqual(await f.run(), { state: "held", ...noPublication });
  assert.deepEqual(f.bytes(), held);
  assert.deepEqual(f.received(), expected);
  assert.deepEqual(f.writes.map(write => write.value), expected);
  assert.equal(f.launches, 1);
  assert.equal(f.attach, 1);
  assert.equal(f.closes, 1);
  assert.equal(f.legacy, 0);
});

test("a refused native activation closes the suspended app-server without any handshake or turn", onWindows, async t => {
  const f = fixture(t, "refused activation");
  assert.deepEqual(await f.run(), { state: "held", ...noPublication });
  assert.equal(f.verified, true);
  assert.equal(f.launches, 1);
  assert.equal(f.closes, 1);
  assert.equal(f.attach, 1);
  assert.equal(f.legacy, 0);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.received(), []);
  assert.equal(f.activated, undefined);
  assert.equal(f.settled?.outcome, "disconnected");
  assert.deepEqual(f.exit, { code: null, signal: null, error: "spawn" });
  assert.deepEqual(f.drained, { state: "unavailable" });
  assert.equal(f.release, undefined);
  assert.ok(f.activationAttempt, "observe the exact journal and ledger at the activation refusal");
  assert.deepEqual(f.bytes(), f.activationAttempt);
  const after = f.snapshot();
  const [intent, started, ...extra] = after.rows;
  assert.equal(intent.kind, "intent");
  assert.deepEqual(started, { kind: "started", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000 });
  assert.deepEqual(extra, []);
  assert.equal(after.ledger.workspace?.writerPid, process.pid);
  assert.ok(after.ledger.workspace?.claimGeneration);
  assert.deepEqual(after.ledger.boundWorkspaceIntents, [intent.id]);
});

test("refused app-server preparation starts no native process or turn", onWindows, async t => {
  const f = fixture(t, "refused preparation");
  assert.deepEqual(await f.run(), { state: "not-started", ...noPublication });
  assert.deepEqual(f.received(), []);
  assert.deepEqual(f.writes, []);
  assert.equal(f.launches, 0);
  assert.equal(f.attach, 0);
  assert.equal(f.legacy, 0);
  assert.equal(f.closes, 0);
  assert.equal(f.release, undefined);
  assert.deepEqual(readFileSync(f.ledger), f.before);
  const [intent, terminal, ...extra] = f.snapshot().rows;
  assert.equal(intent.kind, "intent");
  assert.deepEqual(terminal, { kind: "result", id: intent.id, sequence: 1, requestDigest: intent.requestDigest, at: 1000, outcome: "not-started" });
  assert.deepEqual(extra, []);
});
