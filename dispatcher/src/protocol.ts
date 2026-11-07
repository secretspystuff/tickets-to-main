import { readFileSync } from "node:fs";
import { KEY_MARK, unfold } from "./secret-text.ts";
import { PROTOCOL_REVISION } from "./version.ts";

export type DeviceChallenge = {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
};

export type DevicePoll =
  | { status: "authorization_pending" }
  | { status: "slow_down" }
  | { status: "access_denied" }
  | { status: "expired_token" }
  | { status: "approved"; key: string; boardName: string; agentName: string };

export type DeviceFixture = {
  protocolRevision: typeof PROTOCOL_REVISION;
  serverIntegration: false;
  origin: string;
  computer: string;
  challenge: DeviceChallenge;
  polls: DevicePoll[];
};

const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const KEY = new RegExp("^tp" + "_[A-Za-z0-9_-]{8,80}$");
const LABEL = /^[A-Za-z0-9 ._()'-]{1,80}$/;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url;
  } catch {
    return null;
  }
}

/** Fixtures may name localhost or a .test host. They cannot point at a live site. */
export function fixtureOrigin(value: string): URL | null {
  const url = httpsUrl(value);
  if (!url) return null;
  const host = url.hostname;
  if (host !== "localhost" && !host.endsWith(".test")) return null;
  return url;
}

function poll(value: unknown): DevicePoll | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (row.error === "authorization_pending" && keys.length === 1) return { status: "authorization_pending" };
  if (row.error === "slow_down" && keys.length === 1) return { status: "slow_down" };
  if (row.error === "access_denied" && keys.length === 1) return { status: "access_denied" };
  if (row.error === "expired_token" && keys.length === 1) return { status: "expired_token" };
  if (keys.length !== 3 || typeof row.key !== "string" || typeof row.boardName !== "string" || typeof row.agentName !== "string") {
    return null;
  }
  const key = row.key;
  const boardName = row.boardName;
  const agentName = row.agentName;
  const board = unfold(boardName);
  const agent = unfold(agentName);
  if (!KEY.test(key) || !LABEL.test(boardName) || !LABEL.test(agentName) || board === null || agent === null) return null;
  if ([boardName, board, agentName, agent].some((form) => form.includes(key) || form.includes(KEY_MARK))) return null;
  return { status: "approved", key, boardName, agentName };
}

export function parseFixture(value: unknown): DeviceFixture {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("The fixture is not a connection record.");
  const row = value as Record<string, unknown>;
  const allowed = ["protocolRevision", "serverIntegration", "origin", "computer", "challenge", "polls"];
  if (Object.keys(row).some((key) => !allowed.includes(key))) throw new ProtocolError("The fixture has a field this build does not accept.");
  if (row.protocolRevision !== PROTOCOL_REVISION) throw new ProtocolError("The fixture is not the waiting protocol revision.");
  if (row.serverIntegration !== false) throw new ProtocolError("The fixture claimed a live server. It was refused.");
  if (typeof row.origin !== "string" || !fixtureOrigin(row.origin)) throw new ProtocolError("The fixture origin is not a .test or localhost https address.");
  if (typeof row.computer !== "string" || row.computer.length === 0) throw new ProtocolError("The fixture computer name is missing.");
  const challenge = row.challenge;
  if (challenge === null || typeof challenge !== "object") throw new ProtocolError("The fixture challenge is missing.");
  const fields = challenge as Record<string, unknown>;
  const challengeKeys = ["device_code", "user_code", "verification_uri_complete", "expires_in", "interval"];
  if (Object.keys(fields).some((key) => !challengeKeys.includes(key))) throw new ProtocolError("The fixture challenge has a field this build does not accept.");
  if (typeof fields.device_code !== "string" || fields.device_code.length < 8 || fields.device_code.includes(fields.user_code as string)) {
    throw new ProtocolError("The fixture device code is not usable.");
  }
  if (typeof fields.user_code !== "string" || !USER_CODE.test(fields.user_code)) throw new ProtocolError("The fixture user code is not usable.");
  if (typeof fields.verification_uri_complete !== "string") throw new ProtocolError("The fixture verification address is missing.");
  const deviceCode = fields.device_code;
  const verification = fields.verification_uri_complete;
  const originText = row.origin;
  const page = fixtureOrigin(verification);
  if (!page || page.origin !== new URL(originText).origin) throw new ProtocolError("The fixture verification address does not match its origin.");
  const address = unfold(verification);
  const origin = unfold(originText);
  if (address === null || origin === null) throw new ProtocolError("The fixture address could not be read.");
  if ([verification, address, originText, origin].some((form) => form.includes(deviceCode) || form.includes(KEY_MARK))) {
    throw new ProtocolError("The fixture verification address includes a secret.");
  }
  if (fields.expires_in !== 600 || fields.interval !== 5) throw new ProtocolError("The fixture timing is not the device-login timing.");
  if (!Array.isArray(row.polls) || row.polls.length === 0) throw new ProtocolError("The fixture has no poll results.");
  const polls: DevicePoll[] = [];
  for (const entry of row.polls) {
    const parsed = poll(entry);
    if (!parsed) throw new ProtocolError("The fixture has a poll result this build does not accept.");
    polls.push(parsed);
  }
  return {
    protocolRevision: PROTOCOL_REVISION,
    serverIntegration: false,
    origin: row.origin,
    computer: row.computer,
    challenge: {
      deviceCode: fields.device_code,
      userCode: fields.user_code,
      verificationUriComplete: fields.verification_uri_complete,
      expiresIn: 600,
      interval: 5,
    },
    polls,
  };
}

export function loadFixture(path: string): DeviceFixture {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ProtocolError("The fixture could not be read.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError("The fixture is not JSON.");
  }
  return parseFixture(parsed);
}

export class FixtureTransport {
  private index = 0;
  private readonly fixture: DeviceFixture;

  constructor(fixture: DeviceFixture) {
    this.fixture = fixture;
  }

  challenge(): DeviceChallenge {
    return this.fixture.challenge;
  }

  /** One poll per call. The caller enforces the interval before asking. */
  poll(): DevicePoll {
    const next = this.fixture.polls[this.index];
    if (!next) throw new ProtocolError("The fixture has no further poll result.");
    this.index += 1;
    return next;
  }
}
