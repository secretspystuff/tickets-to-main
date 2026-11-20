import type { Custody } from "./custody.ts";
import { BOARD_KEY_ACCOUNT } from "./custody.ts";
import { loadLedger, type Ledger, type ToolRecord } from "./ledger.ts";
import { osWords } from "./platform.ts";
import { PACKAGE_VERSION, PRODUCT_LINE } from "./version.ts";
import { confirmHello } from "./coordination.ts";
import { verifySelectedRelease, type VerifiedSelectedRelease } from "./install.ts";
import type { ReleaseTrust } from "./release-manifest.ts";
import { assertReleaseRoot } from "./release-store.ts";
import { observeRecordedPid, type PidObservation } from "./process-identity.ts";

export const CODEX_INTERFACE_RULE = "Codex cli and Codex app-server are separate interfaces.";

export type ReleaseStatusContext = { platform: NodeJS.Platform; arch: string; trust?: ReleaseTrust };

type ReleaseVerification =
  | { state: "bootstrap" | "unavailable" | "refused" }
  | ({ state: "verified" } & VerifiedSelectedRelease);

export type StatusSnapshot = {
  lines: string[];
  exitCode: number;
  signedIn: boolean;
  readyForAssignment: false;
  releaseVerification?: ReleaseVerification;
};

function toolLine(tool: ToolRecord | undefined, interfaceId: "cli" | "app-server"): string {
  if (!tool) return `Codex ${interfaceId}: undiscovered`;
  const experimental = tool.experimental === true ? ", experimental" : "";
  if (tool.qualification === "unavailable") return `Codex ${interfaceId}: unavailable${experimental}`;
  if (tool.qualification === "unknown") return `Codex ${interfaceId}: unknown${experimental}`;
  return `Codex ${interfaceId}: documented${experimental}`;
}

function keychainLine(kind: string, signedIn: boolean, approved: boolean): string {
  if (approved && !signedIn) return "Keychain: secret missing";
  if (kind === "test-double") return "Keychain: test double, unqualified";
  if (kind === "secret-tool") return "Keychain: secret-tool, unqualified";
  if (kind === "windows-credential-manager") return "Keychain: Windows Credential Manager, unqualified";
  return "Keychain: unavailable";
}

function observeSelectedRelease(stateDir: string, ledger: Ledger, context: ReleaseStatusContext): ReleaseVerification {
  if (!ledger.install?.release) return { state: "bootstrap" };
  if (!context.trust) return { state: "unavailable" };
  try {
    assertReleaseRoot(stateDir);
    const verified = verifySelectedRelease({ stateDir, platform: context.platform, arch: context.arch }, ledger, context.trust);
    return verified ? { state: "verified", ...verified } : { state: "refused" };
  } catch { return { state: "refused" }; }
}

function selectedReleaseLine(verification: ReleaseVerification): string {
  if (verification.state === "verified") return `Selected release: ${verification.version} verified.`;
  if (verification.state === "bootstrap") return "Selected release: none (bootstrap).";
  return `Selected release: verification ${verification.state}.`;
}

export async function statusOf(stateDir: string, custody: Custody, pidAlive?: (pid: number) => boolean,
  releaseContext?: ReleaseStatusContext): Promise<StatusSnapshot> {
  const hello = confirmHello();
  const loaded = loadLedger(stateDir);
  if (!loaded.ok && loaded.reason === "missing") {
    return {
      exitCode: 1,
      signedIn: false,
      readyForAssignment: false,
      lines: render({ installed: false, health: "not installed", protocolLine: hello.protocolLine, runtimeLine: hello.runtimeLine, servedLine: hello.servedLine }),
    };
  }
  if (!loaded.ok) {
    const health = loaded.reason === "unsafe" ? "state directory is not private" : "local record unreadable";
    return { exitCode: 1, signedIn: false, readyForAssignment: false, lines: render({ installed: false, health, protocolLine: hello.protocolLine, runtimeLine: hello.runtimeLine, servedLine: hello.servedLine }) };
  }
  const ledger = loaded.ledger;
  if (!ledger.install) {
    return { exitCode: 1, signedIn: false, readyForAssignment: false, lines: render({ installed: false, health: "not installed", protocolLine: hello.protocolLine, runtimeLine: hello.runtimeLine, servedLine: hello.servedLine }) };
  }
  const releaseVerification = releaseContext && observeSelectedRelease(stateDir, ledger, releaseContext);
  const releaseFailure = releaseVerification?.state === "unavailable" || releaseVerification?.state === "refused"
    ? releaseVerification.state : null;
  const approved = ledger.connection?.phase === "approved";
  const key = approved ? await custody.get(BOARD_KEY_ACCOUNT) : null;
  const signedIn = Boolean(approved && key);
  const board = boardLine(ledger);
  const lines = render({
    installed: true,
    os: osWords(ledger.install.platform),
    board,
    signedIn,
    keychain: keychainLine(custody.describe().kind, signedIn, Boolean(approved)),
    writerPidObservation: ledger.workspace ? observeRecordedPid(ledger.workspace.writerPid, pidAlive) : undefined,
    tools: ledger.tools,
    releaseVerification,
    health: releaseFailure ? `selected release verification ${releaseFailure}` : "local record ok",
    protocolLine: hello.protocolLine,
    runtimeLine: hello.runtimeLine,
    servedLine: hello.servedLine,
  });
  return {
    exitCode: releaseFailure ? 1 : 0, signedIn, readyForAssignment: false, lines,
    ...(releaseVerification && { releaseVerification }),
  };
}

function boardLine(ledger: Ledger): string {
  const connection = ledger.connection;
  if (!connection) return "not connected";
  if (connection.phase === "pending") return "waiting for approval (fixture)";
  if (connection.phase === "denied") return "human said no";
  if (connection.phase === "expired") return "code expired";
  return `${connection.boardName ?? "unknown board"} (fixture)`;
}

function render(input: {
  installed: boolean;
  health: string;
  os?: string;
  board?: string;
  signedIn?: boolean;
  keychain?: string;
  writerPidObservation?: PidObservation;
  releaseVerification?: ReleaseVerification;
  tools?: ToolRecord[];
  protocolLine: string;
  runtimeLine: string;
  servedLine: string;
}): string[] {
  const lines = [`${PRODUCT_LINE} ${PACKAGE_VERSION}`, "", `Installed: ${input.installed ? "yes" : "no"}`];
  if (input.installed && input.os) {
    lines.push(`Operating system: ${input.os}`, "Signed installers: unqualified.", "Startup: unregistered.");
    if (input.releaseVerification) lines.push(selectedReleaseLine(input.releaseVerification));
    if (input.writerPidObservation === undefined) lines.push("Workspace: none", "Writer: none");
    else {
      const observation = input.writerPidObservation === "present" ? "present (process identity unverified)" : input.writerPidObservation;
      lines.push("Workspace: prepared, unqualified", "Writer: unknown (including helpers)", `Recorded writer PID: ${observation}`);
    }
  }
  lines.push(
    "",
    `Board: ${input.board ?? "not connected"}`,
    `Signed in: ${input.signedIn ? "yes" : "no"}`,
    input.keychain ?? "Keychain: unavailable",
    "",
    "Coding tool:",
  );
  const cli = input.tools?.find((tool) => tool.interfaceId === "cli");
  const appServer = input.tools?.find((tool) => tool.interfaceId === "app-server");
  if (!cli && !appServer) lines.push("none");
  else lines.push(toolLine(cli, "cli"), toolLine(appServer, "app-server"));
  lines.push(
    CODEX_INTERFACE_RULE,
    "Compatible: no",
    "Ready for an assignment: no",
    "",
    input.protocolLine,
    input.runtimeLine,
    input.servedLine,
    `Health: ${input.health}`,
  );
  return lines;
}

export function renderStatus(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}
