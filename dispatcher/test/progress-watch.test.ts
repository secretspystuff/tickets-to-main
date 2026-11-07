import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProgressWatch, SessionStartGuard,
  type JudgePacket, type JudgeResult, type JudgeRoute, type WatchConfig, type WatchControls,
  type WatchEvent, type WatchObservation, type WatchSource,
} from "../src/progress-watch.ts";

const identity = { repoId: "repo", ticketId: "ticket", jobId: "job", runId: "run", evidenceVersion: "candidate-1" };
const builder: WatchSource = {
  id: "root", sessionId: "builder-session", vendor: "codex", interfaceId: "cli", model: "builder-model", role: "builder",
  counters: { turns: true, tokens: true, compactions: true },
};
const helper: WatchSource = { ...builder, id: "helper", sessionId: "helper-session", role: "helper" };
const config: WatchConfig = { identity, sources: [builder], telemetryMaxAgeMs: 2_000_000 };
const controls: WatchControls = {
  identity, sourceId: builder.id, sessionId: builder.sessionId, vendor: builder.vendor, interfaceId: builder.interfaceId,
  evidenceIds: ["qualified-native-input-and-reconcile"], input: "qualified", safeReconcile: "qualified", ownership: "confirmed", liveness: "running", nativeHeld: false,
};
const cheap: JudgeRoute = {
  tier: "cheap", requested: { vendor: "other", model: "cheap" }, eligible: [{ vendor: "other", model: "cheap" }],
  calibrationEvidenceIds: ["calibration"], strongerQualificationEvidenceIds: [],
};
const stronger: JudgeRoute = { ...cheap, tier: "stronger", requested: { vendor: "other", model: "stronger" }, eligible: [{ vendor: "other", model: "stronger" }], strongerQualificationEvidenceIds: ["measured-stronger-confirmation"] };
const context = { title: "Ticket title", plan: [{ id: "item", text: "Complete the behavior", completed: false }] };

function harness(override: Partial<WatchConfig> = {}, secrets: string[] = []) {
  const current = { ...config, ...override };
  let watch = new ProgressWatch(current, secrets);
  const sequences = new Map<string, number>();
  let clock = 0;
  const observation = (event: WatchEvent = { kind: "sample" }, turns: number | null = 0, options: {
    source?: WatchSource; at?: number; counters?: WatchObservation["counters"];
  } = {}): WatchObservation => {
    const source = options.source ?? current.sources[0]!;
    const sequence = (sequences.get(source.id) ?? -1) + 1;
    sequences.set(source.id, sequence);
    clock = options.at ?? clock + 1;
    return { identity: current.identity, source, id: `${source.id}-${sequence}`, sequence, observedAt: clock, counters: options.counters ?? { turns, tokens: turns === null ? null : turns * 1_000, compactions: 0 }, event };
  };
  return {
    get watch() { return watch; }, get now() { return clock; }, current, observation,
    emit(event: WatchEvent = { kind: "sample" }, turns: number | null = 0, options: Parameters<typeof observation>[2] = {}) {
      const sample = observation(event, turns, options);
      return watch.observe(sample, sample.observedAt);
    },
    restore() { watch = ProgressWatch.restore(current, JSON.parse(JSON.stringify(watch.snapshot())), secrets); },
  };
}

function action(key = "same", errorKey?: string): Extract<WatchEvent, { kind: "action" }> {
  return { kind: "action", name: "test", argumentsKey: key, outcomeKey: "failed", shortOutcome: "One assertion failed", ...(errorKey ? { errorKey } : {}) };
}

function verdict(packet: JudgePacket, route: JudgeRoute, overrides: Partial<JudgeResult> = {}): JudgeResult {
  return { packetId: packet.packetId, identity, observed: route.requested, verdict: "stalled", confidence: 0.8, actionIds: packet.actions.slice(-1).map((action) => action.id), diagnosis: "The same observed failure remains.", ...overrides };
}

test("long productive work never gets a size, elapsed time, token or turn stop", () => {
  const h = harness();
  h.emit({ kind: "check", checkId: "builder-tests", passing: 0, failureKey: "first" }, 0);
  for (let i = 1; i <= 60; i += 1) {
    assert.equal(h.emit({ kind: "check", checkId: "builder-tests", passing: i, failureKey: `remaining-${i}` }, i * 1_000_000, { at: i * 86_400_000 }).progress, "strong");
    assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  }
  assert.deepEqual(h.watch.status(h.now).sources[0]!.sinceStrong, { turns: 0, tokens: 0, compactions: 0 });
  h.emit({ kind: "check", checkId: "builder-tests", passing: 60, failureKey: null }, 60_000_001);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
});

test("check failure changes and completed plan items require observed substantive matching evidence", () => {
  const h = harness();
  h.emit({ kind: "check", checkId: "check", passing: 0, failureKey: "syntax" }, 0);
  assert.equal(h.emit({ kind: "check", checkId: "check", passing: 0, failureKey: "new-unknown-failure" }, 1).progress, "none");
  assert.equal(h.emit({ kind: "check", checkId: "check", passing: 0, failureKey: "behavior", debuggingAdvanceEvidenceIds: ["syntax-fixed-behavior-now-reached"] }, 1).progress, "strong");
  assert.equal(h.emit({ kind: "check", checkId: "check", passing: 0, failureKey: null }, 1).progress, "none");
  h.emit({ kind: "check", checkId: "check", passing: 0, failureKey: "remaining" }, 1);
  assert.equal(h.emit({ kind: "check", checkId: "check", passing: 0, failureKey: null, passed: true }, 1).progress, "strong");
  assert.equal(h.emit({ kind: "plan_item", itemId: "item", treeId: "tree1", planFiles: ["a.ts"], files: [{ file: "a.ts", added: 30, removed: 2, substantive: false }] }, 2).progress, "none");
  assert.equal(h.emit({ kind: "plan_item", itemId: "item", treeId: "tree2", planFiles: ["a.ts"], files: [{ file: "b.ts", added: 2, removed: 0, substantive: true }] }, 3).progress, "weak");
  assert.equal(h.emit({ kind: "plan_item", itemId: "item", treeId: "tree3", planFiles: ["a.ts"], files: [{ file: "a.ts", added: 2, removed: 0, substantive: true }] }, 4).progress, "strong");
  assert.equal(h.emit({ kind: "plan_item", itemId: "item", treeId: "tree4", planFiles: ["a.ts"], files: [{ file: "a.ts", added: 3, removed: 0, substantive: true }] }, 5).progress, "weak");
});

test("unknown, stale, duplicated, out-of-order and foreign observations never manufacture counters", () => {
  const h = harness({ telemetryMaxAgeMs: 10 });
  const sample = h.observation({ kind: "sample" }, 100, { at: 100 });
  assert.equal(h.watch.observe(sample, 100).accepted, true);
  assert.equal(h.watch.observe(sample, 100).reason, "duplicate_or_missing_id");
  assert.equal(h.watch.observe({ ...sample, id: "older-sequence" }, 100).reason, "out_of_order");
  assert.equal(h.watch.observe({ ...sample, id: "older-time", sequence: 1, observedAt: 99 }, 100).reason, "out_of_order");
  assert.equal(h.watch.observe({ ...sample, id: "future", sequence: 1, observedAt: 101 }, 100).reason, "unknown_or_stale_time");
  assert.equal(h.watch.observe({ ...sample, id: "stale", sequence: 1 }, 111).reason, "unknown_or_stale_time");
  assert.equal(h.watch.observe({ ...sample, id: "foreign", source: { ...builder, interfaceId: "app-server" }, sequence: 1 }, 100).reason, "unattributed_source");
  assert.equal(h.watch.observe({ ...sample, id: "foreign-job", identity: { ...identity, evidenceVersion: "old" }, sequence: 1 }, 100).reason, "different_job_or_evidence");
  assert.equal(h.watch.observe({ ...sample, id: "regressed", sequence: 1, counters: { turns: 99 } }, 100).reason, "unsupported_or_regressed_counter");
  assert.equal(h.watch.status(111).sources[0]!.sinceStrong.turns, null);
  assert.equal(h.watch.decide(111, controls).kind, "continue");
  h.emit({ kind: "sample" }, null, { at: 101 });
  assert.equal(h.watch.status(101).sources[0]!.sinceStrong.turns, null);
  assert.equal(h.watch.decide(101, controls).kind, "continue");
  assert.equal(h.watch.observe({ ...sample, id: "regressed-after-gap", observedAt: 102, sequence: 2, counters: { turns: 99 } }, 102).reason, "unsupported_or_regressed_counter");
  h.restore();
  assert.equal(h.watch.observe(sample, 101).accepted, false);
  assert.throws(() => ProgressWatch.restore({ ...h.current, identity: { ...identity, runId: "different" } }, h.watch.snapshot()), /checkpoint/);
  const corrupted = h.watch.snapshot();
  corrupted.operations.push(corrupted.operations[0]!);
  assert.throws(() => ProgressWatch.restore(h.current, corrupted), /checkpoint/);
});

test("unsupported counters disable their rules and an action is never counted as a turn", () => {
  const root = { ...builder, counters: { turns: false, tokens: false, compactions: false } };
  const h = harness({ sources: [root] });
  for (let i = 0; i < 100; i += 1) h.emit(action(`file-${i}`), null, { counters: {} });
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  assert.deepEqual(h.watch.status(h.now).sources[0]!.sinceStrong, { turns: null, tokens: null, compactions: null });
  const forged = h.observation({ kind: "sample" }, 100);
  assert.equal(h.watch.observe(forged, h.now).reason, "unsupported_or_regressed_counter");
});

test("weak substantive trees delay a cheap check; whitespace and comments do not", () => {
  const h = harness();
  h.emit();
  h.emit({ kind: "tree", treeId: "a", files: [{ file: "a.ts", added: 2, removed: 0, substantive: true }] }, 14);
  h.emit({ kind: "sample" }, 15);
  assert.equal(h.watch.status(h.now).sources[0]!.sinceStrong.turns, 15);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  h.emit({ kind: "tree", treeId: "comments", files: [{ file: "a.ts", added: 1000, removed: 0, substantive: false }] }, 29);
  assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
});

test("same error across different files needs a judge, while four exact actions may nudge", () => {
  const different = harness();
  different.emit();
  for (let i = 1; i <= 3; i += 1) different.emit(action(`file-${i}`, "same-error"), i);
  assert.equal(different.watch.status(different.now).signals.some((signal) => signal.kind === "identical_errors"), true);
  assert.equal(different.watch.decide(different.now, controls).kind, "judge_needed");
  assert.equal(different.watch.decide(different.now, { ...controls, evidenceIds: [], input: "unknown", safeReconcile: "unknown" }).kind, "judge_needed");
  const packet = different.watch.requestJudgment(different.now, controls, context, cheap);
  different.watch.acceptJudgment(verdict(packet, cheap, { verdict: "progressing", confidence: 0.95 }), different.now);
  assert.equal(different.watch.decide(different.now, controls).kind, "continue");
  const exact = harness();
  exact.emit();
  for (let i = 1; i <= 4; i += 1) exact.emit(action(), i);
  assert.equal(exact.watch.decide(exact.now, controls).kind, "nudge_eligible");
  assert.equal(exact.watch.decide(exact.now, { ...controls, input: "unavailable" }).kind, "preserved_work_blocker");
  assert.equal(exact.watch.decide(exact.now, { ...controls, evidenceIds: [] }).kind, "preserved_work_blocker");
  assert.equal(exact.watch.decide(exact.now, { ...controls, nativeHeld: true }).kind, "continue");
  assert.equal(exact.watch.decide(exact.now, { ...controls, interfaceId: "app-server" }).kind, "continue");
});

test("ping-pong, earlier trees, fix/test cycles and compactions are evidence, never direct stop authority", () => {
  const h = harness();
  h.emit();
  for (let i = 1; i <= 6; i += 1) h.emit(action(i % 2 ? "a" : "b"), i);
  assert.equal(h.watch.status(h.now).signals.find((signal) => signal.kind === "ping_pong")!.count, 6);
  const files = [{ file: "a.ts", added: 1, removed: 0, substantive: true }];
  for (const treeId of ["one", "two", "one"]) h.emit({ kind: "tree", treeId, files }, 6);
  h.emit({ kind: "fix_test_cycle", failureKey: "failure" }, 6);
  h.emit({ kind: "fix_test_cycle", failureKey: "failure" }, 6);
  h.emit({ kind: "sample" }, 6, { counters: { turns: 6, tokens: 6_000, compactions: 2 } });
  assert.deepEqual(h.watch.status(h.now).signals.map((signal) => signal.kind).sort(), ["compactions", "earlier_tree", "same_failure_cycles"]);
  assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
});

test("rerunning the same command after observed substantive changes is useful repetition, not an exact loop", () => {
  const h = harness();
  h.emit();
  for (let i = 1; i <= 6; i += 1) {
    h.emit(action(), i);
    h.emit({ kind: "tree", treeId: `tree-${i}`, files: [{ file: "a.ts", added: i, removed: 0, substantive: true }] }, i);
  }
  assert.equal(h.watch.status(h.now).signals.some((signal) => signal.kind === "identical_actions"), false);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
});

test("busy CPU and missing process attribution are not hung; idle needs two observed samples", () => {
  const h = harness();
  const process = { kind: "process", processId: "pid-1", ownership: "confirmed", liveness: "running", cpuMs: 100, lastOutputAt: 1 } as const;
  h.emit(process, 0, { at: 1 });
  h.emit({ ...process, cpuMs: 200 }, 0, { at: 600_001 });
  assert.equal(h.watch.status(h.now).signals.length, 0);
  h.emit({ ...process, cpuMs: 200 }, 0, { at: 1_200_001 });
  assert.equal(h.watch.status(h.now).signals[0]!.kind, "no_output_or_cpu");
  assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
  h.emit({ ...process, ownership: "unknown", cpuMs: null }, 0, { at: 1_200_002 });
  assert.equal(h.watch.status(h.now).signals.length, 0);
  h.emit(process, 0, { at: 1_200_003 });
  h.emit(action("new-output"), 0, { at: 1_300_000 });
  h.emit(process, 0, { at: 1_800_003 });
  assert.equal(h.watch.status(h.now).signals.some((signal) => signal.kind === "no_output_or_cpu"), false);
});

test("actual cheap-judge cadence adapts after thirty turns and tokens only request judgment", () => {
  for (const [verdictValue, confidence, interval] of [["unsure", 0.2, 5], ["progressing", 0.95, 15], ["progressing", 0.5, 10]] as const) {
    const h = harness();
    h.emit();
    h.emit({ kind: "sample" }, 30);
    assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
    const packet = h.watch.requestJudgment(h.now, controls, context, cheap);
    h.watch.acceptJudgment(verdict(packet, cheap, { verdict: verdictValue, confidence }), h.now);
    h.emit({ kind: "sample" }, 30 + interval - 1);
    assert.equal(h.watch.decide(h.now, controls).kind, "continue");
    h.emit({ kind: "sample" }, 30 + interval);
    assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
  }
  const h = harness();
  h.emit({ kind: "sample" }, null, { counters: { tokens: 0 } });
  h.emit({ kind: "sample" }, null, { counters: { tokens: 150_000 } });
  assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
});

test("judge packet is narrow, capped at twenty actions and excludes helper or hidden material", () => {
  const held = "held-credential-for-test";
  const h = harness({ sources: [builder, helper] }, [held]);
  h.emit();
  h.emit({ ...action("helper"), shortOutcome: "Private helper context" }, 500, { source: helper });
  for (let i = 1; i <= 25; i += 1) h.emit({ ...action(`file-${i}`), shortOutcome: `${held} https://short-outcome.invalid` }, i);
  h.emit({ kind: "tree", treeId: "tree", files: [{ file: "a.ts", added: 3, removed: 1, substantive: false }] }, 25);
  const packet = h.watch.requestJudgment(h.now, controls, { title: held, plan: context.plan, makerReasoning: "Do not include" } as typeof context, cheap);
  assert.equal(packet.actions.length, 20);
  assert.equal(packet.actions.every((action) => action.sourceId === builder.id), true);
  assert.equal(JSON.stringify(packet).includes("Private helper context"), false);
  assert.equal(JSON.stringify(packet).includes("makerReasoning"), false);
  assert.equal(JSON.stringify(packet).includes(held), false);
  assert.equal(JSON.stringify(h.watch.snapshot()).includes(held), false);
  assert.deepEqual(packet.files, [{ file: "a.ts", added: 3, removed: 1 }]);
  const result = h.watch.acceptJudgment(verdict(packet, cheap, { diagnosis: `Run rm -rf /; see https://bad.invalid . ${held}. Repeated failure persists.` }), h.now);
  assert.equal(result.diagnosis.includes("rm"), false);
  assert.equal(result.diagnosis.includes("https"), false);
  assert.equal(result.diagnosis.includes(held), false);
  assert.ok(result.diagnosis.length <= 200);
});

test("private-key bodies never reach projected actions, judge text, returned diagnoses or checkpoints", () => {
  const body = "SYNTHETIC_PRIVATE_KEY_BODY";
  const values = [
    `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`,
    `before -----BEGIN RSA PRIVATE KEY----- ${body} -----END RSA PRIVATE KEY----- after`,
    `-----BEGIN ENCRYPTED PRIVATE KEY-----\r\n${body}\r\n-----END ENCRYPTED PRIVATE KEY-----`,
    `-----BEGIN PRIVATE KEY-----\n${body}`,
    `-----BEGIN PRIVATE KEY----\n${body}`,
    `-----BEGIN PRIVATE KEY\n${body}`,
    `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY----`,
    `-----BEGIN PRIVATE KEY-----\n${body.repeat(50)}\n-----END PRIVATE KEY-----`,
    `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`,
  ];
  for (const value of values) {
    const h = harness({}, ["PRIVATE KEY"]);
    h.emit();
    h.emit({ kind: "action", name: value, argumentsKey: value, outcomeKey: value, shortOutcome: value }, 15);
    h.emit({ kind: "tree", treeId: value, files: [{ file: value, added: 0, removed: 0, substantive: false }] }, 15);
    const packet = h.watch.requestJudgment(h.now, controls, { title: value, plan: [{ id: "item", text: value, completed: false }] }, cheap);
    assert.equal(packet.title.includes(body), false);
    assert.equal(packet.plan[0]!.text.includes(body), false);
    assert.equal(packet.actions[0]!.name.includes(body), false);
    assert.equal(packet.actions[0]!.outcome.includes(body), false);
    assert.equal(packet.files[0]!.file.includes(body), false);
    const result = h.watch.acceptJudgment(verdict(packet, cheap, { diagnosis: `Observed ${value}` }), h.now);
    assert.equal(result.diagnosis.includes(body), false);
    assert.equal(JSON.stringify(h.watch.snapshot()).includes(body), false);
    h.restore();
    assert.equal(JSON.stringify(h.watch.snapshot()).includes(body), false);
  }
});

test("missing calibration, stale packets, foreign action IDs and unexpected observed models cannot nudge", () => {
  const h = harness();
  h.emit();
  h.emit(action("a"), 15);
  assert.throws(() => h.watch.requestJudgment(h.now, controls, context, { ...cheap, calibrationEvidenceIds: [] }), /calibration/);
  const packet = h.watch.requestJudgment(h.now, controls, context, cheap);
  assert.throws(() => h.watch.acceptJudgment(verdict(packet, cheap, { observed: { vendor: "codex", model: "builder-model" } }), h.now), /Unqualified/);
  assert.throws(() => h.watch.acceptJudgment(verdict(packet, cheap, { actionIds: ["hidden-action"] }), h.now), /Unqualified/);
  assert.throws(() => h.watch.acceptJudgment(verdict(packet, cheap, { identity: { ...identity, jobId: "other" } }), h.now), /foreign/);
  h.emit(action("b"), 16);
  assert.throws(() => h.watch.acceptJudgment(verdict(packet, cheap), h.now), /Stale/);
  assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
});

test("repeated polls reuse a pending judge packet without replacing or duplicating the live request", () => {
  const h = harness();
  h.emit();
  h.emit(action("a"), 15);
  const first = h.watch.requestJudgment(h.now, controls, context, cheap);
  const checkpoint = h.watch.snapshot();
  h.restore();
  assert.equal(h.watch.decide(h.now, controls).reason, "judgment_pending");
  assert.deepEqual(h.watch.requestJudgment(h.now, controls, { ...context, title: "A later poll" }, cheap), first);
  assert.deepEqual(h.watch.snapshot(), checkpoint);
  assert.throws(() => h.watch.requestJudgment(h.now, controls, context, stronger), /already pending/);
  h.watch.acceptJudgment(verdict(first, cheap), h.now);
  assert.equal(h.watch.decide(h.now, controls).kind, "nudge_eligible");
  h.watch.recordNudge("delivery", h.now, controls);
  h.emit({ kind: "sample" }, 25);
  const confirmation = h.watch.requestJudgment(h.now, controls, context, stronger);
  assert.equal(h.watch.decide(h.now, controls).reason, "judgment_pending");
  assert.deepEqual(h.watch.requestJudgment(h.now, controls, context, stronger), confirmation);
  h.watch.acceptJudgment(verdict(confirmation, stronger, { confidence: 0.9 }), h.now);
  assert.equal(h.watch.decide(h.now, controls).kind, "safe_reconcile_requested");
});

test("new observations invalidate a pending packet before a later judge request", () => {
  const h = harness();
  h.emit();
  h.emit(action("a"), 15);
  const first = h.watch.requestJudgment(h.now, controls, context, cheap);
  h.emit(action("b"), 16);
  assert.equal(h.watch.decide(h.now, controls).kind, "judge_needed");
  const second = h.watch.requestJudgment(h.now, controls, context, cheap);
  assert.notEqual(second.packetId, first.packetId);
  assert.throws(() => h.watch.acceptJudgment(verdict(first, cheap), h.now), /foreign/);
  h.watch.acceptJudgment(verdict(second, cheap, { verdict: "progressing" }), h.now);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
});

test("nudge confidence, observed delivery and ten further actual builder turns precede stronger confirmation", () => {
  const h = harness();
  h.emit();
  h.emit(action("a"), 15);
  let packet = h.watch.requestJudgment(h.now, controls, context, cheap);
  h.watch.acceptJudgment(verdict(packet, cheap, { confidence: 0.79 }), h.now);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  h.emit(action("b"), 30);
  packet = h.watch.requestJudgment(h.now, controls, context, cheap);
  h.watch.acceptJudgment(verdict(packet, cheap), h.now);
  assert.equal(h.watch.decide(h.now, controls).kind, "nudge_eligible");
  assert.equal(h.watch.status(h.now).nudge, null);
  h.watch.recordNudge("native-delivery-1", h.now, controls);
  h.restore();
  h.emit({ kind: "sample" }, 39);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  h.emit({ kind: "sample" }, 40);
  assert.equal(h.watch.decide(h.now, controls).kind, "confirmation_needed");
  assert.throws(() => h.watch.requestJudgment(h.now, controls, context, cheap), /eligible/);
  assert.throws(() => h.watch.requestJudgment(h.now, controls, context, { ...stronger, strongerQualificationEvidenceIds: [] }), /calibration/);
  packet = h.watch.requestJudgment(h.now, controls, context, stronger);
  h.watch.acceptJudgment(verdict(packet, stronger, { confidence: 0.9 }), h.now);
  assert.equal(h.watch.decide(h.now, { ...controls, ownership: "unknown" }).kind, "preserved_work_blocker");
  assert.equal(h.watch.decide(h.now, { ...controls, safeReconcile: "unavailable" }).kind, "preserved_work_blocker");
  assert.equal(h.watch.decide(h.now, controls).kind, "safe_reconcile_requested");
  h.restore();
  assert.equal(h.watch.decide(h.now, controls).kind, "safe_reconcile_requested");
});

test("unknown delivery counters delay escalation until ten turns after a later actual sample", () => {
  const h = harness();
  h.emit();
  for (let i = 1; i <= 4; i += 1) h.emit(action(), i);
  h.watch.recordNudge("delivery", h.now + 1, controls);
  h.emit({ kind: "sample" }, 14, { at: h.now + 2 });
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  h.emit({ kind: "sample" }, null);
  assert.equal(h.watch.status(h.now).nudge!.furtherTurns, null);
  h.emit({ kind: "sample" }, 24);
  assert.equal(h.watch.decide(h.now, controls).kind, "confirmation_needed");
});

test("weak, progressing or unsure stronger judgments never authorize reconciliation", () => {
  for (const [outcome, confidence] of [["stalled", 0.89], ["progressing", 1], ["unsure", 1]] as const) {
    const h = harness();
    h.emit();
    for (let i = 1; i <= 4; i += 1) h.emit(action(), i);
    h.watch.recordNudge("delivery", h.now, controls);
    h.emit({ kind: "sample" }, 14);
    const packet = h.watch.requestJudgment(h.now, controls, context, stronger);
    h.watch.acceptJudgment(verdict(packet, stronger, { verdict: outcome, confidence }), h.now);
    assert.notEqual(h.watch.decide(h.now, controls).kind, "safe_reconcile_requested");
  }
});

test("strong progress cancels escalation and logs observed nudge outcomes", () => {
  const h = harness();
  h.emit();
  for (let i = 1; i <= 4; i += 1) h.emit(action(), i);
  h.watch.recordNudge("delivery", h.now, controls);
  h.emit({ kind: "check", checkId: "test", passing: 0, failureKey: "fail" }, 8);
  h.emit({ kind: "check", checkId: "test", passing: 1, failureKey: null }, 10);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  assert.equal(h.watch.status(h.now).nudge, null);
  assert.deepEqual(h.watch.status(h.now).nudgeOutcomes, [{ deliveryId: "delivery", progressWithinTenTurns: true }]);
});

test("helpers keep separate actual counts and observed helper strong progress protects owned work", () => {
  const h = harness({ sources: [builder, helper] });
  h.emit();
  h.emit({ kind: "check", checkId: "helper-test", passing: 0, failureKey: "fail" }, 500, { source: helper });
  for (let i = 1; i <= 4; i += 1) h.emit(action(), i);
  h.watch.recordNudge("delivery", h.now, controls);
  const lateHelper = h.observation({ kind: "check", checkId: "helper-test", passing: 1, failureKey: null }, 501, { source: helper, at: 2 });
  assert.equal(h.watch.observe(lateHelper, 6).reason, "out_of_order");
  h.emit({ kind: "sample" }, 10_000, { source: helper, at: 7 });
  assert.equal(h.watch.status(h.now).sources.find((source) => source.sourceId === "root")!.sinceStrong.turns, 4);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
  h.emit({ kind: "check", checkId: "helper-test", passing: 1, failureKey: null }, 10_001, { source: helper });
  assert.equal(h.watch.status(h.now).nudge, null);
  assert.equal(h.watch.status(h.now).sources[0]!.sinceStrong.turns, null);
  h.emit({ kind: "sample" }, 20);
  assert.equal(h.watch.status(h.now).sources[0]!.sinceStrong.turns, 0);
  assert.equal(h.watch.decide(h.now, controls).kind, "continue");
});

test("zero and very large editable thresholds never create a native stop or fabricate observations", () => {
  const zero = harness({ telemetryMaxAgeMs: 0, thresholds: { judgeTurns: 0, judgeTokens: 0, identicalActions: 0 } });
  assert.equal(zero.watch.decide(0, controls).kind, "continue");
  zero.emit();
  assert.equal(zero.watch.decide(zero.now, controls).kind, "judge_needed");
  assert.equal(zero.watch.decide(zero.now + 1, controls).kind, "continue");
  zero.emit({ kind: "check", checkId: "check", passing: 0, failureKey: "fail" }, 0);
  zero.emit({ kind: "check", checkId: "check", passing: 1, failureKey: null }, 0);
  assert.equal(zero.watch.decide(zero.now, controls).kind, "continue");
  const large = harness({ thresholds: { judgeTurns: Number.MAX_SAFE_INTEGER, judgeTokens: Number.MAX_SAFE_INTEGER, identicalActions: Number.MAX_SAFE_INTEGER } });
  large.emit();
  for (let i = 1; i <= 40; i += 1) large.emit(action(), i);
  assert.equal(large.watch.decide(large.now, controls).kind, "continue");
  assert.throws(() => new ProgressWatch({ ...config, thresholds: { judgeTurns: -1 } }), /threshold/);
  assert.throws(() => new ProgressWatch({ ...config, thresholds: { nudgeConfidence: 1.01 } }), /confidence/);
});

test("session-start protection persists ticket and repo holds without touching ongoing work", () => {
  const current = { repoId: "repo" };
  let guard = new SessionStartGuard(current);
  for (let i = 0; i < 20; i += 1) guard.observeStart({ id: `start-${i}`, repoId: "repo", ticketId: "ticket", observedAt: i });
  const denied = guard.checkStart({ ticketId: "ticket", now: 20, usualHourlyStarts: null });
  assert.equal(denied.allowed, false);
  assert.equal(denied.ongoingWork, "preserve");
  assert.equal(denied.recovery, "explicit_human");
  guard = SessionStartGuard.restore(current, JSON.parse(JSON.stringify(guard.snapshot())));
  assert.equal(guard.checkStart({ ticketId: "ticket", now: 90_000_000, usualHourlyStarts: null }).allowed, false);
  guard.recover({ actor: "human", scope: "ticket", ticketId: "ticket", evidenceId: "manual-recovery" });
  assert.equal(guard.checkStart({ ticketId: "ticket", now: 90_000_001, usualHourlyStarts: null }).allowed, true);
  assert.equal(guard.checkStart({ ticketId: "other", now: 20, usualHourlyStarts: { value: 4, evidenceId: "measured-hourly-rate" } }).allowed, false);
  guard = SessionStartGuard.restore(current, guard.snapshot());
  assert.equal(guard.checkStart({ ticketId: "another", now: 90_000_002, usualHourlyStarts: null }).allowed, false);
  assert.throws(() => guard.recover({ actor: "agent", scope: "repo", ticketId: null, evidenceId: "self-recovery" } as never), /human/);
  guard.recover({ actor: "human", scope: "repo", ticketId: null, evidenceId: "manual-recovery" });
  assert.equal(guard.checkStart({ ticketId: "another", now: 90_000_003, usualHourlyStarts: null }).allowed, true);
});

test("start attribution/dedup survives restore and unknown usual rates disable only the ratio rule", () => {
  const current = { repoId: "repo", ticketStarts24h: 1_000 };
  let guard = new SessionStartGuard(current);
  const start = { id: "session", repoId: "repo", ticketId: "ticket", observedAt: 1 };
  guard.observeStart(start);
  guard.observeStart(start);
  guard = SessionStartGuard.restore(current, guard.snapshot());
  guard.observeStart(start);
  assert.equal(guard.checkStart({ ticketId: "ticket", now: 2, usualHourlyStarts: null }).ticketStarts24h, 1);
  assert.equal(guard.checkStart({ ticketId: "ticket", now: 2, usualHourlyStarts: { value: 0, evidenceId: "no-usable-baseline" } }).allowed, true);
  assert.throws(() => guard.observeStart({ ...start, ticketId: "other" }), /Conflicting/);
  assert.throws(() => guard.observeStart({ ...start, id: "other", repoId: "private-other-repo" }), /Unattributed/);
  assert.throws(() => SessionStartGuard.restore({ repoId: "different" }, guard.snapshot()), /checkpoint/);
  assert.equal(new SessionStartGuard({ repoId: "repo", ticketStarts24h: 0 }).checkStart({ ticketId: "ticket", now: 0, usualHourlyStarts: null }).allowed, false);
  assert.equal(new SessionStartGuard({ repoId: "repo", repoHourlyMultiplier: 0 }).checkStart({ ticketId: "ticket", now: 0, usualHourlyStarts: { value: 1, evidenceId: "baseline" } }).allowed, false);
});

test("session guard metadata rejects private-key bodies before adding durable history", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_GUARD_KEY_BODY\n-----END PRIVATE KEY-----";
  assert.throws(() => new SessionStartGuard({ repoId: key }), /Unsafe text/);
  const guard = new SessionStartGuard({ repoId: "repo" });
  assert.throws(() => guard.observeStart({ id: key, repoId: "repo", ticketId: "ticket", observedAt: 0 }), /Unsafe text/);
  assert.throws(() => guard.checkStart({ ticketId: "ticket", now: 0, usualHourlyStarts: { value: 1, evidenceId: key } }), /Unsafe text/);
  assert.throws(() => guard.recover({ actor: "human", scope: "repo", ticketId: null, evidenceId: key }), /Unsafe text/);
  assert.equal(JSON.stringify(guard.snapshot()).includes("SYNTHETIC_GUARD_KEY_BODY"), false);
  assert.equal(guard.snapshot().operations.length, 0);
});
