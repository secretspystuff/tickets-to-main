import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { CODEX_APP_SERVER_SCHEMA_VERSION, startCodexAppServerAssignment } from "../src/adapters/codex-app-server.ts";
import type { NativeObservation } from "../src/adapters/native-result.ts";
import { runAssignment, type AssignmentRequest } from "../src/assignment-boundary.ts";
import { ensurePrivateDirectory } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { parseLedger } from "../src/ledger.ts";
import { processNativeTransport, windowsOwnedNativeTransport, windowsProcessLauncher, type NativeEvents, type NativeExit, type NativeTransport,
  type OriginalGroup } from "../src/native-transport.ts";
import { claimWorkspace, prepareWorkspace } from "../src/workspace.ts";
import { removeDir } from "./helpers.ts";

type PeerMode = "complete" | "wrong workspace" | "invalid initialize" | "wrong turn" | "wrong thread" | "interrupt";
type Scenario = PeerMode | "refused preparation" | "refused activation" | "observer closed before release";
const executable = realpathSync(process.execPath);
const peer = fileURLToPath(new URL("./owned-app-server-peer.fixture.mjs", import.meta.url));
const onWindows = { skip: process.platform !== "win32", timeout: 24_000 };
const noPublication = { qualification: "unqualified-harness", publishable: false };
const id = (value: number) => value.toString(16).padStart(32, "0");
const prompt = "Read the fabricated answer file.";
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

function fixture(t: TestContext, scenario: Scenario) {
  assert.equal(process.version, "v24.18.0");
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-owned-app-server-")));
  assert.equal(dirname(root), parent);
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
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input: prompt,
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
  let settled: NativeObservation | undefined, connected: NativeObservation | undefined, finished: NativeObservation | undefined;
  let prepared: ReturnType<typeof snapshot> | undefined, activated: ReturnType<typeof snapshot> | undefined;
  let release: ReturnType<typeof snapshot> | undefined, drained: OriginalGroup | undefined, live: OriginalGroup | undefined;
  let afterInterruptedClose: OriginalGroup | undefined;
  let releaseBytes: ReturnType<typeof bytes> | undefined, releaseGroup: OriginalGroup | undefined;
  let exit: NativeExit | undefined;
  let activationAttempt: ReturnType<typeof bytes> | undefined;
  const run = () => runAssignment({
    stateDir, raw: JSON.stringify(request), secrets: [], now: () => 1000,
    adapter: {
      kind: "fabricated-harness",
      async readCurrent() { return { binding: request.binding, nextSequence: 1, authorized: true,
        seat: "member", confirmedWorkspace: workspace, writersContained: true }; },
      async execute() { legacy++; throw new Error("Unexpected legacy execution."); },
      async reconcile() { throw new Error("Unexpected reconciliation."); },
    },
    owned: { async prepare(input) {
      if (scenario === "refused preparation") return null;
      assert.equal(input.workspace, workspace);
      const launcher = windowsProcessLauncher();
      const peerMode = scenario === "refused activation" || scenario === "observer closed before release" ? "complete" : scenario;
      const suspended = deferred<void>(), permit = deferred<boolean>(), closed = deferred<NativeExit>();
      let listener: NativeEvents | undefined;
      const child = windowsOwnedNativeTransport({
        async start(...args) {
          launches++;
          const launch = await launcher.start(...args);
          if (!launch) return null;
          return { ...launch, async activate() {
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
        spawned() { activated = snapshot(); listener?.spawned(); },
        stdout(chunk) { listener?.stdout(chunk); }, stderr(chunk) { listener?.stderr(chunk); },
        inputError() { listener?.inputError(); },
        closed(status) { exit = status; closed.resolve(status); listener?.closed(status); },
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
      const bridge: NativeTransport = { start(argv, options, events) {
        attach++;
        assert.equal(attach, 1);
        assert.deepEqual(argv, [executable, "app-server"]);
        assert.equal(options.cwd, workspace);
        assert.deepEqual({ ...options.env }, env);
        listener = events;
        return { write(text) {
          const value = JSON.parse(text);
          if (!activated) beforeActivation.push(value.method);
          writes.push({ value, snapshot: snapshot() });
          return child.write(text);
        }, endInput: () => child.endInput() };
      } };
      return {
        original: { async observeOriginalGroup() {
          release = snapshot();
          releaseBytes = bytes();
          releaseGroup = await child.observeOriginalGroup();
          return releaseGroup;
        } },
        async execute(assignment) {
          const handle = startCodexAppServerAssignment({ assignmentId: assignment.id, prompt: assignment.input,
            workspace: assignment.workspace, model: "fixture-model", effort: "low" }, bridge, env, [],
          { executable, version: CODEX_APP_SERVER_SCHEMA_VERSION });
          connected = handle.snapshot();
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
          if (finished.outcome !== "completed" || settled.outcome !== "completed" || settled.resultText !== answer || settled.threadId !== "fixture-thread"
            || settled.turnId !== "fixture-turn" || afterClose.state !== "verified" || afterClose.activeProcesses !== 0) {
            throw new Error("The original Job or app-server did not provide exact terminal evidence.");
          }
          if (scenario === "observer closed before release") child.closeObservation();
          return { id: assignment.id, sequence: assignment.sequence, result: "completed", writersContained: true };
        },
        close,
      };
    } },
  });
  return { run, workspace, answerFile, env, snapshot, bytes, received, before, ledger, writes, beforeActivation, groupIdentity,
    lateMarker, allowLateWrite: () => writeFileSync(allowWrite, "write", { flag: "wx" }),
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
