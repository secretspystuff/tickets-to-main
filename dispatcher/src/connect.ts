import type { Custody } from "./custody.ts";
import { BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT } from "./custody.ts";
import { loadLedger, saveLedger, type ConnectionRecord, type Ledger } from "./ledger.ts";
import { confirmHello } from "./coordination.ts";
import { FixtureTransport, loadFixture, type DevicePoll } from "./protocol.ts";
import { PROTOCOL_REVISION } from "./version.ts";

export type ConnectResult = { exitCode: number; lines: string[] };

function requireInstalled(stateDir: string): Ledger {
  const loaded = loadLedger(stateDir);
  if (!loaded.ok) throw new Error("The local record could not be read.");
  if (!loaded.ledger.install) throw new Error("Tickets to Main is not installed. Run tickets-to-main install.");
  return loaded.ledger;
}

function secretsOf(ledger: Ledger, extra: string[]): string[] {
  return extra.filter((secret) => secret.length > 0);
}

export async function connectStart(input: {
  stateDir: string;
  computer: string;
  fixturePath: string | null;
  allowFixture: boolean;
  custody: Custody;
  nowIso: string;
}): Promise<ConnectResult> {
  const ledger = requireInstalled(input.stateDir);
  if (input.custody.describe().kind === "unavailable") {
    return {
      exitCode: 1,
      lines: ["The keychain is not available. The connection was not started, and no key was saved to a file."],
    };
  }
  if (!input.fixturePath) return { exitCode: 0, lines: confirmHello().lines };
  if (!input.allowFixture) {
    return { exitCode: 1, lines: ["A fixture connection is only for the test harness. No network request was sent."] };
  }
  const fixture = loadFixture(input.fixturePath);
  if (fixture.computer !== input.computer) {
    return { exitCode: 1, lines: ["The fixture is for a different computer. The connection was not started."] };
  }
  if (ledger.connection?.phase === "approved") {
    return { exitCode: 1, lines: ["This computer is already connected. Run tickets-to-main status."] };
  }
  await input.custody.put(DEVICE_CODE_ACCOUNT, fixture.challenge.deviceCode);
  const connection: ConnectionRecord = {
    phase: "pending",
    fixture: true,
    protocolRevision: PROTOCOL_REVISION,
    origin: fixture.origin,
    computer: input.computer,
    userCode: fixture.challenge.userCode,
    verificationUriComplete: fixture.challenge.verificationUriComplete,
    boardName: null,
    agentName: null,
    lastPollAt: null,
    fixturePollIndex: 0,
  };
  ledger.connection = connection;
  saveLedger(input.stateDir, ledger, [fixture.challenge.deviceCode]);
  return {
    exitCode: 0,
    lines: [`Open ${fixture.challenge.verificationUriComplete} and approve code ${fixture.challenge.userCode}.`],
  };
}

function applyPoll(connection: ConnectionRecord, result: DevicePoll, keyHeld: boolean): { connection: ConnectionRecord; lines: string[]; exitCode: number; dropDevice: boolean; key: string | null } {
  if (result.status === "authorization_pending") {
    return { connection, lines: ["Waiting for approval. Run tickets-to-main connect poll"], exitCode: 0, dropDevice: false, key: null };
  }
  if (result.status === "slow_down") {
    return { connection, lines: ["The server asked to wait. Run tickets-to-main connect poll again later."], exitCode: 0, dropDevice: false, key: null };
  }
  if (result.status === "access_denied") {
    connection.phase = "denied";
    return { connection, lines: ["Your human said no."], exitCode: 0, dropDevice: true, key: null };
  }
  if (result.status === "expired_token") {
    connection.phase = "expired";
    return { connection, lines: ["That code expired. Run tickets-to-main connect start again."], exitCode: 0, dropDevice: true, key: null };
  }
  if (!keyHeld) {
    return { connection, lines: ["The connection secret is missing from the keychain. Start again."], exitCode: 1, dropDevice: false, key: null };
  }
  connection.phase = "approved";
  connection.boardName = result.boardName;
  connection.agentName = result.agentName;
  return {
    connection,
    lines: [
      `Connected to the board ${result.boardName} as ${result.agentName}.`,
      "Connection: fixture.",
    ],
    exitCode: 0,
    dropDevice: true,
    key: result.key,
  };
}

export async function connectPoll(input: {
  stateDir: string;
  fixturePath: string | null;
  allowFixture: boolean;
  custody: Custody;
  nowMs: number;
}): Promise<ConnectResult> {
  const ledger = requireInstalled(input.stateDir);
  const connection = ledger.connection;
  if (!connection || connection.phase !== "pending") {
    return { exitCode: 1, lines: ["There is no connection waiting for approval."] };
  }
  if (!input.fixturePath) return { exitCode: 0, lines: confirmHello().lines };
  if (!input.allowFixture) {
    return { exitCode: 1, lines: ["A fixture connection is only for the test harness. No network request was sent."] };
  }
  const deviceCode = await input.custody.get(DEVICE_CODE_ACCOUNT);
  if (!deviceCode) {
    return { exitCode: 1, lines: ["The connection secret is missing from the keychain. Start again."] };
  }
  if (connection.lastPollAt !== null) {
    const previous = Date.parse(connection.lastPollAt);
    if (Number.isFinite(previous) && input.nowMs < previous + 5000) {
      return { exitCode: 0, lines: ["Wait 5 seconds, then run tickets-to-main connect poll again."] };
    }
  }
  const fixture = loadFixture(input.fixturePath);
  if (fixture.computer !== connection.computer || fixture.origin !== connection.origin || fixture.challenge.userCode !== connection.userCode) {
    return { exitCode: 1, lines: ["The fixture does not match the connection that is waiting."] };
  }
  if (fixture.challenge.deviceCode !== deviceCode) {
    return { exitCode: 1, lines: ["The fixture does not match the connection secret in the keychain."] };
  }
  let result: DevicePoll;
  try {
    const transport = new FixtureTransport(fixture);
    for (let index = 0; index < connection.fixturePollIndex; index += 1) transport.poll();
    result = transport.poll();
  } catch {
    return { exitCode: 1, lines: ["The fixture has no further poll result."] };
  }
  connection.lastPollAt = new Date(input.nowMs).toISOString();
  connection.fixturePollIndex += 1;
  const applied = applyPoll(connection, result, true);
  if (applied.dropDevice) await input.custody.delete(DEVICE_CODE_ACCOUNT);
  if (applied.key) await input.custody.put(BOARD_KEY_ACCOUNT, applied.key);
  ledger.connection = applied.connection;
  const hidden = secretsOf(ledger, [deviceCode, applied.key ?? ""]);
  saveLedger(input.stateDir, ledger, hidden);
  return { exitCode: applied.exitCode, lines: applied.lines };
}
