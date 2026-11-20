import { createHash } from "node:crypto";
import type { CommandRunner } from "../command.ts";
import { toolEnv } from "../command.ts";
import { JsonLines, type NativeProcess, type NativeTransport } from "../native-transport.ts";
import { copyObservation, hasHeldSecret, nativeObservation, opaqueId, record, safeNativeText, type NativeObservation } from "./native-result.ts";
export { startCodexAppServerAssignment, CODEX_APP_SERVER_SCHEMA_VERSION } from "./codex-app-server.ts";
export type { CodexAssignmentHandle, CodexAppServerLaunch } from "./codex-app-server.ts";
import {
  unknownCapabilities,
  type AssignmentRequest,
  type InterfaceClaim,
} from "./contract.ts";

export const CODEX_CLI = "cli";
export const CODEX_APP_SERVER = "app-server";
export const CODEX_INTERFACE_RULE = "Codex cli and Codex app-server are separate interfaces.";

export type CodexInterfaceId = typeof CODEX_CLI | typeof CODEX_APP_SERVER;

const VERSION = /\bcodex-cli (\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?)/;
const CLI_THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLI_COLLAB_TOOLS = new Set(["spawn_agent", "send_input", "wait", "close_agent"]);
const CLI_HELPER_STATES: ReadonlyMap<string, NativeObservation["helpers"]> = new Map([
  ["pending_init", "active-observed"],
  ["running", "active-observed"],
  ["interrupted", "unknown"],
  ["completed", "terminal-observed"],
  ["errored", "terminal-observed"],
  ["shutdown", "terminal-observed"],
  ["not_found", "unknown"],
]);
const CLI_COLLAB_LIMIT = 128;
const CLI_OTHER_ITEM_LIMIT = 1024;
type CliItemPhase = "item.started" | "item.updated" | "item.completed";
type CliCollabItem = {
  id: string;
  tool: string;
  receivers: string[];
  promptDigest: string | null;
  reports: Map<string, NativeObservation["helpers"]>;
};

function safeCliId(value: unknown, prompt: string, secrets: readonly string[]): value is string {
  if (!opaqueId(value)) return false;
  // One input character can match part of a serialized native UUID by chance.
  const assignmentEcho = prompt.length > 0 && value.includes(prompt) && !(prompt.length === 1 && CLI_THREAD_UUID.test(value));
  return !assignmentEcho && !hasHeldSecret(value, secrets) && safeNativeText(value, []) === value;
}

function optionalCliText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function validCliCollabPrompt(tool: string, prompt: unknown): boolean {
  if (tool === "spawn_agent") return optionalCliText(prompt);
  if (tool === "send_input") return typeof prompt === "string";
  return prompt === undefined || prompt === null;
}

function validCliCollabTargets(tool: string, status: unknown, count: number): boolean {
  if (tool === "spawn_agent") {
    if (status === "in_progress") return count === 0;
    if (status === "failed") return count <= 1;
  }
  return tool === "wait" ? count > 0 : count === 1;
}

function readCliCollabItem(
  value: Record<string, unknown>,
  phase: CliItemPhase,
  safeId: (value: unknown) => value is string,
): CliCollabItem | null {
  const { id, sender_thread_id: sender, receiver_thread_ids: receivers, tool, status, prompt } = value;
  const completed = phase === "item.completed";
  const states = record(value.agents_states);
  if (!safeId(id) || !safeId(sender) || typeof tool !== "string" || !CLI_COLLAB_TOOLS.has(tool)
    || phase === "item.updated" || !validCliCollabPrompt(tool, prompt)
    || (completed ? status !== "completed" && status !== "failed" : status !== "in_progress")
    || !Array.isArray(receivers) || receivers.length > CLI_COLLAB_LIMIT || !receivers.every(safeId)
    || !validCliCollabTargets(tool, status, receivers.length) || receivers.includes(sender) || !states) return null;

  const targets = new Set(receivers);
  const reported = Object.keys(states);
  if (targets.size !== receivers.length || reported.length !== (completed ? receivers.length : 0)
    || reported.some(receiver => !targets.has(receiver))) return null;

  const reports = new Map<string, NativeObservation["helpers"]>();
  let failed = tool === "spawn_agent" && targets.size === 0;
  for (const receiver of reported) {
    const report = record(states[receiver]);
    const status = report?.status;
    const observation = typeof status === "string" ? CLI_HELPER_STATES.get(status) : undefined;
    if (observation === undefined || !optionalCliText(report?.message)) return null;
    // The CLI also spells a single-target resume report as wait.
    if (tool === "wait" && targets.size > 1 && (observation === "active-observed" || status === "interrupted")) return null;
    failed ||= status === "errored" || status === "not_found";
    reports.set(receiver, observation);
  }
  if (completed && status !== (failed ? "failed" : "completed")) return null;
  const promptDigest = typeof prompt === "string" ? createHash("sha256").update(prompt, "utf16le").digest("hex") : null;
  return { id, tool, receivers, promptDigest, reports };
}

export function documentedCodexClaim(interfaceId: CodexInterfaceId, extra?: { experimental?: true | "unknown"; qualification?: "documented" | "unavailable" | "unknown" }): InterfaceClaim {
  const qualification = extra?.qualification ?? "documented";
  return {
    vendor: "codex",
    interfaceId,
    interchangeableWith: [],
    qualification,
    capabilities: unknownCapabilities(),
    personFacing: false,
    experimental: extra?.experimental ?? "unknown",
    limit: interfaceId === CODEX_CLI
      ? "Codex cli is documented only. It is a separate interface from app-server."
      : "Codex app-server is documented only. It is a separate interface from cli.",
  };
}

function versionOf(text: string): string | null {
  const found = VERSION.exec(text);
  const version = found?.[1] ?? null;
  if (version && version.length <= 80) return version;
  return null;
}

function experimentalOf(text: string): true | "unknown" {
  return /experimental/i.test(text) ? true : "unknown";
}

export type CodexDiscovery = { claim: InterfaceClaim; version: string | null };

export async function discoverCodex(interfaceId: CodexInterfaceId, runner: CommandRunner): Promise<CodexDiscovery> {
  const version = await runner.run(["codex", "--version"], { timeoutMs: 5000 });
  const helpArgs = interfaceId === CODEX_CLI ? ["codex", "exec", "--help"] : ["codex", "app-server", "--help"];
  const help = await runner.run(helpArgs, { timeoutMs: 5000 });
  if (version.error || version.code === null) return { claim: documentedCodexClaim(interfaceId, { qualification: "unavailable" }), version: null };
  if (version.code !== 0 || help.code !== 0) return { claim: documentedCodexClaim(interfaceId, { qualification: "unknown" }), version: null };
  return {
    claim: documentedCodexClaim(interfaceId, {
      qualification: "documented",
      experimental: experimentalOf(`${help.stdout}\n${help.stderr}`),
    }),
    version: versionOf(`${version.stdout}\n${version.stderr}`),
  };
}

export async function runCodexCliAssignment(
  request: AssignmentRequest,
  transport: NativeTransport,
  parentEnv: NodeJS.ProcessEnv,
  secrets: readonly string[],
  executable = "codex",
): Promise<NativeObservation> {
  const state = nativeObservation(CODEX_CLI);
  if (request.model !== null || request.effort !== null) {
    state.outcome = "refused";
    state.reason = request.model !== null ? "Model selection is unknown on Codex cli." : "Effort selection is unknown on Codex cli.";
    return state;
  }
  const prompt = request.prompt;
  if ([prompt, request.workspace, request.assignmentId, executable].some((part) => hasHeldSecret(part, secrets) || safeNativeText(part, secrets) !== part)) {
    state.outcome = "refused";
    state.reason = "The assignment includes a Dispatcher secret or credential. It was not sent.";
    return state;
  }
  let started = false;
  let terminal = false;
  let ambiguousHelpers = false;
  const helpers = new Map<string, NativeObservation["helpers"]>();
  const collabItems = new Map<string, Pick<CliCollabItem, "tool" | "receivers" | "promptDigest"> | null>();
  const otherItemIds = new Set<string>();
  const spawnedHelpers = new Set<string>();
  function safeCollabId(value: unknown): value is string {
    return safeCliId(value, prompt, secrets);
  }
  function observeItem(item: Record<string, unknown>, phase: CliItemPhase): void {
    if (ambiguousHelpers) return;
    const { id, sender_thread_id: sender } = item;
    if (item.type !== "collab_tool_call" || (safeCollabId(sender) && sender !== state.threadId)) {
      if (!opaqueId(id)) return;
      if (collabItems.has(id) || (!otherItemIds.has(id) && otherItemIds.size >= CLI_OTHER_ITEM_LIMIT)) ambiguousHelpers = true;
      else otherItemIds.add(id);
      return;
    }
    const collab = readCliCollabItem(item, phase, safeCollabId);
    if (!collab || otherItemIds.has(collab.id)) {
      ambiguousHelpers = true;
      return;
    }
    const { id: callId, tool, receivers, promptDigest, reports } = collab;
    const completed = phase === "item.completed";
    const targets = new Set(receivers);
    const previous = collabItems.get(callId);
    if (previous === null || (previous && (!completed || previous.tool !== tool || previous.promptDigest !== promptDigest
        || (tool !== "spawn_agent" && (previous.receivers.length !== receivers.length
          || previous.receivers.some(receiver => !targets.has(receiver))))))
      || (previous === undefined && collabItems.size >= CLI_COLLAB_LIMIT)) {
      ambiguousHelpers = true;
      return;
    }
    collabItems.set(callId, completed ? null : { tool, receivers, promptDigest });
    for (const [receiver, observation] of reports) {
      if ((!helpers.has(receiver) && helpers.size >= CLI_COLLAB_LIMIT) || (tool === "spawn_agent" && spawnedHelpers.has(receiver))) {
        ambiguousHelpers = true;
        return;
      }
      if (tool === "spawn_agent") spawnedHelpers.add(receiver);
      helpers.set(receiver, observation);
    }
  }
  function helperObservation(): NativeObservation["helpers"] {
    if (ambiguousHelpers || helpers.size === 0 || [...collabItems.values()].some(Boolean)) return "unknown";
    const observed = [...helpers.values()];
    if (observed.includes("unknown")) return "unknown";
    return observed.includes("active-observed") ? "active-observed" : "terminal-observed";
  }
  function invalid(): void {
    state.outcome = "protocol-error";
    state.reason = "The Codex cli stream could not establish a result. Writer completion is unknown.";
    delete state.observed.assignment;
  }
  const parser = new JsonLines((value) => {
    if (["protocol-error", "failed", "disconnected"].includes(state.outcome)) return;
    const msg = record(value);
    if (!msg || typeof msg.type !== "string") { invalid(); return; }
    if (msg.type === "thread.started") {
      const id = msg.thread_id;
      if (state.threadId !== null || !safeCliId(id, prompt, secrets)) { invalid(); return; }
      state.threadId = id;
    } else if (msg.type === "turn.started") {
      if (state.threadId === null || started) { invalid(); return; }
      started = true;
      state.outcome = "running";
    } else if (msg.type === "item.completed" || msg.type === "item.started") {
      if (!started || terminal) { invalid(); return; }
      const item = record(msg.item);
      if (!item || !opaqueId(item.id) || typeof item.type !== "string") { invalid(); return; }
      observeItem(item, msg.type);
      if (msg.type === "item.completed" && item.type === "agent_message") {
        if (typeof item.text !== "string") { invalid(); return; }
        state.resultText = safeNativeText(item.text, secrets, prompt);
      }
    } else if (msg.type === "item.updated") {
      const item = record(msg.item);
      if (item && ((started && !terminal) || item.type === "collab_tool_call")) observeItem(item, msg.type);
    } else if (msg.type === "turn.completed") {
      if (!started || terminal || state.resultText === null || state.outcome !== "running") { invalid(); return; }
      terminal = true;
      state.outcome = "completed";
    } else if (msg.type === "turn.failed" || msg.type === "error") {
      terminal = true;
      state.outcome = "failed";
      state.reason = "Codex cli reported a failure. Its specific cause is unknown.";
    }
  }, invalid);
  state.argv = [executable, "exec", "--json", "-"];
  return new Promise((resolve) => {
    let child: NativeProcess | undefined;
    let inputStarted = false;
    let inputEnded = false;
    let connectionClosed = false;
    function sendInput(): void {
      if (!child || !state.spawned || inputStarted || connectionClosed || state.outcome !== "starting") return;
      inputStarted = true;
      const accepted = child.write(prompt);
      if (!accepted) {
        state.outcome = "disconnected";
        state.reason = "Native input is unavailable. Writer completion is unknown.";
      }
      if (!connectionClosed) {
        // EOF can synchronously close the stream after the prompt was accepted.
        inputEnded = accepted;
        child.endInput();
      }
    }
    child = transport.start(state.argv, { cwd: request.workspace, env: toolEnv(parentEnv, secrets) }, {
      spawned() { state.spawned = true; sendInput(); },
      stdout(chunk) { parser.push(chunk); },
      stderr() {},
      inputError() {
        state.outcome = "disconnected";
        state.reason = "Native input disconnected. Writer completion is unknown.";
      },
      closed(exit) {
        if (connectionClosed) return;
        connectionClosed = true;
        parser.finish();
        if (inputEnded && state.outcome === "completed" && exit.code === 0 && exit.signal === null && exit.error === null) {
          state.observed.assignment = "supported";
          state.observed.streamResult = "supported";
          state.helpers = helperObservation();
        } else if (state.outcome !== "protocol-error" && state.outcome !== "failed") {
          state.outcome = "disconnected";
          state.reason = "Codex cli closed without a complete successful result. Writer completion is unknown.";
        }
        resolve(copyObservation(state));
      },
    });
    sendInput();
  });
}
