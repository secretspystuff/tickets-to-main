import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  COMMANDS,
  COMMAND_CATALOG,
  COPY,
  FIXTURE_FILES,
  PROTOCOL,
  PROTOCOL_VERSION,
  RUNTIME,
  admissionReservationsServed,
  applyRule,
  catalog,
  connectionSettingsServed,
  fixtureFindings,
  negotiate,
  runtimeClaimConsistent,
  serveAdmissionReservations,
  serveConnectionSettings,
  validateWire,
  type CommandName,
  type ProtocolFailure,
  type WireRole,
} from "../../src/lib/ttm-protocol.ts";

export const COORDINATION_PROTOCOL = PROTOCOL;
export const COORDINATION_VERSION = PROTOCOL_VERSION;

export type HelloProof = {
  protocolLine: string;
  runtimeLine: string;
  servedLine: string;
  lines: string[];
};

const FIXTURE_DIR = new URL("../../src/lib/ttm-protocol/fixtures/", import.meta.url);
const MANIFEST_URL = new URL("../../src/lib/ttm-protocol/manifest.json", import.meta.url);

type FixtureWire = {
  role?: unknown;
  document?: unknown;
  accept?: unknown;
  code?: unknown;
};

type FixtureCase = {
  rule?: unknown;
  input?: unknown;
  expect?: unknown;
};

type FixtureFile = {
  fabricated?: unknown;
  name?: unknown;
  shows?: unknown;
  wire?: unknown;
  cases?: unknown;
};

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => same(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && same(leftRecord[key], rightRecord[key]));
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8")) as unknown;
}

function isRole(value: unknown): value is WireRole {
  return value === "request" || value === "response" || value === "refusal";
}

function wireFailureCode(result: { ok: true } | ProtocolFailure): string {
  return result.ok ? "" : result.code;
}

function assertFixture(name: string, value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The coordination fixture is not valid.");
  }
  const fixture = value as FixtureFile;
  if (fixture.fabricated !== true) throw new Error("The coordination fixture is not valid.");
  if (fixture.name !== name.replace(/\.json$/, "")) throw new Error("The coordination fixture is not valid.");
  if (typeof fixture.shows !== "string" || fixture.shows.length <= 20) throw new Error("The coordination fixture is not valid.");
  if (fixtureFindings(fixture).length > 0) throw new Error("The coordination fixture is not valid.");
  const wires = fixture.wire === undefined ? [] : fixture.wire;
  if (!Array.isArray(wires)) throw new Error("The coordination fixture is not valid.");
  for (const entry of wires) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("The coordination fixture is not valid.");
    const wire = entry as FixtureWire;
    if (!isRole(wire.role)) throw new Error("The coordination fixture is not valid.");
    const result = validateWire(wire.document, wire.role);
    if (wire.accept === false) {
      if (result.ok || typeof wire.code !== "string" || wireFailureCode(result) !== wire.code) {
        throw new Error("The coordination fixture is not valid.");
      }
    } else if (!result.ok) {
      throw new Error("The coordination fixture is not valid.");
    }
  }
  const cases = fixture.cases === undefined ? [] : fixture.cases;
  if (!Array.isArray(cases)) throw new Error("The coordination fixture is not valid.");
  for (const entry of cases) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("The coordination fixture is not valid.");
    const ruleCase = entry as FixtureCase;
    if (typeof ruleCase.rule !== "string") throw new Error("The coordination fixture is not valid.");
    if (!same(applyRule(ruleCase.rule, ruleCase.input), ruleCase.expect)) throw new Error("The coordination fixture is not valid.");
  }
}

/**
 * Load the reviewed manifest and every fabricated fixture. This build has no
 * network client, so a served runtime or a served command is refused.
 */
export function loadContract(): void {
  if (
    RUNTIME !== "not-served"
    || connectionSettingsServed() !== false
    || admissionReservationsServed() !== false
    || !runtimeClaimConsistent()
    || catalog().served.length !== 0
  ) {
    throw new Error("This build has no network client. It will not speak to a served runtime.");
  }
  const manifest = readJson(MANIFEST_URL);
  if (!same(manifest, catalog())) throw new Error("The coordination manifest does not match.");
  const names = readdirSync(fileURLToPath(FIXTURE_DIR)).sort();
  const expected = [...FIXTURE_FILES].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error("The coordination fixtures are not the reviewed set.");
  }
  for (const name of FIXTURE_FILES) {
    assertFixture(name, readJson(new URL(name, FIXTURE_DIR)));
  }
}

function helloFixture(): { wire?: Array<{ role: WireRole; document: unknown }> } {
  const text = readFileSync(new URL("hello.json", FIXTURE_DIR), "utf8");
  return JSON.parse(text) as { wire?: Array<{ role: WireRole; document: unknown }> };
}

/**
 * Prove the reviewed hello fixture. The runtime is not served, so nothing is sent.
 * A served runtime is refused here until a later milestone has a network client.
 */
export function confirmHello(): HelloProof {
  loadContract();
  const fixture = helloFixture();
  if (fixtureFindings(fixture).length > 0) throw new Error("The coordination hello fixture is not valid.");
  for (const wire of fixture.wire ?? []) {
    const result = validateWire(wire.document, wire.role);
    if (!result.ok) throw new Error("The coordination hello fixture is not valid.");
  }
  const accepted = negotiate({ client_version: PROTOCOL_VERSION });
  if (!accepted.ok) throw new Error(accepted.error);
  const refused = negotiate({ client_version: PROTOCOL_VERSION + 1 });
  if (refused.ok || refused.code !== "unsupported_protocol") {
    throw new Error("The coordination protocol did not refuse another version.");
  }
  const protocolLine = `Server protocol: ${PROTOCOL} version ${PROTOCOL_VERSION}.`;
  const runtimeLine = "Runtime: not served.";
  const servedLine = "Commands served: none.";
  return {
    protocolLine,
    runtimeLine,
    servedLine,
    lines: [protocolLine, runtimeLine, servedLine, "No network request was sent."],
  };
}

/** List every specified command as not served. Fixture bodies are not printed. */
export function showCatalog(): { lines: string[] } {
  const hello = confirmHello();
  const commands = COMMANDS.map((command) => `${command}: ${COMMAND_CATALOG[command].effect}, not served.`);
  const tail = hello.lines[hello.lines.length - 1] ?? "No network request was sent.";
  return { lines: [...hello.lines.slice(0, -1), ...commands, tail] };
}

const READ_COMMANDS = ["connection.status", "repo.activation.read", "settings.effective.read"] as const;
const ADMIT_COMMANDS = ["job.admit", "reservation.decide"] as const;
const STUFFED_JOB = "fab00000000000000000000000000020";

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

function isReadCommand(value: string): value is (typeof READ_COMMANDS)[number] {
  return (READ_COMMANDS as readonly string[]).includes(value);
}

function isAdmitCommand(value: string): value is (typeof ADMIT_COMMANDS)[number] {
  return (ADMIT_COMMANDS as readonly string[]).includes(value);
}

function unservedAnswer(closed: ProtocolFailure, stuffed: ProtocolFailure): { lines: string[] } {
  const shown = JSON.stringify(closed) + JSON.stringify(stuffed);
  if (
    closed.code !== "not_served"
    || stuffed.code !== "not_served"
    || "body" in closed
    || "body" in stuffed
    || shown.includes(STUFFED_JOB)
    || shown.includes("queued")
  ) {
    throw new Error("This build has no network client. It will not speak to a served runtime.");
  }
  return {
    lines: [closed.error, closed.fix, "No network request was sent.", "Nothing was saved."],
  };
}

/**
 * Refuse a command while the runtime is not served. Reads, admission and
 * reservations use the protocol's unserved entries and return no body. Nothing
 * is sent and the local record is not changed. The caller's text is not repeated.
 */
export function refuseUnserved(command: string): { lines: string[] } {
  loadContract();
  if (!isCommandName(command)) {
    return {
      lines: [COPY.invalid.error, COPY.invalid.fix, "No network request was sent.", "Nothing was saved."],
    };
  }
  if (isReadCommand(command)) {
    return unservedAnswer(
      serveConnectionSettings({ command }),
      serveConnectionSettings({ command, record: { signed_in: true, ready_for_assignment: true, job_id: STUFFED_JOB } }),
    );
  }
  if (isAdmitCommand(command)) {
    return unservedAnswer(
      serveAdmissionReservations({ command }),
      serveAdmissionReservations({ command, body: { state: "queued", job_id: STUFFED_JOB, lane_id: STUFFED_JOB } }),
    );
  }
  return {
    lines: [`${command}: not served.`, "No network request was sent.", "Nothing was saved."],
  };
}
