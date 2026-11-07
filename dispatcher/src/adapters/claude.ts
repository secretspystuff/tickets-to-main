import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { toolEnv } from "../command.ts";
import { JsonLines, type NativeTransport } from "../native-transport.ts";
import { unknownCapabilities, type AssignmentRequest, type InterfaceClaim } from "./contract.ts";
import { hasHeldSecret, nativeObservation, opaqueId, record, safeNativeText, type NativeObservation, type NativeOutcome } from "./native-result.ts";

export const CLAUDE_CLI = "cli-stream-json";
export const CLAUDE_CLI_VERSION = "2.1.317";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const ERROR_RESULTS = new Set(["error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]);

export type ClaudeCliLaunch = { executable: string; version: string };
export type ClaudeFailure = "authentication-required" | "permission-denied" | "input-required" | "model-unavailable" | "policy-blocked" | "rate-limited" | "overloaded" | "native-refusal" | "native-error" | "interrupted";
export type ClaudeObservation = NativeObservation & {
  nativeFailure: ClaudeFailure | null;
  nativeModelChange: "unknown" | "observed";
  compaction: "unknown" | "observed";
  helperPermissionDenial: "unknown" | "observed";
  usage: {
    inputTokens: number;
    outputTokens: number;
    scope: "root-loop-turn";
    totalCostUsd: number | null;
    totalCostScope: "query-pipeline-cumulative-estimate";
  } | null;
};
export type ClaudeAssignmentHandle = {
  snapshot(): ClaudeObservation;
  settled: Promise<ClaudeObservation>;
  closed: Promise<ClaudeObservation>;
  interrupt(): false;
};

export function documentedClaudeClaim(): InterfaceClaim {
  return {
    vendor: "claude-code", interfaceId: CLAUDE_CLI, interchangeableWith: [], qualification: "documented",
    capabilities: { ...unknownCapabilities(), resume: "unavailable", cancel: "unavailable" },
    personFacing: false, experimental: "unknown",
    limit: "Fresh Windows print sessions only. Fixtures do not qualify native execution, permission recovery, resume, cancellation, writer containment or role independence.",
  };
}

function absoluteWindowsPath(value: string): boolean {
  const root = win32.parse(value).root;
  return !/[\u0000-\u001f]/.test(value) && (/^[A-Za-z]:[\\/]$/.test(root) || /^\\\\[^\\]+\\[^\\]+\\$/.test(root));
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function startClaudeCliAssignment(
  request: AssignmentRequest,
  transport: NativeTransport,
  parentEnv: NodeJS.ProcessEnv,
  secrets: readonly string[],
  launch: ClaudeCliLaunch,
): ClaudeAssignmentHandle {
  const state: ClaudeObservation = {
    ...nativeObservation("cli"), vendor: "claude-code", interfaceId: CLAUDE_CLI,
    nativeFailure: null, nativeModelChange: "unknown", compaction: "unknown", helperPermissionDenial: "unknown", usage: null,
  };
  let settle!: (value: ClaudeObservation) => void;
  let close!: (value: ClaudeObservation) => void;
  const settled = new Promise<ClaudeObservation>((resolve) => { settle = resolve; });
  const closed = new Promise<ClaudeObservation>((resolve) => { close = resolve; });
  let settledOnce = false;
  let connectionClosed = false;
  let initialized = false;
  let terminal = false;
  let successfulTerminal = false;
  const sessionId = randomUUID();
  const messageId = randomUUID();

  function snapshot(): ClaudeObservation {
    return { ...state, argv: [...state.argv], observed: { ...state.observed }, usage: state.usage === null ? null : { ...state.usage } };
  }
  function outcome(value: NativeOutcome, reason: string | null): void {
    state.outcome = value;
    state.reason = reason;
    if (value !== "completed") { delete state.observed.assignment; delete state.observed.streamResult; delete state.observed.freshContext; }
    if (!settledOnce && value !== "starting" && value !== "running") {
      settledOnce = true;
      settle(snapshot());
    }
  }
  function invalid(): void {
    successfulTerminal = false;
    outcome("protocol-error", "The Claude Code stream could not establish a correlated result. Writer completion is unknown.");
  }
  function held(failure: ClaudeFailure, reason: string): void {
    if (state.outcome === "protocol-error" || state.outcome === "disconnected") return;
    state.nativeFailure ??= failure;
    outcome("held", reason);
  }
  function safeId(value: unknown): value is string {
    return opaqueId(value) && !hasHeldSecret(value, secrets) && safeNativeText(value, secrets) === value;
  }
  function correlate(msg: Record<string, unknown>, required: boolean): boolean {
    if (msg.user_message_uuid !== undefined && msg.user_message_uuid !== messageId) return false;
    if (required && msg.user_message_uuid !== messageId) return false;
    if (msg.user_message_uuids !== undefined && (!Array.isArray(msg.user_message_uuids)
      || msg.user_message_uuids.length !== 1 || msg.user_message_uuids[0] !== messageId)) return false;
    return msg.origin === undefined && msg.resume_reason === undefined;
  }
  function observedModel(value: unknown): void {
    if (value === undefined || value === null || value === "<synthetic>") return;
    if (!safeId(value)) { invalid(); return; }
    if (state.observedModel !== null && state.observedModel !== value) state.nativeModelChange = "observed";
    state.observedModel = value;
  }
  function permissionDenied(): void {
    state.observed.nativeApproval = "unavailable";
    held("permission-denied", "Claude Code reported a native permission denial. Work is held; this adapter cannot answer prompts or recover the session through a qualified native handoff.");
  }
  function assistantFailure(error: unknown): void {
    if (error === "authentication_failed" || error === "cloud_credential_error") {
      held("authentication-required", "Claude Code reported unusable native authentication. Use its native sign-in recovery; this adapter does not log in or substitute an API key.");
    } else if (error === "oauth_org_not_allowed") {
      held("policy-blocked", "Claude Code reported an organization authentication restriction. Work is held for native recovery.");
    } else if (error === "model_not_found") {
      held("model-unavailable", "Claude Code reported that the selected model does not exist or is unavailable to this account. No Dispatcher fallback was selected.");
    } else if (error === "rate_limit") {
      held("rate-limited", "Claude Code reported a native rate limit. Work is held; account headroom remains unknown.");
    } else if (error === "overloaded") {
      held("overloaded", "Claude Code reported provider overload. No Dispatcher fallback was selected.");
    } else {
      held("native-error", "Claude Code reported a native error. Its specific cause remains unspecified.");
    }
  }
  function result(msg: Record<string, unknown>): void {
    terminal = true;
    if (typeof msg.is_error !== "boolean" || !Array.isArray(msg.permission_denials)
      || (msg.subtype !== "success" && !ERROR_RESULTS.has(String(msg.subtype))) || !correlate(msg, msg.subtype === "success" && !msg.is_error)) { invalid(); return; }
    for (const denial of msg.permission_denials) {
      const value = record(denial);
      if (!value || !safeId(value.tool_name) || !safeId(value.tool_use_id) || !record(value.tool_input)) { invalid(); return; }
    }
    if (msg.permission_denials.length > 0) permissionDenied();
    if (msg.subtype !== "success" || msg.is_error) {
      if (state.outcome === "held") return;
      if (msg.startup_failure_reason === "gateway_signin_required") assistantFailure("authentication_failed");
      else {
        state.nativeFailure = "native-error";
        outcome("failed", "Claude Code reported a failed native result. Its specific cause remains unspecified.");
      }
      return;
    }
    if (!initialized || typeof msg.result !== "string" || !nonnegative(msg.num_turns) || !Number.isInteger(msg.num_turns) || msg.num_turns < 1) { invalid(); return; }
    state.resultText = safeNativeText(msg.result, secrets, request.prompt);
    const usage = record(msg.usage);
    if (usage && nonnegative(usage.input_tokens) && Number.isInteger(usage.input_tokens)
      && nonnegative(usage.output_tokens) && Number.isInteger(usage.output_tokens)) {
      state.usage = {
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, scope: "root-loop-turn",
        totalCostUsd: nonnegative(msg.total_cost_usd) ? msg.total_cost_usd : null,
        totalCostScope: "query-pipeline-cumulative-estimate",
      };
      state.observed.usageObservation = "supported";
    }
    if (msg.terminal_reason === "aborted_streaming" || msg.terminal_reason === "aborted_tools") {
      state.nativeFailure ??= "interrupted";
      if (state.outcome !== "held") outcome("interrupted", "Claude Code reported a native interruption. Writer completion is unknown.");
    } else if (msg.stop_reason === "refusal") {
      held("native-refusal", "Claude Code reported a native model refusal. No Dispatcher fallback was selected.");
    } else if (msg.deferred_tool_use !== undefined || msg.local_command !== undefined
      || (msg.stop_reason !== undefined && msg.stop_reason !== null && msg.stop_reason !== "end_turn" && msg.stop_reason !== "stop_sequence")
      || (msg.terminal_reason !== undefined && msg.terminal_reason !== "completed")) {
      held("input-required", "Claude Code ended without a completed assignment loop. Work is held; native continuation and handoff remain unqualified.");
    } else if (state.outcome === "running") {
      // A result is provisional until the final stream closes cleanly.
      successfulTerminal = true;
    }
  }
  function message(value: unknown): void {
    if (state.outcome === "protocol-error" || state.outcome === "disconnected" || connectionClosed) return;
    const msg = record(value);
    if (!msg || typeof msg.type !== "string" || terminal) { invalid(); return; }
    if (msg.type === "control_request") {
      const request = record(msg.request);
      if (!safeId(msg.request_id) || !request || !safeId(request.subtype)
        || (msg.uuid !== undefined && !safeId(msg.uuid)) || !correlate(msg, false) || !correlate(request, false)
        || (msg.session_id !== undefined && msg.session_id !== sessionId)
        || (request.session_id !== undefined && request.session_id !== sessionId)) { invalid(); return; }
      held("input-required", "Claude Code requested native input. This adapter did not answer it; permission recovery and cancellation are unqualified.");
      return;
    }
    if (msg.session_id !== sessionId || !safeId(msg.uuid)) { invalid(); return; }
    if (msg.type === "system" && msg.subtype === "init") {
      if (initialized || msg.claude_code_version !== launch.version || typeof msg.cwd !== "string"
        || !absoluteWindowsPath(msg.cwd) || win32.normalize(msg.cwd).toLowerCase() !== win32.normalize(request.workspace).toLowerCase()
        || typeof msg.permissionMode !== "string") { invalid(); return; }
      initialized = true;
      state.threadId = sessionId;
      observedModel(msg.model);
      if (state.outcome === "starting") state.outcome = "running";
    } else if (msg.type === "result") {
      result(msg);
    } else if (msg.type === "assistant") {
      const assistant = record(msg.message);
      if (!initialized || !assistant || (msg.parent_tool_use_id !== null && !safeId(msg.parent_tool_use_id))) { invalid(); return; }
      // Helper frames do not describe the root request's model, errors or completion.
      if (msg.parent_tool_use_id !== null || msg.agent_id !== undefined) return;
      if (!correlate(msg, false)) { invalid(); return; }
      if (msg.error !== undefined) assistantFailure(msg.error);
      else if (msg.aborted === true) held("interrupted", "Claude Code reported an interrupted native message. Writer completion is unknown.");
      else observedModel(assistant.model);
    } else if (msg.type === "auth_status") {
      if (typeof msg.isAuthenticating !== "boolean") { invalid(); return; }
      if (typeof msg.error === "string") assistantFailure("authentication_failed");
      else if (msg.isAuthenticating) held("authentication-required", "Claude Code reported a native authentication flow. This adapter does not answer it; native handoff remains unqualified.");
    } else if (msg.type === "system" && msg.subtype === "permission_denied") {
      if (!safeId(msg.tool_name) || !safeId(msg.tool_use_id)) { invalid(); return; }
      if (msg.agent_id !== undefined) {
        if (!safeId(msg.agent_id)) { invalid(); return; }
        state.helperPermissionDenial = "observed";
        return;
      }
      permissionDenied();
    } else if (msg.type === "system" && msg.subtype === "compact_boundary") {
      const metadata = record(msg.compact_metadata);
      if (!initialized || !metadata || !["auto", "manual"].includes(String(metadata.trigger)) || !nonnegative(metadata.pre_tokens)) { invalid(); return; }
      state.compaction = "observed";
    } else if (msg.type === "conversation_reset") {
      held("input-required", "Claude Code reset the conversation. Work is held; a fresh authorized assignment is required.");
    }
  }

  const parser = new JsonLines(message, invalid);
  const handle: ClaudeAssignmentHandle = {
    snapshot, settled, closed,
    interrupt() { if (!connectionClosed) state.interruptRequest = "unavailable"; return false; },
  };
  if (launch.version !== CLAUDE_CLI_VERSION || !absoluteWindowsPath(launch.executable)
    || win32.basename(launch.executable).toLowerCase() !== "claude.exe" || !absoluteWindowsPath(request.workspace)) {
    outcome("refused", "This Claude Code adapter requires the inspected native Windows claude.exe version and an absolute Windows workspace.");
    close(snapshot());
    return handle;
  }
  if ((request.model !== null && !opaqueId(request.model)) || (request.effort !== null && !EFFORTS.has(request.effort))) {
    outcome("refused", "The requested Claude Code model or effort value is unsupported by this inspected recipe. Model-specific effort support still requires native evidence.");
    close(snapshot());
    return handle;
  }
  if ([request.prompt, request.workspace, request.assignmentId, request.model ?? "", request.effort ?? "", launch.executable]
    .some((part) => hasHeldSecret(part, secrets) || safeNativeText(part, secrets) !== part)) {
    outcome("refused", "The assignment includes a credential. It was not sent.");
    close(snapshot());
    return handle;
  }
  state.turnId = messageId;
  state.requestedModel = request.model;
  state.requestedEffort = request.effort;
  state.argv = [launch.executable, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--session-id", sessionId];
  if (request.model !== null) state.argv = [...state.argv, `--model=${request.model}`];
  if (request.effort !== null) state.argv = [...state.argv, `--effort=${request.effort}`];
  const child = transport.start(state.argv, { cwd: request.workspace, env: toolEnv(parentEnv, secrets) }, {
    spawned() { state.spawned = true; },
    stdout(chunk) { if (!connectionClosed) parser.push(chunk); },
    stderr() {},
    inputError() { if (!connectionClosed) outcome("disconnected", "Claude Code input disconnected. Writer completion is unknown."); },
    closed(exit) {
      if (connectionClosed) return;
      parser.finish();
      connectionClosed = true;
      if (successfulTerminal && state.spawned && state.outcome === "running" && exit.code === 0 && exit.signal === null && exit.error === null) {
        state.observed.assignment = "supported";
        state.observed.streamResult = "supported";
        state.observed.freshContext = "supported";
        if (request.model !== null && request.model === state.observedModel) state.observed.modelSelection = "supported";
        outcome("completed", null);
      } else if (state.outcome === "starting" || state.outcome === "running") {
        outcome("disconnected", "Claude Code closed without a complete successful stream. Writer completion is unknown; the cause remains unspecified.");
      }
      close(snapshot());
    },
  });
  if (!child.write(`${JSON.stringify({
    type: "user", uuid: messageId, session_id: sessionId, parent_tool_use_id: null, client_composed: true,
    message: { role: "user", content: request.prompt },
  })}\n`)) outcome("disconnected", "Claude Code input is unavailable. Writer completion is unknown.");
  child.endInput();
  return handle;
}
