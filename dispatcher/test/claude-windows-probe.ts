import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { JsonLines, type NativeProcess, type NativeTransport } from "../src/native-transport.ts";
import { record } from "../src/adapters/native-result.ts";

const VERSION = "2.1.326";
const MODEL = "claude-haiku-5-5";
const EFFORT = "low";
const FIXTURE_RESULT = "T3-FIXTURE-OK";
const FIXTURE_PROMPTS = {
  fresh: "Fabricated text test. Use no tools, files, commands, MCP or helpers. Reply with exactly T3-FIXTURE-OK.",
  interrupt: "Fabricated text test. Use no tools, files, commands, MCP or helpers. List 40 fictional one-word windmill names.",
};
const FIXTURE_ENV = new Set([
  "systemroot", "windir", "path", "pathext", "comspec", "temp", "tmp", "userprofile", "homedrive",
  "homepath", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata", "os",
]);

export type ClaudeWindowsProbeOptions = {
  executable: string;
  version: string;
  workspace: string;
  planOnlyVerified: boolean;
  env: NodeJS.ProcessEnv;
  mode: keyof typeof FIXTURE_PROMPTS;
};

type ProbeOutcome = "refused" | "held" | "protocol-error" | "disconnected" | "failed" | "root-result" | "root-interrupted";
type ProbeObservation = {
  scope: "fabricated";
  version: typeof VERSION;
  outcome: ProbeOutcome;
  requestedModel: typeof MODEL;
  initialModel: string | null;
  observedModel: string | null;
  requestedEffort: typeof EFFORT;
  effectiveEffort: "unknown";
  writerState: "unknown";
  helperActivity: "unknown" | "observed";
  interrupt: "not-requested" | "unconfirmed" | "acknowledged";
  resultMatches: boolean | null;
};

function localAbsolute(path: string): boolean {
  return /^[A-Za-z]:\\/.test(path) && !/[\u0000-\u001f]/.test(path) && win32.normalize(path) === path;
}

function model(value: unknown): string | null {
  return typeof value === "string" && /^claude-[a-z0-9-]{1,50}$/.test(value) ? value : null;
}

function isRoot(frame: Record<string, unknown>): boolean {
  return frame.agent_id === undefined && (frame.parent_tool_use_id === undefined || frame.parent_tool_use_id === null);
}

export function startClaudeWindowsProbe(options: ClaudeWindowsProbeOptions, transport: NativeTransport): {
  closed: Promise<ProbeObservation>;
} {
  const { executable, version, workspace, planOnlyVerified, env, mode } = options;
  const evidence: ProbeObservation = {
    scope: "fabricated", version: VERSION, outcome: "refused", requestedModel: MODEL, initialModel: null, observedModel: null,
    requestedEffort: EFFORT, effectiveEffort: "unknown", writerState: "unknown", helperActivity: "unknown",
    interrupt: "not-requested", resultMatches: null,
  };
  if (version !== VERSION || planOnlyVerified !== true || !localAbsolute(executable) || !localAbsolute(workspace)
    || win32.basename(executable).toLowerCase() !== "claude.exe"
    || Object.keys(env).some(name => !FIXTURE_ENV.has(name.toLowerCase()))) {
    return { closed: Promise.resolve(evidence) };
  }

  const sessionId = randomUUID();
  const inputId = randomUUID();
  let initialized = false;
  let spawned = false;
  let ending = false;
  let transportClosed = false;
  let hasReceiptCapability = false;
  let rootStreamBound = false;
  let rootTextSeen = false;
  let lifecycle: "queued" | "started" | "completed" | "cancelled" | null = null;
  let interruptId: string | null = null;
  let receiptSeen = false;
  let terminal: "root-result" | "root-interrupted" | "failed" | null = null;
  let failure: "held" | "protocol-error" | "disconnected" | null = null;
  let child: NativeProcess | undefined;
  let finish!: (value: ProbeObservation) => void;
  const closed = new Promise<ProbeObservation>(resolve => { finish = resolve; });

  function endInput(): void {
    if (ending) return;
    ending = true;
    child?.endInput();
  }

  function stop(reason: NonNullable<typeof failure>): void {
    failure ??= reason;
    endInput();
  }

  function correlate(frame: Record<string, unknown>): boolean {
    const inputs = frame.user_message_uuids;
    return frame.user_message_uuid === inputId && frame.origin === undefined && frame.resume_reason === undefined
      && (inputs === undefined || (Array.isArray(inputs) && inputs.length === 1 && inputs[0] === inputId));
  }

  function receive(value: unknown): void {
    if (failure) return;
    const frame = record(value);
    if (!frame || typeof frame.type !== "string" || terminal) { stop("protocol-error"); return; }
    if (frame.type === "control_response" || frame.type === "control_request") {
      if (!isRoot(frame) || (frame.session_id !== undefined && frame.session_id !== sessionId)) {
        stop("protocol-error"); return;
      }
      if (frame.type === "control_request") {
        stop("held"); return;
      }
      const envelope = record(frame.response);
      const response = record(envelope?.response);
      if (!interruptId || receiptSeen || envelope?.request_id !== interruptId || envelope.subtype !== "success"
        || !isRoot(envelope) || (envelope.session_id !== undefined && envelope.session_id !== sessionId)
        || !Array.isArray(response?.still_queued) || response.still_queued.length !== 0
        || (response.cancelled !== undefined && (!Array.isArray(response.cancelled) || response.cancelled.length !== 0))) {
        stop("protocol-error"); return;
      }
      receiptSeen = true;
      return;
    }
    if (frame.session_id !== sessionId || typeof frame.uuid !== "string" || !frame.uuid) {
      stop("protocol-error"); return;
    }
    if (frame.type === "system" && frame.subtype === "init") {
      if (initialized || !isRoot(frame) || frame.claude_code_version !== VERSION || typeof frame.cwd !== "string"
        || !localAbsolute(frame.cwd) || frame.cwd.toLowerCase() !== workspace.toLowerCase()
        || frame.permissionMode !== "default" || frame.apiKeySource !== "none") {
        stop("protocol-error"); return;
      }
      initialized = true;
      hasReceiptCapability = Array.isArray(frame.capabilities) && frame.capabilities.includes("interrupt_receipt_v1");
      evidence.initialModel = model(frame.model);
    } else if (frame.type === "command_lifecycle") {
      if (!isRoot(frame) || frame.command_uuid !== inputId) { stop("protocol-error"); return; }
      if (frame.state === "queued" && lifecycle === null) lifecycle = "queued";
      else if (frame.state === "started" && lifecycle === "queued") lifecycle = "started";
      else if (frame.state === "cancelled" && lifecycle === "started" && interruptId) lifecycle = "cancelled";
      else if (frame.state === "completed" && lifecycle === "started") lifecycle = "completed";
      else stop("protocol-error");
    } else if (frame.type === "stream_event") {
      if (frame.parent_tool_use_id !== null || !isRoot(frame)) return;
      if (!initialized || frame.origin !== undefined || frame.resume_reason !== undefined
        || ((frame.user_message_uuid !== undefined || frame.user_message_uuids !== undefined) && !correlate(frame))) {
        stop("protocol-error"); return;
      }
      if (correlate(frame)) rootStreamBound = true;
      const event = record(frame.event);
      if (rootStreamBound && event?.type === "content_block_delta" && record(event.delta)?.type === "text_delta") {
        rootTextSeen = true;
      }
    } else if (frame.type === "assistant") {
      if (!isRoot(frame)) { evidence.helperActivity = "observed"; return; }
      if (!initialized || (frame.user_message_uuid !== undefined && !correlate(frame))) {
        stop("protocol-error"); return;
      }
      if (frame.error !== undefined) { stop("held"); return; }
      const message = record(frame.message);
      if (!message || !Array.isArray(message.content)) { stop("protocol-error"); return; }
      if (message.content.some(block => record(block)?.type === "tool_use")) { stop("held"); return; }
      if (frame.parent_tool_use_id === null && correlate(frame)) evidence.observedModel = model(message.model);
    } else if (frame.type === "system" && frame.subtype === "permission_denied") {
      if (isRoot(frame)) stop("held");
      else evidence.helperActivity = "observed";
    } else if (frame.type === "result") {
      if (!initialized || !isRoot(frame) || !correlate(frame) || typeof frame.is_error !== "boolean"
        || !Array.isArray(frame.permission_denials)) {
        stop("protocol-error"); return;
      }
      if (frame.permission_denials.length) { stop("held"); return; }
      if (mode === "fresh" && frame.subtype === "success" && !frame.is_error && frame.stop_reason === "end_turn"
        && frame.local_command === undefined && frame.deferred_tool_use === undefined
        && (frame.terminal_reason === undefined || frame.terminal_reason === "completed")
        && frame.num_turns === 1 && evidence.observedModel !== null) {
        evidence.resultMatches = typeof frame.result === "string" && frame.result.trim() === FIXTURE_RESULT;
        terminal = evidence.resultMatches ? "root-result" : "failed";
      } else if (mode === "interrupt" && frame.subtype === "error_during_execution" && frame.is_error
        && (frame.stop_reason === null || frame.stop_reason === undefined) && receiptSeen && lifecycle === "cancelled") {
        terminal = "root-interrupted";
      } else {
        terminal = "failed";
      }
      endInput();
    } else if (frame.type === "rate_limit_event") {
      const limits = record(frame.rate_limit_info);
      if (limits?.overageEnabled === true || limits?.isUsingOverage === true) stop("held");
    } else if (frame.type === "conversation_reset") {
      stop("held");
    } else if (frame.type === "system" && ["task_started", "task_progress", "task_notification"].includes(String(frame.subtype))) {
      evidence.helperActivity = "observed";
    }
  }

  const parser = new JsonLines(receive, () => stop("protocol-error"));
  const argv = [executable, "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--session-id", sessionId, "--model=" + MODEL, "--effort=" + EFFORT];
  if (mode === "interrupt") argv.push("--include-partial-messages");
  child = transport.start(argv, { cwd: workspace, env }, {
    spawned() { spawned = true; },
    stdout(chunk) {
      if (transportClosed) return;
      parser.push(chunk);
      if (mode === "interrupt" && !ending && !interruptId && hasReceiptCapability && lifecycle === "started" && rootTextSeen) {
        interruptId = "req_1_" + randomUUID().replaceAll("-", "").slice(0, 8);
        const request = { type: "control_request", request_id: interruptId, request: { subtype: "interrupt" } };
        if (!child?.write(JSON.stringify(request) + "\n")) stop("disconnected");
      }
    },
    stderr() {},
    inputError() { if (!transportClosed) stop("disconnected"); },
    closed(exit) {
      if (transportClosed) return;
      parser.finish();
      transportClosed = true;
      const clean = spawned && exit.signal === null && exit.error === null;
      if (failure) evidence.outcome = failure;
      else if (terminal === "root-result" && clean && exit.code === 0) evidence.outcome = terminal;
      else if (terminal === "root-interrupted" && clean && exit.code === 1) evidence.outcome = terminal;
      else evidence.outcome = terminal === "failed" ? "failed" : "disconnected";
      evidence.interrupt = evidence.outcome === "root-interrupted" ? "acknowledged" : interruptId ? "unconfirmed" : "not-requested";
      if (evidence.outcome !== "root-result") evidence.resultMatches = null;
      finish(evidence);
    },
  });
  if (ending) child.endInput();
  else if (!child.write(JSON.stringify({
    type: "user", uuid: inputId, session_id: sessionId, parent_tool_use_id: null, client_composed: true,
    message: { role: "user", content: FIXTURE_PROMPTS[mode] },
  }) + "\n")) stop("disconnected");
  return { closed };
}
