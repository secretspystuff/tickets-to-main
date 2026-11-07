import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_CLI, CLAUDE_CLI_VERSION, documentedClaudeClaim, startClaudeCliAssignment, type ClaudeObservation } from "../src/adapters/claude.ts";
import { applyHarnessEvidence, checkClaim, claimCovers, type AssignmentRequest } from "../src/adapters/contract.ts";
import { processNativeTransport, type NativeEvents, type NativeTransport } from "../src/native-transport.ts";
import { scriptedTransport } from "./native-fixtures.ts";

const REQUEST: AssignmentRequest = { assignmentId: "fixture", workspace: "C:\\fixture-work", prompt: "Current common guidance and selected role with authorized context", model: null, effort: null };
const LAUNCH = { executable: "C:\\fixture-tools\\claude-code\\2.1.317\\claude.exe", version: CLAUDE_CLI_VERSION };
type Input = { uuid: string; session_id: string; parent_tool_use_id: null; message: { role: "user"; content: string } };
function emit(events: NativeEvents, value: unknown): void { events.stdout(`${JSON.stringify(value)}\n`); }
function init(input: Input, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system", subtype: "init", uuid: "init-fixture", session_id: input.session_id,
    claude_code_version: CLAUDE_CLI_VERSION, cwd: REQUEST.workspace, model: "native-model", permissionMode: "default",
    tools: [], mcp_servers: [], slash_commands: [], skills: [], plugins: [], apiKeySource: "none", output_style: "default", ...extra,
  };
}
function terminal(input: Input, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "result", subtype: "success", uuid: "result-fixture", session_id: input.session_id, user_message_uuid: input.uuid,
    user_message_uuids: [input.uuid], num_turns: 1, result: "Fixture result.", is_error: false,
    duration_ms: 1, duration_api_ms: 1, stop_reason: "end_turn", terminal_reason: "completed", permission_denials: [],
    usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0, modelUsage: {}, ...extra,
  };
}
function assistant(input: Input, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant", uuid: "assistant-fixture", session_id: input.session_id, user_message_uuid: input.uuid,
    parent_tool_use_id: null, message: { id: "message-fixture", role: "assistant", content: [{ type: "text", text: "Fixture response." }], model: "native-model", stop_reason: "end_turn" }, ...extra,
  };
}
function cli(scenario: (events: NativeEvents, input: Input) => void, initExtra: Record<string, unknown> = {}) {
  return scriptedTransport((text, events) => {
    const input: Input = JSON.parse(text);
    emit(events, init(input, initExtra));
    scenario(events, input);
  });
}
async function finish(transport: NativeTransport, request = REQUEST): Promise<ClaudeObservation> {
  return startClaudeCliAssignment(request, transport, {}, [], LAUNCH).closed;
}

test("the inspected native exe receives fresh correlated assignment context without overrides or stored input", async () => {
  const transport = cli((events, input) => { emit(events, assistant(input)); emit(events, terminal(input)); });
  const handle = startClaudeCliAssignment(REQUEST, transport, {}, [], LAUNCH);
  const result = await handle.closed;
  assert.equal(result.outcome, "completed");
  assert.equal((await handle.settled).outcome, "completed");
  assert.equal(result.vendor, "claude-code");
  assert.equal(result.interfaceId, CLAUDE_CLI);
  assert.equal(result.resultText, "Fixture result.");
  assert.equal(result.stdin, "");
  assert.equal(result.approvalAnswered, false);
  assert.equal(result.writerState, "unknown");
  assert.equal(result.helpers, "unknown");
  assert.equal(result.observed.assignment, "supported");
  assert.equal(result.observed.freshContext, "supported");
  assert.equal(result.observed.streamResult, "supported");
  const call = transport.calls[0]!;
  assert.equal(call.cwd, REQUEST.workspace);
  assert.deepEqual(call.argv, [LAUNCH.executable, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--session-id", result.threadId]);
  assert.equal(call.input.length, 1);
  assert.deepEqual(JSON.parse(call.input[0]!), {
    type: "user", uuid: result.turnId, session_id: result.threadId, parent_tool_use_id: null, client_composed: true,
    message: { role: "user", content: REQUEST.prompt },
  });
  assert.equal(JSON.stringify(result).includes(REQUEST.prompt), false);
  const claim = applyHarnessEvidence(documentedClaudeClaim(), result);
  assert.equal(claim.qualification, "harness-passed");
  assert.equal(claim.personFacing, false);
  assert.equal(claimCovers({ vendor: "codex", interfaceId: CLAUDE_CLI, capability: "assignment" }, claim), false);
  assert.equal(claimCovers({ vendor: "claude-code", interfaceId: "sdk", capability: "assignment" }, claim), false);
  assert.deepEqual(checkClaim(documentedClaudeClaim()), []);
});

test("a native terminal is provisional until clean close, and snapshot copies do not mutate evidence", async () => {
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const transport: NativeTransport = { start(_argv, _options, events) {
    return {
      write(text) {
        const input: Input = JSON.parse(text);
        queueMicrotask(() => {
          events.spawned(); emit(events, init(input)); emit(events, terminal(input)); ready();
        });
        return true;
      },
      endInput() { release = () => events.closed({ code: 0, signal: null, error: null }); },
    };
  } };
  const handle = startClaudeCliAssignment(REQUEST, transport, {}, [], LAUNCH);
  await started;
  const before = handle.snapshot();
  assert.equal(before.outcome, "running");
  assert.equal(before.observed.assignment, undefined);
  before.observed.assignment = "supported";
  before.usage!.inputTokens = 999;
  assert.equal(handle.snapshot().observed.assignment, undefined);
  assert.equal(handle.snapshot().usage!.inputTokens, 2);
  release();
  assert.equal((await handle.settled).outcome, "completed");
  assert.equal((await handle.closed).writerState, "unknown");
});

test("native model and exact supported CLI effort remain requested versus observed, with no Dispatcher fallback", async () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const request = { ...REQUEST, model: "requested-model", effort };
    const transport = cli((events, input) => { emit(events, assistant(input)); emit(events, terminal(input)); }, { model: "requested-model" });
    const result = await finish(transport, request);
    assert.equal(result.requestedModel, "requested-model");
    assert.equal(result.observedModel, "native-model");
    assert.equal(result.nativeModelChange, "observed");
    assert.equal(result.requestedEffort, effort);
    assert.equal(result.observed.effortSelection, undefined);
    assert.equal(result.observed.modelSelection, undefined);
    assert.deepEqual(transport.calls[0]!.argv.slice(-2), ["--model=requested-model", `--effort=${effort}`]);
  }
  const exact = await finish(cli((events, input) => emit(events, terminal(input))), { ...REQUEST, model: "native-model" });
  assert.equal(exact.observed.modelSelection, "supported");
  const unknown = await finish(cli((events, input) => emit(events, terminal(input)), { model: undefined }));
  assert.equal(unknown.observedModel, null);
  assert.equal(unknown.nativeModelChange, "unknown");
});

test("unsupported pins, shell launchers, relative paths and unsupported effort refuse without spawning", async () => {
  const transport = scriptedTransport(() => assert.fail("Refused input must not reach native transport"));
  const cases: [AssignmentRequest, typeof LAUNCH][] = [
    [REQUEST, { ...LAUNCH, version: "2.1.318" }],
    [REQUEST, { ...LAUNCH, executable: "claude" }],
    [REQUEST, { ...LAUNCH, executable: "C:\\fixture\\claude.cmd" }],
    [REQUEST, { ...LAUNCH, executable: "C:\\fixture\\other.exe" }],
    [REQUEST, { ...LAUNCH, executable: "C:claude.exe" }],
    [REQUEST, { ...LAUNCH, executable: "\\fixture\\claude.exe" }],
    [{ ...REQUEST, workspace: "/linux-fixture" }, LAUNCH],
    [{ ...REQUEST, workspace: "C:fixture" }, LAUNCH],
    [{ ...REQUEST, effort: "ultracode" }, LAUNCH],
    [{ ...REQUEST, effort: "highest" }, LAUNCH],
    [{ ...REQUEST, model: "" }, LAUNCH],
    [{ ...REQUEST, model: "model\n--bare" }, LAUNCH],
  ];
  for (const [request, launch] of cases) {
    const handle = startClaudeCliAssignment(request, transport, {}, [], launch);
    assert.equal((await handle.settled).outcome, "refused");
    assert.equal((await handle.closed).spawned, false);
  }
  assert.equal(transport.calls.length, 0);
});

test("JSON framing preserves quoted content, Unicode and leading native command text as one literal assignment", async () => {
  const prompt = '/compact @private-file\r\n"quoted" \\ slash; $HOME $(echo) 🚂';
  const transport = cli((events, input) => {
    assert.equal(input.message.content, prompt);
    const text = JSON.stringify(terminal(input, { result: "Literal fixture result." }));
    for (const character of text) events.stdout(character);
  });
  const result = await finish(transport, { ...REQUEST, prompt });
  assert.equal(result.outcome, "completed");
  assert.equal(transport.calls[0]!.input[0]!.split("\n").length, 2);
  assert.equal(JSON.parse(transport.calls[0]!.input[0]!).client_composed, true);
});

test("wrong session, foreign request, merged input, resumed work and injected-origin results cannot prove success", async () => {
  const cases = [
    { session_id: "foreign-session" }, { user_message_uuid: "foreign-request" }, { user_message_uuid: undefined },
    { user_message_uuids: ["foreign-request"] }, { user_message_uuids: [] },
    { origin: { kind: "task-notification" } }, { resume_reason: "interrupted_turn" },
    { permission_denials: null }, { is_error: "false" }, { num_turns: 0 }, { result: null },
  ];
  for (const extra of cases) {
    const result = await finish(cli((events, input) => emit(events, terminal(input, extra))));
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.observed.assignment, undefined);
  }
  const merged = await finish(cli((events, input) => emit(events, terminal(input, { user_message_uuids: [input.uuid, "foreign-request"] }))));
  assert.equal(merged.outcome, "protocol-error");
});

test("root result text, clean exit, assistant prose and incomplete native events are insufficient on their own", async () => {
  for (const scenario of [
    (events: NativeEvents, input: Input) => emit(events, assistant(input, { message: { content: [{ type: "text", text: JSON.stringify(terminal(input)) }] } })),
    (events: NativeEvents, input: Input) => emit(events, { ...terminal(input), type: "assistant", parent_tool_use_id: null, message: {} }),
    (events: NativeEvents) => events.stderr("Authentication failed; model unavailable; permission denied"),
    () => {},
  ]) {
    const result = await finish(cli(scenario));
    assert.equal(result.outcome, "disconnected");
    assert.equal(result.nativeFailure, null);
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.writerState, "unknown");
  }
  const missingInit = scriptedTransport((text, events) => emit(events, terminal(JSON.parse(text))));
  assert.equal((await finish(missingInit)).outcome, "protocol-error");
});

test("a changed native version, workspace or malformed native initialization cannot qualify the selected recipe", async () => {
  for (const extra of [
    { claude_code_version: "2.1.318" }, { cwd: "C:\\foreign-work" }, { cwd: "C:fixture-work" },
    { permissionMode: undefined }, { session_id: "foreign-session" }, { uuid: undefined },
  ]) {
    const result = await finish(cli((events, input) => emit(events, terminal(input)), extra));
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.writerState, "unknown");
  }
});

test("startup native errors can be reported before init without inventing a successful request or prose-derived cause", async () => {
  for (const [failure, expected] of [["gateway_signin_required", "held"], [undefined, "failed"], ["unknown_future_value", "failed"]] as const) {
    const transport = scriptedTransport((text, events) => {
      const input: Input = JSON.parse(text);
      emit(events, terminal(input, { subtype: "error_during_execution", is_error: true, user_message_uuid: undefined, user_message_uuids: undefined, startup_failure_reason: failure, errors: ["Private native diagnostic"] }));
    });
    const result = await finish(transport);
    assert.equal(result.outcome, expected);
    assert.equal(result.nativeFailure, failure === "gateway_signin_required" ? "authentication-required" : "native-error");
    assert.equal(result.observedModel, null);
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.writerState, "unknown");
    assert.equal(JSON.stringify(result).includes("Private native diagnostic"), false);
  }
});

test("malformed, duplicate and post-terminal frames invalidate the stream", async () => {
  for (const scenario of [
    (events: NativeEvents) => events.stdout("{broken}\n"),
    (events: NativeEvents, input: Input) => { emit(events, terminal(input)); emit(events, terminal(input)); },
    (events: NativeEvents, input: Input) => { emit(events, terminal(input)); emit(events, assistant(input)); },
    (events: NativeEvents, input: Input) => { emit(events, terminal(input)); events.stdout("{truncated"); },
    (events: NativeEvents, input: Input) => emit(events, init(input)),
    (events: NativeEvents) => events.stdout("x".repeat(1024 * 1024 + 1)),
  ]) {
    const result = await finish(cli(scenario));
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.observed.assignment, undefined);
  }
});

for (const [error, expected] of [
  ["authentication_failed", "authentication-required"], ["cloud_credential_error", "authentication-required"],
  ["oauth_org_not_allowed", "policy-blocked"], ["model_not_found", "model-unavailable"],
  ["rate_limit", "rate-limited"], ["overloaded", "overloaded"], ["unknown-future-value", "native-error"],
] as const) {
  test(`native ${error} remains held with its supported cause and no automatic answers`, async () => {
    const transport = cli((events, input) => {
      emit(events, assistant(input, { error, message: { model: "<synthetic>", content: [{ type: "text", text: "Private failure body" }] } }));
      emit(events, terminal(input, { subtype: "error_during_execution", is_error: true, errors: ["Private failure body"] }));
    });
    const handle = startClaudeCliAssignment(REQUEST, transport, {}, [], LAUNCH);
    assert.equal(handle.interrupt(), false);
    const held = await handle.settled;
    assert.equal(held.outcome, "held");
    assert.equal(held.nativeFailure, expected);
    const result = await handle.closed;
    assert.equal(result.outcome, "held");
    assert.equal(result.interruptRequest, "unavailable");
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.observed.assignment, undefined);
    assert.equal(JSON.stringify(result).includes("Private failure body"), false);
    assert.equal(transport.calls[0]!.input.length, 1);
  });
}

test("native denial events and authoritative terminal denials preserve work without changing permission mode", async () => {
  for (const liveEvent of [false, true]) {
    const transport = cli((events, input) => {
      if (liveEvent) emit(events, { type: "system", subtype: "permission_denied", uuid: "denial-fixture", session_id: input.session_id, tool_name: "Bash", tool_use_id: "tool-fixture", message: "Private denied command" });
      emit(events, terminal(input, { permission_denials: [{ tool_name: "Bash", tool_use_id: "tool-fixture", tool_input: { command: "Private denied command" } }] }));
    });
    const result = await finish(transport);
    assert.equal(result.outcome, "held");
    assert.equal(result.nativeFailure, "permission-denied");
    assert.equal(result.observed.nativeApproval, "unavailable");
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.writerState, "unknown");
    assert.match(result.reason!, /qualified native handoff/);
    assert.equal(JSON.stringify(result).includes("Private denied command"), false);
    assert.equal(transport.calls[0]!.argv.some((part) => /permission|allowedTools|settings|system-prompt/.test(part)), false);
  }
});

test("native input and authentication requests remain held without reading or answering their private payload", async () => {
  for (const event of [
    { type: "control_request", request_id: "private-request", request: { subtype: "can_use_tool", input: { command: "Private payload" } } },
    { type: "auth_status", uuid: "auth-fixture", isAuthenticating: true, output: ["Private payload"] },
  ]) {
    const transport = cli((events, input) => emit(events, { session_id: input.session_id, ...event }));
    const handle = startClaudeCliAssignment(REQUEST, transport, {}, [], LAUNCH);
    assert.equal((await handle.settled).outcome, "held");
    const result = await handle.closed;
    assert.equal(result.outcome, "held");
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.writerState, "unknown");
    assert.equal(transport.calls[0]!.input.length, 1);
    assert.equal(JSON.stringify(result).includes("Private payload"), false);
  }
});

test("helper denials stay separate from root outcome and authoritative root result denials", async () => {
  for (const rootDenial of [false, true]) {
    const transport = cli((events, input) => {
      emit(events, { type: "system", subtype: "permission_denied", uuid: "helper-denial-fixture", session_id: input.session_id,
        agent_id: "helper-fixture", tool_name: "Bash", tool_use_id: "helper-call", message: "Private helper denial" });
      emit(events, terminal(input, { permission_denials: rootDenial
        ? [{ tool_name: "Bash", tool_use_id: "root-call", tool_input: { command: "Private root command" } }] : [] }));
    });
    const result = await finish(transport);
    assert.equal(result.helperPermissionDenial, "observed");
    assert.equal(result.outcome, rootDenial ? "held" : "completed");
    assert.equal(result.nativeFailure, rootDenial ? "permission-denied" : null);
    assert.equal(result.observed.assignment, rootDenial ? undefined : "supported");
    assert.equal(result.observed.nativeApproval, rootDenial ? "unavailable" : undefined);
    assert.equal(result.helpers, "unknown");
    assert.equal(result.writerState, "unknown");
    assert.equal(result.approvalAnswered, false);
    assert.equal(transport.calls[0]!.input.length, 1);
    assert.equal(JSON.stringify(result).includes("Private helper denial"), false);
    assert.equal(JSON.stringify(result).includes("Private root command"), false);
  }
  const rootEvent = await finish(cli((events, input) => {
    emit(events, { type: "system", subtype: "permission_denied", uuid: "root-denial-fixture", session_id: input.session_id,
      tool_name: "Bash", tool_use_id: "root-call", message: "Private root denial" });
    emit(events, terminal(input));
  }));
  assert.equal(rootEvent.outcome, "held");
  assert.equal(rootEvent.helperPermissionDenial, "unknown");
  for (const agent_id of [null, "", 42, {}]) {
    const malformed = await finish(cli((events, input) => {
      emit(events, { type: "system", subtype: "permission_denied", uuid: "denial-fixture", session_id: input.session_id,
        agent_id, tool_name: "Bash", tool_use_id: "tool-fixture" });
      emit(events, terminal(input));
    }));
    assert.equal(malformed.outcome, "protocol-error");
    assert.equal(malformed.observed.assignment, undefined);
  }
});

test("valid control envelopes hold without optional session or event UUID fields and remain unanswered", async () => {
  for (const includeContext of [false, true]) {
    const transport = cli((events, input) => {
      emit(events, { type: "control_request", request_id: "control-fixture", request: { subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "root-tool" },
        ...(includeContext ? { session_id: input.session_id, uuid: "control-event", user_message_uuid: input.uuid } : {}) });
      emit(events, terminal(input));
    });
    const result = await finish(transport);
    assert.equal(result.outcome, "held");
    assert.equal(result.nativeFailure, "input-required");
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.writerState, "unknown");
    assert.equal(transport.calls[0]!.input.length, 1);
  }
});

test("malformed or contradictory control envelopes cannot manufacture a native input hold", async () => {
  const valid = { type: "control_request", request_id: "control-fixture", request: { subtype: "can_use_tool" } };
  for (const event of [
    { type: "control_request" }, { ...valid, request_id: undefined }, { ...valid, request_id: null },
    { ...valid, request_id: "" }, { ...valid, request_id: {} }, { ...valid, request: null },
    { ...valid, request: [] }, { ...valid, request: {} }, { ...valid, request: { subtype: "" } },
    { ...valid, request: { subtype: 42 } }, { ...valid, uuid: null },
    { ...valid, session_id: "foreign-session" }, { ...valid, session_id: null },
    { ...valid, user_message_uuid: "foreign-request" }, { ...valid, user_message_uuids: ["foreign-request"] },
    { ...valid, request: { subtype: "can_use_tool", session_id: "foreign-session" } },
    { ...valid, request: { subtype: "can_use_tool", user_message_uuid: "foreign-request" } },
    { ...valid, origin: { kind: "task-notification" } }, { ...valid, resume_reason: "interrupted_turn" },
  ]) {
    const transport = cli((events, input) => { emit(events, event); emit(events, terminal(input)); });
    const result = await finish(transport);
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.nativeFailure, null);
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.approvalAnswered, false);
    assert.equal(result.writerState, "unknown");
    assert.equal(transport.calls[0]!.input.length, 1);
  }
});

test("helpers, task notifications and native compaction never establish helper or writer completion", async () => {
  const transport = cli((events, input) => {
    emit(events, assistant(input, { parent_tool_use_id: "helper-call", agent_id: "helper-task", error: "authentication_failed", message: { model: "helper-model", content: [] } }));
    emit(events, { type: "system", subtype: "task_notification", uuid: "task-fixture", session_id: input.session_id, task_id: "helper-task", status: "completed", summary: "Helper done", output_file: "C:\\fixture\\private-output" });
    emit(events, { type: "system", subtype: "compact_boundary", uuid: "compact-fixture", session_id: input.session_id, compact_metadata: { trigger: "auto", pre_tokens: 50 } });
    emit(events, terminal(input));
  });
  const result = await finish(transport);
  assert.equal(result.outcome, "completed");
  assert.equal(result.compaction, "observed");
  assert.equal(result.observedModel, "native-model");
  assert.equal(result.nativeFailure, null);
  assert.equal(result.helpers, "unknown");
  assert.equal(result.writerState, "unknown");
  assert.equal(result.observed.helperCompletion, undefined);
  assert.equal(result.observed.cancel, undefined);
  assert.equal(result.observed.resume, undefined);
  assert.equal(JSON.stringify(result).includes("private-output"), false);
});

test("deferred, interrupted, noncompleted and unknown native terminal reasons never become assignment success", async () => {
  for (const [extra, expected] of [
    [{ deferred_tool_use: { id: "deferred", name: "Bash", input: { command: "Private payload" } } }, "held"],
    [{ local_command: "compact" }, "held"], [{ stop_reason: "refusal" }, "held"],
    [{ stop_reason: "tool_use" }, "held"], [{ stop_reason: "max_tokens" }, "held"],
    [{ terminal_reason: "aborted_tools" }, "interrupted"], [{ terminal_reason: "aborted_streaming" }, "interrupted"],
    [{ terminal_reason: "hook_stopped" }, "held"], [{ terminal_reason: "background_requested" }, "held"],
    [{ terminal_reason: "unknown_future_value" }, "held"],
    [{ subtype: "error_max_turns", is_error: true }, "failed"],
    [{ subtype: "error_max_budget_usd", is_error: true }, "failed"],
  ] as const) {
    const result = await finish(cli((events, input) => emit(events, terminal(input, extra))));
    assert.equal(result.outcome, expected);
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.writerState, "unknown");
    assert.equal(JSON.stringify(result).includes("Private payload"), false);
  }
});

test("usage is optional, zero is observed, and cumulative cost is separate from root turn tokens", async () => {
  const zero = await finish(cli((events, input) => emit(events, terminal(input, { usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }))));
  assert.deepEqual(zero.usage, { inputTokens: 0, outputTokens: 0, scope: "root-loop-turn", totalCostUsd: 0, totalCostScope: "query-pipeline-cumulative-estimate" });
  for (const usage of [undefined, null, {}, { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }]) {
    const result = await finish(cli((events, input) => emit(events, terminal(input, { usage }))));
    assert.equal(result.outcome, "completed");
    assert.equal(result.usage, null);
    assert.equal(result.observed.usageObservation, undefined);
  }
});

test("credentials refuse before spawn and native results use the shared redactor without preserving diagnostics", async () => {
  const unused = scriptedTransport(() => assert.fail());
  for (const part of [{ prompt: "held-secret" }, { model: "held-secret" }, { effort: "held-secret" }, { assignmentId: "held-secret" }, { workspace: "C:\\held-secret" }, { prompt: "-----BEGIN PRIVATE KEY-----\nPrivate body" }]) {
    const result = await startClaudeCliAssignment({ ...REQUEST, ...part }, unused, {}, ["held-secret"], LAUNCH).closed;
    assert.equal(result.outcome, "refused");
  }
  assert.equal(unused.calls.length, 0);
  const key = "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_KEY_BODY\n-----END PRIVATE KEY-----";
  const transport = cli((events, input) => {
    events.stderr("Private diagnostic held-secret");
    emit(events, terminal(input, { result: `${REQUEST.prompt} held-secret tp_${"s".repeat(24)} ${key}` }));
  });
  const result = await startClaudeCliAssignment(REQUEST, transport, {
    TICKETS_PLEASE_TOKEN: "held-secret", TICKETS_TO_MAIN_JOB: "held-secret", ALIAS: "held-secret",
    NATIVE_PREFERENCE: "retained", CLAUDE_CONFIG_DIR: "C:\\fixture-native-config",
  }, ["held-secret"], LAUNCH).closed;
  const serialized = JSON.stringify(result);
  for (const forbidden of [REQUEST.prompt, "held-secret", "SYNTHETIC_PRIVATE_KEY_BODY", "s".repeat(24), "Private diagnostic"]) assert.equal(serialized.includes(forbidden), false);
  assert.deepEqual({ ...transport.calls[0]!.env }, { NATIVE_PREFERENCE: "retained", CLAUDE_CONFIG_DIR: "C:\\fixture-native-config" });
  assert.equal(result.resultText!.includes("[assignment input omitted]"), true);
});

test("abnormal close and lost input invalidate a provisional success without claiming native authentication failure", async () => {
  for (const exit of [
    { code: 1, signal: null, error: null }, { code: null, signal: "SIGTERM", error: null },
    { code: null, signal: null, error: "spawn" },
  ] as const) {
    const transport = cli((events, input) => { emit(events, terminal(input)); events.closed(exit); });
    const result = await finish(transport);
    assert.equal(result.outcome, "disconnected");
    assert.equal(result.observed.assignment, undefined);
    assert.equal(result.nativeFailure, null);
  }
  const lost = await finish(cli((events, input) => { emit(events, terminal(input)); events.inputError(); }));
  assert.equal(lost.outcome, "disconnected");
  assert.equal(lost.writerState, "unknown");
});

test("synthetic subprocess proves the actual transport framing without running a native assignment", async () => {
  const script = `const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);
send({type:'system',subtype:'init',uuid:'fixture-init',session_id:m.session_id,claude_code_version:'2.1.317',cwd:'C:\\\\fixture-work',permissionMode:'default'});
send({type:'result',subtype:'success',uuid:'fixture-result',session_id:m.session_id,user_message_uuid:m.uuid,is_error:false,num_turns:1,result:'Synthetic only',permission_denials:[]});});`;
  const actual = processNativeTransport();
  const transport: NativeTransport = { start(_argv, options, events) {
    return actual.start([process.execPath, "-e", script], { ...options, cwd: process.cwd() }, events);
  } };
  const result = await finish(transport);
  assert.equal(result.outcome, "completed");
  assert.equal(result.resultText, "Synthetic only");
  assert.equal(result.observedModel, null);
  assert.equal(result.writerState, "unknown");
});
