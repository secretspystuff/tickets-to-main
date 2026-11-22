import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCodexCliAssignment } from "../src/adapters/codex.ts";
import { runAssignment, type AssignmentRequest } from "../src/assignment-boundary.ts";
import type { Intent } from "../src/assignment-journal.ts";
import { readRecoverySelection, readRecoverySnapshot } from "../src/board-feed-recovery.ts";
import { ensurePrivateDirectory } from "../src/fs-safety.ts";
import { install } from "../src/install.ts";
import { loadLedger, updateLedger, type BoardFeedCursorRecord, type Ledger } from "../src/ledger.ts";
import { attachOwnedNativeProcess, windowsOwnedNativeTransport, windowsProcessLauncher, type NativeExit,
  type NativeTransport, type OriginalGroup } from "../src/native-transport.ts";
import { observeStateLease, observeStateLeaseEpoch } from "../src/state-lease.ts";
import { claimWorkspace, prepareWorkspace, processAlive } from "../src/workspace.ts";

const id = (value: number) => value.toString(16).padStart(32, "0");
const prompt = "Read the fabricated answer file.";
const answer = "fabricated local CLI answer";
const at = 1000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The ordinary CLI fixture stalled.")), 10_000);
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); }
}

test("a successful Windows owned CLI releases its durable claim and preserves a recovered board cursor", { skip: process.platform !== "win32" }, async t => {
  assert.equal(process.version, "v24.18.0");
  const parent = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(parent, "ttm-cli-cursor-")));
  assert.equal(dirname(root), parent);
  const stateDir = join(root, "state");
  const workspace = join(root, "workspace");
  const temp = join(root, "tmp");
  const exitGate = join(root, "allow-exit");
  const receipt = join(root, "received.bin");
  const eof = join(root, "reached-eof");
  const allowExit = () => { if (!existsSync(exitGate)) writeFileSync(exitGate, "1", { flag: "wx" }); };
  t.after(() => {
    assert.equal(realpathSync(root), root);
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  });
  ensurePrivateDirectory(root);
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, workspace, processAlive);
  claimWorkspace(stateDir, process.pid, processAlive);
  mkdirSync(temp);
  writeFileSync(join(workspace, "answer.txt"), answer, { flag: "wx" });

  const fixture = (name: string) => readFileSync(new URL(`../../src/lib/ttm-protocol/feed-recovery/${name}.json`, import.meta.url), "utf8");
  const selection = readRecoverySelection(fixture("request"));
  assert.ok(selection);
  const recoverySnapshot = readRecoverySnapshot(fixture("response"), "fabricated-board", selection);
  assert.ok(recoverySnapshot);
  const cursor: BoardFeedCursorRecord = { board: recoverySnapshot.board, binding: "fabricated-binding",
    handled: recoverySnapshot.next, recoveryEpoch: id(11), recoverySnapshot };
  updateLedger(stateDir, [], ledger => { ledger.boardFeedCursors = [cursor]; });

  function ledgerFromDisk(): Ledger {
    const read = loadLedger(stateDir);
    assert.equal(read.ok, true);
    return read.ledger;
  }
  const before = ledgerFromDisk();
  assert.ok(before.install);
  assert.equal(before.install.release, undefined);
  assert.deepEqual(before.boardFeedCursors, [cursor]);
  assert.deepEqual(before.workspace, { path: workspace, writerPid: process.pid, qualified: false });
  const initialLease = observeStateLease(stateDir, "ledger");
  assert.equal(initialLease.state, "released");

  const journal = join(stateDir, "assignment-intents.jsonl");
  assert.equal(existsSync(journal), false);
  const journalRows = () => readFileSync(journal, "utf8").trimEnd().split("\n").map((line): unknown => JSON.parse(line));
  const snapshot = () => ({ ledger: ledgerFromDisk(), rows: journalRows(), lease: observeStateLease(stateDir, "ledger").state });
  const request: AssignmentRequest = {
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input: prompt,
    binding: { board: id(2), repo: id(3), activation: id(4), connection: id(5), job: id(6),
      claim: id(7), requirements: id(8), candidate: id(9), policy: id(10), fence: 1 },
  };
  const executable = realpathSync(process.execPath);
  const peer = fileURLToPath(new URL("./owned-cli-recovered-cursor.fixture.mjs", import.meta.url));
  assert.ok(process.env.SystemRoot);
  const env = { SystemRoot: process.env.SystemRoot, TEMP: temp, TMP: temp };
  const zero: OriginalGroup = { state: "verified", activeProcesses: 0 };
  const verified = deferred<void>();
  const permitActivation = deferred<void>();
  const terminalOutput = deferred<void>();
  const closed = deferred<NativeExit>();
  const milestones: string[] = [];
  let intent: Intent | undefined;
  let beforeActivation: ReturnType<typeof snapshot> | undefined;
  let beforeRelease: ReturnType<typeof snapshot> | undefined;
  let releaseSample: OriginalGroup | undefined;
  let positiveSample: OriginalGroup | undefined;
  let originalMembership = false;
  let startCount = 0;
  let attachCount = 0;
  let closeCount = 0;
  let stdout = "";
  const launcher = windowsProcessLauncher();

  const result = await runAssignment({
    stateDir, raw: JSON.stringify(request), secrets: [], now: () => at,
    adapter: {
      kind: "fabricated-harness",
      async readCurrent() { return { binding: request.binding, nextSequence: 1, authorized: true, seat: "member",
        confirmedWorkspace: workspace, writersContained: true }; },
      async execute() { throw new Error("The assignment must use the staged CLI."); },
      async reconcile() { throw new Error("The initial assignment cannot reconcile."); },
    },
    owned: { async prepare(input) {
      assert.equal(input.workspace, workspace);
      intent = input.intent;
      const child = windowsOwnedNativeTransport({ async start(...args) {
        startCount++;
        const launch = await launcher.start(...args);
        if (!launch) return null;
        return { ...launch,
          async verify() {
            const membership = await launch.verify();
            originalMembership = membership?.job === launch.originalJob && membership.child === launch.exactChild;
            milestones.push("verified");
            verified.resolve();
            return membership;
          },
          async activate() {
            await permitActivation.promise;
            return launch.activate();
          },
          pipe: {
            write(text) { milestones.push("input"); return launch.pipe.write(text); },
            endInput() { milestones.push("eof"); launch.pipe.endInput(); },
          },
        };
      } }).start([executable, peer, workspace], { cwd: workspace, env }, {
        spawned() {
          milestones.push("active");
          if (attachCount === 0) child.endInput();
        },
        stdout(chunk) {
          stdout += chunk;
          if (stdout.includes('{"type":"turn.completed"}\n')) terminalOutput.resolve();
        },
        stderr() {}, inputError() {},
        closed(status) { milestones.push("closed"); closed.resolve(status); },
      });

      const close = async () => {
        allowExit();
        permitActivation.resolve();
        await bounded(closed.promise);
        child.closeObservation();
        closeCount++;
      };
      try {
        await bounded(Promise.race([verified.promise, closed.promise.then(() => { throw new Error("Launch closed before verification."); })]));
      } catch (error) {
        await close();
        throw error;
      }
      return {
        original: { async observeOriginalGroup() {
          releaseSample = await child.observeOriginalGroup();
          beforeRelease = snapshot();
          milestones.push("release observation");
          return releaseSample;
        } },
        async execute(assignment) {
          assert.deepEqual(assignment, { id: request.id, sequence: request.sequence, input: prompt, workspace });
          beforeActivation = snapshot();
          assert.equal(existsSync(receipt) || existsSync(eof), false);
          const bridge: NativeTransport = { start(argv, options, events) {
            assert.deepEqual(argv, [executable, "exec", "--json", "-"]);
            const pipe = attachOwnedNativeProcess(child, executable, options, events);
            attachCount++;
            return pipe;
          } };
          const cli = runCodexCliAssignment({ assignmentId: assignment.id, prompt: assignment.input, workspace: assignment.workspace,
            model: null, effort: null }, bridge, env, [], executable);
          permitActivation.resolve();
          try {
            assert.equal(await bounded(Promise.race([terminalOutput.promise.then(() => "terminal"), cli.then(() => "closed")])), "terminal");
            positiveSample = await child.observeOriginalGroup();
            milestones.push("live observation");
          } finally {
            allowExit();
          }
          const observed = await bounded(cli);
          assert.equal(observed.outcome, "completed");
          assert.equal(observed.resultText, answer);
          assert.equal(observed.threadId, "fixture-cli-thread");
          assert.equal(observed.observed.assignment, "supported");
          assert.equal(observed.observed.streamResult, "supported");
          assert.equal(observed.writerState, "unknown");
          assert.deepEqual(positiveSample, { state: "verified", activeProcesses: 1 });
          return { id: assignment.id, sequence: assignment.sequence, result: "completed", writersContained: true };
        }, close,
      };
    } },
  });

  assert.deepEqual(result, { state: "completed", qualification: "unqualified-harness", publishable: false });
  assert.equal(originalMembership, true);
  assert.deepEqual([startCount, attachCount, closeCount], [1, 1, 1]);
  assert.deepEqual(milestones, ["verified", "active", "input", "eof", "live observation", "closed", "release observation"]);
  assert.deepEqual(await closed.promise, { code: 0, signal: null, error: null });
  assert.deepEqual(readFileSync(receipt), Buffer.from(prompt));
  assert.equal(readFileSync(eof, "utf8"), "fixture EOF");
  assert.ok(intent && beforeActivation && beforeRelease);
  const started = { kind: "started", id: request.id, sequence: request.sequence, requestDigest: intent.requestDigest, at };
  const settled = { ...started, kind: "result", outcome: "completed" };
  const generation = beforeActivation.ledger.workspace?.claimGeneration;
  assert.ok(generation);
  assert.deepEqual(beforeActivation, { rows: [intent, started], lease: "released", ledger: {
    ...before, workspace: { path: workspace, writerPid: process.pid, qualified: false, claimGeneration: generation },
    boundWorkspaceIntents: [request.id],
  } });
  assert.deepEqual(releaseSample, zero);
  assert.deepEqual(beforeRelease, { ...beforeActivation, rows: [intent, started, settled] });
  assert.deepEqual(snapshot(), { rows: [intent, started, settled], lease: "released",
    ledger: { ...before, workspace: { path: workspace, writerPid: null, qualified: false } } });

  const finalLease = observeStateLease(stateDir, "ledger");
  assert.equal(finalLease.epoch - initialLease.epoch, 5n);
  for (let epoch = initialLease.epoch + 1n; epoch <= finalLease.epoch; epoch++) {
    assert.equal(observeStateLeaseEpoch(stateDir, "ledger", epoch).state, "released");
  }
  assert.equal(observeStateLease(stateDir, "release").state, "none");
  t.diagnostic("Original Windows Job verified before activation, one active process after exact stdin and EOF, zero before durable release.");
  t.diagnostic("One intent, start and settlement. The recovered graph and install record matched the baseline; all five assignment leases released.");
});
