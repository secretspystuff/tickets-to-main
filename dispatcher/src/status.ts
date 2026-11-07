import type { Custody } from "./custody.ts";
import { BOARD_KEY_ACCOUNT } from "./custody.ts";
import { loadLedger, type Ledger, type ToolRecord } from "./ledger.ts";
import { osWords } from "./platform.ts";
import { PACKAGE_VERSION, PRODUCT_LINE } from "./version.ts";
import { confirmHello } from "./coordination.ts";
import { processAlive } from "./workspace.ts";

export const CODEX_INTERFACE_RULE = "Codex cli and Codex app-server are separate interfaces.";

export type StatusSnapshot = {
  lines: string[];
  exitCode: number;
  signedIn: boolean;
  readyForAssignment: false;
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
  return "Keychain: unavailable";
}

export async function statusOf(stateDir: string, custody: Custody, pidAlive: (pid: number) => boolean = processAlive): Promise<StatusSnapshot> {
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
  const approved = ledger.connection?.phase === "approved";
  const key = approved ? await custody.get(BOARD_KEY_ACCOUNT) : null;
  const signedIn = Boolean(approved && key);
  const board = boardLine(ledger);
  const writerPid = ledger.workspace?.writerPid ?? null;
  const writer = writerPid === null ? "none" : pidAlive(writerPid) ? "running" : "stopped";
  const lines = render({
    installed: true,
    os: osWords(ledger.install.platform),
    board,
    signedIn,
    keychain: keychainLine(custody.describe().kind, signedIn, Boolean(approved)),
    workspace: ledger.workspace ? "prepared, unqualified" : "none",
    writer,
    tools: ledger.tools,
    health: "local record ok",
    protocolLine: hello.protocolLine,
    runtimeLine: hello.runtimeLine,
    servedLine: hello.servedLine,
  });
  return { exitCode: 0, signedIn, readyForAssignment: false, lines };
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
  workspace?: string;
  writer?: string;
  tools?: ToolRecord[];
  protocolLine: string;
  runtimeLine: string;
  servedLine: string;
}): string[] {
  const lines = [`${PRODUCT_LINE} ${PACKAGE_VERSION}`, "", `Installed: ${input.installed ? "yes" : "no"}`];
  if (input.installed && input.os) {
    lines.push(`Operating system: ${input.os}`, "Signed installers: unqualified.", "Startup: unregistered.");
    lines.push(`Workspace: ${input.workspace ?? "none"}`, `Writer: ${input.writer ?? "none"}`);
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
