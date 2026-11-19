import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_CLI_VERSION, documentedClaudeClaim, startClaudeCliAssignment } from "../src/adapters/claude.ts";
import { applyHarnessEvidence, type AssignmentObservation } from "../src/adapters/contract.ts";
import { processNativeTransport, type NativeEvents, type NativeTransport } from "../src/native-transport.ts";
import { startClaudeWindowsProbe, type ClaudeWindowsProbeOptions } from "./claude-windows-probe.ts";

const EXECUTABLE = "C:\\fixture-tools\\2.1.326\\claude.exe";
const WORKSPACE = "C:\\fixture-checkout";
const FIXTURE_RESULT = "T3-FIXTURE-OK";
const MODEL = "claude-haiku-5-5";

type Frame = Record<string, unknown>;

function fixture(overrides: Partial<ClaudeWindowsProbeOptions> = {}) {
  const writes: Frame[] = [];
  const launches: { argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  let output!: NativeEvents;
  let eof = 0;
  let nextFrame = 0;
  const transport: NativeTransport = {
    start(argv, options, events) {
      launches.push({ argv, ...options });
      output = events;
      queueMicrotask(events.spawned);
      return {
        write(text) { writes.push(JSON.parse(text) as Frame); return true; },
        endInput() { eof++; },
      };
    },
  };
  const handle = startClaudeWindowsProbe({
    executable: EXECUTABLE, version: "2.1.326", workspace: WORKSPACE, planOnlyVerified: true,
    env: {}, mode: "fresh", ...overrides,
  }, transport);
  const user = writes[0];
  const session = user?.session_id;
  const input = user?.uuid;
  const emitBatch = (...frames: Frame[]) => output.stdout(frames.map(frame => JSON.stringify(frame) + "\n").join(""));
  const emit = (frame: Frame) => emitBatch(frame);
  const scoped = (frame: Frame) => emit({ session_id: session, uuid: "event-" + ++nextFrame, ...frame });
  const init = (more: Frame = {}) => scoped({
    type: "system", subtype: "init", claude_code_version: "2.1.326", cwd: WORKSPACE,
    model: MODEL, permissionMode: "default", apiKeySource: "none", capabilities: ["interrupt_receipt_v1"], ...more,
  });
  const assistant = (more: Frame = {}) => scoped({
    type: "assistant", user_message_uuid: input, parent_tool_use_id: null,
    message: { model: MODEL, content: [{ type: "text", text: FIXTURE_RESULT }] }, ...more,
  });
  const result = (more: Frame = {}) => scoped({
    type: "result", subtype: "success", is_error: false, user_message_uuid: input,
    stop_reason: "end_turn", num_turns: 1, permission_denials: [], result: FIXTURE_RESULT, ...more,
  });
  const streamStarted = (more: Frame = {}) => scoped({
    type: "stream_event", parent_tool_use_id: null, user_message_uuid: input, event: { type: "message_start" }, ...more,
  });
  const textDelta = (more: Frame = {}) => scoped({
    type: "stream_event", parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "fabricated" } }, ...more,
  });
  const receipt = (more: Frame = {}, inner: Frame = {}) => emit({
    type: "control_response",
    response: { request_id: writes[1]?.request_id, subtype: "success", response: { still_queued: [] }, ...inner },
    ...more,
  });
  const lifecycle = (state: string, more: Frame = {}) => scoped({ type: "command_lifecycle", command_uuid: input, state, ...more });
  const startInput = () => { lifecycle("queued"); lifecycle("started"); streamStarted(); };
  const interruptResult = (more: Frame = {}) => result({
    subtype: "error_during_execution", is_error: true, stop_reason: null, result: undefined, ...more,
  });
  async function close(code: number) {
    await Promise.resolve();
    output.closed({ code, signal: null, error: null });
    return handle.closed;
  }
  return {
    handle, launches, writes, input, session, emit, emitBatch, scoped, init, assistant, result, streamStarted, textDelta, receipt,
    lifecycle, startInput, interruptResult, loseInput: () => output.inputError(), close, get eof() { return eof; },
  };
}

test("the shipping adapter keeps only 2.1.317 and refuses the test candidate before spawn", async () => {
  assert.equal(CLAUDE_CLI_VERSION, "2.1.317");
  const unused: NativeTransport = { start() { assert.fail("shipping adapter spawned an unqualified version"); } };
  const result = await startClaudeCliAssignment({
    assignmentId: "pin-check", prompt: "Fabricated only", workspace: WORKSPACE, model: MODEL, effort: "low",
  }, unused, {}, [], { executable: EXECUTABLE, version: "2.1.326" }).closed;
  assert.equal(result.outcome, "refused");
  assert.equal(result.spawned, false);
  assert.equal(documentedClaudeClaim().personFacing, false);
  assert.equal(documentedClaudeClaim().capabilities.cancel, "unavailable");
});

test("the test candidate refuses a mismatched pin, unsafe paths, or missing plan proof before spawn", async () => {
  for (const options of [
    { version: "2.1.317" }, { version: "2.1.327" }, { version: "2.1.326+other" },
    { executable: "C:\\fixture-tools\\claude.cmd" }, { executable: "C:claude.exe" },
    { executable: "\\\\fixture-share\\tools\\claude.exe" }, { workspace: "C:fixture-checkout" },
    { planOnlyVerified: false },
    { env: { anthropic_api_key: "fabricated-substitute" } },
    { env: { CLAUDE_CODE_OAUTH_TOKEN: "fabricated-substitute" } },
    { env: { CLAUDE_CODE_USE_BEDROCK: "1" } }, { env: { Anthropic_Base_Url: "fabricated-endpoint" } },
    { env: { claude_config_dir: "C:\\foreign-profile" } }, { env: { GiT_DiR: "C:\\foreign-git" } },
  ]) {
    const current = fixture(options);
    assert.equal((await current.handle.closed).outcome, "refused");
    assert.deepEqual(current.launches, []);
  }
});

test("the candidate uses fixed fabricated input and only promotes a clean, bound semantic root result", async () => {
  const current = fixture();
  current.init();
  current.assistant();
  current.result();
  assert.equal(current.eof, 1);
  const observation = await current.close(0);
  assert.equal(observation.outcome, "root-result");
  assert.equal(observation.resultMatches, true);
  assert.equal(observation.writerState, "unknown");
  assert.equal(observation.requestedModel, MODEL);
  assert.equal(observation.observedModel, MODEL);
  assert.equal(observation.requestedEffort, "low");
  assert.equal(observation.effectiveEffort, "unknown");
  assert.equal(observation.version, "2.1.326");
  assert.equal(observation.scope, "fabricated");
  assert.ok(["vendor", "interfaceId", "observed"].every(key => !(key in observation)));
  const shipping = documentedClaudeClaim();
  assert.throws(() => applyHarnessEvidence(shipping, observation as unknown as AssignmentObservation), /cannot qualify cli-stream-json/);
  assert.equal(current.writes.length, 1);
  assert.deepEqual(current.launches[0]?.argv, [
    EXECUTABLE, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--session-id", current.session, "--model=" + MODEL, "--effort=low",
  ]);
  assert.equal(JSON.stringify(observation).includes(FIXTURE_RESULT), false);
  assert.equal(JSON.stringify(observation).includes(String(current.session)), false);
});

test("native init pin, workspace, session and auth cannot be inferred from launch arguments", async () => {
  for (const more of [
    { claude_code_version: "2.1.317" }, { claude_code_version: "2.1.327" }, { session_id: "other" },
    { cwd: "C:\\other" }, { permissionMode: "bypassPermissions" }, { apiKeySource: "user" },
    { agent_id: "helper", parent_tool_use_id: "helper" },
  ]) {
    const current = fixture();
    current.init(more);
    current.assistant();
    current.result();
    assert.equal((await current.close(0)).outcome, "protocol-error");
  }
});

test("native defaults and helper models stay separate from the observed root model", async () => {
  const current = fixture();
  current.init({ effort: "high" });
  current.assistant({ parent_tool_use_id: "helper", agent_id: "helper",
    message: { model: "claude-opus-5-5", content: [] }, error: "authentication_failed" });
  current.scoped({ type: "system", subtype: "permission_denied", agent_id: "helper" });
  current.assistant({ message: { model: "claude-sonnet-5-5", content: [] }, effort: "max" });
  current.result();
  const observed = await current.close(0);
  assert.equal(observed.outcome, "root-result");
  assert.equal(observed.requestedModel, MODEL);
  assert.equal(observed.initialModel, MODEL);
  assert.equal(observed.observedModel, "claude-sonnet-5-5");
  assert.equal(observed.effectiveEffort, "unknown");
  assert.equal(observed.helperActivity, "observed");
  assert.equal(observed.writerState, "unknown");
});

test("a helper result, unbound root result, text mismatch and late writer observation never clear the probe", async () => {
  for (const more of [
    { agent_id: "helper", parent_tool_use_id: "helper" }, { session_id: "other-session" },
    { user_message_uuid: "other-input" }, { user_message_uuids: ["foreign", "another"] },
    { origin: { kind: "task-notification" } }, { resume_reason: "interrupted_turn" },
    { result: "some other text" }, { permission_denials: [{ tool_name: "Bash" }] },
  ]) {
    const current = fixture();
    current.init();
    current.assistant();
    current.result(more);
    assert.notEqual((await current.close(0)).outcome, "root-result");
  }
  const missingRoot = fixture();
  missingRoot.init();
  missingRoot.assistant({ parent_tool_use_id: "helper", agent_id: "helper" });
  missingRoot.result();
  const missingRootResult = await missingRoot.close(0);
  assert.notEqual(missingRootResult.outcome, "root-result");
  assert.equal(missingRootResult.observedModel, null);
  const late = fixture();
  late.init();
  late.assistant();
  late.result();
  late.scoped({ type: "system", subtype: "task_notification", task_id: "delayed-helper", status: "completed" });
  const lateResult = await late.close(0);
  assert.equal(lateResult.outcome, "protocol-error");
  assert.equal(lateResult.writerState, "unknown");
});

test("an interrupt needs a bound root stream, the native feature and one correlated receipt", async () => {
  const current = fixture({ mode: "interrupt" });
  current.init();
  current.streamStarted({ parent_tool_use_id: "helper" });
  current.textDelta({ parent_tool_use_id: "helper" });
  assert.equal(current.writes.length, 1);
  current.startInput();
  current.textDelta();
  const request = current.writes[1];
  assert.equal(request?.type, "control_request");
  assert.deepEqual(request?.request, { subtype: "interrupt" });
  assert.equal(typeof request?.request_id, "string");
  current.textDelta();
  assert.equal(current.writes.length, 2);
  current.receipt();
  current.lifecycle("cancelled");
  current.interruptResult();
  const result = await current.close(1);
  assert.equal(result.outcome, "root-interrupted");
  assert.equal(result.interrupt, "acknowledged");
  assert.equal(result.writerState, "unknown");
  assert.equal(current.eof, 1);
});

test("wrong, duplicate, malformed, or unrequested receipts cannot establish cancellation", async () => {
  const wrongReceiptCases = [
    (current: ReturnType<typeof fixture>) => current.receipt({}, { request_id: "foreign-receipt" }),
    (current: ReturnType<typeof fixture>) => current.receipt({ session_id: "foreign" }),
    (current: ReturnType<typeof fixture>) => current.receipt({}, { session_id: "foreign" }),
    (current: ReturnType<typeof fixture>) => current.receipt({ agent_id: "helper", parent_tool_use_id: "helper" }),
    (current: ReturnType<typeof fixture>) => current.receipt({}, { response: {} }),
    (current: ReturnType<typeof fixture>) => current.receipt({}, { response: { still_queued: ["other-input"] } }),
    (current: ReturnType<typeof fixture>) => current.receipt({}, { response: { still_queued: [], cancelled: ["other-input"] } }),
    (current: ReturnType<typeof fixture>) => current.receipt({}, { subtype: "error" }),
    (current: ReturnType<typeof fixture>) => { current.receipt(); current.receipt(); },
    (_current: ReturnType<typeof fixture>) => {},
  ];
  for (const sendReceipt of wrongReceiptCases) {
    const current = fixture({ mode: "interrupt" });
    current.init();
    current.startInput();
    current.textDelta();
    sendReceipt(current);
    current.lifecycle("cancelled");
    current.interruptResult();
    const result = await current.close(1);
    assert.notEqual(result.outcome, "root-interrupted");
    assert.notEqual(result.interrupt, "acknowledged");
  }
  const unsolicited = fixture({ mode: "interrupt" });
  unsolicited.receipt({}, { request_id: "never-sent" });
  assert.equal((await unsolicited.close(0)).outcome, "protocol-error");
});

test("missing capability, unbound deltas and a denial cannot issue a control request", async () => {
  const missingFeature = fixture({ mode: "interrupt" });
  missingFeature.init({ capabilities: [] });
  missingFeature.startInput();
  missingFeature.textDelta();
  missingFeature.interruptResult();
  assert.notEqual((await missingFeature.close(1)).outcome, "root-interrupted");
  assert.equal(missingFeature.writes.length, 1);

  const unbound = fixture({ mode: "interrupt" });
  unbound.init();
  unbound.textDelta();
  unbound.interruptResult();
  assert.notEqual((await unbound.close(1)).outcome, "root-interrupted");
  assert.equal(unbound.writes.length, 1);

  const held = fixture({ mode: "interrupt" });
  held.init();
  held.emit({ type: "control_request", request_id: "permission-fixture", request: { subtype: "can_use_tool" } });
  held.startInput();
  held.textDelta();
  held.interruptResult();
  assert.equal((await held.close(1)).outcome, "held");
  assert.equal(held.writes.length, 1);
});

test("a valid interrupt receipt cannot turn the wrong result, exit or late result into completion", async () => {
  for (const [resultFields, exit] of [
    [{ user_message_uuid: "foreign" }, 1], [{}, 0], [{ subtype: "success", is_error: false, result: FIXTURE_RESULT }, 0],
  ] as const) {
    const current = fixture({ mode: "interrupt" });
    current.init();
    current.startInput();
    current.textDelta();
    current.receipt();
    current.lifecycle("cancelled");
    current.interruptResult(resultFields);
    assert.notEqual((await current.close(exit)).outcome, "root-interrupted");
    current.textDelta();
    assert.equal(current.writes.length, 2);
  }
});

test("a foreign command, a lost input channel and an uncancelled lifecycle stay unconfirmed", async () => {
  const foreign = fixture({ mode: "interrupt" });
  foreign.init();
  foreign.lifecycle("queued");
  foreign.lifecycle("started", { command_uuid: "different-input" });
  foreign.streamStarted();
  foreign.textDelta();
  foreign.interruptResult();
  assert.notEqual((await foreign.close(1)).outcome, "root-interrupted");
  assert.equal(foreign.writes.length, 1);

  for (const loseInput of [true, false]) {
    const current = fixture({ mode: "interrupt" });
    current.init();
    current.startInput();
    current.textDelta();
    if (loseInput) current.loseInput();
    current.receipt();
    current.interruptResult();
    const result = await current.close(1);
    assert.notEqual(result.outcome, "root-interrupted");
    assert.notEqual(result.interrupt, "acknowledged");
  }
});

test("an eligible delta cannot send a late interrupt if the same stdout chunk holds or terminates", async () => {
  for (const lastFrame of [
    { type: "control_request", request_id: "permission-fixture", request: { subtype: "can_use_tool" } },
    { type: "result", subtype: "error_during_execution", is_error: true, permission_denials: [] },
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } },
  ]) {
    const current = fixture({ mode: "interrupt" });
    current.init();
    current.startInput();
    current.emitBatch({
      type: "stream_event", session_id: current.session, uuid: "delta", parent_tool_use_id: null,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "fabricated" } },
    }, { session_id: current.session, uuid: "last", user_message_uuid: current.input, ...lastFrame });
    const result = await current.close(1);
    assert.notEqual(result.outcome, "root-interrupted");
    assert.equal(current.writes.length, 1);
  }
});

test("a completed lifecycle and a duplicate receipt after a provisional result refuse control evidence", async () => {
  const ended = fixture({ mode: "interrupt" });
  ended.init();
  ended.startInput();
  ended.emitBatch({
    type: "stream_event", session_id: ended.session, uuid: "delta", parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "fabricated" } },
  }, {
    type: "command_lifecycle", session_id: ended.session, uuid: "already-completed", command_uuid: ended.input,
    state: "completed",
  });
  ended.interruptResult();
  assert.equal(ended.writes.length, 1);
  assert.notEqual((await ended.close(0)).outcome, "root-interrupted");

  const duplicate = fixture({ mode: "interrupt" });
  duplicate.init();
  duplicate.startInput();
  duplicate.textDelta();
  duplicate.receipt();
  duplicate.lifecycle("cancelled");
  duplicate.interruptResult();
  duplicate.receipt();
  const observation = await duplicate.close(1);
  assert.equal(observation.outcome, "protocol-error");
  assert.equal(observation.interrupt, "unconfirmed");
});

test("the real subprocess transport runs the controller against a local fabricated executable", async () => {
  const script = [
    "const reader = require('node:readline').createInterface({input:process.stdin})",
    "let input",
    "const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n')",
    "const emit = frame => send({session_id: input.session_id, uuid: 'fixture-' + frame.type + '-' + (frame.state ?? frame.subtype ?? ''), ...frame})",
    "reader.on('line', line => {",
    "  const frame = JSON.parse(line)",
    "  if (frame.type === 'user') {",
    "    input = frame",
    '    emit({type:"system",subtype:"init",claude_code_version:"2.1.326",cwd:"C:\\\\fixture-checkout",permissionMode:"default",apiKeySource:"none",model:"claude-haiku-5-5",capabilities:["interrupt_receipt_v1"]})',
    '    emit({type:"command_lifecycle",command_uuid:input.uuid,state:"queued"})',
    '    emit({type:"command_lifecycle",command_uuid:input.uuid,state:"started"})',
    '    emit({type:"stream_event",parent_tool_use_id:null,user_message_uuid:input.uuid,event:{type:"message_start"}})',
    '    emit({type:"stream_event",parent_tool_use_id:null,event:{type:"content_block_delta",delta:{type:"text_delta",text:"fabricated"}}})',
    "  } else {",
    '    if (frame.type !== "control_request" || frame.request?.subtype !== "interrupt") process.exitCode = 2',
    '    send({type:"control_response",response:{request_id:frame.request_id,subtype:"success",response:{still_queued:[]}}})',
    '    emit({type:"command_lifecycle",command_uuid:input.uuid,state:"cancelled"})',
    '    emit({type:"result",user_message_uuid:input.uuid,subtype:"error_during_execution",is_error:true,permission_denials:[]})',
    "    process.exitCode ??= 1",
    "  }",
    "})",
  ].join("\n");
  const subprocess = processNativeTransport();
  const transport: NativeTransport = {
    start(argv, options, events) {
      assert.equal(argv[0], EXECUTABLE);
      assert.equal(options.cwd, WORKSPACE);
      assert.deepEqual(options.env, {});
      return subprocess.start([process.execPath, "-e", script], {
        cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot },
      }, events);
    },
  };
  const observation = await startClaudeWindowsProbe({
    executable: EXECUTABLE, version: "2.1.326", workspace: WORKSPACE, planOnlyVerified: true, env: {}, mode: "interrupt",
  }, transport).closed;
  assert.equal(observation.outcome, "root-interrupted");
  assert.equal(observation.interrupt, "acknowledged");
  assert.equal(observation.writerState, "unknown");
});
