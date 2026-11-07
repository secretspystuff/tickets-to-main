import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { runCheckAttempt } from "../src/check-attempt.ts";
import { processRunner } from "../src/command.ts";
import { install } from "../src/install.ts";
import { loadLedger, saveLedger } from "../src/ledger.ts";

type Bind = { candidate_id: string; requirements_id: string; base_id: string; policy_id: string };
type Check = { id: string; argv: string[]; memberIds: string[]; dependsOn: string[] };
type Snapshot = {
  authorized: boolean;
  claimId: string;
  binding: Bind;
  candidateCommit: string;
  baseCommit: string;
  evidenceRevision: string;
  buildReview: { id: string; result: "passed" | "failed"; candidateCommit: string; binding: Bind } | null;
  profile: { id: string; revision: string; mode: "scripted" | "none"; sourceId: string; checks: Check[] };
  memberIds: string[];
  requiredHostChecks: string[];
};
type Terminal = {
  attemptId: string;
  checkId: string;
  sourceId: string;
  candidateCommit: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error: "spawn" | null;
  writerCustody: "contained" | "unknown";
};
type Observation = { stdout: string; stderr: string; terminal: Terminal | null; coveredMemberIds: string[] };
type ExecuteInput = { attemptId: string; checkId: string; argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; candidateCommit: string };

const root = fileURLToPath(new URL("../..", import.meta.url));
const id = (suffix: string) => "fab" + suffix.padStart(29, "0");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  assert.equal(result.status, 0, `fabricated Git command failed: ${args[0]}`);
  return result.stdout.trim();
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(root, ".check-attempt-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, "workspace");
  const stateDir = join(directory, "private-state");
  mkdirSync(workspace);
  git(workspace, "init", "--quiet", "--initial-branch=fixture-work");
  for (const key of ["user.name", "user.email"]) git(workspace, "config", key, git(root, "config", key));
  writeFileSync(join(workspace, "behavior.txt"), "before\n");
  git(workspace, "add", "behavior.txt");
  git(workspace, "commit", "--quiet", "-m", "Fabricated base");
  const baseCommit = git(workspace, "rev-parse", "HEAD");
  writeFileSync(join(workspace, "behavior.txt"), "after\n");
  git(workspace, "add", "behavior.txt");
  git(workspace, "commit", "--quiet", "-m", "Fabricated candidate");
  const candidateCommit = git(workspace, "rev-parse", "HEAD");
  install({ stateDir, platform: "linux", arch: "x64", nowIso: "2026-11-07T00:00:00Z" });
  const loaded = loadLedger(stateDir);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) throw new Error("Fixture ledger is missing");
  loaded.ledger.connection = {
    phase: "approved", fixture: true, protocolRevision: "waiting-on-t1", origin: "https://fixture.invalid",
    computer: "Fixture computer", userCode: "fabricated", verificationUriComplete: "https://fixture.invalid/consent",
    boardName: "Fabricated board", agentName: "Fixture Dispatcher", lastPollAt: null, fixturePollIndex: 1,
  };
  loaded.ledger.workspace = { path: workspace, writerPid: null, qualified: false };
  saveLedger(stateDir, loaded.ledger, []);
  const originalLedger = structuredClone(loaded.ledger);
  const binding = { candidate_id: id("1"), requirements_id: id("2"), base_id: id("3"), policy_id: id("4") };
  let current: Snapshot = {
    authorized: true, claimId: id("5"), binding, candidateCommit, baseCommit, evidenceRevision: id("6"),
    buildReview: { id: id("7"), result: "passed", candidateCommit, binding: { ...binding } },
    profile: {
      id: id("8"), revision: id("9"), mode: "scripted", sourceId: "fabricated-executor",
      checks: [{ id: "behavior", argv: ["fabricated-check", "behavior"], memberIds: [id("10")], dependsOn: [] }],
    },
    memberIds: [id("10")], requiredHostChecks: [],
  };
  let reads = 0;
  const calls: ExecuteInput[] = [];
  const env: NodeJS.ProcessEnv = {};
  const request = { jobId: id("11"), attemptId: id("12"), snapshot: structuredClone(current) };
  const good = (input: ExecuteInput): Observation => ({
    stdout: "behavior verified", stderr: "", coveredMemberIds: [...current.memberIds],
    terminal: {
      attemptId: input.attemptId, checkId: input.checkId, sourceId: current.profile.sourceId,
      candidateCommit: input.candidateCommit, code: 0, signal: null, error: null, writerCustody: "contained",
    },
  });
  let execute = async (input: ExecuteInput): Promise<Observation> => good(input);
  let observe = (): Snapshot => structuredClone(current);
  const run = () => runCheckAttempt({
    stateDir, workspace, request, env, gitRunner: processRunner(), now: () => 1794009600000, secrets: ["fixture-held-secret"],
    readCurrent: async () => { reads++; return observe(); },
    executor: { kind: "fabricated-harness" as const, execute: async (input: ExecuteInput) => { calls.push(input); return execute(input); } },
  });
  return {
    workspace, stateDir, request, originalLedger, calls, env, good, run,
    get current() { return current; }, set current(value: Snapshot) { current = value; },
    get reads() { return reads; },
    set execute(value: (input: ExecuteInput) => Promise<Observation>) { execute = value; },
    set observe(value: () => Snapshot) { observe = value; },
    saved() {
      const result = loadLedger(stateDir);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("Attempt ledger is missing");
      return result.ledger as typeof result.ledger & { checkAttempts: Array<{ attemptId: string; state: string; checks: Array<{ state: string }> }> };
    },
  };
}

test("a scripted attempt persists intent before execution and binds terminal evidence to the actual Git candidate", async (t) => {
  const f = fixture(t);
  f.execute = async (input) => {
    const pending = f.saved().checkAttempts.find((entry) => entry.attemptId === f.request.attemptId);
    assert.equal(pending?.state, "running");
    assert.deepEqual(input.argv, f.current.profile.checks[0]!.argv);
    assert.equal(input.cwd, f.workspace);
    assert.equal(input.candidateCommit, git(f.workspace, "rev-parse", "HEAD"));
    assert.equal(Object.values(input.env).some((value) => value?.includes("fixture-held-secret")), false);
    return f.good(input);
  };
  const result = await f.run();
  assert.equal(result.state, "passed");
  assert.equal(result.publicResult, "passed");
  assert.equal(result.qualification, "unqualified-harness");
  assert.equal(result.publishable, false);
  assert.equal(f.calls.length, 1);
  assert.ok(f.reads >= 3, "fresh snapshots are required before admission, launch and final result");
  const saved = f.saved();
  assert.equal(saved.checkAttempts.at(-1)?.state, "passed");
  assert.deepEqual(saved.install, f.originalLedger.install);
  assert.deepEqual(saved.connection, f.originalLedger.connection);
  assert.deepEqual(saved.workspace, f.originalLedger.workspace);
  assert.deepEqual(saved.tools, f.originalLedger.tools);
});

for (const [label, change] of [
  ["requirements", (s: Snapshot) => { s.binding.requirements_id = id("20"); }],
  ["base", (s: Snapshot) => { s.baseCommit = "0".repeat(40); }],
  ["candidate", (s: Snapshot) => { s.candidateCommit = s.baseCommit; }],
  ["policy", (s: Snapshot) => { s.binding.policy_id = id("21"); }],
  ["claim", (s: Snapshot) => { s.claimId = id("22"); }],
  ["Build review", (s: Snapshot) => { s.buildReview!.id = id("23"); }],
  ["evidence revision", (s: Snapshot) => { s.evidenceRevision = id("24"); }],
  ["selected checks", (s: Snapshot) => { s.profile.checks[0]!.argv.push("--different"); }],
  ["member coverage", (s: Snapshot) => { s.memberIds.push(id("25")); }],
] as const) {
  for (const boundary of ["admission", "launch", "result"] as const) {
    test(`${label} changes at ${boundary} cannot authorize this captured attempt`, async (t) => {
      const f = fixture(t);
      let observed = 0;
      f.observe = () => {
        observed++;
        const snapshot = structuredClone(f.current);
        if (observed >= ({ admission: 1, launch: 2, result: 3 }[boundary])) change(snapshot);
        return snapshot;
      };
      const result = await f.run();
      assert.equal(result.state, "stale");
      assert.equal(result.publicResult, "unavailable");
      assert.equal(result.publishable, false);
      assert.equal(f.calls.length, boundary === "result" ? 1 : 0);
    });
  }
}

test("revoked authority prevents launch without converting an old passing snapshot into authority", async (t) => {
  const f = fixture(t);
  f.current.authorized = false;
  const result = await f.run();
  assert.equal(result.state, "held");
  assert.equal(result.publicResult, "unavailable");
  assert.equal(f.calls.length, 0);
});

for (const [label, change] of [
  ["missing", (s: Snapshot) => { s.buildReview = null; }],
  ["failed", (s: Snapshot) => { s.buildReview!.result = "failed"; }],
  ["another Git commit", (s: Snapshot) => { s.buildReview!.candidateCommit = s.baseCommit; }],
  ["another candidate binding", (s: Snapshot) => { s.buildReview!.binding.candidate_id = id("50"); }],
  ["another base binding", (s: Snapshot) => { s.buildReview!.binding.base_id = id("51"); }],
  ["another requirements revision", (s: Snapshot) => { s.buildReview!.binding.requirements_id = id("52"); }],
  ["another policy", (s: Snapshot) => { s.buildReview!.binding.policy_id = id("53"); }],
] as const) {
  test(`${label} starting Build review is invalid even when captured and current snapshots agree`, async (t) => {
    const f = fixture(t);
    change(f.current);
    f.request.snapshot = structuredClone(f.current);
    const result = await f.run();
    assert.equal(result.state, "held");
    assert.equal(result.publicResult, "unavailable");
    assert.equal(f.calls.length, 0);
  });
}

for (const mutation of ["working file", "index", "commit", "untracked file"] as const) {
  for (const when of ["before", "during"] as const) {
    test(`${mutation} changed ${when} execution invalidates the checked candidate and preserves the write`, async (t) => {
      const f = fixture(t);
      const mutate = () => {
        const path = join(f.workspace, mutation === "untracked file" ? "late-write.txt" : "behavior.txt");
        writeFileSync(path, "late writer data\n");
        if (mutation === "index" || mutation === "commit") git(f.workspace, "add", "behavior.txt");
        if (mutation === "commit") git(f.workspace, "commit", "--quiet", "-m", "Fabricated late writer");
      };
      if (when === "before") mutate();
      else f.execute = async (input) => { mutate(); return f.good(input); };
      const result = await f.run();
      assert.equal(result.state, "stale");
      assert.equal(result.publicResult, "unavailable");
      assert.equal(f.calls.length, when === "before" ? 0 : 1);
      assert.equal(readFileSync(join(f.workspace, mutation === "untracked file" ? "late-write.txt" : "behavior.txt"), "utf8"), "late writer data\n");
    });
  }
}

for (const [label, change, state] of [
  ["green prose with exit failure", (o: Observation) => { o.stdout = "All tests passed"; o.terminal!.code = 1; }, "failed"],
  ["no terminal", (o: Observation) => { o.terminal = null; }, "interrupted"],
  ["signalled process", (o: Observation) => { o.terminal!.code = null; o.terminal!.signal = "SIGTERM"; }, "interrupted"],
  ["spawn failure", (o: Observation) => { o.terminal!.code = null; o.terminal!.error = "spawn"; }, "unavailable"],
  ["unknown descendants", (o: Observation) => { o.terminal!.writerCustody = "unknown"; }, "held"],
  ["wrong executor source", (o: Observation) => { o.terminal!.sourceId = "another-executor"; }, "unavailable"],
  ["wrong attempt", (o: Observation) => { o.terminal!.attemptId = id("30"); }, "unavailable"],
  ["wrong check", (o: Observation) => { o.terminal!.checkId = "other-check"; }, "unavailable"],
  ["wrong candidate", (o: Observation) => { o.terminal!.candidateCommit = "0".repeat(40); }, "unavailable"],
  ["missing member coverage", (o: Observation) => { o.coveredMemberIds = []; }, "held"],
] as const) {
  test(`${label} is not successful check evidence`, async (t) => {
    const f = fixture(t);
    f.execute = async (input) => { const value = f.good(input); change(value); return value; };
    const result = await f.run();
    assert.equal(result.state, state);
    assert.equal(result.publicResult, state === "failed" ? "failed" : "unavailable");
    assert.equal(result.publishable, false);
    assert.equal(f.saved().checkAttempts.at(-1)?.state, state);
  });
}

test("mixed checks retain genuine failures and do not accept a passing subset of a batch", async (t) => {
  const f = fixture(t);
  const second = id("40");
  f.current.memberIds.push(second);
  f.current.profile.checks.push({ id: "second-member", argv: ["fabricated-check", "second"], memberIds: [second], dependsOn: [] });
  f.request.snapshot = structuredClone(f.current);
  f.execute = async (input) => {
    const result = f.good(input);
    result.coveredMemberIds = input.checkId === "behavior" ? [id("10")] : [second];
    result.terminal!.code = input.checkId === "behavior" ? 1 : 0;
    return result;
  };
  const result = await f.run();
  assert.equal(result.state, "failed");
  assert.equal(result.publicResult, "failed");
  assert.deepEqual(result.checks.map((check: { state: string }) => check.state), ["failed", "passed"]);
});

test("a failed dependency leaves dependent checks unrun while unrelated selected checks continue", async (t) => {
  const f = fixture(t);
  f.current.profile.checks.push(
    { id: "dependent", argv: ["fabricated-check", "dependent"], memberIds: [id("10")], dependsOn: ["behavior"] },
    { id: "unaffected", argv: ["fabricated-check", "unaffected"], memberIds: [id("10")], dependsOn: [] },
  );
  f.request.snapshot = structuredClone(f.current);
  f.execute = async (input) => {
    const result = f.good(input);
    result.terminal!.code = input.checkId === "behavior" ? 1 : 0;
    return result;
  };
  const result = await f.run();
  assert.equal(result.state, "failed");
  assert.equal(result.publicResult, "failed");
  assert.deepEqual(f.calls.map((call) => call.checkId), ["behavior", "unaffected"]);
  assert.deepEqual(result.checks.map((check: { state: string }) => check.state), ["failed", "unrun", "passed"]);
});

test("a two-member batch cannot pass when selected checks only cover one member", async (t) => {
  const f = fixture(t);
  f.current.memberIds.push(id("54"));
  f.request.snapshot = structuredClone(f.current);
  f.execute = async (input) => ({ ...f.good(input), coveredMemberIds: [id("10")] });
  const result = await f.run();
  assert.equal(result.state, "held");
  assert.equal(result.publicResult, "unavailable");
  assert.equal(result.publishable, false);
});

test("a disappeared selected result is held, never Not required", async (t) => {
  const f = fixture(t);
  f.current.profile.checks = [];
  f.request.snapshot = structuredClone(f.current);
  const result = await f.run();
  assert.equal(result.state, "held");
  assert.equal(result.publicResult, "unavailable");
  assert.equal(f.calls.length, 0);
});

test("an explicit no-Dispatcher-test profile does not run code or pretend host requirements passed", async (t) => {
  const f = fixture(t);
  f.current.profile.mode = "none";
  f.current.profile.checks = [];
  f.current.requiredHostChecks = ["host-required-check"];
  f.request.snapshot = structuredClone(f.current);
  const result = await f.run();
  assert.equal(result.state, "not_required");
  assert.equal(result.publicResult, "not_required");
  assert.deepEqual(result.outstandingHostChecks, ["host-required-check"]);
  assert.equal(result.publishable, false);
  assert.equal(f.calls.length, 0);
});

test("a passing retry preserves the earlier failed attempt and its exact input identity", async (t) => {
  const f = fixture(t);
  f.execute = async (input) => { const result = f.good(input); result.terminal!.code = 1; return result; };
  assert.equal((await f.run()).state, "failed");
  f.request.attemptId = id("41");
  f.execute = async (input) => f.good(input);
  assert.equal((await f.run()).state, "passed");
  assert.deepEqual(f.saved().checkAttempts.map((attempt) => attempt.state), ["failed", "passed"]);
  assert.deepEqual(f.saved().checkAttempts.map((attempt) => attempt.attemptId), [id("12"), id("41")]);
});

test("replaying the same completed attempt does not execute or append another check", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).state, "passed");
  const repeated = await f.run();
  assert.equal(repeated.state, "passed");
  assert.equal(repeated.publishable, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.saved().checkAttempts.length, 1);
});

for (const invalidation of ["Git mutation", "revoked authority"] as const) {
  test(`replay after ${invalidation} retains history without returning a current green`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.run()).state, "passed");
    const completed = structuredClone(f.saved().checkAttempts);
    if (invalidation === "Git mutation") writeFileSync(join(f.workspace, "behavior.txt"), "new unreviewed bytes\n");
    else f.current.authorized = false;
    const result = await f.run();
    assert.equal(result.state, invalidation === "Git mutation" ? "stale" : "held");
    assert.equal(result.publicResult, "unavailable");
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.saved().checkAttempts, completed);
  });
}

test("overlapping calls for one attempt execute once and preserve one durable record", async (t) => {
  const f = fixture(t);
  let enter!: () => void;
  let release!: () => void;
  let secondRead!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const observedOverlap = new Promise<void>((resolve) => { secondRead = resolve; });
  let executing = false;
  f.execute = async (input) => {
    executing = true;
    enter();
    await released;
    return f.good(input);
  };
  f.observe = () => { if (executing) secondRead(); return structuredClone(f.current); };
  const first = f.run();
  await entered;
  const second = f.run();
  try {
    await Promise.race([second.then(() => undefined), observedOverlap, new Promise<void>((resolve) => setImmediate(resolve))]);
    release();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].state, "passed");
    assert.equal(results.every((result) => result.publishable === false), true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.saved().checkAttempts.length, 1);
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
});

test("a reused attempt identity with different selected inputs refuses without another effect", async (t) => {
  const f = fixture(t);
  assert.equal((await f.run()).state, "passed");
  f.current.profile.checks[0]!.argv.push("--other-input");
  f.request.snapshot = structuredClone(f.current);
  const result = await f.run();
  assert.equal(result.state, "held");
  assert.equal(result.publicResult, "unavailable");
  assert.equal(f.calls.length, 1);
  assert.equal(f.saved().checkAttempts.length, 1);
});

test("restart with durable intent and no durable result holds instead of launching the effect again", async (t) => {
  const f = fixture(t);
  let durableIntent = "";
  f.execute = async (input) => {
    durableIntent = readFileSync(join(f.stateDir, "ledger.json"), "utf8");
    return f.good(input);
  };
  await f.run();
  writeFileSync(join(f.stateDir, "ledger.json"), durableIntent);
  const result = await f.run();
  assert.equal(result.state, "held");
  assert.equal(result.publicResult, "unavailable");
  assert.equal(f.calls.length, 1);
  assert.equal(f.saved().checkAttempts.length, 1);
});

test("the check attempt preserves an existing connection enrollment and custody receipt", async (t) => {
  const f = fixture(t);
  const loaded = loadLedger(f.stateDir);
  if (!loaded.ok || !loaded.ledger.connection) throw new Error("Fixture connection is missing");
  const receipt = {
    version: 1, scopeId: "a".repeat(64), enrollmentId: "b".repeat(32),
    bindingDigest: "c".repeat(64), credentialDigest: "d".repeat(64),
    boardName: "Fabricated board", agentName: "Fixture Dispatcher",
  };
  Object.assign(loaded.ledger.connection, { enrollmentId: receipt.enrollmentId, deliveryReceipt: receipt });
  saveLedger(f.stateDir, loaded.ledger, []);
  await f.run();
  const saved = f.saved().connection as unknown as { enrollmentId: string; deliveryReceipt: typeof receipt };
  assert.equal(saved.enrollmentId, receipt.enrollmentId);
  assert.deepEqual(saved.deliveryReceipt, receipt);
});

test("outgoing results and persisted attempts redact held values and supported credential shapes", async (t) => {
  const f = fixture(t);
  const sentinel = "ghp" + "_" + "A".repeat(36);
  const privateKey = ["-----BEGIN PRIVATE KEY-----", "fabricated-body", "-----END PRIVATE KEY-----"].join("\n");
  f.execute = async (input) => ({ ...f.good(input), stdout: `fixture-held-secret ${sentinel}\n${privateKey}`, stderr: "fixture-held-secret" });
  const result = await f.run();
  const shown = JSON.stringify(result) + readFileSync(join(f.stateDir, "ledger.json"), "utf8");
  assert.equal(shown.includes("fixture-held-secret"), false);
  assert.equal(shown.includes(sentinel), false);
  assert.equal(shown.includes("fabricated-body"), false);
  assert.match(shown, /\[redacted\]/);
});

test("fabricated environment credentials and aliases cannot enter the check executor or ledger", async (t) => {
  const f = fixture(t);
  const github = "ghp" + "_" + "B".repeat(36);
  const vendor = "sk-ant-" + "C".repeat(25);
  Object.assign(f.env, {
    TICKETS_PLEASE_TOKEN: "fixture-held-secret", TICKETS_TO_MAIN_CONNECTION: "fixture-held-secret",
    GITHUB_TOKEN: github, ANTHROPIC_API_KEY: vendor, PUBLIC_ALIAS: "prefix-fixture-held-secret-suffix",
  });
  f.execute = async (input) => {
    for (const name of Object.keys(f.env)) assert.equal(Object.hasOwn(input.env, name), false);
    for (const value of ["fixture-held-secret", github, vendor]) assert.equal(JSON.stringify(input).includes(value), false);
    return f.good(input);
  };
  const result = await f.run();
  assert.equal(result.state, "passed");
  assert.equal(f.calls.length, 1);
  const shown = JSON.stringify(result) + readFileSync(join(f.stateDir, "ledger.json"), "utf8");
  for (const value of ["fixture-held-secret", github, vendor]) assert.equal(shown.includes(value), false);
});

for (const secret of ["fixture-held-secret", "github_pat" + "_" + "D".repeat(25)]) {
  test("secret-bearing selected argv is rejected before execution without persisting plaintext", async (t) => {
    const f = fixture(t);
    f.current.profile.checks[0]!.argv.push("--value=" + secret);
    f.request.snapshot = structuredClone(f.current);
    const result = await f.run();
    assert.equal(result.state, "held");
    assert.equal(result.publicResult, "unavailable");
    assert.equal(f.calls.length, 0);
    const shown = JSON.stringify(result) + readFileSync(join(f.stateDir, "ledger.json"), "utf8");
    assert.equal(shown.includes(secret), false);
  });
}

test("an executor exception cannot leak its secret message or leave a successful result", async (t) => {
  const f = fixture(t);
  f.execute = async () => { throw new Error("fixture-held-secret"); };
  const result = await f.run();
  assert.equal(result.state, "unavailable");
  assert.equal(result.publicResult, "unavailable");
  assert.equal(JSON.stringify(result).includes("fixture-held-secret"), false);
  assert.equal(readFileSync(join(f.stateDir, "ledger.json"), "utf8").includes("fixture-held-secret"), false);
});

test("no caller boolean can promote the fabricated executor to production qualification", async (t) => {
  const f = fixture(t);
  Object.assign(f.request, { qualified: true, publishable: true });
  Object.assign(f.request.snapshot.profile, { qualified: true });
  const result = await f.run();
  assert.equal(result.publishable, false);
  assert.equal(result.qualification, "unqualified-harness");
});
