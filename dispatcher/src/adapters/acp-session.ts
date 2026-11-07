import { win32 } from "node:path";
import { toolEnv } from "../command.ts";
import { JsonLines, type NativeProcess, type NativeTransport } from "../native-transport.ts";
import type { AssignmentRequest } from "./contract.ts";
import { copyObservation, hasHeldSecret, opaqueId, record, safeNativeText, type NativeObservation, type NativeOutcome } from "./native-result.ts";

export type AcpRecipe = {
  vendor: "cursor" | "grok-build";
  argv: readonly string[];
  valid: boolean;
  authHandoff: string;
};

export type AcpAssignmentHandle = {
  snapshot(): NativeObservation;
  settled: Promise<NativeObservation>;
  closed: Promise<NativeObservation>;
  interrupt(): boolean;
  closeInput(): void;
};

const MAX_RETAINED_TEXT = 1024 * 1024;
const MAX_PENDING_REQUESTS = 256;
const TERMINAL = new Set<NativeOutcome>(["completed", "failed", "interrupted", "disconnected", "protocol-error", "refused"]);

export function absoluteWindowsPath(value: string): boolean {
  const root = win32.parse(value).root;
  return !/[\u0000-\u001f]/.test(value) && (/^[A-Za-z]:[\\/]$/.test(root) || /^\\\\[^\\]+\\[^\\]+\\$/.test(root));
}

// Each handle owns a new process and one prompt: ACP v1 has no per-update turn identifier.
export function startAcpAssignment(
  request: AssignmentRequest,
  transport: NativeTransport,
  parentEnv: NodeJS.ProcessEnv,
  secrets: readonly string[],
  recipe: AcpRecipe,
): AcpAssignmentHandle {
  const state: NativeObservation = {
    vendor: recipe.vendor, interfaceId: "acp", spawned: false, argv: [], stdin: "", observed: {}, reason: null,
    approvalAnswered: false, outcome: "starting", writerState: "unknown", interruptRequest: "not-requested", helpers: "unknown",
    resultText: null, threadId: null, turnId: null, requestedModel: null, observedModel: null, requestedEffort: null,
  };
  let settle!: (value: NativeObservation) => void;
  let close!: (value: NativeObservation) => void;
  const settled = new Promise<NativeObservation>((resolve) => { settle = resolve; });
  const closed = new Promise<NativeObservation>((resolve) => { close = resolve; });
  let settledOnce = false;
  let connectionClosed = false;
  let inputClosed = false;
  let process: NativeProcess | null = null;
  let stage: "initialize" | "session" | "prompt" | "terminal" = "initialize";
  let expectedId: number | null = 1;
  let text = "";
  let cancelSent = false;
  const permissions = new Map<string | number, true>();
  const activeTools = new Set<string>();

  function outcome(value: NativeOutcome, reason: string | null): void {
    state.outcome = value;
    state.reason = reason;
    if (value !== "completed") {
      delete state.observed.assignment;
      delete state.observed.streamResult;
      state.resultText = null;
    }
    if (!settledOnce && value !== "starting" && value !== "running") {
      settledOnce = true;
      settle(copyObservation(state));
    }
  }
  function invalid(): void {
    outcome("protocol-error", "The ACP stream could not establish an assignment result. Writer completion is unknown.");
  }
  function safeId(value: unknown): value is string {
    return opaqueId(value) && !hasHeldSecret(value, secrets) && safeNativeText(value, secrets) === value;
  }
  function requestId(value: unknown): value is string | number {
    return safeId(value) || (typeof value === "number" && Number.isSafeInteger(value));
  }
  function send(value: unknown): boolean {
    if (connectionClosed || inputClosed || process === null || !process.write(`${JSON.stringify(value)}\n`)) {
      outcome("disconnected", "Native input is unavailable. Writer completion is unknown.");
      return false;
    }
    return true;
  }
  function cancelledPermission(id: string | number): boolean {
    return send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
  }
  function active(params: Record<string, unknown>): boolean {
    return stage === "prompt" && state.threadId !== null && params.sessionId === state.threadId && !TERMINAL.has(state.outcome);
  }
  function update(params: Record<string, unknown>): void {
    if (params.sessionId !== state.threadId || state.threadId === null) return;
    const item = record(params.update);
    if (!item || typeof item.sessionUpdate !== "string") { invalid(); return; }
    if (!active(params)) {
      if (stage === "terminal" && item.sessionUpdate === "agent_message_chunk") invalid();
      return;
    }
    if (item.sessionUpdate === "agent_message_chunk") {
      const content = record(item.content);
      if (!content || typeof content.type !== "string") { invalid(); return; }
      if (content.type !== "text") {
        outcome("held", "The ACP result includes unsupported non-text content. Preserve the native session for recovery.");
        return;
      }
      if (typeof content.text !== "string" || text.length + content.text.length > MAX_RETAINED_TEXT) { invalid(); return; }
      text += content.text;
    } else if (item.sessionUpdate === "tool_call" || item.sessionUpdate === "tool_call_update") {
      if (!safeId(item.toolCallId)) { invalid(); return; }
      if (item.sessionUpdate === "tool_call" && (typeof item.title !== "string" || activeTools.has(item.toolCallId))) { invalid(); return; }
      if (item.sessionUpdate === "tool_call_update" && !activeTools.has(item.toolCallId)) return;
      if (item.status === "completed" || item.status === "failed") activeTools.delete(item.toolCallId);
      else {
        if (activeTools.size >= MAX_PENDING_REQUESTS && !activeTools.has(item.toolCallId)) { invalid(); return; }
        activeTools.add(item.toolCallId);
      }
    }
  }
  function inboundRequest(method: string, id: unknown, params: Record<string, unknown>): void {
    if (!requestId(id) || !active(params)) return;
    if (method === "session/request_permission") {
      const tool = record(params.toolCall);
      if (!tool || !safeId(tool.toolCallId) || !Array.isArray(params.options) || params.options.length === 0
        || params.options.some((option) => {
          const value = record(option);
          return !value || !safeId(value.optionId) || typeof value.name !== "string"
            || !["allow_once", "allow_always", "reject_once", "reject_always"].includes(String(value.kind));
        })) { invalid(); return; }
      if (permissions.has(id)) return;
      if (cancelSent) { cancelledPermission(id); return; }
      if (permissions.size >= MAX_PENDING_REQUESTS) { invalid(); return; }
      permissions.set(id, true);
      outcome("held", "The native tool requires permission. It was not answered; recovery through a native host is unqualified.");
    } else {
      outcome("held", "The native tool requires an unsupported client action. It was not performed; preserve the native session for recovery.");
    }
  }
  function cursorRequest(method: string, id: unknown, params: Record<string, unknown>): void {
    if (recipe.vendor !== "cursor" || stage !== "prompt" || TERMINAL.has(state.outcome) || !requestId(id)) return;
    if (params.sessionId !== undefined && params.sessionId !== state.threadId) return;
    // Cursor's documented extension requests have only toolCallId, so require a live ACP tool call.
    if (!safeId(params.toolCallId) || !activeTools.has(params.toolCallId)) return;
    if (method === "cursor/ask_question" || method === "cursor/create_plan") {
      outcome("held", "Cursor requires a native question or plan decision. It was not answered; recovery through a native host is unqualified.");
    }
  }
  function response(msg: Record<string, unknown>): void {
    if (typeof msg.id !== "number" || msg.id !== expectedId || TERMINAL.has(state.outcome)) return;
    expectedId = null;
    if ((msg.result !== undefined) === (msg.error !== undefined)) { invalid(); return; }
    if (msg.error !== undefined) {
      const error = record(msg.error);
      if (!error || !Number.isInteger(error.code) || typeof error.message !== "string") { invalid(); return; }
      if (error.code === -32000) outcome("held", recipe.authHandoff);
      else outcome("failed", "The native tool refused an ACP request. Its specific cause is unknown.");
      stage = "terminal";
      return;
    }
    const result = record(msg.result);
    if (!result) { invalid(); return; }
    if (stage === "initialize") {
      if (result.protocolVersion !== 1 || !record(result.agentCapabilities)
        || (result.authMethods !== undefined && !Array.isArray(result.authMethods))) { invalid(); return; }
      stage = "session";
      expectedId = 2;
      send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: request.workspace, mcpServers: [] } });
    } else if (stage === "session") {
      if (!safeId(result.sessionId)) { invalid(); return; }
      state.threadId = result.sessionId;
      stage = "prompt";
      expectedId = 3;
      state.outcome = "running";
      send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: result.sessionId, prompt: [{ type: "text", text: request.prompt }] } });
    } else if (stage === "prompt") {
      stage = "terminal";
      if (result.stopReason === "cancelled") {
        if (cancelSent) state.interruptRequest = "acknowledged";
        outcome("interrupted", "The native tool reported a cancelled prompt. Writer completion is unknown.");
      } else if (result.stopReason === "refusal") {
        outcome("refused", "The native tool refused to continue.");
      } else if (result.stopReason === "max_tokens" || result.stopReason === "max_turn_requests") {
        outcome("failed", "The native tool stopped at its own limit. The assignment is incomplete.");
      } else if (result.stopReason === "end_turn") {
        if (state.outcome === "held" || permissions.size > 0 || activeTools.size > 0) {
          outcome("held", "The native prompt ended with unresolved native work or input. Writer completion is unknown.");
        } else if (text.length === 0) invalid();
        else {
          state.resultText = safeNativeText(text, secrets, request.prompt);
          state.observed.assignment = "supported";
          state.observed.streamResult = "supported";
          outcome("completed", null);
        }
      } else invalid();
      text = "";
    } else invalid();
  }
  function message(value: unknown): void {
    if (connectionClosed || ["protocol-error", "disconnected", "refused", "failed", "interrupted"].includes(state.outcome)) return;
    const msg = record(value);
    if (!msg || msg.jsonrpc !== "2.0") { invalid(); return; }
    if (!Object.hasOwn(msg, "method")) { response(msg); return; }
    if (typeof msg.method !== "string") { invalid(); return; }
    if (msg.result !== undefined || msg.error !== undefined) { invalid(); return; }
    const params = record(msg.params);
    if (!params) { invalid(); return; }
    if (msg.method === "session/update" && msg.id === undefined) update(params);
    else if (msg.id !== undefined && msg.method.startsWith("cursor/")) cursorRequest(msg.method, msg.id, params);
    else if (msg.id !== undefined) inboundRequest(msg.method, msg.id, params);
  }

  const parser = new JsonLines(message, invalid);
  const handle: AcpAssignmentHandle = {
    snapshot: () => copyObservation(state), settled, closed,
    interrupt() {
      if (cancelSent || stage !== "prompt" || state.threadId === null || TERMINAL.has(state.outcome) || connectionClosed || inputClosed) return false;
      cancelSent = true;
      state.interruptRequest = "pending";
      if (!send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: state.threadId } })) {
        state.interruptRequest = "unavailable";
        return false;
      }
      for (const id of permissions.keys()) {
        if (!cancelledPermission(id)) { state.interruptRequest = "unavailable"; return false; }
      }
      permissions.clear();
      return true;
    },
    closeInput() { inputClosed = true; process?.endInput(); },
  };
  function refuse(reason: string): AcpAssignmentHandle {
    outcome("refused", reason);
    close(copyObservation(state));
    return handle;
  }
  if (!recipe.valid || !absoluteWindowsPath(request.workspace) || !safeId(request.assignmentId)) {
    return refuse("This ACP recipe requires its inspected Windows executable version and an absolute Windows workspace.");
  }
  if ([request.prompt, request.workspace, request.assignmentId, request.model ?? "", request.effort ?? "", ...recipe.argv]
    .some((part) => hasHeldSecret(part, secrets) || safeNativeText(part, secrets) !== part)) {
    return refuse("The assignment includes a credential. It was not sent.");
  }
  state.requestedModel = request.model;
  state.requestedEffort = request.effort;
  if (request.model !== null || request.effort !== null) {
    return refuse("Model and effort selection are unqualified on this ACP recipe. No assignment was sent.");
  }
  if (request.prompt.length > MAX_RETAINED_TEXT) return refuse("The assignment input exceeds the ACP message bound. It was not sent.");
  state.argv = [...recipe.argv];
  const env = toolEnv(parentEnv, secrets);
  for (const name of Object.keys(env)) {
    if (/^(?:ANTHROPIC_|CLAUDE_CODE_|OPENAI_|CODEX_|GITHUB_TOKEN$|GH_TOKEN$|GIT_ASKPASS$)/i.test(name)
      || (recipe.vendor === "cursor" ? /^(?:XAI_|GROK_)/i.test(name) : /^CURSOR_/i.test(name))) delete env[name];
  }
  process = transport.start(state.argv, { cwd: request.workspace, env }, {
    spawned() { state.spawned = true; },
    stdout(chunk) { if (!connectionClosed) parser.push(chunk); },
    stderr() {},
    inputError() { outcome("disconnected", "Native input disconnected. Writer completion is unknown."); },
    closed(exit) {
      if (connectionClosed) return;
      parser.finish();
      connectionClosed = true;
      text = "";
      if (state.interruptRequest === "pending") state.interruptRequest = "unconfirmed";
      if (state.outcome === "starting" || state.outcome === "running") outcome("disconnected", "The native connection closed before a result. Writer completion is unknown.");
      else if (state.outcome === "completed" && (exit.error !== null || exit.code !== 0 || exit.signal !== null)) {
        outcome("disconnected", "The native connection closed abnormally. Writer completion is unknown.");
      }
      close(copyObservation(state));
    },
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "tickets_to_main", version: "0.1.0" },
  } });
  return handle;
}
