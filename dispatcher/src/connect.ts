import { createHash, randomBytes } from "node:crypto";
import type { Custody } from "./custody.ts";
import { BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT } from "./custody.ts";
import { loadLedger, updateLedger, type ConnectionRecord, type DeliveryReceipt, type Ledger } from "./ledger.ts";
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

function commitConnection(stateDir: string, expected: string, connection: ConnectionRecord, secrets: readonly string[]): string {
  updateLedger(stateDir, secrets, (current) => {
    if (!current.install || JSON.stringify(current.connection) !== expected) throw new Error("The connection changed. Its work was preserved; reload before retrying.");
    current.connection = structuredClone(connection);
  });
  return JSON.stringify(connection);
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function scopeOf(custody: Custody): string | null {
  if (custody.scopeId === undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(custody.scopeId)) throw new Error("The credential scope is unavailable.");
  return custody.scopeId;
}

function bindingOf(connection: ConnectionRecord): string {
  return digest(JSON.stringify([connection.enrollmentId, connection.fixture, connection.protocolRevision, connection.origin, connection.computer, connection.userCode, connection.verificationUriComplete]));
}

function connectedLines(connection: ConnectionRecord): string[] {
  return [`Connected to the board ${connection.boardName} as ${connection.agentName}.`, "Connection: fixture."];
}

function receiptOf(connection: ConnectionRecord, scopeId: string, key: string, boardName: string, agentName: string): DeliveryReceipt {
  if (!connection.enrollmentId) throw new Error("The pending connection has no enrollment identity. Its work was preserved.");
  return { version: 1, scopeId, enrollmentId: connection.enrollmentId, bindingDigest: bindingOf(connection), credentialDigest: digest(key), boardName, agentName };
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
  let expectedConnection = JSON.stringify(ledger.connection);
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
    ...(scopeOf(input.custody) === null ? {} : { enrollmentId: randomBytes(16).toString("hex") }),
  };
  commitConnection(input.stateDir, expectedConnection, connection, [fixture.challenge.deviceCode]);
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
    lines: connectedLines(connection),
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
  let expectedConnection = JSON.stringify(ledger.connection);
  const connection = ledger.connection;
  if (!connection || connection.phase !== "pending") {
    return { exitCode: 1, lines: ["There is no connection waiting for approval."] };
  }
  if (!input.fixturePath) return { exitCode: 0, lines: confirmHello().lines };
  if (!input.allowFixture) {
    return { exitCode: 1, lines: ["A fixture connection is only for the test harness. No network request was sent."] };
  }
  const scope = scopeOf(input.custody);
  if (scope !== null && connection.deliveryReceipt !== undefined) {
    const receipt = connection.deliveryReceipt;
    if (receipt.scopeId !== scope || receipt.enrollmentId !== connection.enrollmentId || receipt.bindingDigest !== bindingOf(connection)) {
      return { exitCode: 1, lines: ["The saved delivery does not belong to this pending connection and credential scope. Its work was preserved."] };
    }
    const stored = await input.custody.get(BOARD_KEY_ACCOUNT);
    if (stored === null || digest(stored) !== receipt.credentialDigest) {
      return { exitCode: 1, lines: ["The saved delivery could not be verified in the keychain. Its work was preserved without another token request."] };
    }
    await input.custody.delete(DEVICE_CODE_ACCOUNT);
    const approved: ConnectionRecord = { ...connection, phase: "approved", boardName: receipt.boardName, agentName: receipt.agentName };
    delete approved.deliveryReceipt;
    commitConnection(input.stateDir, expectedConnection, approved, [stored]);
    return { exitCode: 0, lines: connectedLines(approved) };
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
  const applied = applyPoll({ ...connection }, result, true);
  if (scope !== null && applied.key !== null) {
    const receipt = receiptOf(connection, scope, applied.key, applied.connection.boardName!, applied.connection.agentName!);
    expectedConnection = commitConnection(input.stateDir, expectedConnection, { ...connection, deliveryReceipt: receipt }, [deviceCode, applied.key]);
    await input.custody.put(BOARD_KEY_ACCOUNT, applied.key);
    await input.custody.delete(DEVICE_CODE_ACCOUNT);
    commitConnection(input.stateDir, expectedConnection, applied.connection, [deviceCode, applied.key]);
    return { exitCode: applied.exitCode, lines: applied.lines };
  }
  if (applied.dropDevice) await input.custody.delete(DEVICE_CODE_ACCOUNT);
  if (applied.key) await input.custody.put(BOARD_KEY_ACCOUNT, applied.key);
  const hidden = [deviceCode, applied.key ?? ""].filter(Boolean);
  commitConnection(input.stateDir, expectedConnection, applied.connection, hidden);
  return { exitCode: applied.exitCode, lines: applied.lines };
}
