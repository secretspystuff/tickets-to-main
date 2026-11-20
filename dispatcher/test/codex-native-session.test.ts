import assert from "node:assert/strict";
import { test } from "node:test";
import { startCodexAppServerAssignment, runCodexCliAssignment } from "../src/adapters/codex.ts";
import { applyHarnessEvidence, claimCovers, type AssignmentRequest } from "../src/adapters/contract.ts";
import { documentedCodexClaim } from "../src/adapters/codex.ts";
import { safeNativeText, type NativeObservation } from "../src/adapters/native-result.ts";
import { processNativeTransport, type NativeEvents, type NativeTransport } from "../src/native-transport.ts";
import { CLI_RESULT, scriptedTransport } from "./native-fixtures.ts";

const REQUEST: AssignmentRequest = { assignmentId: "fixture", workspace: "C:\\fixture-work", prompt: "Private assignment text", model: null, effort: null };
const LAUNCH = { executable: "C:\\fixture\\codex.exe", version: "0.163.0" };
const THREAD = "thread-1";
const TURN = "turn-1";
function emit(events: NativeEvents, value: unknown): void { events.stdout(`${JSON.stringify(value)}\n`); }
function terminal(events: NativeEvents, status = "completed", turnId = TURN): void {
  emit(events, { method: "turn/completed", params: { threadId: THREAD, turn: { id: turnId, status, items: [] } } });
}
function message(events: NativeEvents, text = "Result.", turnId = TURN): void {
  emit(events, { method: "item/completed", params: { threadId: THREAD, turnId, item: { id: "msg-1", type: "agentMessage", text } } });
}
function permission(events: NativeEvents, method = "item/commandExecution/requestApproval"): void {
  const context = { threadId: THREAD, turnId: TURN, itemId: "cmd-1", startedAtMs: 1 };
  const params = method === "item/permissions/requestApproval"
    ? { ...context, cwd: REQUEST.workspace, permissions: { network: { enabled: true } } }
    : context;
  emit(events, { id: 100, method, params });
}
function server(
  turn: (events: NativeEvents) => void,
  options: { observedModel?: string; reasoningEffort?: unknown; workspace?: string; threadId?: string;
    startedBeforeReply?: boolean; interrupt?: (events: NativeEvents, id: number) => void } = {},
) {
  return scriptedTransport((input, events) => {
    const msg = JSON.parse(input) as { id?: number; method: string };
    if (msg.method === "initialize") emit(events, { id: msg.id, result: { userAgent: "codex/0.163.0", platformFamily: "windows", platformOs: "windows", codexHome: "C:\\own-codex" } });
    if (msg.method === "thread/start") emit(events, { id: msg.id, result: {
      thread: { id: options.threadId ?? THREAD }, model: options.observedModel ?? "native-model", modelProvider: "openai",
      reasoningEffort: options.reasoningEffort, cwd: options.workspace ?? REQUEST.workspace,
      approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" },
    } });
    if (msg.method === "turn/start") {
      if (options.startedBeforeReply) emit(events, { method: "turn/started", params: { threadId: THREAD, turn: { id: TURN, items: [], status: "inProgress" } } });
      emit(events, { id: msg.id, result: { turn: { id: TURN, items: [], status: "inProgress" } } });
      turn(events);
    }
    if (msg.method === "turn/interrupt") {
      if (options.interrupt) options.interrupt(events, msg.id!);
      else { emit(events, { id: msg.id, result: {} }); terminal(events, "interrupted"); }
    }
  });
}
async function finish(transport: NativeTransport, request = REQUEST, secrets: readonly string[] = []): Promise<NativeObservation> {
  const handle = startCodexAppServerAssignment(request, transport, {}, secrets, LAUNCH);
  await handle.settled;
  handle.closeInput();
  return handle.closed;
}

test("app-server uses native configuration, correlated fresh context and no persisted prompt", async () => {
  const transport = server((events) => { message(events); terminal(events); }, { startedBeforeReply: true });
  const result = await finish(transport);
  assert.equal(result.outcome, "completed");
  assert.equal(result.observed.assignment, "supported");
  assert.equal(result.resultText, "Result.");
  assert.equal(result.writerState, "unknown");
  assert.equal(result.approvalAnswered, false);
  assert.equal(result.stdin, "");
  assert.equal(JSON.stringify(result).includes(REQUEST.prompt), false);
  assert.deepEqual(transport.calls[0]?.argv, [LAUNCH.executable, "app-server"]);
  const sent = transport.calls[0]!.input.map((value) => JSON.parse(value));
  assert.deepEqual(sent.map((value) => value.method), ["initialize", "initialized", "thread/start", "turn/start"]);
  assert.deepEqual(sent[0].params, { clientInfo: { name: "tickets_to_main", version: "0.1.0" } });
  assert.deepEqual(sent[2].params, { cwd: REQUEST.workspace });
  assert.deepEqual(sent[3].params, { threadId: THREAD, input: [{ type: "text", text: REQUEST.prompt }] });
  assert.equal(result.observed.helperCompletion, undefined);
});

test("model and effort preserve exact native values without permission or auth overrides", async () => {
  const transport = server((events) => { message(events); terminal(events); }, { observedModel: "requested-model" });
  const result = await finish(transport, { ...REQUEST, model: "requested-model", effort: "provider-advertised-value" });
  assert.equal(result.observedModel, "requested-model");
  const sent = transport.calls[0]!.input.map((value) => JSON.parse(value));
  assert.deepEqual(sent[2].params, { cwd: REQUEST.workspace, model: "requested-model" });
  assert.equal(sent[3].params.effort, "provider-advertised-value");
  const mismatch = server(() => assert.fail("mismatched model must not get an assignment"));
  assert.equal((await finish(mismatch, { ...REQUEST, model: "requested-model" })).outcome, "refused");
  assert.equal(mismatch.calls[0]!.input.some((value) => value.includes('"turn/start"')), false);
});

test("app-server model evidence separates pre-turn thread configuration from the request", async () => {
  const request = { ...REQUEST, model: "requested-model", effort: "low" };
  const transport = server((events) => { message(events); terminal(events); }, { observedModel: request.model, reasoningEffort: "medium" });
  const handle = startCodexAppServerAssignment(request, transport, {}, [], LAUNCH);
  const settled = await handle.settled;
  handle.closeInput();
  const closed = await handle.closed;
  assert.deepEqual(transport.calls[0]!.input.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "thread/start", "turn/start"]);
  for (const result of [settled, closed]) {
    assert.equal(result.outcome, "completed");
    assert.equal(result.requestedModel, request.model);
    assert.equal(result.requestedEffort, request.effort);
    assert.equal(result.writerState, "unknown");
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.observed.modelSelection, undefined);
  }
  const beforeTurn = { model: request.model, reasoningEffort: "medium" };
  assert.deepEqual([Reflect.get(settled, "appServerModelEvidence"), Reflect.get(closed, "appServerModelEvidence")],
    [{ beforeTurn, reroute: null }, { beforeTurn, reroute: null }]);
});

test("app-server model evidence keeps only an exact turn's well-formed reroute", async t => {
  const reroute = { fromModel: "reroute-source-model", toModel: "changed-model", reason: "highRiskCyberActivity" };
  const heldValue = "fabricated-held-model";
  for (const [name, change, outcome, evidence] of [
    ["matching", {}, "held", reroute],
    ["foreign thread", { threadId: "helper-thread" }, "completed", null],
    ["foreign turn", { turnId: "stale-turn" }, "completed", null],
    ["malformed source", { fromModel: 12 }, "held", null],
    ["malformed destination", { toModel: null }, "held", null],
    ["held destination value", { toModel: heldValue }, "held", null],
    ["unrecognized reason", { reason: "fabricated-unknown" }, "held", null],
  ] as const) {
    await t.test(name, async () => {
      const transport = server((events) => {
        emit(events, { method: "model/rerouted", params: { threadId: THREAD, turnId: TURN, ...reroute, ...change } });
        if (outcome === "completed") { message(events); terminal(events); }
      }, { reasoningEffort: "high" });
      const result = await finish(transport, REQUEST, [heldValue]);
      assert.equal(result.outcome, outcome);
      assert.equal(result.writerState, "unknown");
      assert.equal(result.approvalAnswered, false);
      assert.equal(result.observed.modelSelection, undefined);
      assert.equal(result.resultText, outcome === "completed" ? "Result." : null);
      assert.equal(result.requestedModel, null);
      assert.equal(result.requestedEffort, null);
      assert.equal(JSON.stringify(result).includes(heldValue), false);
      assert.deepEqual(Reflect.get(result, "appServerModelEvidence"), {
        beforeTurn: { model: "native-model", reasoningEffort: "high" }, reroute: evidence,
      });
    });
  }
});

test("app-server model evidence preserves native effort and exact startup refusals", async t => {
  const heldEffort = "fabricated-held-effort";
  const longEffort = "a".repeat(200) + "b";
  for (const [name, reasoningEffort, expectedEffort] of [
    ["omitted", undefined, null],
    ["null", null, null],
    ["malformed", 7, null],
    ["empty", "", null],
    ["held value", heldEffort, null],
    ["provider-defined", "fixture-effort", "fixture-effort"],
    ["provider-defined effort of 201 characters", longEffort, longEffort],
  ] as const) {
    await t.test(name, async () => {
      const transport = server((events) => { message(events); terminal(events); }, { reasoningEffort });
      const result = await finish(transport, { ...REQUEST, effort: "low" }, [heldEffort]);
      assert.equal(result.outcome, "completed");
      assert.equal(result.requestedEffort, "low");
      assert.equal(result.writerState, "unknown");
      assert.equal(JSON.stringify(result).includes(heldEffort), false);
      assert.deepEqual(Reflect.get(result, "appServerModelEvidence"), {
        beforeTurn: { model: "native-model", reasoningEffort: expectedEffort }, reroute: null,
      });
    });
  }
  await t.test("wrong workspace", async () => {
    const transport = server(() => assert.fail("a foreign workspace must receive no assignment"), {
      workspace: "C:\\different-workspace", reasoningEffort: "high",
    });
    const result = await finish(transport, { ...REQUEST, model: "native-model", effort: "low" });
    assert.equal(result.outcome, "refused");
    assert.equal(result.threadId, null);
    assert.equal(result.writerState, "unknown");
    assert.equal(result.requestedModel, "native-model");
    assert.equal(result.requestedEffort, "low");
    assert.deepEqual(transport.calls[0]!.input.map((line) => JSON.parse(line).method), ["initialize", "initialized", "thread/start"]);
    assert.deepEqual(Reflect.get(result, "appServerModelEvidence"), { beforeTurn: null, reroute: null });
  });
  await t.test("different configured model", async () => {
    const transport = server(() => assert.fail("a model mismatch must receive no assignment"), { reasoningEffort: "high" });
    const result = await finish(transport, { ...REQUEST, model: "requested-model", effort: "low" });
    assert.equal(result.outcome, "refused");
    assert.equal(result.turnId, null);
    assert.equal(result.requestedModel, "requested-model");
    assert.equal(result.requestedEffort, "low");
    assert.equal(result.writerState, "unknown");
    assert.deepEqual(transport.calls[0]!.input.map((line) => JSON.parse(line).method), ["initialize", "initialized", "thread/start"]);
    assert.deepEqual(Reflect.get(result, "appServerModelEvidence"), {
      beforeTurn: { model: "native-model", reasoningEffort: "high" }, reroute: null,
    });
  });
  await t.test("overlong thread identity", async () => {
    const transport = server(() => assert.fail("an invalid thread identity must receive no assignment"), {
      threadId: "r".repeat(201), reasoningEffort: longEffort,
    });
    const result = await finish(transport);
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.threadId, null);
    assert.equal(result.writerState, "unknown");
    assert.deepEqual(transport.calls[0]!.input.map((line) => JSON.parse(line).method), ["initialize", "initialized", "thread/start"]);
    assert.deepEqual(Reflect.get(result, "appServerModelEvidence"), { beforeTurn: null, reroute: null });
  });
});

test("app-server late reroutes leave terminal model evidence intact", async t => {
  const earlyReroute = { fromModel: "early-source", toModel: "early-target", reason: "highRiskCyberActivity" };
  const lateReroute = { fromModel: "late-source", toModel: "late-target", reason: "highRiskCyberActivity" };
  for (const prior of ["completed", "held"] as const) {
    await t.test(prior, async () => {
      let native!: NativeEvents;
      const transport = server((events) => {
        native = events;
        if (prior === "held") {
          emit(events, { method: "model/rerouted", params: { threadId: THREAD, turnId: TURN, ...earlyReroute } });
        } else {
          message(events);
        }
        terminal(events);
      }, { reasoningEffort: "high" });
      const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
      const settled = await handle.settled;
      assert.equal(settled.outcome, prior);
      emit(native, { method: "model/rerouted", params: { threadId: THREAD, turnId: TURN, ...lateReroute } });
      const after = handle.snapshot();
      handle.closeInput();
      const closed = await handle.closed;
      assert.deepEqual(transport.calls[0]!.input.map((line) => JSON.parse(line).method),
        ["initialize", "initialized", "thread/start", "turn/start"]);
      for (const observation of [settled, after, closed]) {
        assert.equal(observation.threadId, THREAD);
        assert.equal(observation.turnId, TURN);
        assert.equal(observation.writerState, "unknown");
      }
      for (const observation of [after, closed]) {
        assert.equal(observation.outcome, "held");
        assert.equal(observation.appServerTerminalLineage, null);
        assert.equal(observation.observedModel, "late-target");
      }
      const lineage = prior === "completed" ? { vendor: "codex", interfaceId: "app-server", threadId: THREAD, turnId: TURN } : null;
      assert.deepEqual(settled.appServerTerminalLineage, lineage);
      const evidence = { beforeTurn: { model: "native-model", reasoningEffort: "high" }, reroute: prior === "held" ? earlyReroute : null };
      assert.deepEqual([settled.appServerModelEvidence, after.appServerModelEvidence, closed.appServerModelEvidence],
        [evidence, evidence, evidence]);
    });
  }
});

test("a malformed app-server terminal status does not close reroute evidence", async () => {
  let native!: NativeEvents;
  const transport = server((events) => {
    native = events;
    permission(events);
    emit(events, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: ["completed"], items: [] } } });
  });
  const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
  const settled = await handle.settled;
  const reroute = { fromModel: "after-malformed-source", toModel: "after-malformed-target", reason: "highRiskCyberActivity" };
  emit(native, { method: "model/rerouted", params: { threadId: THREAD, turnId: TURN, ...reroute } });
  const after = handle.snapshot();
  handle.closeInput();
  const closed = await handle.closed;
  assert.deepEqual(transport.calls[0]!.input.map((line) => JSON.parse(line).method),
    ["initialize", "initialized", "thread/start", "turn/start"]);
  for (const observation of [settled, after, closed]) {
    assert.equal(observation.outcome, "held");
    assert.equal(observation.approvalAnswered, false);
    assert.equal(observation.writerState, "unknown");
  }
  assert.equal(settled.appServerModelEvidence.reroute, null);
  assert.deepEqual(after.appServerModelEvidence.reroute, reroute);
  assert.deepEqual(closed.appServerModelEvidence.reroute, reroute);
});

for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
  test(`${method} stays held and is never answered`, async () => {
    const transport = server((events) => permission(events, method));
    const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
    const held = await handle.settled;
    assert.equal(held.outcome, "held");
    assert.equal(held.approvalAnswered, false);
    assert.match(held.reason!, /headless recovery is unqualified/);
    assert.equal(held.observed.nativeApproval, "supported");
    assert.equal(held.observed.assignment, undefined);
    const claim = applyHarnessEvidence(documentedCodexClaim("app-server"), held);
    assert.equal(claimCovers({ vendor: "codex", interfaceId: "cli", capability: "nativeApproval" }, claim), false);
    assert.equal(claimCovers({ vendor: "codex", interfaceId: "app-server", capability: "nativeApproval" }, claim), true);
    assert.equal(handle.interrupt(), true);
    assert.equal(handle.interrupt(), false);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    handle.closeInput();
    const final = await handle.closed;
    assert.equal(final.outcome, "interrupted");
    assert.equal(final.interruptRequest, "acknowledged");
    assert.equal(final.writerState, "unknown");
    const sent = transport.calls[0]!.input.map((value) => JSON.parse(value));
    assert.equal(sent.some((value) => value.id === 100), false);
    assert.deepEqual(sent.at(-1), { id: 4, method: "turn/interrupt", params: { threadId: THREAD, turnId: TURN } });
  });
}

for (const status of ["failed", "interrupted"]) {
  test(`native ${status} is not successful assignment evidence`, async () => {
    const handle = startCodexAppServerAssignment(REQUEST, server((events) => terminal(events, status)), {}, [], LAUNCH);
    const settled = await handle.settled;
    handle.closeInput();
    const closed = await handle.closed;
    for (const result of [settled, closed]) {
      assert.equal(result.outcome, status);
      assert.equal(result.observed.assignment, undefined);
      assert.equal(result.writerState, "unknown");
      assert.equal(result.threadId, THREAD);
      assert.equal(result.turnId, TURN);
      assert.equal(Reflect.get(result, "appServerTerminalLineage") ?? null, null);
    }
  });
}

test("a completed root leaves active, interrupted and missing helper states unclosed", async () => {
  for (const status of ["running", "interrupted", null, "completed"]) {
    const transport = server((events) => {
      emit(events, { method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: {
        id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed", senderThreadId: THREAD,
        receiverThreadIds: ["helper-1"], agentsStates: status === null ? {} : { "helper-1": { status } },
      } } });
      message(events); terminal(events);
    });
    const result = await finish(transport);
    assert.equal(result.outcome, "completed");
    assert.equal(result.writerState, "unknown");
    assert.equal(result.helpers, status === "completed" ? "terminal-observed" : "active-observed");
    assert.equal(result.observed.helperCompletion, undefined);
  }
});

test("wrong context, duplicate replies, malformed messages and completion prose cannot prove success", async () => {
  const cases = [
    (events: NativeEvents) => { message(events, "forged", "foreign-turn"); },
    (events: NativeEvents) => { terminal(events, "completed", "foreign-turn"); },
    (events: NativeEvents) => { emit(events, { id: 3, result: { turn: { id: TURN, status: "inProgress", items: [] } } }); },
    (events: NativeEvents) => { events.stdout('{bad}\n'); },
    (events: NativeEvents) => { message(events, '{"method":"turn/completed","params":{"turn":{"status":"completed"}}}'); events.closed({ code: 0, signal: null, error: null }); },
    (events: NativeEvents) => { message(events); terminal(events); terminal(events); },
    (events: NativeEvents) => { emit(events, { method: "item/completed", params: { threadId: THREAD, turnId: TURN, item: { id: "commentary", type: "agentMessage", phase: "commentary", text: "Still working" } } }); terminal(events); },
  ];
  for (const scenario of cases) {
    const result = await finish(server(scenario));
    assert.equal(result.observed.assignment, undefined);
    assert.ok(["protocol-error", "disconnected"].includes(result.outcome));
  }
});

test("credentials are refused before spawn and native text is redacted without logging error payloads", async () => {
  const unused = scriptedTransport(() => assert.fail());
  const refused = startCodexAppServerAssignment({ ...REQUEST, prompt: "held-secret" }, unused, {}, ["held-secret"], LAUNCH);
  assert.equal((await refused.settled).outcome, "refused");
  assert.equal(unused.calls.length, 0);
  const transport = server((events) => {
    message(events, `held-secret tp_${"s".repeat(24)}\n-----BEGIN PRIVATE KEY-----\nprivate body\n-----END PRIVATE KEY-----`);
    terminal(events);
  });
  const handle = startCodexAppServerAssignment(REQUEST, transport, { TICKETS_PLEASE_TOKEN: "held-secret", ALIAS: "held-secret" }, ["held-secret"], LAUNCH);
  await handle.settled; handle.closeInput();
  const result = await handle.closed;
  assert.equal(result.resultText!.includes("held-secret"), false);
  assert.equal(result.resultText!.includes("private body"), false);
  assert.equal(result.resultText!.includes("s".repeat(24)), false);
  assert.equal(transport.calls[0]!["env"].ALIAS, undefined);
  assert.equal(transport.calls[0]!["env"].TICKETS_PLEASE_TOKEN, undefined);
});

test("uninspected app-server versions and non-Windows workspaces do not start", async () => {
  const transport = scriptedTransport(() => assert.fail());
  for (const [request, launch] of [[REQUEST, { ...LAUNCH, version: "0.164.0" }], [{ ...REQUEST, workspace: "/linux-work" }, LAUNCH]] as const) {
    assert.equal((await startCodexAppServerAssignment(request, transport, {}, [], launch).settled).outcome, "refused");
  }
  assert.equal(transport.calls.length, 0);
});

test("CLI parses native events incrementally and rejects fake result, failed and incomplete streams", async () => {
  for (const [stdout, expected] of [
    [CLI_RESULT, "completed"],
    ['{"type":"result"}\n', "disconnected"],
    [CLI_RESULT.replace('"turn.completed"', '"turn.failed"'), "failed"],
    [CLI_RESULT.split('\n').slice(0, 3).join('\n'), "disconnected"],
    [CLI_RESULT + '{broken}\n', "protocol-error"],
  ]) {
    const transport = scriptedTransport((_input, events) => {
      for (const character of stdout!) events.stdout(character);
    });
    const result = await runCodexCliAssignment(REQUEST, transport, {}, []);
    assert.equal(result.outcome, expected);
    assert.equal(result.observed.assignment, expected === "completed" ? "supported" : undefined);
    assert.equal(result.stdin, "");
    assert.equal(result.writerState, "unknown");
  }
});

test("synthetic subprocess exercises the real streaming app-server transport without a native assignment", async () => {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{userAgent:'fixture',platformFamily:'windows',platformOs:'windows',codexHome:'C:\\\\fixture'}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-1'},model:'native-model',modelProvider:'openai',cwd:'C:\\\\fixture-work',approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:{type:'workspaceWrite'}}});
if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn-1',items:[],status:'inProgress'}}});send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{id:'answer',type:'agentMessage',text:'Synthetic only'}}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',items:[],status:'completed'}}});}
});rl.on('close',()=>process.exit(0));`;
  const actual = processNativeTransport();
  const transport: NativeTransport = { start(_argv, options, events) {
    return actual.start([process.execPath, "-e", script], { ...options, cwd: process.cwd() }, events);
  } };
  const result = await finish(transport);
  assert.equal(result.resultText, "Synthetic only");
  assert.equal(result.outcome, "completed");
  assert.equal(result.writerState, "unknown");
});

for (const status of ["completed", "failed", "interrupted"]) {
  test(`a rejected interrupt preserves the running assignment until its own ${status} result`, async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const transport = server(() => ready(), { interrupt(events, id) {
      emit(events, { id, error: { code: -32600, message: "Synthetic interrupt rejection" } });
      const stillRunning = handle.snapshot();
      assert.equal(stillRunning.outcome, "running");
      assert.equal(stillRunning.threadId, THREAD);
      assert.equal(stillRunning.turnId, TURN);
      assert.equal(Reflect.get(stillRunning, "appServerTerminalLineage") ?? null, null);
      assert.equal(stillRunning.interruptRequest, "rejected");
      assert.equal(stillRunning.resultText, null);
      assert.equal(stillRunning.writerState, "unknown");
      if (status === "completed") message(events, "Result after rejected interruption.");
      terminal(events, status);
    } });
    const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
    await started;
    assert.equal(handle.interrupt(), true);
    assert.equal(handle.snapshot().interruptRequest, "pending");
    const result = await handle.settled;
    assert.equal(result.outcome, status);
    assert.equal(result.interruptRequest, "rejected");
    assert.equal(result.observed.assignment, status === "completed" ? "supported" : undefined);
    assert.equal(result.resultText, status === "completed" ? "Result after rejected interruption." : null);
    assert.equal(JSON.stringify(result).includes("Synthetic interrupt rejection"), false);
    assert.equal(result.writerState, "unknown");
    handle.closeInput();
    assert.equal((await handle.closed).outcome, status);
  });
}

for (const method of ["error", "model/rerouted"]) {
  for (const context of [{ threadId: "helper-thread", turnId: TURN }, { threadId: THREAD, turnId: "stale-turn" }]) {
    test(`${method} from ${context.threadId}/${context.turnId} cannot alter the root assignment`, async () => {
      const transport = server((events) => {
        emit(events, { method, params: { ...context, willRetry: false, error: { message: "Foreign error" }, fromModel: "native-model", toModel: "foreign-model" } });
        const current = handle.snapshot();
        assert.equal(current.outcome, "running");
        assert.equal(current.observedModel, "native-model");
        assert.equal(current.reason, null);
        message(events, "Root result.");
        terminal(events);
      });
      const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
      const result = await handle.settled;
      assert.equal(result.outcome, "completed");
      assert.equal(result.resultText, "Root result.");
      assert.equal(result.observedModel, "native-model");
      assert.equal(result.writerState, "unknown");
      handle.closeInput();
      assert.equal((await handle.closed).outcome, "completed");
    });
  }
}

for (const method of ["error", "model/rerouted"]) {
  test(`${method} for the active root turn still preserves work under a hold`, async () => {
    const transport = server((events) => {
      emit(events, { method, params: { threadId: THREAD, turnId: TURN, willRetry: false, error: { message: "Root error" }, fromModel: "native-model", toModel: "changed-model" } });
    });
    const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
    const result = await handle.settled;
    assert.equal(result.outcome, "held");
    assert.equal(result.observedModel, method === "model/rerouted" ? "changed-model" : "native-model");
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.writerState, "unknown");
    handle.closeInput();
    assert.equal((await handle.closed).outcome, "held");
  });
}

for (const status of ["completed", "failed", "interrupted"]) {
  for (const reply of ["acknowledged", "rejected"]) {
    for (const order of ["reply-first", "terminal-first"]) {
      test(`interrupt ${reply}, ${status} turn, ${order} preserve independent outcomes`, async () => {
        let ready!: () => void;
        const started = new Promise<void>((resolve) => { ready = resolve; });
        const transport = server(() => ready(), { interrupt(events, id) {
          const respond = () => emit(events, reply === "acknowledged"
            ? { id, result: {} }
            : { id, error: { code: -32600, message: "Synthetic rejection" } });
          if (order === "reply-first") respond();
          if (status === "completed") message(events, "Result independent of interrupt reply.");
          terminal(events, status);
          assert.equal(handle.snapshot().outcome, status);
          if (order === "terminal-first") {
            assert.equal(handle.snapshot().interruptRequest, "pending");
            respond();
          }
          assert.equal(handle.snapshot().interruptRequest, reply);
          assert.equal(handle.snapshot().outcome, status);
        } });
        const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
        await started;
        assert.equal(handle.interrupt(), true);
        const atTurnBoundary = await handle.settled;
        assert.equal(atTurnBoundary.outcome, status);
        assert.equal(atTurnBoundary.interruptRequest, order === "terminal-first" ? "pending" : reply);
        handle.closeInput();
        const final = await handle.closed;
        assert.equal(final.outcome, status);
        assert.equal(final.interruptRequest, reply);
        assert.equal(final.writerState, "unknown");
        assert.equal(final.observed.assignment, status === "completed" ? "supported" : undefined);
      });
    }
  }
}

for (const status of ["completed", "failed", "interrupted", "no-terminal"]) {
  test(`close before interrupt reply leaves it unconfirmed after ${status}`, async () => {
    let ready!: () => void;
    let requestSeen!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const requested = new Promise<void>((resolve) => { requestSeen = resolve; });
    const transport = server(() => ready(), { interrupt(events) {
      if (status === "completed") message(events, "Result before lost interrupt reply.");
      if (status !== "no-terminal") terminal(events, status);
      requestSeen();
    } });
    const handle = startCodexAppServerAssignment(REQUEST, transport, {}, [], LAUNCH);
    await started;
    assert.equal(handle.interrupt(), true);
    await requested;
    assert.equal(handle.snapshot().interruptRequest, "pending");
    handle.closeInput();
    const final = await handle.closed;
    assert.equal(final.interruptRequest, "unconfirmed");
    assert.equal(final.outcome, status === "no-terminal" ? "disconnected" : status);
    assert.equal(final.writerState, "unknown");
    assert.equal(final.observed.cancel, undefined);
    assert.equal(final.approvalAnswered, false);
  });
}


test("private-key blocks are removed before exact held values or assignment fragments", () => {
  const body = "SYNTHETIC_PRIVATE_KEY_BODY";
  for (const header of ["-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN OPENSSH PRIVATE KEY--", "-----BEGIN EC PRIVATE KEY", "----BEGIN RSA PRIVATE KEY-----", "BEGIN PRIVATE KEY"]) {
    for (const separator of ["\n", "\r\n", " "]) {
      const key = header + separator + body + separator + "-----END PRIVATE KEY-----";
      const text = "before " + key + " after";
      assert.equal(safeNativeText(text, []), "before [redacted] after");
      assert.equal(safeNativeText(text, [header, "PRIVATE KEY", body]), "before [redacted] after");
      assert.equal(safeNativeText(text, [], header).includes(body), false);
      assert.equal(safeNativeText(text, [], key), "before [assignment input omitted] after");
    }
  }
});

test("unterminated and consecutive private-key blocks never retain their body", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_KEY_BODY";
  assert.equal(safeNativeText("prefix " + key, []), "prefix [redacted]");
  assert.equal(safeNativeText("prefix " + key + "\n-----END PRIVATE KE", []), "prefix [redacted]");
  const complete = key + "\n-----END PRIVATE KEY-----";
  assert.equal(safeNativeText(complete + " middle " + complete + " tail", []), "[redacted] middle [redacted] tail");
  assert.equal(safeNativeText(complete + " middle " + key, []), "[redacted] middle [redacted]");
});

test("private assignment omission still matches after key-block redaction", () => {
  const prompt = "Private instructions -----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_KEY_BODY\n-----END PRIVATE KEY----- next";
  const shown = safeNativeText("echo: " + prompt, ["Private"], prompt);
  assert.equal(shown, "echo: [assignment input omitted]");
});


test("malformed request envelopes cannot masquerade as native replies", async () => {
  for (const method of [null, 42, {}, [], true, "initialize"]) {
    const transport = scriptedTransport((input, events) => {
      const sent = JSON.parse(input);
      if (sent.method === "initialize") emit(events, {
        id: sent.id, method,
        result: { userAgent: "codex/0.163.0", platformFamily: "windows", platformOs: "windows", codexHome: "C:\\own-codex" },
      });
    });
    const result = await finish(transport);
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.writerState, "unknown");
    assert.equal(transport.calls[0]!.input.some(value => JSON.parse(value).method === "thread/start"), false);
  }
});
