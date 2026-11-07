import type { CommandRunner } from "../command.ts";
import { toolEnv } from "../command.ts";
import { JsonLines, type NativeTransport } from "../native-transport.ts";
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
  if ([request.prompt, request.workspace, request.assignmentId, executable].some((part) => hasHeldSecret(part, secrets) || safeNativeText(part, secrets) !== part)) {
    state.outcome = "refused";
    state.reason = "The assignment includes a Dispatcher secret or credential. It was not sent.";
    return state;
  }
  let started = false;
  let terminal = false;
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
      if (state.threadId !== null || !opaqueId(msg.thread_id) || safeNativeText(msg.thread_id, secrets) !== msg.thread_id) { invalid(); return; }
      state.threadId = msg.thread_id;
    } else if (msg.type === "turn.started") {
      if (state.threadId === null || started) { invalid(); return; }
      started = true;
      state.outcome = "running";
    } else if (msg.type === "item.completed" || msg.type === "item.started") {
      if (!started || terminal) { invalid(); return; }
      const item = record(msg.item);
      if (!item || !opaqueId(item.id) || typeof item.type !== "string") { invalid(); return; }
      if (msg.type === "item.completed" && item.type === "agent_message") {
        if (typeof item.text !== "string") { invalid(); return; }
        state.resultText = safeNativeText(item.text, secrets, request.prompt);
      }
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
    const child = transport.start(state.argv, { cwd: request.workspace, env: toolEnv(parentEnv, secrets) }, {
      spawned() { state.spawned = true; },
      stdout(chunk) { parser.push(chunk); },
      stderr() {},
      inputError() {
        state.outcome = "disconnected";
        state.reason = "Native input disconnected. Writer completion is unknown.";
      },
      closed(exit) {
        parser.finish();
        if (state.outcome === "completed" && exit.code === 0 && exit.signal === null && exit.error === null) {
          state.observed.assignment = "supported";
          state.observed.streamResult = "supported";
        } else if (state.outcome !== "protocol-error" && state.outcome !== "failed") {
          state.outcome = "disconnected";
          state.reason = "Codex cli closed without a complete successful result. Writer completion is unknown.";
        }
        resolve(copyObservation(state));
      },
    });
    if (!child.write(request.prompt)) {
      state.outcome = "disconnected";
      state.reason = "Native input is unavailable. Writer completion is unknown.";
    }
    child.endInput();
  });
}
