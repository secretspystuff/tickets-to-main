import test from "node:test";
import assert from "node:assert/strict";
import { type NativeEvents, type NativeTransport, processNativeTransport } from "../src/native-transport.ts";
import type { AcpAssignmentHandle } from "../src/adapters/acp-session.ts";
import { startCursorAcpAssignment, CURSOR_ACP_VERSION, documentedCursorAcpClaim } from "../src/adapters/cursor.ts";
import { startGrokBuildAcpAssignment, GROK_BUILD_ACP_VERSION, documentedGrokBuildAcpClaim } from "../src/adapters/grok-build.ts";
import { applyHarnessEvidence, checkClaim, claimCovers, type AssignmentRequest } from "../src/adapters/contract.ts";
import { scriptedTransport } from "./native-fixtures.ts";

const REQUEST: AssignmentRequest = { assignmentId: "assignment-fixture", prompt: "Synthetic assignment input.", workspace: "C:\\fixture-work", model: null, effort: null };
const CURSOR = {
  executable: `C:\\Users\\Fixture\\AppData\\Local\\cursor-agent\\versions\\${CURSOR_ACP_VERSION}\\node.exe`,
  entrypoint: `C:\\Users\\Fixture\\AppData\\Local\\cursor-agent\\versions\\${CURSOR_ACP_VERSION}\\index.js`,
  version: CURSOR_ACP_VERSION,
};
const GROK = { executable: "C:\\Users\\Fixture\\.grok\\bin\\grok.exe", version: GROK_BUILD_ACP_VERSION };
const SESSION = "fresh-session";
type Start = (transport: NativeTransport, request?: AssignmentRequest, env?: NodeJS.ProcessEnv, secrets?: readonly string[]) => AcpAssignmentHandle;
const RECIPES: { vendor: "cursor" | "grok-build"; start: Start; argv: string[] }[] = [
  { vendor: "cursor", start: (transport, request = REQUEST, env = {}, secrets = []) => startCursorAcpAssignment(request, transport, env, secrets, CURSOR), argv: [CURSOR.executable, CURSOR.entrypoint, "acp"] },
  { vendor: "grok-build", start: (transport, request = REQUEST, env = {}, secrets = []) => startGrokBuildAcpAssignment(request, transport, env, secrets, GROK), argv: [GROK.executable, "agent", "stdio"] },
];

function emit(events: NativeEvents, message: unknown): void { events.stdout(`${JSON.stringify(message)}\n`); }
function reply(events: NativeEvents, id: number, result: unknown): void { emit(events, { jsonrpc: "2.0", id, result }); }
function update(events: NativeEvents, value: unknown, sessionId = SESSION): void {
  emit(events, { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
}
function chunk(events: NativeEvents, text = "Synthetic result.", sessionId = SESSION): void {
  update(events, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, sessionId);
}
function terminal(events: NativeEvents, stopReason = "end_turn"): void { reply(events, 3, { stopReason }); }
function permission(events: NativeEvents, id: string | number = "permission-1", sessionId = SESSION): void {
  emit(events, { jsonrpc: "2.0", id, method: "session/request_permission", params: {
    sessionId, toolCall: { toolCallId: "native-call", title: "Synthetic operation" },
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject once", kind: "reject_once" }],
  } });
}
function server(
  prompt: (events: NativeEvents) => void,
  options: { cancel?: (events: NativeEvents) => void; initialize?: (events: NativeEvents) => void; session?: (events: NativeEvents) => void; other?: (message: Record<string, unknown>, events: NativeEvents) => void } = {},
) {
  return scriptedTransport((line, events) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (message.method === "initialize") {
      if (options.initialize) options.initialize(events);
      else reply(events, 1, { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "native-login", name: "Native login" }] });
    } else if (message.method === "session/new") {
      if (options.session) options.session(events);
      else reply(events, 2, { sessionId: SESSION, models: { currentModelId: "requested-identity-only" } });
    } else if (message.method === "session/prompt") prompt(events);
    else if (message.method === "session/cancel") options.cancel?.(events);
    else options.other?.(message, events);
  });
}
async function finish(start: Start, transport: NativeTransport, request = REQUEST) {
  const handle = start(transport, request);
  await handle.settled;
  handle.closeInput();
  return handle.closed;
}

for (const { vendor, start, argv } of RECIPES) {
  test(`${vendor} uses its explicit inspected executable, fresh session and ordinary native configuration`, async () => {
    const transport = server((events) => { chunk(events); terminal(events); });
    const result = await finish(start, transport);
    assert.equal(result.vendor, vendor);
    assert.equal(result.interfaceId, "acp");
    assert.equal(result.outcome, "completed");
    assert.equal(result.resultText, "Synthetic result.");
    assert.equal(result.observed.assignment, "supported");
    assert.equal(result.observed.streamResult, "supported");
    assert.equal(result.observedModel, null);
    assert.equal(result.writerState, "unknown");
    assert.equal(result.helpers, "unknown");
    assert.equal(result.observed.helperCompletion, undefined);
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.stdin, "");
    assert.equal(JSON.stringify(result).includes(REQUEST.prompt), false);
    assert.deepEqual(transport.calls[0]!.argv, argv);
    assert.equal(transport.calls[0]!.cwd, REQUEST.workspace);
    const sent = transport.calls[0]!.input.map((line) => JSON.parse(line));
    assert.deepEqual(sent, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "tickets_to_main", version: "0.1.0" },
      } },
      { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: REQUEST.workspace, mcpServers: [] } },
      { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text: REQUEST.prompt }] } },
    ]);
  });

  test(`${vendor} never authenticates or substitutes an API key on native auth-required`, async () => {
    const transport = server(() => assert.fail("Unauthenticated session must not receive a prompt"), { session(events) {
      emit(events, { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "Do not retain secret error detail" } });
    } });
    const result = await finish(start, transport);
    assert.equal(result.outcome, "held");
    assert.match(result.reason!, /native sign-in/);
    assert.equal(JSON.stringify(result).includes("secret error detail"), false);
    assert.equal(transport.calls[0]!.input.length, 2);
  });

  test(`${vendor} permission is held indefinitely without answering or granting native-approval capability`, async () => {
    let eventsRef!: NativeEvents;
    const transport = server((events) => { eventsRef = events; permission(events); });
    const handle = start(transport);
    const result = await handle.settled;
    assert.equal(result.outcome, "held");
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.observed.nativeApproval, undefined);
    assert.equal(transport.calls[0]!.input.length, 3);
    terminal(eventsRef);
    assert.equal(handle.snapshot().outcome, "held");
    assert.equal(handle.snapshot().observed.assignment, undefined);
    handle.closeInput();
    assert.equal((await handle.closed).writerState, "unknown");
  });

  test(`${vendor} cancel is one notification plus cancelled pending permissions; only cancelled prompt confirms it`, async () => {
    const transport = server((events) => { permission(events, 0); permission(events, "permission-2"); }, {
      cancel(events) { chunk(events, "Late native progress after cancel."); },
      other(message, events) { if (message.id === "permission-2") terminal(events, "cancelled"); },
    });
    const handle = start(transport);
    await handle.settled;
    assert.equal(handle.interrupt(), true);
    assert.equal(handle.interrupt(), false);
    assert.equal(handle.snapshot().interruptRequest, "pending");
    handle.closeInput();
    const result = await handle.closed;
    assert.equal(result.outcome, "interrupted");
    assert.equal(result.interruptRequest, "acknowledged");
    assert.equal(result.writerState, "unknown");
    assert.equal(result.observed.cancel, undefined);
    assert.equal(result.approvalAnswered, false);
    assert.deepEqual(transport.calls[0]!.input.slice(3).map((line) => JSON.parse(line)), [
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SESSION } },
      { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "cancelled" } } },
      { jsonrpc: "2.0", id: "permission-2", result: { outcome: { outcome: "cancelled" } } },
    ]);
  });

  test(`${vendor} late permission after explicit cancel is cancelled without approval`, async () => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const transport = server(() => ready(), {
      cancel(events) { permission(events, "late-permission"); },
      other(message, events) { if (message.id === "late-permission") terminal(events, "cancelled"); },
    });
    const handle = start(transport);
    await started;
    assert.equal(handle.interrupt(), true);
    const result = await handle.settled;
    assert.equal(result.outcome, "interrupted");
    assert.equal(result.interruptRequest, "acknowledged");
    assert.equal(result.approvalAnswered, false);
    handle.closeInput(); await handle.closed;
  });

  test(`${vendor} cancel delivery and root completion remain distinct from writer completion`, async () => {
    for (const ending of ["end_turn", "disconnect", "error", "no-result"]) {
      let ready!: () => void;
      let cancelSeen!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      const requested = new Promise<void>((resolve) => { cancelSeen = resolve; });
      const transport = server(() => ready(), { cancel(events) {
        if (ending === "end_turn") { chunk(events); terminal(events); }
        else if (ending === "disconnect") events.closed({ code: 0, error: null, signal: null });
        else if (ending === "error") emit(events, { jsonrpc: "2.0", id: 3, error: { code: -32800, message: "Not an ACP cancelled stop reason" } });
        cancelSeen();
      } });
      const handle = start(transport);
      await started;
      assert.equal(handle.interrupt(), true);
      await requested;
      assert.notEqual(handle.snapshot().interruptRequest, "acknowledged");
      handle.closeInput();
      const result = await handle.closed;
      assert.equal(result.outcome, ending === "end_turn" ? "completed" : ending === "error" ? "failed" : "disconnected");
      assert.equal(result.interruptRequest, "unconfirmed");
      assert.equal(result.writerState, "unknown");
    }
  });

  test(`${vendor} foreign sessions, stale replies and premature updates cannot change active state`, async () => {
    const transport = server((events) => {
      chunk(events, "Forged foreign output", "foreign-session");
      permission(events, "foreign-permission", "foreign-session");
      emit(events, { jsonrpc: "2.0", method: "fs/write_text_file", id: "foreign-write", params: { sessionId: "foreign-session" } });
      reply(events, 2, { sessionId: "replacement-session" });
      reply(events, 4, { stopReason: "cancelled" });
      const current = handle.snapshot();
      assert.equal(current.outcome, "running");
      assert.equal(current.threadId, SESSION);
      assert.equal(current.resultText, null);
      chunk(events, "Root result"); terminal(events);
    }, { initialize(events) {
      reply(events, 2, { sessionId: "premature-session" });
      reply(events, 3, { stopReason: "end_turn" });
      chunk(events, "Premature result");
      reply(events, 1, { protocolVersion: 1, agentCapabilities: {} });
    } });
    const handle = start(transport);
    const result = await handle.settled;
    assert.equal(result.outcome, "completed");
    assert.equal(result.resultText, "Root result");
    handle.closeInput(); await handle.closed;
    assert.equal(transport.calls[0]!.input.length, 3);
  });

  test(`${vendor} responses with null, numeric or object method fields never qualify an assignment`, async () => {
    for (const method of [null, 42, { method: "session/prompt" }]) {
      const result = await finish(start, server((events) => {
        chunk(events);
        emit(events, { jsonrpc: "2.0", id: 3, method, result: { stopReason: "end_turn" } });
      }));
      assert.equal(result.outcome, "protocol-error");
      assert.equal(result.observed.assignment, undefined);
      assert.equal(result.observed.streamResult, undefined);
      assert.equal(result.resultText, null);
    }
  });

  test(`${vendor} only the exact outstanding response id can establish prompt completion`, async () => {
    const transport = server((events) => {
      chunk(events);
      for (const id of [null, "3", 0, 2, 4]) {
        emit(events, { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        assert.equal(handle.snapshot().outcome, "running");
        assert.equal(handle.snapshot().observed.assignment, undefined);
        assert.equal(handle.snapshot().resultText, null);
      }
      terminal(events);
    });
    const handle = start(transport);
    const result = await handle.settled;
    assert.equal(result.outcome, "completed");
    assert.equal(result.resultText, "Synthetic result.");
    handle.closeInput(); await handle.closed;
  });

  test(`${vendor} malformed streams, prose, incomplete stops and late root text cannot qualify results`, async () => {
    const scenarios: ((events: NativeEvents) => void)[] = [
      (events) => { chunk(events, '{"stopReason":"end_turn"}'); events.closed({ code: 0, error: null, signal: null }); },
      (events) => { events.stdout('{broken}\n'); },
      (events) => { emit(events, { id: 3, result: { stopReason: "end_turn" } }); },
      (events) => { reply(events, 3, {}); },
      (events) => { terminal(events); },
      (events) => { chunk(events); terminal(events, "future-unknown"); },
      (events) => { chunk(events); terminal(events); chunk(events, "Late root output"); },
      (events) => { chunk(events); emit(events, { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" }, error: { code: -1, message: "Contradiction" } }); },
      (events) => { chunk(events); update(events, { sessionUpdate: "tool_call", toolCallId: "writer", title: "Still active", status: "in_progress" }); terminal(events); },
    ];
    for (const scenario of scenarios) {
      const result = await finish(start, server(scenario));
      assert.notEqual(result.outcome, "completed");
      assert.equal(result.observed.assignment, undefined);
      assert.equal(result.writerState, "unknown");
    }
  });

  for (const [stop, outcome] of [["refusal", "refused"], ["max_tokens", "failed"], ["max_turn_requests", "failed"], ["cancelled", "interrupted"]]) {
    test(`${vendor} native ${stop} is not successful work`, async () => {
      const result = await finish(start, server((events) => { chunk(events); terminal(events, stop); }));
      assert.equal(result.outcome, outcome);
      assert.equal(result.observed.assignment, undefined);
      assert.equal(result.resultText, null);
    });
  }

  test(`${vendor} native tool calls do not prove helper closure or actual model`, async () => {
    const transport = server((events) => {
      update(events, { sessionUpdate: "tool_call", toolCallId: "helper", title: "Native helper", status: "in_progress", rawInput: { model: "untrusted-model" } });
      update(events, { sessionUpdate: "tool_call_update", toolCallId: "helper", status: "completed" });
      update(events, { sessionUpdate: "current_mode_update", currentModeId: "agent" });
      update(events, { sessionUpdate: "usage_update", used: 5, size: 100 });
      emit(events, { jsonrpc: "2.0", method: "cursor/task", params: { toolCallId: "helper", description: "Completed", agentId: "helper-id", durationMs: 1, model: "helper-model" } });
      chunk(events); terminal(events);
    });
    const result = await finish(start, transport);
    assert.equal(result.outcome, "completed");
    assert.equal(result.helpers, "unknown");
    assert.equal(result.observedModel, null);
    assert.equal(result.observed.usageObservation, undefined);
    assert.equal(result.observed.helperCompletion, undefined);
    assert.equal(result.writerState, "unknown");
  });

  test(`${vendor} protocol buffer bounds fail safely without imposing a time or turn limit`, async () => {
    for (const prompt of [
      (events: NativeEvents) => { events.stdout("x".repeat(1024 * 1024 + 1)); },
      (events: NativeEvents) => { chunk(events, "x".repeat(600_000)); chunk(events, "x".repeat(600_000)); terminal(events); },
    ]) {
      const result = await finish(start, server(prompt));
      assert.equal(result.outcome, "protocol-error");
      assert.equal(result.observed.assignment, undefined);
    }
  });

  test(`${vendor} credentials are refused pre-spawn and split streamed credentials are never exposed`, async () => {
    const unused = scriptedTransport(() => assert.fail());
    for (const request of [{ ...REQUEST, prompt: "held-secret" }, { ...REQUEST, model: "held-secret" }, { ...REQUEST, effort: "held-secret" }]) {
      const result = await start(unused, request, {}, ["held-secret"]).settled;
      assert.equal(result.outcome, "refused");
      assert.equal(JSON.stringify(result).includes("held-secret"), false);
    }
    assert.equal(unused.calls.length, 0);
    const transport = server((events) => {
      chunk(events, "held-");
      assert.equal(handle.snapshot().resultText, null);
      chunk(events, `secret tp_${"s".repeat(24)} ${REQUEST.prompt}\n-----BEGIN PRIVATE KEY-----\nprivate body\n-----END PRIVATE KEY-----`);
      terminal(events);
    });
    const handle = start(transport, REQUEST, {
      TICKETS_PLEASE_TOKEN: "held-secret", ALIAS: "held-secret", OPENAI_API_KEY: "other-value", ANTHROPIC_API_KEY: "other-value",
      CURSOR_API_KEY: "cursor-native-value", XAI_API_KEY: "grok-native-value", GITHUB_TOKEN: "other-value", PATH: "inherited-path",
    }, ["held-secret"]);
    await handle.settled; handle.closeInput();
    const result = await handle.closed;
    for (const secret of ["held-secret", "s".repeat(24), "private body", REQUEST.prompt]) assert.equal(JSON.stringify(result).includes(secret), false);
    assert.match(result.resultText!, /\[redacted\]/);
    const env = transport.calls[0]!.env;
    for (const name of ["TICKETS_PLEASE_TOKEN", "ALIAS", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) assert.equal(env[name], undefined);
    assert.equal(env[ vendor === "cursor" ? "XAI_API_KEY" : "CURSOR_API_KEY" ], undefined);
    assert.equal(env[ vendor === "cursor" ? "CURSOR_API_KEY" : "XAI_API_KEY" ], vendor === "cursor" ? "cursor-native-value" : "grok-native-value");
    assert.equal(env.PATH, "inherited-path");
  });

  test(`${vendor} unsupported selection is refused without guessing flags or actual model`, async () => {
    const transport = scriptedTransport(() => assert.fail());
    for (const request of [{ ...REQUEST, model: "requested-model" }, { ...REQUEST, effort: "high" }]) {
      const result = await start(transport, request).settled;
      assert.equal(result.outcome, "refused");
      assert.equal(result.requestedModel, request.model);
      assert.equal(result.requestedEffort, request.effort);
      assert.equal(result.observedModel, null);
    }
    assert.equal(transport.calls.length, 0);
  });
}

for (const method of ["cursor/ask_question", "cursor/create_plan"]) {
  test(`${method} requires a live native tool correlation and is never answered`, async () => {
    const transport = server((events) => {
      emit(events, { jsonrpc: "2.0", id: "foreign-question", method, params: { toolCallId: "foreign-call" } });
      assert.equal(handle.snapshot().outcome, "running");
      update(events, { sessionUpdate: "tool_call", toolCallId: "question-call", title: "Native decision", status: "in_progress" });
      emit(events, { jsonrpc: "2.0", id: "foreign-session-question", method, params: { sessionId: "foreign-session", toolCallId: "question-call" } });
      assert.equal(handle.snapshot().outcome, "running");
      emit(events, { jsonrpc: "2.0", id: "root-question", method, params: { toolCallId: "question-call" } });
    });
    const handle = RECIPES[0]!.start(transport);
    const result = await handle.settled;
    assert.equal(result.outcome, "held");
    assert.equal(result.approvalAnswered, false);
    assert.equal(transport.calls[0]!.input.length, 3);
    handle.closeInput(); await handle.closed;
  });
}

test("uninspected versions, ambiguous launchers, cross-version Cursor entrypoints and non-Windows workspaces never spawn", async () => {
  const transport = scriptedTransport(() => assert.fail());
  for (const launch of [
    { ...CURSOR, version: "future-version" }, { ...CURSOR, executable: "agent" },
    { ...CURSOR, entrypoint: CURSOR.entrypoint.replace(CURSOR_ACP_VERSION, "another-version") },
    { ...CURSOR, executable: CURSOR.executable.replace("node.exe", "agent.exe") },
  ]) assert.equal((await startCursorAcpAssignment(REQUEST, transport, {}, [], launch).settled).outcome, "refused");
  for (const launch of [{ ...GROK, version: "1.0.71" }, { ...GROK, executable: "agent" }, { ...GROK, executable: GROK.executable.replace("grok.exe", "agent.exe") }]) {
    assert.equal((await startGrokBuildAcpAssignment(REQUEST, transport, {}, [], launch).settled).outcome, "refused");
  }
  for (const { start } of RECIPES) assert.equal((await start(transport, { ...REQUEST, workspace: "/linux-probe" }).settled).outcome, "refused");
  assert.equal(transport.calls.length, 0);
});

test("separate assignments never reuse a process, session or pending permission state", async () => {
  let index = 0;
  const transport = scriptedTransport((line, events) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") reply(events, 1, { protocolVersion: 1, agentCapabilities: {} });
    if (message.method === "session/new") reply(events, 2, { sessionId: `fresh-${++index}` });
    if (message.method === "session/prompt") {
      chunk(events, "foreign result", message.params.sessionId === "fresh-1" ? "fresh-2" : "fresh-1");
      chunk(events, `own-${message.params.sessionId}`, message.params.sessionId);
      terminal(events);
    }
  });
  const a = RECIPES[0]!.start(transport);
  const b = RECIPES[0]!.start(transport, { ...REQUEST, assignmentId: "another-assignment" });
  const results = await Promise.all([a.settled, b.settled]);
  assert.equal(transport.calls.length, 2);
  assert.notEqual(results[0]!.threadId, results[1]!.threadId);
  for (const result of results) assert.equal(result.resultText, `own-${result.threadId}`);
  a.closeInput(); b.closeInput(); await Promise.all([a.closed, b.closed]);
});

test("ACP fixtures never qualify another vendor or CLI, editor, remote or actual runtime path", async () => {
  for (const [index, claim] of [documentedCursorAcpClaim(), documentedGrokBuildAcpClaim()].entries()) {
    assert.deepEqual(checkClaim(claim), []);
    assert.equal(claim.personFacing, false);
    assert.equal(claim.qualification, "documented");
    const evidence = await finish(RECIPES[index]!.start, server((events) => { chunk(events); terminal(events); }));
    const scored = applyHarnessEvidence(claim, evidence);
    assert.equal(scored.qualification, "harness-passed");
    assert.equal(scored.personFacing, false);
    assert.equal(claimCovers({ vendor: claim.vendor, interfaceId: "cli", capability: "assignment" }, scored), false);
    assert.equal(claimCovers({ vendor: "grok-bot", interfaceId: "acp", capability: "assignment" }, scored), false);
    assert.equal(claimCovers({ vendor: claim.vendor, interfaceId: "acp", capability: "helperCompletion" }, scored), false);
  }
});

test("synthetic subprocess uses real NDJSON transport without native assignment or login", async () => {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
if(m.method==='session/new')send({id:m.id,result:{sessionId:'fresh-session'}});
if(m.method==='session/prompt'){send({method:'session/update',params:{sessionId:'fresh-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Synthetic only'}}}});send({id:m.id,result:{stopReason:'end_turn'}});}
});rl.on('close',()=>process.exit(0));`;
  const actual = processNativeTransport();
  const transport: NativeTransport = { start(_argv, options, events) {
    return actual.start([process.execPath, "-e", script], { ...options, cwd: process.cwd() }, events);
  } };
  const result = await finish(RECIPES[1]!.start, transport);
  assert.equal(result.outcome, "completed");
  assert.equal(result.resultText, "Synthetic only");
  assert.equal(result.writerState, "unknown");
});
