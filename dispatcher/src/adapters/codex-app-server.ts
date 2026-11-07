import { win32 } from "node:path";
import { toolEnv } from "../command.ts";
import { JsonLines, type NativeProcess, type NativeTransport } from "../native-transport.ts";
import type { AssignmentRequest } from "./contract.ts";
import { copyObservation, hasHeldSecret, nativeObservation, opaqueId, record, safeNativeText, type NativeObservation, type NativeOutcome } from "./native-result.ts";

export const CODEX_APP_SERVER_SCHEMA_VERSION = "0.163.0";

export type CodexAppServerLaunch = { executable: string; version: string };
export type CodexAssignmentHandle = {
  snapshot(): NativeObservation;
  settled: Promise<NativeObservation>;
  closed: Promise<NativeObservation>;
  interrupt(): boolean;
  closeInput(): void;
};

const APPROVALS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
]);
const TERMINAL_HELPERS = new Set(["completed", "errored", "shutdown"]);

function absoluteWindowsPath(value: string): boolean {
  const root = win32.parse(value).root;
  return /^[A-Za-z]:[\\/]$/.test(root) || /^\\\\[^\\]+\\[^\\]+\\$/.test(root);
}

export function startCodexAppServerAssignment(
  request: AssignmentRequest,
  transport: NativeTransport,
  parentEnv: NodeJS.ProcessEnv,
  secrets: readonly string[],
  launch: CodexAppServerLaunch,
): CodexAssignmentHandle {
  const state = nativeObservation("app-server");
  let settle!: (value: NativeObservation) => void;
  let close!: (value: NativeObservation) => void;
  const settled = new Promise<NativeObservation>((resolve) => { settle = resolve; });
  const closed = new Promise<NativeObservation>((resolve) => { close = resolve; });
  let process: NativeProcess | null = null;
  let settledOnce = false;
  let connectionClosed = false;
  let stage: "initialize" | "thread" | "turn" | "active" = "initialize";
  let interruptSent = false;
  const pending = new Set<number>([1]);
  const helpers = new Map<string, string>();

  function boundary(): void {
    if (!settledOnce && state.outcome !== "starting" && state.outcome !== "running") {
      settledOnce = true;
      settle(copyObservation(state));
    }
  }
  function outcome(value: NativeOutcome, reason: string | null): void {
    state.outcome = value;
    state.reason = reason;
    if (value !== "completed") { delete state.observed.assignment; delete state.observed.streamResult; }
    boundary();
  }
  function invalid(): void {
    outcome("protocol-error", "The native stream could not establish an assignment result. Writer completion is unknown.");
  }
  function send(value: unknown): boolean {
    if (connectionClosed || process === null || !process.write(`${JSON.stringify(value)}\n`)) {
      outcome("disconnected", "Native input is unavailable. Writer completion is unknown.");
      return false;
    }
    return true;
  }
  function sameContext(params: Record<string, unknown>): boolean {
    return params.threadId === state.threadId && params.turnId === state.turnId && state.turnId !== null;
  }
  function safeId(value: unknown): value is string {
    return opaqueId(value) && !hasHeldSecret(value, secrets) && safeNativeText(value, secrets) === value;
  }
  function threadResult(result: Record<string, unknown>): void {
    const thread = record(result.thread);
    if (!thread || !safeId(thread.id) || typeof result.model !== "string" || typeof result.cwd !== "string"
      || typeof result.modelProvider !== "string" || result.approvalPolicy === undefined
      || result.approvalsReviewer === undefined || !record(result.sandbox)) { invalid(); return; }
    if (win32.normalize(result.cwd).toLowerCase() !== win32.normalize(request.workspace).toLowerCase()) {
      outcome("refused", "The native tool reported a different workspace. No assignment was sent.");
      return;
    }
    state.threadId = thread.id;
    state.observedModel = safeNativeText(result.model, secrets);
    if (request.model !== null && result.model !== request.model) {
      outcome("refused", "The native tool reported a different model. No assignment was sent.");
      return;
    }
    stage = "turn";
    pending.add(3);
    const params: Record<string, unknown> = { threadId: thread.id, input: [{ type: "text", text: request.prompt }] };
    if (request.effort !== null) params.effort = request.effort;
    send({ id: 3, method: "turn/start", params });
  }
  function turnResult(result: Record<string, unknown>): void {
    const turn = record(result.turn);
    if (!turn || !safeId(turn.id) || !Array.isArray(turn.items) || turn.status !== "inProgress"
      || (state.turnId !== null && turn.id !== state.turnId)) { invalid(); return; }
    state.turnId = turn.id;
    stage = "active";
    if (state.outcome === "starting") state.outcome = "running";
  }
  function item(params: Record<string, unknown>, completed: boolean): void {
    if (!sameContext(params)) { invalid(); return; }
    const value = record(params.item);
    if (!value || !safeId(value.id) || typeof value.type !== "string") { invalid(); return; }
    if (value.type === "agentMessage" && completed && (value.phase === undefined || value.phase === null || value.phase === "final_answer")) {
      if (typeof value.text !== "string") { invalid(); return; }
      state.resultText = safeNativeText(value.text, secrets, request.prompt);
    }
    if (value.type === "collabAgentToolCall") {
      const agents = record(value.agentsStates);
      if (!Array.isArray(value.receiverThreadIds) || !agents) { invalid(); return; }
      for (const id of value.receiverThreadIds) {
        if (!safeId(id)) { invalid(); return; }
        const agent = record(agents[id]);
        helpers.set(id, typeof agent?.status === "string" ? agent.status : "unknown");
      }
      state.helpers = helpers.size === 0 ? "unknown"
        : [...helpers.values()].every((status) => TERMINAL_HELPERS.has(status)) ? "terminal-observed" : "active-observed";
    }
  }
  function notification(method: string, msg: Record<string, unknown>): void {
    if (["protocol-error", "refused", "failed", "interrupted", "disconnected"].includes(state.outcome)) return;
    const params = record(msg.params);
    if (msg.id !== undefined) {
      if (APPROVALS.has(method)) {
        if (!params || !sameContext(params) || !safeId(params.itemId) || typeof params.startedAtMs !== "number") { invalid(); return; }
        state.observed.nativeApproval = "supported";
      }
      outcome("held", "The native tool requires input. This adapter did not answer it; headless recovery is unqualified.");
      return;
    }
    if (method === "turn/started") {
      const turn = record(params?.turn);
      if (!params || params.threadId !== state.threadId || !turn || !safeId(turn.id)
        || (stage !== "turn" && stage !== "active") || (state.turnId !== null && state.turnId !== turn.id)) { invalid(); return; }
      state.turnId = turn.id;
    } else if (method === "item/started" || method === "item/completed") {
      if (!params) { invalid(); return; }
      item(params, method === "item/completed");
    } else if (method === "turn/completed") {
      const turn = record(params?.turn);
      if (!params || params.threadId !== state.threadId || !turn || turn.id !== state.turnId || state.turnId === null
        || !Array.isArray(turn.items) || !["completed", "interrupted", "failed"].includes(String(turn.status))) { invalid(); return; }
      if (state.outcome === "completed" || state.outcome === "failed" || state.outcome === "interrupted") { invalid(); return; }
      if (turn.status === "completed" && state.resultText !== null && state.outcome !== "held") {
        state.observed.assignment = "supported";
        state.observed.streamResult = "supported";
        outcome("completed", null);
      } else if (turn.status === "failed" || turn.status === "interrupted") {
        outcome(turn.status, turn.status === "failed" ? "The native tool reported a failed turn." : "The native tool reported an interrupted turn.");
      } else if (state.outcome !== "held") { invalid(); }
    } else if (method === "model/rerouted" && params && sameContext(params)) {
      if (typeof params.toModel === "string") state.observedModel = safeNativeText(params.toModel, secrets);
      outcome("held", "The native tool reported a model change. Writer completion is unknown.");
    } else if (method === "error" && params && sameContext(params) && params.willRetry !== true) {
      outcome("held", "The native tool reported an error without a terminal result. Writer completion is unknown.");
    }
  }

  function response(msg: Record<string, unknown>): void {
    if (typeof msg.id !== "number" || !pending.delete(msg.id)) { invalid(); return; }
    if (msg.id === 4) {
      state.interruptRequest = msg.error !== undefined && record(msg.error) && msg.result === undefined
        ? "rejected"
        : msg.error === undefined && record(msg.result) ? "acknowledged" : "unconfirmed";
      return;
    }
    if (state.outcome !== "starting" && state.outcome !== "running") return;
    if (msg.error !== undefined) {
      outcome("failed", "The native tool refused a request. Its specific cause is unknown.");
      return;
    }
    const result = record(msg.result);
    if (!result) { invalid(); return; }
    if (msg.id === 1 && stage === "initialize") {
      if (typeof result.userAgent !== "string" || result.platformFamily !== "windows" || result.platformOs !== "windows"
        || typeof result.codexHome !== "string") { invalid(); return; }
      if (!send({ method: "initialized" })) return;
      stage = "thread";
      pending.add(2);
      const params: Record<string, unknown> = { cwd: request.workspace };
      if (request.model !== null) params.model = request.model;
      send({ id: 2, method: "thread/start", params });
    } else if (msg.id === 2 && stage === "thread") threadResult(result);
    else if (msg.id === 3 && stage === "turn") turnResult(result);
    else invalid();
  }

  function message(value: unknown): void {
    const msg = record(value);
    if (!msg) { invalid(); return; }
    if (Object.hasOwn(msg, "method")) {
      if (typeof msg.method !== "string" || Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error")) { invalid(); return; }
      notification(msg.method, msg);
    } else response(msg);
  }

  const parser = new JsonLines(message, invalid);
  const handle: CodexAssignmentHandle = {
    snapshot: () => copyObservation(state), settled, closed,
    interrupt() {
      if (connectionClosed || interruptSent || !["starting", "running", "held"].includes(state.outcome) || state.threadId === null || state.turnId === null) return false;
      interruptSent = true;
      pending.add(4);
      state.interruptRequest = "pending";
      const sent = send({ id: 4, method: "turn/interrupt", params: { threadId: state.threadId, turnId: state.turnId } });
      if (!sent) state.interruptRequest = "unavailable";
      return sent;
    },
    closeInput() { process?.endInput(); },
  };
  if (launch.version !== CODEX_APP_SERVER_SCHEMA_VERSION || !absoluteWindowsPath(launch.executable)
    || launch.executable.includes("\0") || request.workspace.includes("\0") || !absoluteWindowsPath(request.workspace)) {
    outcome("refused", "This app-server adapter requires the inspected Windows executable version and an absolute Windows workspace.");
    close(copyObservation(state));
    return handle;
  }
  if ([request.prompt, request.workspace, request.assignmentId, request.model ?? "", request.effort ?? "", launch.executable]
    .some((part) => hasHeldSecret(part, secrets) || safeNativeText(part, secrets) !== part)) {
    outcome("refused", "The assignment includes a credential. It was not sent.");
    close(copyObservation(state));
    return handle;
  }
  state.argv = [launch.executable, "app-server"];
  state.requestedModel = request.model;
  state.requestedEffort = request.effort;
  process = transport.start(state.argv, { cwd: request.workspace, env: toolEnv(parentEnv, secrets) }, {
    spawned() { state.spawned = true; },
    stdout(chunk) { parser.push(chunk); },
    stderr() {},
    inputError() { outcome("disconnected", "Native input disconnected. Writer completion is unknown."); },
    closed(exit) {
      parser.finish();
      connectionClosed = true;
      if (state.interruptRequest === "pending") state.interruptRequest = "unconfirmed";
      if (state.outcome === "starting" || state.outcome === "running") outcome("disconnected", "The native connection closed before a result. Writer completion is unknown.");
      else if (state.outcome === "completed" && (exit.error !== null || exit.code !== 0 || exit.signal !== null)) {
        outcome("disconnected", "The native connection closed abnormally. Writer completion is unknown.");
      }
      close(copyObservation(state));
    },
  });
  send({ id: 1, method: "initialize", params: { clientInfo: { name: "tickets_to_main", version: "0.1.0" } } });
  return handle;
}
