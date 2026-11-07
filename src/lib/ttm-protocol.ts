/** The public contract stays independent of private application code and served runtime authority. */

export const PROTOCOL = "tickets-to-main.coordination";
export const PROTOCOL_VERSION = 1;
export const RUNTIME = "not-served" as "not-served" | "served";

export const CODE_UNAVAILABLE_EXPLANATION = "The code could not be inspected. This approval does not review it.";

/** Product default for the one pre-Triage delay. Zero is immediate. There is no upper bound. */
export const DELAY_MINUTES_DEFAULT = 10;
export const LANES_MIN = 1;
export const LANES_MAX = 5;
export const LANES_DEFAULT = 1;
export const MEMBERS_MAX = 20;
export const EXPLANATION_MAX = 240;
export const LABEL_MAX = 80;
export const TOTALS_MAX = 40;

export const STEPS = ["triage", "plan", "build", "tests", "main"] as const;
export type Step = (typeof STEPS)[number];

export const CHECK_RESULTS = ["passed", "failed", "running", "unavailable", "not_required"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];

export const CONNECTION_TOOLS = ["claude-code", "codex", "cursor", "grok", "unknown"] as const;
export type ConnectionTool = (typeof CONNECTION_TOOLS)[number];

export const COMMANDS = [
  "protocol.hello",
  "connection.status",
  "repo.activation.read",
  "settings.effective.read",
  "job.admit",
  "reservation.decide",
  "evidence.record",
  "approval.submit",
  "completion.record",
  "authority.revoke",
  "metrics.aggregate",
] as const;
export type CommandName = (typeof COMMANDS)[number];

export const COMMAND_GROUPS = [
  "public-contract",
  "connection-settings",
  "admission-reservations",
  "candidate-approval-completion",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** Every command is specified. None is served until a later milestone flips `served` and `RUNTIME` together. */
export const COMMAND_CATALOG = {
  "protocol.hello": { effect: "read", group: "public-contract", served: false },
  "connection.status": { effect: "read", group: "connection-settings", served: false },
  "repo.activation.read": { effect: "read", group: "connection-settings", served: false },
  "settings.effective.read": { effect: "read", group: "connection-settings", served: false },
  "job.admit": { effect: "write", group: "admission-reservations", served: false },
  "reservation.decide": { effect: "write", group: "admission-reservations", served: false },
  "evidence.record": { effect: "write", group: "candidate-approval-completion", served: false },
  "approval.submit": { effect: "write", group: "candidate-approval-completion", served: false },
  "completion.record": { effect: "write", group: "candidate-approval-completion", served: false },
  "authority.revoke": { effect: "write", group: "candidate-approval-completion", served: false },
  "metrics.aggregate": { effect: "write", group: "candidate-approval-completion", served: false },
} as const satisfies Record<CommandName, { effect: "read" | "write"; group: CommandGroup; served: boolean }>;

export const METRIC_NAMES = ["ttm.runs", "ttm.results", "ttm.tokens", "ttm.cost", "ttm.fallbacks"] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export const METRIC_LABELS = {
  "ttm.runs": STEPS,
  "ttm.results": ["passed", "failed"],
  "ttm.tokens": ["known", "unknown"],
  "ttm.cost": ["known", "unknown"],
  "ttm.fallbacks": ["used", "not_used"],
} as const satisfies Record<MetricName, readonly string[]>;

export const FIXTURE_FILES = [
  "hello.json",
  "connection-status.json",
  "repo-activation.json",
  "settings-effective.json",
  "admission.json",
  "reservation.json",
  "fence.json",
  "evidence.json",
  "approval.json",
  "completion.json",
  "revocation.json",
  "metrics.json",
  "refusals.json",
] as const;

export const COPY = {
  unsupported_protocol: {
    error: "This program speaks a coordination version the server does not.",
    fix: "Update Tickets to Main and try again.",
    then: "stop",
  },
  unauthorized: {
    error: "This connection cannot do that.",
    fix: "Use a connection a person approved for this board.",
    then: "stop",
  },
  repo_held: {
    error: "Another board already coordinates this repo.",
    fix: "Use the board that already coordinates it, or turn coordination off there.",
    then: "stop",
  },
  changed_since: {
    error: "That changed after you read it. Nothing was saved.",
    fix: "Read it again and send the version you read.",
    then: "retry",
  },
  idempotency_conflict: {
    error: "That Idempotency-Key was already used for a different action.",
    fix: "Repeat the original action, or use a new key for a new one.",
    then: "stop",
  },
  stale_candidate: {
    error: "That evidence is for a different candidate, base, requirements or policy.",
    fix: "Send evidence for the current candidate, base, requirements and policy.",
    then: "stop",
  },
  stale_writer: {
    error: "A newer fence owns that work.",
    fix: "Read the current fence. A new writer waits until the old one has stopped or is isolated.",
    then: "reconcile",
  },
  not_stopped: {
    error: "The writer is not stopped or isolated.",
    fix: "Stop the writer or isolate it before releasing the lane. A lease expiry does not count.",
    then: "stop",
  },
  not_a_person: {
    error: "Only a signed-in person can approve.",
    fix: "Ask a person who is allowed to approve.",
    then: "stop",
  },
  false_code_review: {
    error: "This approval would say the code was reviewed when it could not be inspected.",
    fix: "Leave code reviewed off, and say the code could not be inspected.",
    then: "stop",
  },
  host_missing: {
    error: "Required host evidence is still missing.",
    fix: "Wait for the required host evidence before approval.",
    then: "stop",
  },
  checks_unsatisfied: {
    error: "The selected checks are not satisfied.",
    fix: "Wait until the selected checks pass, or until they are Not required.",
    then: "stop",
  },
  forbidden_identifier: {
    error: "That total includes a private identifier.",
    fix: "Send only the anonymous total, with no person, board, ticket or address.",
    then: "stop",
  },
  unknown_amount: {
    error: "Unknown usage has to stay unknown.",
    fix: "Send a null amount for unknown usage. Do not send zero in its place.",
    then: "stop",
  },
  metric_conflict: {
    error: "That usage was already counted.",
    fix: "Repeat the same amount under the same label, or leave unknown usage unknown. Do not add it twice.",
    then: "stop",
  },
  completion_open: {
    error: "The ticket cannot close before its completion evidence is satisfied.",
    fix: "Record the integration without closing the ticket, and wait for the configured completion evidence.",
    then: "stop",
  },
  lane_full: {
    error: "Every lane for this repo is in use.",
    fix: "Wait for a lane. Admission stays queued and takes no lane.",
    then: "stop",
  },
  invalid: {
    error: "That coordination message is not valid.",
    fix: "Send the version 1 message for this command.",
    then: "stop",
  },
  already_admitted: {
    error: "That work is already queued.",
    fix: "Use the existing job. Do not admit it again.",
    then: "stop",
  },
  not_served: {
    error: "This coordination command is not served yet.",
    fix: "Use the contract. The server does not answer this command yet.",
    then: "stop",
  },
} as const;

export type RefusalCode = keyof typeof COPY;
export const REFUSAL_CODES = Object.keys(COPY) as RefusalCode[];

export type Then = "retry" | "stop" | "reconcile";

export type ProtocolFailure = {
  ok: false;
  code: RefusalCode;
  field: string | null;
  error: string;
  fix: string;
  then: Then;
};

export type WireRole = "request" | "response" | "refusal";

export type WireRefusal = {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  command: CommandName;
  id: string;
  idempotency_key: string | null;
  error: string;
  code: RefusalCode;
  field: string | null;
  fix: string;
  then: Then;
};

const OPAQUE_ID = /^[A-Za-z0-9]{32}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const KEY = /^[A-Za-z0-9_-]{8,80}$/;
const SECRET = /bearer\s|^sk-|ghp_|xox[baprs]-/i;
const CONTROLS = /[\u0000-\u001f\u007f]/;
const COUNT_METRICS = new Set<MetricName>(["ttm.runs", "ttm.results", "ttm.fallbacks"]);
const USAGE_METRICS = new Set<MetricName>(["ttm.tokens", "ttm.cost"]);
const FORBIDDEN_KEYS = new Set([
  "email", "token", "secret", "credential", "password", "transcript", "allowance", "reset", "reset_at",
  "quota_window", "person_id", "ip", "authorization", "cookie", "api_key", "access_token", "refresh_token",
  "grace_minutes", "second_wait", "pickup_grace", "extra_approval_required", "closed_because", "closed_from_main",
]);
const MERGE_LABELS = { none: "None", risky_only: "Risky only", every: "Every merge" } as const;
const APPROVER_LABELS = {
  owner: "Owner only",
  full_and_owner: "Full and Owner",
  member_full_and_owner: "Member, Full and Owner",
} as const;
const FALLBACK_LABELS = { wait: "Wait", choose: "Choose a supported fallback" } as const;
const INTENTS = ["acquire", "pause", "pause_all", "park", "idle"] as const;
const WRITERS = ["running", "unknown", "stopped", "isolated"] as const;
const HOST_CHECKS = ["none", "satisfied", "missing", "unknown"] as const;
const COMPLETION = ["pending", "satisfied", "failed"] as const;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function isBoardId(value: unknown): value is string {
  return isOpaqueId(value) || slug(value);
}

export function isFabricatedId(value: unknown): value is string {
  return isOpaqueId(value) && value.startsWith("fab0");
}

export function runtimeClaimConsistent(): boolean {
  const served = COMMANDS.filter((command) => COMMAND_CATALOG[command].served);
  if (RUNTIME === "not-served") {
    return served.length === 0 && connectionSettingsServed() === false && admissionReservationsServed() === false && candidateApprovalServed() === false;
  }
  return served.length > 0;
}

/** The three connection and settings reads are not served. */
export function connectionSettingsServed(): false {
  return false;
}

/** Admission and reservations are not served. */
export function admissionReservationsServed(): false {
  return false;
}

/** Evidence, approval, completion, revocation and metrics are not served. */
export function candidateApprovalServed(): false {
  return false;
}

export function catalog() {
  return {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    runtime: RUNTIME,
    no_runtime_readiness_claim: RUNTIME === "not-served",
    served: COMMANDS.filter((command) => COMMAND_CATALOG[command].served),
    sharing: "Public contract and authorized fabricated fixtures. No private source, credentials or customer evidence.",
    connection: "Starts after the existing human-approved program connection. This protocol does not define a new sign-in.",
    entry: "src/lib/ttm-protocol.ts",
    fixtures_dir: "src/lib/ttm-protocol/fixtures",
    commands: COMMAND_CATALOG,
    groups: COMMAND_GROUPS,
    refusal_codes: REFUSAL_CODES,
    refusals: COPY,
    steps: STEPS,
    check_results: CHECK_RESULTS,
    metrics: METRIC_NAMES,
    metric_labels: METRIC_LABELS,
    cost_unit: "micro-usd",
    limits: {
      delay_minutes_default: DELAY_MINUTES_DEFAULT,
      lanes_min: LANES_MIN,
      lanes_max: LANES_MAX,
      lanes_default: LANES_DEFAULT,
      members_max: MEMBERS_MAX,
      explanation_max: EXPLANATION_MAX,
      label_max: LABEL_MAX,
      totals_max: TOTALS_MAX,
    },
    fixtures: FIXTURE_FILES,
  };
}

export function fail(field: string | null, code: RefusalCode = "invalid"): ProtocolFailure {
  const copy = COPY[code];
  return { ok: false, code, field, error: copy.error, fix: copy.fix, then: copy.then };
}

export function wireRefusal(input: {
  command: CommandName;
  id: string;
  idempotency_key: string | null;
  code: RefusalCode;
  field: string | null;
}): WireRefusal {
  const copy = COPY[input.code];
  return {
    protocol: PROTOCOL,
    version: PROTOCOL_VERSION,
    command: input.command,
    id: input.id,
    idempotency_key: input.idempotency_key,
    error: copy.error,
    code: input.code,
    field: input.field,
    fix: copy.fix,
    then: copy.then,
  };
}

function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const got = Object.keys(value);
  if (got.length !== keys.length) return false;
  return keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function cleanString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !CONTROLS.test(value) && !value.includes("@") && !SECRET.test(value);
}

function slug(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SLUG.test(value);
}

function whole(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

export function delayAllowed(minutes: unknown): boolean {
  return whole(minutes, 0, Number.MAX_SAFE_INTEGER);
}

export function reportedPassed(result: unknown): boolean {
  return result === "passed";
}

export function selectedGateSatisfied(result: unknown): boolean {
  return result === "passed" || result === "not_required";
}

/** Choosing no tests never adds an approval. The return is only false. */
export function testsImposeExtraApproval(result: unknown): false | ProtocolFailure {
  if (!oneOf(result, CHECK_RESULTS)) return fail("tests_result");
  return false;
}

/** A lease expiry is not proof the writer stopped. */
export function writerStoppedByLeaseExpiry(): false {
  return false;
}

export function areaRequired(step: unknown): boolean | ProtocolFailure {
  if (!oneOf(step, STEPS)) return fail("step");
  return step === "build" || step === "tests" || step === "main";
}

export function negotiate(input: { client_version: unknown }): { ok: true; accepted_version: 1 } | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["client_version"])) return fail("client_version");
  if (input.client_version !== PROTOCOL_VERSION) return fail("client_version", "unsupported_protocol");
  return { ok: true, accepted_version: PROTOCOL_VERSION };
}

export function heldActivation(input: { id: string }): WireRefusal | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["id"]) || !isOpaqueId(input.id)) return fail("id");
  // A string on a property named code would join the live refusal list (218). This code is specified and not served.
  const code = "repo_held" satisfies RefusalCode;
  return wireRefusal({
    command: "repo.activation.read",
    id: input.id,
    idempotency_key: null,
    code,
    field: "repo",
  });
}

export function canonical(value: unknown): string | null {
  try {
    return JSON.stringify(order(value));
  } catch {
    return null;
  }
}

function order(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("number");
    return value;
  }
  if (Array.isArray(value)) return value.map(order);
  if (!plain(value)) throw new Error("object");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("key");
    if (value[key] === undefined) throw new Error("undefined");
    out[key] = order(value[key]);
  }
  return out;
}

export function sameBody(a: unknown, b: unknown): boolean {
  const left = canonical(a);
  const right = canonical(b);
  return left !== null && left === right;
}

export function replayAdmission(
  stored: { idempotency_key: string; body: unknown; job_id: string } | null,
  next: { idempotency_key: string; body: unknown },
): { kind: "create" } | { kind: "replay"; job_id: string } | ProtocolFailure {
  if (stored === null) return { kind: "create" };
  if (!plain(stored) || !plain(next)) return fail("idempotency_key");
  if (!exactKeys(stored, ["idempotency_key", "body", "job_id"]) || !exactKeys(next, ["idempotency_key", "body"])) return fail("idempotency_key");
  if (typeof stored.idempotency_key !== "string" || typeof next.idempotency_key !== "string") return fail("idempotency_key");
  if (!isOpaqueId(stored.job_id)) return fail("job_id");
  if (stored.idempotency_key !== next.idempotency_key) return { kind: "create" };
  if (sameBody(stored.body, next.body)) return { kind: "replay", job_id: stored.job_id };
  return fail("idempotency_key", "idempotency_conflict");
}

export function reservationDecision(input: { intent: unknown; writers: unknown }): { release: boolean } | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["intent", "writers"])) return fail("intent");
  if (!oneOf(input.intent, INTENTS) || !oneOf(input.writers, WRITERS)) return fail("intent");
  if (input.intent === "acquire" || input.intent === "pause" || input.intent === "pause_all") return { release: false };
  if (input.writers === "stopped" || input.writers === "isolated") return { release: true };
  return fail("writers", "not_stopped");
}

export function fenceAllows(input: {
  role: "coordinator" | "executor";
  expected: { coordinator: string; executor: string };
  current: { coordinator: string; executor: string };
}): { ok: true } | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["role", "expected", "current"])) return fail("role");
  if (input.role !== "coordinator" && input.role !== "executor") return fail("role");
  if (!plain(input.expected) || !plain(input.current)) return fail(input.role);
  if (!exactKeys(input.expected, ["coordinator", "executor"]) || !exactKeys(input.current, ["coordinator", "executor"])) return fail(input.role);
  if (!isOpaqueId(input.expected.coordinator) || !isOpaqueId(input.expected.executor)) return fail(input.role);
  if (!isOpaqueId(input.current.coordinator) || !isOpaqueId(input.current.executor)) return fail(input.role);
  if (input.expected[input.role] !== input.current[input.role]) return fail(input.role, "stale_writer");
  return { ok: true };
}

export function evidenceBinds(
  evidence: { candidate_id: string; requirements_id: string; base_id: string; policy_id: string },
  target: { candidate_id: string; requirements_id: string; base_id: string; policy_id: string },
): { ok: true } | ProtocolFailure {
  const keys = ["candidate_id", "requirements_id", "base_id", "policy_id"] as const;
  if (!plain(evidence) || !plain(target) || !exactKeys(evidence, keys) || !exactKeys(target, keys)) return fail("candidate_id");
  for (const key of keys) {
    if (!isOpaqueId(evidence[key]) || evidence[key] !== target[key]) return fail(key, "stale_candidate");
  }
  return { ok: true };
}

export function approvalAllowed(input: {
  actor: unknown;
  candidate_id: unknown;
  reviewed_candidate_id: unknown;
  base_id: unknown;
  reviewed_base_id: unknown;
  code_inspection: unknown;
  code_reviewed: unknown;
  tests_result: unknown;
  host_checks: unknown;
  explanation: unknown;
}): { ok: true; extra_approval: false } | ProtocolFailure {
  const keys = ["actor", "candidate_id", "reviewed_candidate_id", "base_id", "reviewed_base_id", "code_inspection", "code_reviewed", "tests_result", "host_checks", "explanation"];
  if (!plain(input) || !exactKeys(input, keys)) return fail("actor");
  const leaked = privacyFindings(input, "shared");
  if (leaked.length) return fail(leaked[0] ?? "actor", "forbidden_identifier");
  if (input.actor !== "person") return fail("actor", "not_a_person");
  if (!isOpaqueId(input.candidate_id) || !isOpaqueId(input.reviewed_candidate_id) || input.candidate_id !== input.reviewed_candidate_id) {
    return fail("candidate_id", "stale_candidate");
  }
  if (!isOpaqueId(input.base_id) || !isOpaqueId(input.reviewed_base_id) || input.base_id !== input.reviewed_base_id) {
    return fail("base_id", "stale_candidate");
  }
  if (input.host_checks !== "none" && input.host_checks !== "satisfied") return fail("host_checks", "host_missing");
  if (!selectedGateSatisfied(input.tests_result)) return fail("tests_result", "checks_unsatisfied");
  if (input.code_inspection !== "available" && input.code_inspection !== "unavailable") return fail("code_inspection");
  if (typeof input.code_reviewed !== "boolean") return fail("code_reviewed");
  if (input.code_inspection === "unavailable" && input.code_reviewed) return fail("code_reviewed", "false_code_review");
  if (input.code_inspection === "unavailable" && input.explanation !== CODE_UNAVAILABLE_EXPLANATION) return fail("explanation");
  if (input.code_inspection === "available" && input.explanation !== undefined && !cleanString(input.explanation, EXPLANATION_MAX) && input.explanation !== "") {
    return fail("explanation");
  }
  return { ok: true, extra_approval: false };
}

export function completionRecord(input: {
  on_main: unknown;
  closed: unknown;
  completion_evidence: unknown;
}): { ok: true; on_main: boolean; closed: boolean; completion_evidence: "pending" | "satisfied" | "failed" } | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["on_main", "closed", "completion_evidence"])) return fail("closed");
  if (typeof input.on_main !== "boolean" || typeof input.closed !== "boolean") return fail("closed");
  if (!oneOf(input.completion_evidence, COMPLETION)) return fail("completion_evidence");
  if (input.closed && input.completion_evidence !== "satisfied") return fail("closed", "completion_open");
  return { ok: true, on_main: input.on_main, closed: input.closed, completion_evidence: input.completion_evidence };
}

export function expectRevision(expected: unknown, current: unknown): { ok: true } | ProtocolFailure {
  if (!whole(expected, 0, Number.MAX_SAFE_INTEGER) || !whole(current, 1, Number.MAX_SAFE_INTEGER)) return fail("expected_revision");
  if (expected !== current) return fail("expected_revision", "changed_since");
  return { ok: true };
}

type MetricEvent = { metric: MetricName; label: string; amount: number | null; attempt: string; known: boolean };

export function foldMetricEvents(events: unknown): { ok: true; totals: Array<{ metric: MetricName; label: string; amount: number | null; observations: number }> } | ProtocolFailure {
  if (!Array.isArray(events)) return fail("totals");
  const groups = new Map<string, Map<string, { amount: number | null; attempts: Map<string, number | null> }>>();
  const attemptLabel = new Map<string, string>();
  for (const event of events) {
    const leaked = metricEventLeak(event);
    if (leaked) return fail(leaked, "forbidden_identifier");
    const read = readMetricEvent(event);
    if ("ok" in read && read.ok === false) return read;
    const item = read as MetricEvent;
    const attemptKey = `${item.metric}\0${item.attempt}`;
    const previousLabel = attemptLabel.get(attemptKey);
    if (previousLabel !== undefined && previousLabel !== item.label) return fail("attempt", "metric_conflict");
    attemptLabel.set(attemptKey, item.label);
    let labels = groups.get(item.metric);
    if (!labels) {
      labels = new Map();
      groups.set(item.metric, labels);
    }
    let group = labels.get(item.label);
    if (!group) {
      group = { amount: item.label === "unknown" ? null : 0, attempts: new Map() };
      labels.set(item.label, group);
    }
    const prior = group.attempts.get(item.attempt);
    if (prior !== undefined && prior !== item.amount) return fail("amount", "metric_conflict");
    if (prior === undefined) {
      group.attempts.set(item.attempt, item.amount);
      if (item.amount !== null) group.amount = Number(group.amount) + item.amount;
    }
  }
  const totals: Array<{ metric: MetricName; label: string; amount: number | null; observations: number }> = [];
  for (const metric of METRIC_NAMES) {
    const labels = groups.get(metric);
    if (!labels) continue;
    for (const label of METRIC_LABELS[metric]) {
      const group = labels.get(label);
      if (!group) continue;
      totals.push({ metric, label, amount: label === "unknown" ? null : group.amount, observations: group.attempts.size });
    }
  }
  const published = privacyFindings({ totals }, "metrics");
  if (published.length) return fail(published[0] ?? "totals", "forbidden_identifier");
  return { ok: true, totals };
}

function metricEventLeak(event: unknown): string | null {
  if (!plain(event)) return null;
  for (const key of Object.keys(event)) {
    if (FORBIDDEN_KEYS.has(key) || key === "board" || key === "ticket" || key === "person" || (key.endsWith("_id") && key !== "attempt")) return key;
    const item = event[key];
    if (typeof item === "string" && (item.includes("@") || SECRET.test(item))) return key;
  }
  return null;
}

function readMetricEvent(event: unknown): MetricEvent | ProtocolFailure {
  if (!plain(event) || !exactKeys(event, ["metric", "label", "amount", "attempt", "known"])) return fail("totals");
  if (!oneOf(event.metric, METRIC_NAMES)) return fail("metric");
  if (!oneOf(event.label, METRIC_LABELS[event.metric])) return fail("label");
  if (!isOpaqueId(event.attempt)) return fail("attempt");
  if (USAGE_METRICS.has(event.metric)) {
    const known = event.label === "known";
    if (event.known !== known) return fail("known", "unknown_amount");
    if (known) {
      if (!whole(event.amount, 0, Number.MAX_SAFE_INTEGER)) return fail("amount", "unknown_amount");
    } else if (event.amount !== null) return fail("amount", "unknown_amount");
  } else {
    if (event.known !== true || event.amount !== 1) return fail("amount");
  }
  return {
    metric: event.metric,
    label: event.label,
    amount: event.amount as number | null,
    attempt: event.attempt,
    known: event.known as boolean,
  };
}

export function privacyFindings(value: unknown, mode: "shared" | "metrics" | "held"): string[] {
  const found: string[] = [];
  walk(value, mode, found, "");
  return found;
}

function walk(value: unknown, mode: "shared" | "metrics" | "held", found: string[], path: string): void {
  if (typeof value === "string") {
    if (value.includes("@") || SECRET.test(value)) found.push(path || "value");
    if (mode === "metrics" && OPAQUE_ID.test(value)) found.push(path || "value");
    if (mode === "held" && path !== "id" && path !== "idempotency_key" && (OPAQUE_ID.test(value) || value.startsWith("fabricated-") || value.includes("example.com"))) found.push(path || "value");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, mode, found, `${path}[${index}]`));
    return;
  }
  if (!plain(value)) return;
  for (const key of Object.keys(value)) {
    const next = path ? `${path}.${key}` : key;
    if (key === "__proto__" || key === "constructor" || key === "prototype" || FORBIDDEN_KEYS.has(key)) found.push(next);
    if (mode === "metrics" && (key.endsWith("_id") || key === "attempt" || key === "members")) found.push(next);
    if (mode === "held" && key !== "id" && key !== "idempotency_key" && (key.endsWith("_id") || key === "repo" || key === "body")) found.push(next);
    walk(value[key], mode, found, next);
  }
}

export function validateWire(document: unknown, role: WireRole): { ok: true } | ProtocolFailure {
  if (!plain(document)) return fail(null);
  if (role === "refusal") return validateRefusal(document);
  const envelope = readEnvelope(document);
  if ("ok" in envelope && envelope.ok === false) return envelope;
  const body = document.body;
  if (!plain(body)) return fail("body");
  const privacy = privacyFindings(body, "shared");
  if (privacy.length) return fail(privacy[0] ?? "body", "forbidden_identifier");
  const command = document.command as CommandName;
  if (role === "request") return validateRequest(command, body);
  return validateResponse(command, body);
}

function readEnvelope(document: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(document, ["protocol", "version", "command", "id", "idempotency_key", "body"])) return fail(null);
  if (document.protocol !== PROTOCOL || document.version !== PROTOCOL_VERSION) return fail("version", "unsupported_protocol");
  if (!oneOf(document.command, COMMANDS)) return fail("command");
  if (!isOpaqueId(document.id)) return fail("id");
  const effect = COMMAND_CATALOG[document.command].effect;
  if (effect === "read") {
    if (document.idempotency_key !== null) return fail("idempotency_key");
  } else if (typeof document.idempotency_key !== "string" || !KEY.test(document.idempotency_key)) return fail("idempotency_key");
  return { ok: true };
}

const REFUSAL_FIELDS = new Set([
  "actor", "amount", "base_id", "candidate_id", "client_version", "closed", "code_reviewed", "coordinator", "executor",
  "expected_revision", "host_checks", "idempotency_key", "job_id", "lane_id", "members", "policy_id", "repo",
  "requirements_id", "tests_result", "totals", "writers",
]);

function validateRefusal(document: Record<string, unknown>): { ok: true } | ProtocolFailure {
  for (const key of Object.keys(document)) {
    if (FORBIDDEN_KEYS.has(key) || key === "board_id" || key === "repo" || key === "body" || key === "ticket_id") {
      return fail(key, "forbidden_identifier");
    }
  }
  if (!exactKeys(document, ["protocol", "version", "command", "id", "idempotency_key", "error", "code", "field", "fix", "then"])) return fail(null);
  if (document.protocol !== PROTOCOL || document.version !== PROTOCOL_VERSION) return fail("version", "unsupported_protocol");
  if (!oneOf(document.command, COMMANDS) || !oneOf(document.code, REFUSAL_CODES)) return fail("code");
  if (!isOpaqueId(document.id)) return fail("id");
  const effect = COMMAND_CATALOG[document.command].effect;
  if (effect === "read" ? document.idempotency_key !== null : typeof document.idempotency_key !== "string" || !KEY.test(document.idempotency_key)) {
    return fail("idempotency_key");
  }
  if (document.code === "repo_held" && document.field !== "repo") return fail("field", "forbidden_identifier");
  if (document.field !== null && !REFUSAL_FIELDS.has(String(document.field))) return fail("field", "forbidden_identifier");
  const expected = wireRefusal({
    command: document.command,
    id: document.id,
    idempotency_key: document.idempotency_key as string | null,
    code: document.code,
    field: document.field as string | null,
  });
  if (document.error !== expected.error || document.fix !== expected.fix || document.then !== expected.then) return fail("error");
  if (document.code === "repo_held" && privacyFindings(document, "held").length) return fail("repo", "forbidden_identifier");
  return { ok: true };
}

function validateRequest(command: CommandName, body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (command === "protocol.hello") {
    if (!exactKeys(body, ["client_version"]) || typeof body.client_version !== "number" || !Number.isFinite(body.client_version)) return fail("client_version");
    return { ok: true };
  }
  if (command === "connection.status") return exactKeys(body, []) ? { ok: true } : fail("body");
  if (command === "repo.activation.read" || command === "settings.effective.read") {
    return exactKeys(body, ["repo"]) && readRepo(body.repo).ok ? { ok: true } : fail("repo");
  }
  if (command === "job.admit") return validateAdmitRequest(body);
  if (command === "reservation.decide") return validateReservationRequest(body);
  if (command === "evidence.record") return validateEvidenceRequest(body);
  if (command === "approval.submit") return validateApprovalRequest(body);
  if (command === "completion.record") return validateCompletionRequest(body);
  if (command === "authority.revoke") {
    return exactKeys(body, ["connection_id", "expected_revision"]) && isOpaqueId(body.connection_id) && whole(body.expected_revision, 0, Number.MAX_SAFE_INTEGER)
      ? { ok: true }
      : fail("connection_id");
  }
  if (command === "metrics.aggregate") return validateMetrics(body);
  return fail("command");
}

function validateResponse(command: CommandName, body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (command === "protocol.hello") {
    return exactKeys(body, ["accepted_version", "runtime"]) && body.accepted_version === PROTOCOL_VERSION && body.runtime === RUNTIME
      ? { ok: true }
      : fail("runtime");
  }
  if (command === "connection.status") return validateConnection(body);
  if (command === "repo.activation.read") return validateActivation(body);
  if (command === "settings.effective.read") return validateSettings(body);
  if (command === "job.admit") return validateAdmitResponse(body);
  if (command === "reservation.decide") return validateReservationResponse(body);
  if (command === "evidence.record") return validateEvidenceResponse(body);
  if (command === "approval.submit") return validateApprovalResponse(body);
  if (command === "completion.record") return validateCompletionResponse(body);
  if (command === "authority.revoke") return validateRevokeResponse(body);
  if (!exactKeys(body, ["accepted", "period", "totals"]) || body.accepted !== true) return fail("accepted");
  return validateMetricTotals(body.period, body.totals);
}

function readRepo(value: unknown): { ok: true } | ProtocolFailure {
  if (!plain(value) || !exactKeys(value, ["host", "owner", "name", "board_repo_id"])) return fail("repo");
  if (typeof value.host !== "string" || !HOST.test(value.host)) return fail("host");
  if (!slug(value.owner) || !slug(value.name) || !slug(value.board_repo_id)) return fail("board_repo_id");
  return { ok: true };
}

function validateConnection(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  const keys = ["connection_id", "board_id", "tool", "computer", "person_label", "installed", "signed_in", "compatible", "ready_for_assignment"];
  if (!exactKeys(body, keys)) return fail("body");
  if (!isOpaqueId(body.connection_id) || !isBoardId(body.board_id) || !oneOf(body.tool, CONNECTION_TOOLS)) return fail("connection_id");
  if (!cleanString(body.computer, LABEL_MAX) || !cleanString(body.person_label, LABEL_MAX)) return fail("computer");
  for (const key of ["installed", "signed_in", "compatible", "ready_for_assignment"] as const) {
    if (typeof body[key] !== "boolean") return fail(key);
  }
  return { ok: true };
}

function validateActivation(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, ["repo", "active", "board_id"]) || !readRepo(body.repo).ok || typeof body.active !== "boolean") return fail("repo");
  if (body.active) return isBoardId(body.board_id) ? { ok: true } : fail("board_id");
  return body.board_id === null ? { ok: true } : fail("board_id");
}

function validateSettings(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, ["repo", "lanes", "steps"]) || !readRepo(body.repo).ok) return fail("repo");
  if (!plain(body.lanes) || !exactKeys(body.lanes, ["value", "min", "max"])) return fail("lanes");
  if (body.lanes.min !== LANES_MIN || body.lanes.max !== LANES_MAX || !whole(body.lanes.value, LANES_MIN, LANES_MAX)) return fail("lanes");
  if (!plain(body.steps) || !exactKeys(body.steps, STEPS)) return fail("steps");
  if (!readTriage(body.steps.triage)) return fail("triage");
  if (!readWorkStep(body.steps.plan) || !readWorkStep(body.steps.build)) return fail("plan");
  if (!readTests(body.steps.tests) || !readMain(body.steps.main)) return fail("tests");
  return { ok: true };
}

function readSource(value: unknown): boolean {
  return plain(value) && (value.source === "board" || value.source === "repo");
}

function readFallback(value: unknown): boolean {
  if (!plain(value) || !exactKeys(value, ["value", "label"])) return false;
  return oneOf(value.value, ["wait", "choose"] as const) && value.label === FALLBACK_LABELS[value.value];
}

function readModel(value: unknown): boolean {
  if (!plain(value) || !exactKeys(value, ["requested", "observed"])) return false;
  if (!cleanString(value.requested, 64)) return false;
  return value.observed === null || cleanString(value.observed, 64);
}

function readTriage(value: unknown): boolean {
  if (!plain(value) || !exactKeys(value, ["source", "review", "delay_minutes", "fallback", "guidance_version", "model", "initial_review"])) return false;
  return readSource(value) && value.review === "not_required" && value.initial_review === false && delayAllowed(value.delay_minutes)
    && readFallback(value.fallback) && cleanString(value.guidance_version, 64) && readModel(value.model);
}

function readWorkStep(value: unknown): boolean {
  if (!plain(value) || !readSource(value) || !readFallback(value.fallback) || !cleanString(value.guidance_version, 64) || !readModel(value.model)) return false;
  if (value.review === "enabled") {
    return exactKeys(value, ["source", "review", "fallback", "guidance_version", "model", "initial_review", "correction_cycles"])
      && value.initial_review === true && whole(value.correction_cycles, 0, Number.MAX_SAFE_INTEGER);
  }
  if (value.review !== "not_required" || value.initial_review !== false) return false;
  return exactKeys(value, ["source", "review", "fallback", "guidance_version", "model", "initial_review"]);
}

function readTests(value: unknown): boolean {
  if (!plain(value) || !exactKeys(value, ["source", "review", "selection", "initial_review"])) return false;
  return readSource(value) && value.review === "not_required" && value.initial_review === false
    && (value.selection === "not_required" || value.selection === "selected");
}

function readMain(value: unknown): boolean {
  if (!plain(value) || !exactKeys(value, ["source", "merges", "approvers"]) || !readSource(value)) return false;
  if (!plain(value.merges) || !exactKeys(value.merges, ["value", "label"]) || !oneOf(value.merges.value, ["none", "risky_only", "every"] as const)) return false;
  if (value.merges.label !== MERGE_LABELS[value.merges.value]) return false;
  if (!plain(value.approvers) || !exactKeys(value.approvers, ["value", "label"])) return false;
  return oneOf(value.approvers.value, ["owner", "full_and_owner", "member_full_and_owner"] as const)
    && value.approvers.label === APPROVER_LABELS[value.approvers.value];
}

function hexList(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= MEMBERS_MAX && value.every(isOpaqueId) && new Set(value).size === value.length;
}

function validateAdmitRequest(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, ["repo", "members", "expected_revision"])) return fail("body");
  if (!readRepo(body.repo).ok || !hexList(body.members) || body.expected_revision !== null) return fail("members");
  return { ok: true };
}

function validateAdmitResponse(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, ["job_id", "state", "lane_id", "revision", "members"])) return fail("body");
  if (!isOpaqueId(body.job_id) || body.state !== "queued" || body.lane_id !== null || !whole(body.revision, 1, Number.MAX_SAFE_INTEGER)) return fail("lane_id");
  if (!hexList(body.members)) return fail("members");
  return { ok: true };
}

function validateReservationRequest(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  const keys = ["job_id", "intent", "writers", "expected_revision", "lane_id", "area_id"];
  if (!exactKeys(body, keys) || !isOpaqueId(body.job_id) || !oneOf(body.intent, INTENTS) || !oneOf(body.writers, WRITERS)) return fail("intent");
  if (!whole(body.expected_revision, 0, Number.MAX_SAFE_INTEGER)) return fail("expected_revision");
  if (body.lane_id !== null && !isOpaqueId(body.lane_id)) return fail("lane_id");
  if (body.area_id !== null && !isOpaqueId(body.area_id)) return fail("area_id");
  return { ok: true };
}

function validateReservationResponse(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  const keys = ["job_id", "intent", "writers", "released", "lane_id", "area_id", "revision"];
  if (!exactKeys(body, keys) || !isOpaqueId(body.job_id) || typeof body.released !== "boolean") return fail("released");
  if (!whole(body.revision, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
  const decision = reservationDecision({ intent: body.intent, writers: body.writers });
  if (!("release" in decision) || decision.release !== body.released) return fail("released", "code" in decision ? decision.code : "invalid");
  if (body.intent === "acquire" && !isOpaqueId(body.lane_id)) return fail("lane_id");
  if (body.released) {
    if (body.lane_id !== null || body.area_id !== null) return fail("lane_id");
  } else if ((body.lane_id !== null && !isOpaqueId(body.lane_id)) || (body.area_id !== null && !isOpaqueId(body.area_id))) return fail("lane_id");
  return { ok: true };
}

const EVIDENCE_KEYS = ["job_id", "candidate_id", "requirements_id", "base_id", "policy_id", "attempt_id", "result", "expected_revision"] as const;

function validateEvidenceRequest(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, EVIDENCE_KEYS)) return fail("body");
  for (const key of EVIDENCE_KEYS) {
    if (key === "result" || key === "expected_revision") continue;
    if (!isOpaqueId(body[key])) return fail(key);
  }
  if (!oneOf(body.result, CHECK_RESULTS) || !whole(body.expected_revision, 0, Number.MAX_SAFE_INTEGER)) return fail("result");
  return { ok: true };
}

function validateEvidenceResponse(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  const keys = ["job_id", "candidate_id", "requirements_id", "base_id", "policy_id", "attempt_id", "result", "recorded", "revision"];
  if (!exactKeys(body, keys) || body.recorded !== true || !oneOf(body.result, CHECK_RESULTS)) return fail("recorded");
  if (!whole(body.revision, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
  for (const key of keys) {
    if (key === "result" || key === "recorded" || key === "revision") continue;
    if (!isOpaqueId(body[key])) return fail(key);
  }
  return { ok: true };
}

function validateApprovalRequest(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  const keys = [
    "job_id", "actor", "candidate_id", "reviewed_candidate_id", "base_id", "reviewed_base_id", "requirements_id", "policy_id",
    "expected_revision", "code_inspection", "code_reviewed", "explanation", "tests_result", "host_checks",
  ];
  if (!exactKeys(body, keys)) return fail("body");
  for (const key of ["job_id", "candidate_id", "reviewed_candidate_id", "base_id", "reviewed_base_id", "requirements_id", "policy_id"] as const) {
    if (!isOpaqueId(body[key])) return fail(key);
  }
  if (body.actor !== "person" && body.actor !== "agent") return fail("actor");
  if (!whole(body.expected_revision, 0, Number.MAX_SAFE_INTEGER)) return fail("expected_revision");
  if (!oneOf(body.code_inspection, ["available", "unavailable"] as const) || typeof body.code_reviewed !== "boolean") return fail("code_reviewed");
  if (typeof body.explanation !== "string" || body.explanation.length > EXPLANATION_MAX) return fail("explanation");
  if (!oneOf(body.tests_result, CHECK_RESULTS) || !oneOf(body.host_checks, HOST_CHECKS)) return fail("tests_result");
  return { ok: true };
}

function validateApprovalResponse(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  const keys = [
    "job_id", "approved", "candidate_id", "base_id", "requirements_id", "policy_id", "code_inspection", "code_reviewed",
    "explanation", "tests_result", "host_checks", "extra_approval", "revision",
  ];
  if (!exactKeys(body, keys) || body.approved !== true || body.extra_approval !== false) return fail("extra_approval");
  const allowed = approvalAllowed({
    actor: "person",
    candidate_id: body.candidate_id,
    reviewed_candidate_id: body.candidate_id,
    base_id: body.base_id,
    reviewed_base_id: body.base_id,
    code_inspection: body.code_inspection,
    code_reviewed: body.code_reviewed,
    tests_result: body.tests_result,
    host_checks: body.host_checks,
    explanation: body.explanation,
  });
  if (!allowed.ok) return allowed;
  if (!whole(body.revision, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
  for (const key of ["job_id", "candidate_id", "base_id", "requirements_id", "policy_id"] as const) {
    if (!isOpaqueId(body[key])) return fail(key);
  }
  return { ok: true };
}

function validateCompletionRequest(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, ["job_id", "on_main", "closed", "completion_evidence", "expected_revision"])) return fail("body");
  if (!isOpaqueId(body.job_id) || !whole(body.expected_revision, 0, Number.MAX_SAFE_INTEGER)) return fail("job_id");
  const record = completionRecord({ on_main: body.on_main, closed: body.closed, completion_evidence: body.completion_evidence });
  return record.ok ? { ok: true } : record;
}

function validateCompletionResponse(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, ["job_id", "on_main", "closed", "completion_evidence", "revision"])) return fail("body");
  if (!isOpaqueId(body.job_id) || !whole(body.revision, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
  const record = completionRecord({ on_main: body.on_main, closed: body.closed, completion_evidence: body.completion_evidence });
  return record.ok ? { ok: true } : record;
}

function validateRevokeResponse(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  const keys = ["connection_id", "further_server_actions", "process_stopped", "in_flight"];
  if (!exactKeys(body, keys) || !isOpaqueId(body.connection_id)) return fail("connection_id");
  if (body.further_server_actions !== "refused" || body.process_stopped !== false) return fail("process_stopped");
  if (body.in_flight !== "uncertain" && body.in_flight !== "reconciled") return fail("in_flight");
  return { ok: true };
}

function validateMetrics(body: Record<string, unknown>): { ok: true } | ProtocolFailure {
  if (!exactKeys(body, ["period", "totals"])) return fail("body");
  const findings = privacyFindings(body, "metrics");
  if (findings.length) return fail(findings[0] ?? "totals", "forbidden_identifier");
  return validateMetricTotals(body.period, body.totals);
}

function validateMetricTotals(period: unknown, totals: unknown): { ok: true } | ProtocolFailure {
  if (period !== "day" && period !== "week") return fail("period");
  if (!Array.isArray(totals) || totals.length < 1 || totals.length > TOTALS_MAX) return fail("totals");
  const seen = new Set<string>();
  for (const row of totals) {
    if (!plain(row) || !exactKeys(row, ["metric", "label", "amount", "observations"])) return fail("totals");
    if (!oneOf(row.metric, METRIC_NAMES) || !oneOf(row.label, METRIC_LABELS[row.metric])) return fail("label");
    const rowKey = `${row.metric}\0${row.label}`;
    if (seen.has(rowKey)) return fail("totals", "metric_conflict");
    seen.add(rowKey);
    if (!whole(row.observations, 1, Number.MAX_SAFE_INTEGER)) return fail("observations");
    if (row.label === "unknown") {
      if (row.amount !== null) return fail("amount", "unknown_amount");
    } else if (!whole(row.amount, 0, Number.MAX_SAFE_INTEGER)) return fail("amount");
    if (COUNT_METRICS.has(row.metric) && row.amount !== row.observations) return fail("amount");
  }
  return { ok: true };
}

const READ_SEATS = ["owner", "full", "member", "viewer"] as const;
const READ_COMMANDS = ["connection.status", "repo.activation.read", "settings.effective.read"] as const;

function authorizeRead(caller: unknown): { ok: true; caller: { connection_id: string; board_id: string; seat: (typeof READ_SEATS)[number] } } | ProtocolFailure {
  if (!plain(caller) || !exactKeys(caller, ["connection_id", "board_id", "seat"])) return fail("actor", "unauthorized");
  if (!isOpaqueId(caller.connection_id) || !isBoardId(caller.board_id) || !oneOf(caller.seat, READ_SEATS)) return fail("actor", "unauthorized");
  return { ok: true, caller: { connection_id: caller.connection_id, board_id: caller.board_id, seat: caller.seat } };
}

function readAnswer(command: (typeof READ_COMMANDS)[number], id: string, body: Record<string, unknown>) {
  return { protocol: PROTOCOL, version: PROTOCOL_VERSION, command, id, idempotency_key: null as null, body };
}

/** The caller's own connection. Another connection is refused without its id. */
export function connectionStatus(input: unknown): ReturnType<typeof readAnswer> | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["id", "caller", "record"])) return fail("body");
  if (!isOpaqueId(input.id)) return fail("id");
  const caller = authorizeRead(input.caller);
  if (caller.ok === false) return caller;
  if (!plain(input.record) || input.record.connection_id !== caller.caller.connection_id || input.record.board_id !== caller.caller.board_id) {
    return fail("connection_id", "unauthorized");
  }
  if (privacyFindings(input.record, "shared").length) return fail("body", "forbidden_identifier");
  const keys = ["connection_id", "board_id", "tool", "computer", "person_label", "installed", "signed_in", "compatible", "ready_for_assignment"];
  if (!exactKeys(input.record, keys)) return fail("body");
  const body = {
    connection_id: input.record.connection_id,
    board_id: input.record.board_id,
    tool: input.record.tool,
    computer: input.record.computer,
    person_label: input.record.person_label,
    installed: input.record.installed,
    signed_in: input.record.signed_in,
    compatible: input.record.compatible,
    ready_for_assignment: input.record.ready_for_assignment,
  };
  const answer = readAnswer("connection.status", input.id, body);
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** This board's activation, or a refusal that does not name the board that holds the repo. */
export function activationRead(input: unknown): ReturnType<typeof readAnswer> | WireRefusal | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["id", "caller", "repo", "held_by"])) return fail("body");
  if (!isOpaqueId(input.id)) return fail("id");
  const caller = authorizeRead(input.caller);
  if (caller.ok === false) return caller;
  if (!readRepo(input.repo).ok) return fail("repo");
  if (privacyFindings(input.repo, "shared").length) return fail("repo", "forbidden_identifier");
  const held = input.held_by;
  if (held !== null && !isBoardId(held)) return fail("repo");
  if (held !== null && held !== caller.caller.board_id) {
    const code = "repo_held" satisfies RefusalCode;
    return wireRefusal({ command: "repo.activation.read", id: input.id, idempotency_key: null, code, field: "repo" });
  }
  const body = { repo: input.repo, active: held !== null, board_id: held === null ? null : caller.caller.board_id };
  const answer = readAnswer("repo.activation.read", input.id, body);
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

function mergeLanes(board: unknown, override: unknown): { ok: true; lanes: { value: number; min: number; max: number } } | ProtocolFailure {
  const picked = override ?? board;
  if (picked === undefined) return { ok: true, lanes: { value: LANES_DEFAULT, min: LANES_MIN, max: LANES_MAX } };
  if (!plain(picked) || !exactKeys(picked, ["value"]) || !whole(picked.value, LANES_MIN, LANES_MAX)) return fail("lanes");
  return { ok: true, lanes: { value: picked.value, min: LANES_MIN, max: LANES_MAX } };
}

function mergeSteps(board: unknown, override: unknown): { ok: true; steps: Record<string, unknown> } | ProtocolFailure {
  const boardSteps = board === undefined ? {} : board;
  const overrideSteps = override === undefined ? {} : override;
  if (!plain(boardSteps) || !plain(overrideSteps)) return fail("steps");
  const steps: Record<string, unknown> = {};
  for (const step of STEPS) {
    const fromRepo = Object.hasOwn(overrideSteps, step);
    const chosen = fromRepo ? overrideSteps[step] : boardSteps[step];
    if (chosen === undefined) return fail(step);
    if (!plain(chosen) || Object.hasOwn(chosen, "source")) return fail(step);
    steps[step] = { ...chosen, source: fromRepo ? "repo" : "board" };
  }
  return { ok: true, steps };
}

function readLayer(value: unknown): { ok: true; lanes?: unknown; steps?: unknown } | ProtocolFailure {
  if (!plain(value)) return fail("body");
  if (privacyFindings(value, "shared").length) return fail("body", "forbidden_identifier");
  if (!Object.keys(value).every((key) => key === "lanes" || key === "steps")) return fail("body");
  return { ok: true, lanes: value.lanes, steps: value.steps };
}

/** Board defaults, with a repo override winning the whole step. Missing guidance is not invented. */
export function effectiveSettings(input: unknown): ReturnType<typeof readAnswer> | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, ["id", "caller", "repo", "board", "override"])) return fail("body");
  if (!isOpaqueId(input.id)) return fail("id");
  const caller = authorizeRead(input.caller);
  if (caller.ok === false) return caller;
  if (!readRepo(input.repo).ok) return fail("repo");
  if (privacyFindings(input.repo, "shared").length) return fail("repo", "forbidden_identifier");
  const board = readLayer(input.board);
  if (board.ok === false) return board;
  const override = input.override === null ? { ok: true as const, lanes: undefined, steps: undefined } : readLayer(input.override);
  if (override.ok === false) return override;
  const lanes = mergeLanes(board.lanes, override.lanes);
  if (lanes.ok === false) return lanes;
  const steps = mergeSteps(board.steps, override.steps);
  if (steps.ok === false) return steps;
  const answer = readAnswer("settings.effective.read", input.id, { repo: input.repo, lanes: lanes.lanes, steps: steps.steps });
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** Live entry for the three reads. It returns no body while `connectionSettingsServed()` is false. */
export function serveConnectionSettings(input: unknown): ProtocolFailure {
  if (!plain(input) || !oneOf(input.command, READ_COMMANDS)) return fail("command");
  return fail(null, "not_served");
}

const WRITE_SEATS = ["owner", "full", "member"] as const;
const ADMIT_COMMANDS = ["job.admit", "reservation.decide"] as const;
const CANDIDATE_COMMANDS = ["evidence.record", "approval.submit", "completion.record", "authority.revoke", "metrics.aggregate"] as const;
const WRITE_COMMANDS = [...ADMIT_COMMANDS, ...CANDIDATE_COMMANDS] as const;

function authorizeWrite(caller: unknown): { ok: true; caller: { connection_id: string; board_id: string; seat: (typeof WRITE_SEATS)[number] } } | ProtocolFailure {
  if (!plain(caller) || !exactKeys(caller, ["connection_id", "board_id", "seat"])) return fail("actor", "unauthorized");
  if (!isOpaqueId(caller.connection_id) || !isBoardId(caller.board_id) || !oneOf(caller.seat, WRITE_SEATS)) return fail("actor", "unauthorized");
  return { ok: true, caller: { connection_id: caller.connection_id, board_id: caller.board_id, seat: caller.seat } };
}

function writeAnswer(command: (typeof WRITE_COMMANDS)[number], id: string, idempotency_key: string, body: Record<string, unknown>) {
  return { protocol: PROTOCOL, version: PROTOCOL_VERSION, command, id, idempotency_key, body };
}

function commandRefusal(
  command: (typeof WRITE_COMMANDS)[number],
  id: string,
  idempotency_key: string,
  code: RefusalCode,
  field: string | null,
): WireRefusal {
  return wireRefusal({ command, id, idempotency_key, code, field });
}

/** One batch is one queued job and takes no lane. A second admit does not create a second job. */
export function admitJob(input: unknown): ReturnType<typeof writeAnswer> | WireRefusal | ProtocolFailure {
  const keys = ["id", "idempotency_key", "caller", "body", "held_by", "new_job_id", "stored", "open_member_ids"];
  if (!plain(input) || !exactKeys(input, keys)) return fail("body");
  if (!isOpaqueId(input.id)) return fail("id");
  const id = input.id;
  const caller = authorizeWrite(input.caller);
  if (caller.ok === false) return caller;
  if (typeof input.idempotency_key !== "string" || !KEY.test(input.idempotency_key)) return fail("idempotency_key");
  const idempotencyKey = input.idempotency_key;
  if (!plain(input.body)) return fail("body");
  if (privacyFindings(input.body, "shared").length) return fail("body", "forbidden_identifier");
  const request = validateAdmitRequest(input.body);
  if (request.ok === false) return request;
  if (!isOpaqueId(input.new_job_id)) return fail("job_id");
  const held = input.held_by;
  if (held !== null && !isBoardId(held)) return fail("repo");
  if (held === null) return fail("repo", "unauthorized");
  if (held !== caller.caller.board_id) {
    const code = "repo_held" satisfies RefusalCode;
    return commandRefusal("job.admit", id, idempotencyKey, code, "repo");
  }
  if (!Array.isArray(input.open_member_ids) || !input.open_member_ids.every(isOpaqueId)) return fail("members");
  const stored = input.stored === null ? null : input.stored;
  if (stored !== null && (!plain(stored) || !exactKeys(stored, ["idempotency_key", "body", "job_id"]))) return fail("idempotency_key");
  const replay = replayAdmission(stored as { idempotency_key: string; body: unknown; job_id: string } | null, {
    idempotency_key: idempotencyKey,
    body: input.body,
  });
  if ("ok" in replay) {
    if (replay.code !== "idempotency_conflict") return replay;
    const code = "idempotency_conflict" satisfies RefusalCode;
    return commandRefusal("job.admit", id, idempotencyKey, code, "idempotency_key");
  }
  const members = input.body.members as string[];
  const queued = (job_id: string) => {
    const answer = writeAnswer("job.admit", id, idempotencyKey, {
      job_id,
      state: "queued",
      lane_id: null,
      revision: 1,
      members,
    });
    const checked = validateWire(answer, "response");
    return checked.ok ? answer : checked;
  };
  if (replay.kind === "replay") return queued(replay.job_id);
  const open = new Set(input.open_member_ids as string[]);
  if (members.some((member) => open.has(member))) {
    const code = "already_admitted" satisfies RefusalCode;
    return commandRefusal("job.admit", id, idempotencyKey, code, "members");
  }
  if (open.has(input.new_job_id) || members.includes(input.new_job_id)) return fail("job_id");
  return queued(input.new_job_id);
}

/** Lane and area effects. Pause keeps the lane. Park releases only a stopped or isolated writer. */
export function decideReservation(input: unknown): ReturnType<typeof writeAnswer> | WireRefusal | ProtocolFailure {
  const keys = [
    "id", "idempotency_key", "caller", "body", "current_revision", "lanes_in_use", "lane_limit",
    "offered_lane_id", "offered_area_id", "fence", "lease_expired", "stored",
  ];
  if (!plain(input) || !exactKeys(input, keys)) return fail("body");
  if (!isOpaqueId(input.id)) return fail("id");
  const caller = authorizeWrite(input.caller);
  if (caller.ok === false) return caller;
  if (typeof input.idempotency_key !== "string" || !KEY.test(input.idempotency_key)) return fail("idempotency_key");
  if (typeof input.lease_expired !== "boolean") return fail("writers");
  if (!plain(input.body)) return fail("body");
  if (privacyFindings(input.body, "shared").length) return fail("body", "forbidden_identifier");
  const request = validateReservationRequest(input.body);
  if (request.ok === false) return request;
  if (!whole(input.lanes_in_use, 0, Number.MAX_SAFE_INTEGER) || !whole(input.lane_limit, LANES_MIN, LANES_MAX)) return fail("lane_id");
  if (input.offered_lane_id !== null && !isOpaqueId(input.offered_lane_id)) return fail("lane_id");
  if (input.offered_area_id !== null && !isOpaqueId(input.offered_area_id)) return fail("area_id");
  if (!whole(input.current_revision, 1, Number.MAX_SAFE_INTEGER)) return fail("expected_revision");
  const key = input.idempotency_key;
  if (input.stored !== null) {
    if (!plain(input.stored) || !exactKeys(input.stored, ["idempotency_key", "body", "response"])) return fail("idempotency_key");
    if (input.stored.idempotency_key === key) {
      if (!sameBody(input.stored.body, input.body)) {
        const code = "idempotency_conflict" satisfies RefusalCode;
        return commandRefusal("reservation.decide", input.id, key, code, "idempotency_key");
      }
      if (!plain(input.stored.response)) return fail("body");
      const replayed = writeAnswer("reservation.decide", input.id, key, input.stored.response);
      const checked = validateWire(replayed, "response");
      return checked.ok ? replayed : checked;
    }
  }
  if (input.fence !== null) {
    const fence = fenceAllows(input.fence as Parameters<typeof fenceAllows>[0]);
    if (fence.ok === false) {
      if (fence.code !== "stale_writer") return fence;
      return commandRefusal("reservation.decide", input.id, key, fence.code, fence.field);
    }
  }
  const revision = expectRevision(input.body.expected_revision, input.current_revision);
  if (revision.ok === false) {
    if (revision.code !== "changed_since") return revision;
    return commandRefusal("reservation.decide", input.id, key, revision.code, revision.field);
  }
  const decision = reservationDecision({ intent: input.body.intent, writers: input.body.writers });
  if (!("release" in decision)) {
    if (decision.code !== "not_stopped") return decision;
    return commandRefusal("reservation.decide", input.id, key, decision.code, decision.field);
  }
  const nextRevision = input.current_revision + 1;
  if (!whole(nextRevision, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
  let laneId: string | null;
  let areaId: string | null;
  if (decision.release) {
    laneId = null;
    areaId = null;
  } else if (input.body.intent === "acquire") {
    if (input.lanes_in_use >= input.lane_limit) {
      const code = "lane_full" satisfies RefusalCode;
      return commandRefusal("reservation.decide", input.id, key, code, "lane_id");
    }
    if (!isOpaqueId(input.offered_lane_id)) return fail("lane_id");
    laneId = input.offered_lane_id;
    areaId = input.offered_area_id;
  } else {
    if (!isOpaqueId(input.body.lane_id)) return fail("lane_id");
    laneId = input.body.lane_id;
    areaId = input.body.area_id as string | null;
  }
  const answer = writeAnswer("reservation.decide", input.id, key, {
    job_id: input.body.job_id,
    intent: input.body.intent,
    writers: input.body.writers,
    released: decision.release,
    lane_id: laneId,
    area_id: areaId,
    revision: nextRevision,
  });
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** Live entry for admission and reservations. It returns no job or lane while the serve gate is closed. */
export function serveAdmissionReservations(input: unknown): ProtocolFailure {
  if (!plain(input) || !oneOf(input.command, ADMIT_COMMANDS)) return fail("command");
  return fail(null, "not_served");
}

function openWrite(input: unknown, keys: readonly string[]): { ok: true; id: string; idempotencyKey: string; caller: { connection_id: string; board_id: string; seat: (typeof WRITE_SEATS)[number] }; body: Record<string, unknown>; raw: Record<string, unknown> } | ProtocolFailure {
  if (!plain(input) || !exactKeys(input, keys)) return fail("body");
  if (!isOpaqueId(input.id)) return fail("id");
  const caller = authorizeWrite(input.caller);
  if (caller.ok === false) return caller;
  if (typeof input.idempotency_key !== "string" || !KEY.test(input.idempotency_key)) return fail("idempotency_key");
  if (!plain(input.body)) return fail("body");
  return { ok: true, id: input.id, idempotencyKey: input.idempotency_key, caller: caller.caller, body: input.body, raw: input };
}

function heldByCaller(command: (typeof CANDIDATE_COMMANDS)[number], id: string, key: string, held: unknown, boardId: string): { ok: true } | WireRefusal | ProtocolFailure {
  if (held !== null && !isBoardId(held)) return fail("repo");
  if (held === null) return fail("repo", "unauthorized");
  if (held !== boardId) {
    const code = "repo_held" satisfies RefusalCode;
    return commandRefusal(command, id, key, code, "repo");
  }
  return { ok: true };
}

function replayWrite(command: (typeof WRITE_COMMANDS)[number], id: string, key: string, body: unknown, stored: unknown): { kind: "fresh" } | { kind: "replay"; body: Record<string, unknown> } | WireRefusal | ProtocolFailure {
  if (stored === null) return { kind: "fresh" };
  if (!plain(stored) || !exactKeys(stored, ["idempotency_key", "body", "response"])) return fail("idempotency_key");
  if (typeof stored.idempotency_key !== "string" || stored.idempotency_key !== key) return { kind: "fresh" };
  if (!sameBody(stored.body, body)) {
    const code = "idempotency_conflict" satisfies RefusalCode;
    return commandRefusal(command, id, key, code, "idempotency_key");
  }
  if (!plain(stored.response)) return fail("body");
  return { kind: "replay", body: stored.response };
}

function replayOrFresh(
  command: (typeof WRITE_COMMANDS)[number],
  id: string,
  key: string,
  body: unknown,
  stored: unknown,
  accept: (response: Record<string, unknown>) => boolean,
): { kind: "fresh" } | WireRefusal | ProtocolFailure | ReturnType<typeof writeAnswer> {
  const replay = replayWrite(command, id, key, body, stored);
  if (!("kind" in replay)) return replay;
  if (replay.kind === "fresh") return replay;
  const answer = writeAnswer(command, id, key, replay.body);
  const checked = validateWire(answer, "response");
  if (checked.ok && accept(replay.body)) return answer;
  return { kind: "fresh" };
}

function clientRefusal(code: RefusalCode): boolean {
  return code === "stale_candidate" || code === "not_a_person" || code === "false_code_review" || code === "host_missing"
    || code === "checks_unsatisfied" || code === "completion_open" || code === "changed_since" || code === "unknown_amount"
    || code === "metric_conflict" || code === "forbidden_identifier";
}

function promote(command: (typeof CANDIDATE_COMMANDS)[number], id: string, key: string, failure: ProtocolFailure): WireRefusal | ProtocolFailure {
  if (failure.field === null || !REFUSAL_FIELDS.has(failure.field) || !clientRefusal(failure.code)) return failure;
  return commandRefusal(command, id, key, failure.code, failure.field);
}

function bumpedRevision(command: (typeof CANDIDATE_COMMANDS)[number], id: string, key: string, expected: unknown, current: unknown): { ok: true; revision: number } | WireRefusal | ProtocolFailure {
  if (!whole(current, 1, Number.MAX_SAFE_INTEGER)) return fail("expected_revision");
  const revision = expectRevision(expected, current);
  if (revision.ok === false) return promote(command, id, key, revision);
  const next = current + 1;
  if (!whole(next, 1, Number.MAX_SAFE_INTEGER)) return fail("revision");
  return { ok: true, revision: next };
}

function readBind(value: unknown): { ok: true; bind: { candidate_id: string; requirements_id: string; base_id: string; policy_id: string } } | ProtocolFailure {
  const keys = ["candidate_id", "requirements_id", "base_id", "policy_id"] as const;
  if (!plain(value) || !exactKeys(value, keys)) return fail("candidate_id");
  if (!isOpaqueId(value.candidate_id) || !isOpaqueId(value.requirements_id) || !isOpaqueId(value.base_id) || !isOpaqueId(value.policy_id)) return fail("candidate_id");
  return {
    ok: true,
    bind: {
      candidate_id: value.candidate_id,
      requirements_id: value.requirements_id,
      base_id: value.base_id,
      policy_id: value.policy_id,
    },
  };
}

function seatMayApprove(seat: (typeof WRITE_SEATS)[number], approvers: unknown): { ok: true } | ProtocolFailure {
  if (approvers === "owner") return seat === "owner" ? { ok: true } : fail("actor", "unauthorized");
  if (approvers === "full_and_owner") return seat === "owner" || seat === "full" ? { ok: true } : fail("actor", "unauthorized");
  if (approvers === "member_full_and_owner") return { ok: true };
  return fail("actor");
}

/** Not required stays Not required. Evidence for one candidate does not cover another. */
export function recordEvidence(input: unknown): ReturnType<typeof writeAnswer> | WireRefusal | ProtocolFailure {
  const opened = openWrite(input, ["id", "idempotency_key", "caller", "body", "held_by", "current_revision", "target", "stored"]);
  if (opened.ok === false) return opened;
  const { id, idempotencyKey, caller, body, raw } = opened;
  if (privacyFindings(body, "shared").length) return fail("body", "forbidden_identifier");
  const held = heldByCaller("evidence.record", id, idempotencyKey, raw.held_by, caller.board_id);
  if (!("ok" in held) || held.ok === false) return held;
  const replay = replayOrFresh("evidence.record", id, idempotencyKey, body, raw.stored, (response) =>
    response.recorded === true && response.result === body.result && response.job_id === body.job_id
    && response.candidate_id === body.candidate_id && response.requirements_id === body.requirements_id
    && response.base_id === body.base_id && response.policy_id === body.policy_id && response.attempt_id === body.attempt_id);
  if (!("kind" in replay)) return replay;
  const request = validateEvidenceRequest(body);
  if (request.ok === false) return request;
  const target = readBind(raw.target);
  if (target.ok === false) return target;
  const evidence = readBind({
    candidate_id: body.candidate_id,
    requirements_id: body.requirements_id,
    base_id: body.base_id,
    policy_id: body.policy_id,
  });
  if (evidence.ok === false) return evidence;
  const bound = evidenceBinds(evidence.bind, target.bind);
  if (bound.ok === false) return promote("evidence.record", id, idempotencyKey, bound);
  const revision = bumpedRevision("evidence.record", id, idempotencyKey, body.expected_revision, raw.current_revision);
  if (!("ok" in revision) || revision.ok === false) return revision;
  const answer = writeAnswer("evidence.record", id, idempotencyKey, {
    job_id: body.job_id,
    candidate_id: evidence.bind.candidate_id,
    requirements_id: evidence.bind.requirements_id,
    base_id: evidence.bind.base_id,
    policy_id: evidence.bind.policy_id,
    attempt_id: body.attempt_id,
    result: body.result,
    recorded: true,
    revision: revision.revision,
  });
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** Only a person in the merge approver group can approve. Tests add no extra approval. */
export function submitApproval(input: unknown): ReturnType<typeof writeAnswer> | WireRefusal | ProtocolFailure {
  const opened = openWrite(input, ["id", "idempotency_key", "caller", "body", "held_by", "current_revision", "approvers", "stored"]);
  if (opened.ok === false) return opened;
  const { id, idempotencyKey, caller, body, raw } = opened;
  if (privacyFindings(body, "shared").length) return fail("body", "forbidden_identifier");
  const held = heldByCaller("approval.submit", id, idempotencyKey, raw.held_by, caller.board_id);
  if (!("ok" in held) || held.ok === false) return held;
  const replay = replayOrFresh("approval.submit", id, idempotencyKey, body, raw.stored, (response) =>
    response.approved === true && response.extra_approval === false && response.job_id === body.job_id
    && response.candidate_id === body.candidate_id && response.base_id === body.base_id
    && response.requirements_id === body.requirements_id && response.policy_id === body.policy_id
    && response.code_inspection === body.code_inspection && response.code_reviewed === body.code_reviewed
    && response.explanation === body.explanation && response.tests_result === body.tests_result
    && response.host_checks === body.host_checks);
  if (!("kind" in replay)) return replay;
  const request = validateApprovalRequest(body);
  if (request.ok === false) return request;
  const allowed = approvalAllowed({
    actor: body.actor,
    candidate_id: body.candidate_id,
    reviewed_candidate_id: body.reviewed_candidate_id,
    base_id: body.base_id,
    reviewed_base_id: body.reviewed_base_id,
    code_inspection: body.code_inspection,
    code_reviewed: body.code_reviewed,
    tests_result: body.tests_result,
    host_checks: body.host_checks,
    explanation: body.explanation,
  });
  if (allowed.ok === false) return promote("approval.submit", id, idempotencyKey, allowed);
  const seat = seatMayApprove(caller.seat, raw.approvers);
  if (seat.ok === false) return seat;
  const revision = bumpedRevision("approval.submit", id, idempotencyKey, body.expected_revision, raw.current_revision);
  if (!("ok" in revision) || revision.ok === false) return revision;
  const answer = writeAnswer("approval.submit", id, idempotencyKey, {
    job_id: body.job_id,
    approved: true,
    candidate_id: body.candidate_id,
    base_id: body.base_id,
    requirements_id: body.requirements_id,
    policy_id: body.policy_id,
    code_inspection: body.code_inspection,
    code_reviewed: body.code_reviewed,
    explanation: body.explanation,
    tests_result: body.tests_result,
    host_checks: body.host_checks,
    extra_approval: false,
    revision: revision.revision,
  });
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** On main and closed stay separate. Pending or failed evidence cannot close the ticket. */
export function recordCompletion(input: unknown): ReturnType<typeof writeAnswer> | WireRefusal | ProtocolFailure {
  const opened = openWrite(input, ["id", "idempotency_key", "caller", "body", "held_by", "current_revision", "stored"]);
  if (opened.ok === false) return opened;
  const { id, idempotencyKey, caller, body, raw } = opened;
  if (privacyFindings(body, "shared").length) return fail("body", "forbidden_identifier");
  const held = heldByCaller("completion.record", id, idempotencyKey, raw.held_by, caller.board_id);
  if (!("ok" in held) || held.ok === false) return held;
  const replay = replayOrFresh("completion.record", id, idempotencyKey, body, raw.stored, (response) =>
    response.job_id === body.job_id && response.on_main === body.on_main && response.closed === body.closed
    && response.completion_evidence === body.completion_evidence);
  if (!("kind" in replay)) return replay;
  if (!exactKeys(body, ["job_id", "on_main", "closed", "completion_evidence", "expected_revision"])) return fail("body");
  if (!isOpaqueId(body.job_id)) return fail("job_id");
  const record = completionRecord({ on_main: body.on_main, closed: body.closed, completion_evidence: body.completion_evidence });
  if (record.ok === false) return promote("completion.record", id, idempotencyKey, record);
  const revision = bumpedRevision("completion.record", id, idempotencyKey, body.expected_revision, raw.current_revision);
  if (!("ok" in revision) || revision.ok === false) return revision;
  const answer = writeAnswer("completion.record", id, idempotencyKey, {
    job_id: body.job_id,
    on_main: record.on_main,
    closed: record.closed,
    completion_evidence: record.completion_evidence,
    revision: revision.revision,
  });
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** Revocation refuses new server actions. It does not claim the process stopped. */
export function revokeAuthority(input: unknown): ReturnType<typeof writeAnswer> | WireRefusal | ProtocolFailure {
  const opened = openWrite(input, ["id", "idempotency_key", "caller", "body", "current_revision", "target_board_id", "stored"]);
  if (opened.ok === false) return opened;
  const { id, idempotencyKey, caller, body, raw } = opened;
  if (!exactKeys(body, ["connection_id", "expected_revision"]) || !isOpaqueId(body.connection_id) || !whole(body.expected_revision, 0, Number.MAX_SAFE_INTEGER)) {
    return fail("connection_id");
  }
  const own = body.connection_id === caller.connection_id;
  const sameBoard = raw.target_board_id === caller.board_id;
  const mayRevokeOther = sameBoard && (caller.seat === "owner" || caller.seat === "full");
  if (!own && !mayRevokeOther) return fail("connection_id", "unauthorized");
  const replay = replayOrFresh("authority.revoke", id, idempotencyKey, body, raw.stored, (response) =>
    response.connection_id === body.connection_id && response.further_server_actions === "refused"
    && response.process_stopped === false && response.in_flight === "uncertain");
  if (!("kind" in replay)) return replay;
  const revision = bumpedRevision("authority.revoke", id, idempotencyKey, body.expected_revision, raw.current_revision);
  if (!("ok" in revision) || revision.ok === false) return revision;
  const answer = writeAnswer("authority.revoke", id, idempotencyKey, {
    connection_id: body.connection_id,
    further_server_actions: "refused",
    process_stopped: false,
    in_flight: "uncertain",
  });
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** Anonymous totals. Unknown usage stays null, a known zero stays zero, and a replay does not add the total again. */
export function aggregateMetrics(input: unknown): ReturnType<typeof writeAnswer> | WireRefusal | ProtocolFailure {
  const opened = openWrite(input, ["id", "idempotency_key", "caller", "body", "stored"]);
  if (opened.ok === false) return opened;
  const { id, idempotencyKey, body, raw } = opened;
  const replay = replayOrFresh("metrics.aggregate", id, idempotencyKey, body, raw.stored, (response) =>
    response.accepted === true && response.period === body.period && sameBody(response.totals, body.totals));
  if (!("kind" in replay)) return replay;
  const request = validateMetrics(body);
  if (request.ok === false) {
    if (request.code === "forbidden_identifier") {
      const code = "forbidden_identifier" satisfies RefusalCode;
      return commandRefusal("metrics.aggregate", id, idempotencyKey, code, "totals");
    }
    return promote("metrics.aggregate", id, idempotencyKey, request);
  }
  const answer = writeAnswer("metrics.aggregate", id, idempotencyKey, {
    accepted: true,
    period: body.period,
    totals: body.totals,
  });
  const checked = validateWire(answer, "response");
  return checked.ok ? answer : checked;
}

/** Live entry for evidence, approval, completion, revocation and metrics. It returns no body while the serve gate is closed. */
export function serveCandidateApproval(input: unknown): ProtocolFailure {
  if (!plain(input) || !oneOf(input.command, CANDIDATE_COMMANDS)) return fail("command");
  return fail(null, "not_served");
}

export function applyRule(name: string, input: unknown): unknown {
  if (!plain(input) && name !== "foldMetricEvents") return fail(null);
  if (name === "negotiate") return negotiate(input as { client_version: unknown });
  if (name === "heldActivation") return heldActivation(input as { id: string });
  if (name === "replayAdmission") {
    const value = input as { stored?: unknown; next?: unknown };
    return replayAdmission(
      value.stored as { idempotency_key: string; body: unknown; job_id: string } | null,
      value.next as { idempotency_key: string; body: unknown },
    );
  }
  if (name === "reservationDecision") return reservationDecision(input as { intent: unknown; writers: unknown });
  if (name === "fenceAllows") return fenceAllows(input as Parameters<typeof fenceAllows>[0]);
  if (name === "evidenceBinds") {
    const value = input as { evidence: Parameters<typeof evidenceBinds>[0]; target: Parameters<typeof evidenceBinds>[1] };
    return evidenceBinds(value.evidence, value.target);
  }
  if (name === "approvalAllowed") return approvalAllowed(input as Parameters<typeof approvalAllowed>[0]);
  if (name === "completionRecord") return completionRecord(input as Parameters<typeof completionRecord>[0]);
  if (name === "expectRevision") {
    const value = input as { expected?: unknown; current?: unknown };
    return expectRevision(value.expected, value.current);
  }
  if (name === "foldMetricEvents") {
    const value = input as { events?: unknown };
    return foldMetricEvents(value.events);
  }
  if (name === "delayAllowed") return delayAllowed((input as { minutes?: unknown }).minutes);
  if (name === "reportedPassed") return reportedPassed((input as { result?: unknown }).result);
  if (name === "selectedGateSatisfied") return selectedGateSatisfied((input as { result?: unknown }).result);
  if (name === "testsImposeExtraApproval") return testsImposeExtraApproval((input as { result?: unknown }).result);
  if (name === "writerStoppedByLeaseExpiry") return writerStoppedByLeaseExpiry();
  if (name === "areaRequired") return areaRequired((input as { step?: unknown }).step);
  if (name === "connectionStatus") return connectionStatus(input);
  if (name === "activationRead") return activationRead(input);
  if (name === "effectiveSettings") return effectiveSettings(input);
  if (name === "serveConnectionSettings") return serveConnectionSettings(input);
  if (name === "admitJob") return admitJob(input);
  if (name === "decideReservation") return decideReservation(input);
  if (name === "serveAdmissionReservations") return serveAdmissionReservations(input);
  if (name === "recordEvidence") return recordEvidence(input);
  if (name === "submitApproval") return submitApproval(input);
  if (name === "recordCompletion") return recordCompletion(input);
  if (name === "revokeAuthority") return revokeAuthority(input);
  if (name === "aggregateMetrics") return aggregateMetrics(input);
  if (name === "serveCandidateApproval") return serveCandidateApproval(input);
  return fail("rule");
}

const FABRICATED_SLUG = /^fabricated(?:-[a-z0-9]+)*$/;

/** Authorized fixtures use fabricated ids only. Runtime hosts are not limited to example.com. */
export function fixtureFindings(value: unknown): string[] {
  const found: string[] = [];
  walkFixture(value, found, "");
  return found;
}

function walkFixture(value: unknown, found: string[], path: string): void {
  if (typeof value === "string") {
    if (value.includes("@") || SECRET.test(value)) found.push(path || "value");
    if (OPAQUE_ID.test(value) && !value.startsWith("fab0")) found.push(path || "value");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkFixture(item, found, `${path}[${index}]`));
    return;
  }
  if (!plain(value)) return;
  for (const key of Object.keys(value)) {
    const next = path ? `${path}.${key}` : key;
    if (key === "__proto__" || key === "constructor" || key === "prototype") found.push(next);
    const item = value[key];
    if ((key === "board_id" || key === "board_repo_id" || key === "owner") && item !== null && !FABRICATED_SLUG.test(String(item)) && !(key === "board_id" && isFabricatedId(item))) found.push(next);
    if (key === "name" && next.endsWith("repo.name") && item !== null && !FABRICATED_SLUG.test(String(item))) found.push(next);
    if ((key.endsWith("_id") && key !== "board_id" && key !== "board_repo_id" || key === "attempt" || key === "members") && typeof item === "string" && !isFabricatedId(item)) found.push(next);
    if (key === "host" && item !== "example.com") found.push(next);
    if (key === "idempotency_key" && item !== null && (typeof item !== "string" || !item.startsWith("fab-"))) found.push(next);
    if (key === "guidance_version" && (typeof item !== "string" || !item.startsWith("fab-guidance-"))) found.push(next);
    if (key === "computer" && item !== "Fabricated computer") found.push(next);
    if (key === "person_label" && item !== "Fabricated person") found.push(next);
    if (key === "requested" && item !== "fabricated-model") found.push(next);
    walkFixture(item, found, next);
  }
}
