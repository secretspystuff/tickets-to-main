import { createHash } from "node:crypto";
import { safeNativeText } from "./adapters/native-result.ts";

export type WatchIdentity = {
  repoId: string;
  ticketId: string;
  jobId: string;
  runId: string;
  evidenceVersion: string;
};

export type WatchSource = {
  id: string;
  sessionId: string;
  vendor: string;
  interfaceId: string;
  model: string | null;
  role: "builder" | "helper";
  counters: { turns: boolean; tokens: boolean; compactions: boolean };
};

export type WatchThresholds = {
  identicalActions: number;
  identicalErrors: number;
  pingPongActions: number;
  compactions: number;
  idleMs: number;
  judgeTurns: number;
  judgeTokens: number;
  frequentAfterTurns: number;
  judgeEveryTurns: number;
  confidentEveryTurns: number;
  unsureEveryTurns: number;
  nudgeConfidence: number;
  furtherTurns: number;
  confirmationConfidence: number;
};

export const DEFAULT_WATCH_THRESHOLDS: Readonly<WatchThresholds> = {
  identicalActions: 4,
  identicalErrors: 3,
  pingPongActions: 6,
  compactions: 2,
  idleMs: 600_000,
  judgeTurns: 15,
  judgeTokens: 150_000,
  frequentAfterTurns: 30,
  judgeEveryTurns: 10,
  confidentEveryTurns: 15,
  unsureEveryTurns: 5,
  nudgeConfidence: 0.8,
  furtherTurns: 10,
  confirmationConfidence: 0.9,
};

export type WatchConfig = {
  identity: WatchIdentity;
  sources: WatchSource[];
  // Freshness comes from the consuming adapter's observation contract.
  telemetryMaxAgeMs: number;
  thresholds?: Partial<WatchThresholds>;
};

export type DiffSize = { file: string; added: number; removed: number; substantive: boolean };
export type WatchEvent =
  | { kind: "action"; name: string; argumentsKey: string; outcomeKey: string; shortOutcome: string; errorKey?: string }
  | { kind: "check"; checkId: string; passing: number; failureKey: string | null; passed?: boolean; debuggingAdvanceEvidenceIds?: string[] }
  | { kind: "tree"; treeId: string; files: DiffSize[] }
  | { kind: "plan_item"; itemId: string; planFiles: string[]; treeId: string; files: DiffSize[] }
  | { kind: "fix_test_cycle"; failureKey: string }
  // A reused OS PID alone cannot identify the same owned process.
  | { kind: "process"; processId: string; ownership: "confirmed" | "unknown"; liveness: "running" | "unknown"; cpuMs: number | null; lastOutputAt: number | null }
  | { kind: "sample" };

export type WatchObservation = {
  identity: WatchIdentity;
  source: WatchSource;
  id: string;
  // Observation ordering is independent of the native counters below.
  sequence: number;
  observedAt: number;
  counters: { turns?: number | null; tokens?: number | null; compactions?: number | null };
  event: WatchEvent;
};

export type WatchControls = {
  identity: WatchIdentity;
  sourceId: string;
  sessionId: string;
  vendor: string;
  interfaceId: string;
  evidenceIds: string[];
  input: "qualified" | "unavailable" | "unknown";
  safeReconcile: "qualified" | "unavailable" | "unknown";
  ownership: "confirmed" | "unknown";
  liveness: "running" | "unknown";
  nativeHeld: boolean;
};

export type JudgeVerdict = "progressing" | "stalled" | "looping" | "off_scope" | "unsure";
export type JudgeRoute = {
  tier: "cheap" | "stronger";
  requested: { vendor: string; model: string };
  eligible: Array<{ vendor: string; model: string }>;
  calibrationEvidenceIds: string[];
  // A model name alone cannot establish that this is a stronger confirmation.
  strongerQualificationEvidenceIds: string[];
};

export type JudgeResult = {
  packetId: string;
  identity: WatchIdentity;
  observed: { vendor: string; model: string };
  verdict: JudgeVerdict;
  confidence: number;
  actionIds: string[];
  diagnosis: string;
};

export type WatchSignal = { kind: string; sourceId: string; count: number; actionIds: string[] };
export type WatchStatus = {
  revision: number;
  lastEvent: { sourceId: string; id: string; observedAt: number } | null;
  sources: Array<{
    sourceId: string;
    role: WatchSource["role"];
    fresh: boolean;
    sinceStrong: { turns: number | null; tokens: number | null; compactions: number | null };
    actionCount: number;
  }>;
  missing: string[];
  signals: WatchSignal[];
  nudge: { deliveryId: string; observedAt: number; furtherTurns: number | null } | null;
  nudgeOutcomes: Array<{ deliveryId: string; progressWithinTenTurns: boolean | null }>;
};

export type WatchDecision = {
  kind: "continue" | "judge_needed" | "nudge_eligible" | "confirmation_needed" | "safe_reconcile_requested" | "preserved_work_blocker";
  reason: string;
  status: WatchStatus;
  nudgeText?: string;
};

export type JudgePacket = {
  packetId: string;
  identity: WatchIdentity;
  revision: number;
  title: string;
  plan: Array<{ id: string; text: string; completed: boolean }>;
  actions: Array<{ id: string; sourceId: string; name: string; outcome: string }>;
  signals: Pick<WatchStatus, "sources" | "missing" | "signals" | "lastEvent">;
  files: Array<{ file: string; added: number; removed: number }>;
};

type CounterName = "turns" | "tokens" | "compactions";
type Counter = { value: number | null; highest: number | null; strong: number | null; weak: number | null };
type SourceState = {
  sequence: number;
  at: number | null;
  seenIds: Set<string>;
  counters: Record<CounterName, Counter>;
  actions: Array<{ id: string; action: Extract<WatchEvent, { kind: "action" }> }>;
  actionCount: number;
  pattern: { exact: number; error: number; alternating: number };
  checks: Map<string, { passing: number; failureKey: string | null }>;
  completed: Set<string>;
  trees: Set<string>;
  lastTree: string | null;
  returnedTree: boolean;
  cycles: { key: string; count: number } | null;
  process: { id: string; cpuMs: number; outputAt: number; idleSince: number; at: number } | null;
};

type Pending = { packet: JudgePacket; route: JudgeRoute; at: number };
type Judgment = { result: JudgeResult; route: JudgeRoute; revision: number; turns: number | null; tokens: number | null };
type Nudge = { deliveryId: string; observedAt: number; turns: number | null };
type WatchOperation =
  | { kind: "observe"; observation: WatchObservation; now: number }
  | { kind: "request"; now: number; controls: WatchControls; context: { title: string; plan: JudgePacket["plan"] }; route: JudgeRoute }
  | { kind: "judge"; result: JudgeResult; now: number }
  | { kind: "nudge"; deliveryId: string; now: number; controls: WatchControls };

export type WatchSnapshot = { version: 1; config: WatchConfig; operations: WatchOperation[] };

const COUNTERS: CounterName[] = ["turns", "tokens", "compactions"];
const clone = <T>(value: T): T => structuredClone(value);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const opaqueKey = (value: string): string => /^sha256:[a-f0-9]{64}$/.test(value) ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
const whole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const textId = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isStuck = (verdict: JudgeVerdict): boolean => ["stalled", "looping", "off_scope"].includes(verdict);

function validateConfig(config: WatchConfig): WatchThresholds {
  if (![config.identity.repoId, config.identity.ticketId, config.identity.jobId, config.identity.runId, config.identity.evidenceVersion].every(textId)
    || Object.keys(config.identity).length !== 5) throw new Error("Invalid watch identity.");
  if (!whole(config.telemetryMaxAgeMs)) throw new Error("A measured freshness bound is required.");
  if (config.sources.filter((source) => source.role === "builder").length !== 1) throw new Error("One attributed builder is required.");
  const ids = new Set<string>();
  const sessions = new Set<string>();
  for (const source of config.sources) {
    if (![source.id, source.sessionId, source.vendor, source.interfaceId].every(textId)
      || (source.model !== null && !textId(source.model)) || !["builder", "helper"].includes(source.role)
      || COUNTERS.some((name) => typeof source.counters[name] !== "boolean")
      || ids.has(source.id) || sessions.has(source.sessionId)) throw new Error("Invalid watch source.");
    ids.add(source.id);
    sessions.add(source.sessionId);
  }
  const thresholds = { ...DEFAULT_WATCH_THRESHOLDS, ...config.thresholds };
  for (const [key, value] of Object.entries(thresholds)) {
    if (key.endsWith("Confidence")) {
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid confidence threshold.");
    } else if (!whole(value)) throw new Error("Invalid watch threshold.");
  }
  if (Object.keys(thresholds).length !== Object.keys(DEFAULT_WATCH_THRESHOLDS).length) throw new Error("Unknown watch threshold.");
  return thresholds;
}

function emptySource(): SourceState {
  const counter = (): Counter => ({ value: null, highest: null, strong: null, weak: null });
  return {
    sequence: -1, at: null, seenIds: new Set(), counters: { turns: counter(), tokens: counter(), compactions: counter() },
    actions: [], actionCount: 0, pattern: { exact: 0, error: 0, alternating: 0 }, checks: new Map(), completed: new Set(), trees: new Set(), lastTree: null,
    returnedTree: false, cycles: null, process: null,
  };
}

function sameAction(a: Extract<WatchEvent, { kind: "action" }>, b: Extract<WatchEvent, { kind: "action" }>): boolean {
  return a.name === b.name && a.argumentsKey === b.argumentsKey && a.outcomeKey === b.outcomeKey;
}

function validateEvent(event: WatchEvent, at: number): void {
  switch (event.kind) {
    case "action":
      if (![event.name, event.argumentsKey, event.outcomeKey].every(textId) || typeof event.shortOutcome !== "string"
        || (event.errorKey !== undefined && !textId(event.errorKey))) throw new Error("Invalid observed action.");
      break;
    case "check":
      if (!textId(event.checkId) || !whole(event.passing) || (event.failureKey !== null && !textId(event.failureKey))
        || (event.passed !== undefined && (typeof event.passed !== "boolean" || (event.passed && event.failureKey !== null)))
        || (event.debuggingAdvanceEvidenceIds !== undefined && !event.debuggingAdvanceEvidenceIds.every(textId))) throw new Error("Invalid observed check.");
      break;
    case "plan_item":
      if (!textId(event.itemId) || !event.planFiles.every(textId)) throw new Error("Invalid plan progress.");
      // A plan completion requires its own observed substantive file evidence.
    case "tree":
      if (!textId(event.treeId) || !event.files.every((file) => textId(file.file) && whole(file.added) && whole(file.removed) && typeof file.substantive === "boolean")) throw new Error("Invalid observed diff.");
      break;
    case "fix_test_cycle":
      if (!textId(event.failureKey)) throw new Error("Invalid observed cycle.");
      break;
    case "process":
      if (!textId(event.processId) || !["confirmed", "unknown"].includes(event.ownership) || !["running", "unknown"].includes(event.liveness)
        || (event.cpuMs !== null && !whole(event.cpuMs))
        || (event.lastOutputAt !== null && (!whole(event.lastOutputAt) || event.lastOutputAt > at))) throw new Error("Invalid process sample.");
      break;
    case "sample": break;
    default: throw new Error("Unsupported observation.");
  }
}

// Outgoing packets and diagnoses use the same redaction boundary, including held secrets supplied by the caller.
function safeText(value: string, heldSecrets: readonly string[], limit = 300): string {
  return safeNativeText(value, heldSecrets)
    .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
}

function diagnosisText(value: string, heldSecrets: readonly string[]): string {
  return safeText(value, heldSecrets, 2_000)
    .replace(/(?:https?:\/\/|www\.)\S+|\[[^\]]*\]\([^)]*\)|<[^>]*>|`[^`]*`|\$\([^)]*\)/gi, "")
    .split(/[.!?;\n]/).filter((part) => !/\b(?:run|execute|invoke|curl|wget|bash|powershell|sudo|rm|git|npm|node|python|kill|delete)\b/i.test(part))
    .join(". ").trim().slice(0, 200);
}

function assertSafeRecord(value: unknown, heldSecrets: readonly string[]): void {
  if (typeof value === "string" && safeText(value, heldSecrets, Number.MAX_SAFE_INTEGER) !== value) throw new Error("Unsafe text cannot enter watch identity or a checkpoint.");
  if (Array.isArray(value)) for (const item of value) assertSafeRecord(item, heldSecrets);
  else if (value !== null && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    assertSafeRecord(key, heldSecrets);
    assertSafeRecord(item, heldSecrets);
  }
}

function projectEvent(event: WatchEvent, secrets: readonly string[]): WatchEvent {
  switch (event.kind) {
    case "action": return {
      kind: "action", name: safeText(event.name, secrets), argumentsKey: opaqueKey(event.argumentsKey), outcomeKey: opaqueKey(event.outcomeKey),
      shortOutcome: safeText(event.shortOutcome, secrets), ...(event.errorKey === undefined ? {} : { errorKey: opaqueKey(event.errorKey) }),
    };
    case "check": return {
      kind: "check", checkId: opaqueKey(event.checkId), passing: event.passing, failureKey: event.failureKey === null ? null : opaqueKey(event.failureKey),
      ...(event.passed === undefined ? {} : { passed: event.passed }),
      ...(event.debuggingAdvanceEvidenceIds === undefined ? {} : { debuggingAdvanceEvidenceIds: event.debuggingAdvanceEvidenceIds.map((id) => safeText(id, secrets)) }),
    };
    case "tree": return { kind: "tree", treeId: opaqueKey(event.treeId), files: event.files.map((file) => ({ file: safeText(file.file, secrets), added: file.added, removed: file.removed, substantive: file.substantive })) };
    case "plan_item": return {
      kind: "plan_item", itemId: opaqueKey(event.itemId), treeId: opaqueKey(event.treeId), planFiles: event.planFiles.map((file) => safeText(file, secrets)),
      files: event.files.map((file) => ({ file: safeText(file.file, secrets), added: file.added, removed: file.removed, substantive: file.substantive })),
    };
    case "fix_test_cycle": return { kind: "fix_test_cycle", failureKey: opaqueKey(event.failureKey) };
    case "process": return { kind: "process", processId: opaqueKey(event.processId), ownership: event.ownership, liveness: event.liveness, cpuMs: event.cpuMs, lastOutputAt: event.lastOutputAt };
    case "sample": return { kind: "sample" };
  }
}

export class ProgressWatch {
  readonly config: WatchConfig;
  readonly thresholds: WatchThresholds;
  private readonly states = new Map<string, SourceState>();
  private readonly builder: WatchSource;
  private readonly heldSecrets: readonly string[];
  private operations: WatchOperation[] = [];
  private revision = 0;
  private lastStrongRevision: number | null = null;
  private lastEvent: WatchStatus["lastEvent"] = null;
  private files: DiffSize[] = [];
  private pending: Pending | null = null;
  private judgment: Judgment | null = null;
  private nudge: Nudge | null = null;
  private outcomes: WatchStatus["nudgeOutcomes"] = [];

  constructor(config: WatchConfig, heldSecrets: readonly string[] = []) {
    this.thresholds = validateConfig(config);
    assertSafeRecord(config, heldSecrets);
    this.config = clone(config);
    this.heldSecrets = heldSecrets;
    this.builder = this.config.sources.find((source) => source.role === "builder")!;
    for (const source of config.sources) this.states.set(source.id, emptySource());
  }

  static restore(config: WatchConfig, snapshot: WatchSnapshot, heldSecrets: readonly string[] = []): ProgressWatch {
    if (snapshot.version !== 1 || !same(config, snapshot.config) || !Array.isArray(snapshot.operations)) throw new Error("Watch checkpoint does not match the current job and sources.");
    const watch = new ProgressWatch(config, heldSecrets);
    for (const operation of snapshot.operations) {
      switch (operation.kind) {
        case "observe":
          if (!watch.observe(operation.observation, operation.now).accepted) throw new Error("Invalid observation checkpoint.");
          break;
        case "request": watch.requestJudgment(operation.now, operation.controls, operation.context, operation.route); break;
        case "judge": watch.acceptJudgment(operation.result, operation.now); break;
        case "nudge": watch.recordNudge(operation.deliveryId, operation.now, operation.controls); break;
        default: throw new Error("Invalid watch checkpoint operation.");
      }
    }
    return watch;
  }

  snapshot(): WatchSnapshot {
    const snapshot = clone({ version: 1 as const, config: this.config, operations: this.operations });
    assertSafeRecord(snapshot, this.heldSecrets);
    return snapshot;
  }

  observe(observation: WatchObservation, now: number): { accepted: boolean; reason: string; progress: "strong" | "weak" | "none" } {
    const reject = (reason: string) => ({ accepted: false, reason, progress: "none" as const });
    if (!whole(now) || !whole(observation.observedAt) || observation.observedAt > now || now - observation.observedAt > this.config.telemetryMaxAgeMs) return reject("unknown_or_stale_time");
    if (!same(observation.identity, this.config.identity)) return reject("different_job_or_evidence");
    const source = this.config.sources.find((candidate) => same(candidate, observation.source));
    if (!source) return reject("unattributed_source");
    const state = this.states.get(source.id)!;
    if (!textId(observation.id) || state.seenIds.has(observation.id)) return reject("duplicate_or_missing_id");
    assertSafeRecord(observation.id, this.heldSecrets);
    if (!whole(observation.sequence) || observation.sequence <= state.sequence || (state.at !== null && observation.observedAt < state.at)
      || (this.lastEvent !== null && observation.observedAt < this.lastEvent.observedAt)
      || (this.nudge !== null && observation.observedAt < this.nudge.observedAt)) return reject("out_of_order");
    validateEvent(observation.event, observation.observedAt);
    for (const name of COUNTERS) {
      const value = observation.counters[name];
      if (value != null && (!whole(value) || !source.counters[name] || (state.counters[name].highest !== null && value < state.counters[name].highest!))) return reject("unsupported_or_regressed_counter");
    }
    state.sequence = observation.sequence;
    state.at = observation.observedAt;
    state.seenIds.add(observation.id);
    for (const name of COUNTERS) {
      const counter = state.counters[name];
      counter.value = source.counters[name] ? observation.counters[name] ?? null : null;
      if (counter.value !== null) counter.highest = counter.value;
      if (counter.strong === null) counter.strong = counter.value;
      if (counter.weak === null) counter.weak = counter.value;
    }
    const event = projectEvent(observation.event, this.heldSecrets);
    if (event.kind !== "process" && event.kind !== "sample") state.process = null;
    if (this.nudge && source.role === "builder" && this.nudge.turns === null && observation.observedAt >= this.nudge.observedAt) {
      this.nudge.turns = state.counters.turns.value;
    }
    let progress: "strong" | "weak" | "none" = "none";
    if (event.kind === "action") {
      const last = state.pattern.exact > 0 ? state.actions.at(-1)?.action : undefined;
      const previous = state.pattern.alternating >= 2 ? state.actions.at(-2)?.action : undefined;
      state.pattern.exact = last && sameAction(last, event) ? state.pattern.exact + 1 : 1;
      state.pattern.error = event.errorKey ? last?.name === event.name && last.errorKey === event.errorKey ? state.pattern.error + 1 : 1 : 0;
      state.pattern.alternating = last && !sameAction(last, event) ? previous && sameAction(previous, event) ? state.pattern.alternating + 1 : 2 : 1;
      state.actions.push({ id: observation.id, action: event });
      state.actionCount += 1;
      if (state.actions.length > 20) state.actions.shift();
    } else if (event.kind === "check") {
      const before = state.checks.get(event.checkId);
      if (before && (event.passing > before.passing || (before.failureKey !== null && event.passed === true)
        || (before.failureKey !== null && event.failureKey !== before.failureKey && (event.debuggingAdvanceEvidenceIds?.length ?? 0) > 0))) progress = "strong";
      state.checks.set(event.checkId, { passing: event.passing, failureKey: event.failureKey });
    } else if (event.kind === "tree" || event.kind === "plan_item") {
      const substantive = event.files.some((file) => file.substantive && file.added + file.removed > 0);
      if (substantive) {
        if (!state.trees.has(event.treeId)) progress = "weak";
        else if (event.treeId !== state.lastTree) state.returnedTree = true;
        if (event.kind === "plan_item" && !state.completed.has(event.itemId)
          && event.files.some((file) => file.substantive && file.added + file.removed > 0 && event.planFiles.includes(file.file))) {
          progress = "strong";
          state.completed.add(event.itemId);
        }
        state.trees.add(event.treeId);
        state.lastTree = event.treeId;
      }
      if (source.role === "builder") this.files = event.files;
    } else if (event.kind === "fix_test_cycle") {
      state.cycles = { key: event.failureKey, count: state.cycles?.key === event.failureKey ? state.cycles.count + 1 : 1 };
    } else if (event.kind === "process") {
      const previous = state.process;
      if (event.ownership === "confirmed" && event.liveness === "running" && event.cpuMs !== null && event.lastOutputAt !== null) {
        const unchanged = previous?.id === event.processId && event.cpuMs === previous.cpuMs && event.lastOutputAt === previous.outputAt;
        state.process = { id: event.processId, cpuMs: event.cpuMs, outputAt: event.lastOutputAt, idleSince: unchanged ? previous.idleSince : observation.observedAt, at: observation.observedAt };
      } else state.process = null;
    }
    this.revision += 1;
    this.lastEvent = { sourceId: source.id, id: observation.id, observedAt: observation.observedAt };
    if (progress === "strong") this.strongProgress(source, state, now);
    else if (progress === "weak") {
      for (const name of COUNTERS) state.counters[name].weak = state.counters[name].value;
      state.pattern = { exact: 0, error: 0, alternating: 0 };
    }
    this.operations.push({ kind: "observe", observation: clone({
      identity: this.config.identity, source, id: observation.id, sequence: observation.sequence, observedAt: observation.observedAt,
      counters: Object.fromEntries(COUNTERS.filter((name) => observation.counters[name] !== undefined).map((name) => [name, observation.counters[name]])), event,
    }), now });
    return { accepted: true, reason: "observed", progress };
  }

  private strongProgress(source: WatchSource, state: SourceState, now: number): void {
    this.lastStrongRevision = this.revision;
    for (const name of COUNTERS) {
      state.counters[name].strong = state.counters[name].value;
      state.counters[name].weak = state.counters[name].value;
    }
    state.actions = [];
    state.actionCount = 0;
    state.pattern = { exact: 0, error: 0, alternating: 0 };
    state.returnedTree = false;
    state.cycles = null;
    state.process = null;
    // Observed helper progress protects owned work without adding helper turns to the builder.
    this.judgment = null;
    this.pending = null;
    if (this.nudge) {
      const turns = source.role === "builder" && this.fresh(this.builder, now) ? this.delta(this.builder, "turns", this.nudge.turns) : null;
      this.outcomes.push({ deliveryId: this.nudge.deliveryId, progressWithinTenTurns: turns === null ? null : turns <= 10 });
      this.nudge = null;
    }
    if (source.role === "helper") {
      const builder = this.states.get(this.builder.id)!;
      for (const name of COUNTERS) {
        builder.counters[name].strong = null;
        builder.counters[name].weak = null;
      }
      builder.actions = [];
      builder.actionCount = 0;
      builder.pattern = { exact: 0, error: 0, alternating: 0 };
      builder.returnedTree = false;
      builder.cycles = null;
      builder.process = null;
    }
  }

  private fresh(source: WatchSource, now: number): boolean {
    const at = this.states.get(source.id)!.at;
    return at !== null && now >= at && now - at <= this.config.telemetryMaxAgeMs;
  }

  private delta(source: WatchSource, name: CounterName, baseline: number | null): number | null {
    const value = this.states.get(source.id)!.counters[name].value;
    return baseline === null || value === null ? null : Math.max(0, value - baseline);
  }

  status(now: number): WatchStatus {
    if (!whole(now)) throw new Error("Invalid observation time.");
    const missing: string[] = [];
    const sources = this.config.sources.map((source) => {
      const state = this.states.get(source.id)!;
      const fresh = this.fresh(source, now);
      if (!fresh) missing.push(`${source.id}:freshness`);
      const sinceStrong = { turns: null, tokens: null, compactions: null } as Record<CounterName, number | null>;
      for (const name of COUNTERS) {
        sinceStrong[name] = fresh ? this.delta(source, name, state.counters[name].strong) : null;
        if (sinceStrong[name] === null) missing.push(`${source.id}:${name}`);
      }
      return { sourceId: source.id, role: source.role, fresh, sinceStrong, actionCount: state.actionCount };
    });
    const nudgeTurns = this.nudge && this.fresh(this.builder, now) ? this.delta(this.builder, "turns", this.nudge.turns) : null;
    return clone({
      revision: this.revision, lastEvent: this.lastEvent, sources, missing, signals: this.signals(now),
      nudge: this.nudge ? { deliveryId: this.nudge.deliveryId, observedAt: this.nudge.observedAt, furtherTurns: nudgeTurns } : null,
      nudgeOutcomes: this.nudge ? [...this.outcomes, {
        deliveryId: this.nudge.deliveryId, progressWithinTenTurns: nudgeTurns !== null && nudgeTurns > 10 ? false : null,
      }] : this.outcomes,
    });
  }

  private signals(now: number): WatchSignal[] {
    const signals: WatchSignal[] = [];
    for (const source of this.config.sources) {
      if (!this.fresh(source, now)) continue;
      const state = this.states.get(source.id)!;
      const actions = state.actions;
      const last = actions.at(-1);
      const add = (kind: string, count: number, ids: string[] = []) => signals.push({ kind, sourceId: source.id, count, actionIds: ids });
      if (last) {
        const { exact, error, alternating } = state.pattern;
        if (exact >= Math.max(1, this.thresholds.identicalActions)) add("identical_actions", exact, actions.slice(-exact).map((action) => action.id));
        if (error >= Math.max(1, this.thresholds.identicalErrors)) add("identical_errors", error, actions.slice(-error).map((action) => action.id));
        if (actions.length >= 2 && !sameAction(actions.at(-1)!.action, actions.at(-2)!.action)
          && alternating >= Math.max(2, this.thresholds.pingPongActions)) add("ping_pong", alternating, actions.slice(-alternating).map((action) => action.id));
      }
      if (state.returnedTree) add("earlier_tree", 1);
      if (state.cycles && state.cycles.count >= 2) add("same_failure_cycles", state.cycles.count);
      const compactions = this.delta(source, "compactions", state.counters.compactions.strong);
      if (compactions !== null && compactions > 0 && compactions >= this.thresholds.compactions) add("compactions", compactions);
      if (state.process && now - state.process.at <= this.config.telemetryMaxAgeMs
        && state.process.at - state.process.idleSince >= this.thresholds.idleMs && state.process.at > state.process.idleSince) add("no_output_or_cpu", state.process.at - state.process.idleSince);
    }
    return signals;
  }

  private controlsMatch(controls: WatchControls): boolean {
    return same(controls.identity, this.config.identity) && controls.sourceId === this.builder.id
      && controls.sessionId === this.builder.sessionId && controls.vendor === this.builder.vendor && controls.interfaceId === this.builder.interfaceId;
  }

  private controlsQualified(controls: WatchControls): boolean {
    return controls.evidenceIds.length > 0 && controls.evidenceIds.every(textId);
  }

  decide(now: number, controls: WatchControls): WatchDecision {
    const status = this.status(now);
    const decide = (kind: WatchDecision["kind"], reason: string): WatchDecision => ({ kind, reason, status });
    if (!this.controlsMatch(controls)) return decide("continue", "unqualified_control_identity");
    if (controls.nativeHeld) return decide("continue", "native_approval_or_signin_wait");
    if (!this.fresh(this.builder, now)) return decide("continue", "unknown_builder_telemetry");
    if (this.lastStrongRevision === this.revision) return decide("continue", "observed_strong_progress");
    if (this.pending?.packet.revision === this.revision && now >= this.pending.at) return decide("continue", "judgment_pending");
    const builder = this.states.get(this.builder.id)!;
    if (this.nudge) {
      const further = this.delta(this.builder, "turns", this.nudge.turns);
      if (further === null || further < this.thresholds.furtherTurns) return decide("continue", "await_observed_further_turns");
      if (this.judgment?.revision === this.revision && this.judgment.route.tier === "stronger"
        && isStuck(this.judgment.result.verdict) && this.judgment.result.confidence >= this.thresholds.confirmationConfidence) {
        if (!this.controlsQualified(controls) || controls.safeReconcile !== "qualified" || controls.ownership !== "confirmed" || controls.liveness !== "running") return decide("preserved_work_blocker", "safe_reconcile_control_unavailable");
        return decide("safe_reconcile_requested", "confirmed_after_observed_nudge_turns");
      }
      if (this.judgment?.revision === this.revision && ["progressing", "unsure"].includes(this.judgment.result.verdict)) return decide("continue", this.judgment.result.verdict);
      return decide("confirmation_needed", "further_turns_without_strong_progress");
    }
    const judgment = this.judgment?.revision === this.revision ? this.judgment : null;
    if (judgment && ["progressing", "unsure"].includes(judgment.result.verdict)) return decide("continue", judgment.result.verdict);
    const exact = status.signals.some((signal) => signal.sourceId === this.builder.id && signal.kind === "identical_actions");
    if (exact || (judgment && isStuck(judgment.result.verdict) && judgment.result.confidence >= this.thresholds.nudgeConfidence)) {
      if (!this.controlsQualified(controls) || controls.input !== "qualified") return decide("preserved_work_blocker", "in_place_input_unavailable");
      return { ...decide("nudge_eligible", exact ? "observed_exact_repetition" : "calibrated_stuck_judgment"), nudgeText: "Check the repeated approach against the plan and observed results. Try a different approach if it is not advancing the work." };
    }
    const turns = this.delta(this.builder, "turns", builder.counters.turns.weak);
    const tokens = this.delta(this.builder, "tokens", builder.counters.tokens.weak);
    const sinceStrong = this.delta(this.builder, "turns", builder.counters.turns.strong);
    const lastJudge = this.judgment;
    let interval = this.thresholds.judgeTurns;
    if (sinceStrong !== null && sinceStrong >= this.thresholds.frequentAfterTurns) {
      interval = lastJudge?.result.verdict === "unsure" ? this.thresholds.unsureEveryTurns
        : lastJudge && lastJudge.result.confidence >= this.thresholds.nudgeConfidence ? this.thresholds.confidentEveryTurns : this.thresholds.judgeEveryTurns;
    }
    const turnsSinceJudge = lastJudge ? this.delta(this.builder, "turns", lastJudge.turns) : turns;
    const tokensSinceJudge = lastJudge ? this.delta(this.builder, "tokens", lastJudge.tokens) : tokens;
    const turnDue = turns !== null && turns >= this.thresholds.judgeTurns && turnsSinceJudge !== null && turnsSinceJudge >= interval;
    const tokenDue = tokens !== null && tokens >= this.thresholds.judgeTokens && tokensSinceJudge !== null && tokensSinceJudge >= this.thresholds.judgeTokens;
    if (turnDue || tokenDue || (status.signals.some((signal) => signal.sourceId === this.builder.id) && !lastJudge)) return decide("judge_needed", "observed_watch_signals");
    return decide("continue", "no_qualified_intervention");
  }

  requestJudgment(now: number, controls: WatchControls, context: { title: string; plan: JudgePacket["plan"] }, route: JudgeRoute): JudgePacket {
    if (!whole(now)) throw new Error("Invalid observation time.");
    if (this.pending?.packet.revision === this.revision && this.fresh(this.builder, now) && now >= this.pending.at
      && this.controlsMatch(controls) && !controls.nativeHeld) {
      if (!same(route, this.pending.route)) throw new Error("A judgment is already pending.");
      return clone(this.pending.packet);
    }
    const decision = this.decide(now, controls);
    const expectedTier = decision.kind === "confirmation_needed" ? "stronger" : "cheap";
    if (!["judge_needed", "confirmation_needed"].includes(decision.kind) || route.tier !== expectedTier) throw new Error("No judgment is eligible.");
    if (!route.eligible.length || !route.eligible.every((model) => textId(model.vendor) && textId(model.model))
      || !textId(route.requested.vendor) || !textId(route.requested.model)
      || !route.eligible.some((model) => same(model, route.requested))
      || !route.calibrationEvidenceIds.length || !route.calibrationEvidenceIds.every(textId)
      || (route.tier === "stronger" && (!route.strongerQualificationEvidenceIds.length || !route.strongerQualificationEvidenceIds.every(textId)))) throw new Error("Missing eligible routing or calibration evidence.");
    assertSafeRecord(controls, this.heldSecrets);
    assertSafeRecord(route, this.heldSecrets);
    const state = this.states.get(this.builder.id)!;
    const packet: JudgePacket = {
      packetId: `${this.config.identity.runId}:${this.config.identity.evidenceVersion}:${this.revision}:${this.operations.length}`,
      identity: clone(this.config.identity), revision: this.revision,
      title: safeText(context.title, this.heldSecrets),
      plan: context.plan.map((item) => ({ id: safeText(item.id, this.heldSecrets), text: safeText(item.text, this.heldSecrets), completed: item.completed === true })),
      actions: state.actions.slice(-20).map(({ id, action }) => ({ id: safeText(id, this.heldSecrets), sourceId: safeText(this.builder.id, this.heldSecrets), name: safeText(action.name, this.heldSecrets), outcome: safeText(action.shortOutcome, this.heldSecrets) })),
      signals: {
        sources: decision.status.sources, missing: decision.status.missing, signals: decision.status.signals, lastEvent: decision.status.lastEvent,
      },
      files: this.files.map((file) => ({ file: safeText(file.file, this.heldSecrets), added: file.added, removed: file.removed })),
    };
    this.pending = { packet: clone(packet), route: clone(route), at: now };
    // Only the projected context is retained; extra maker or checker fields cannot enter a checkpoint.
    this.operations.push({ kind: "request", now, controls: clone(controls), context: { title: packet.title, plan: clone(packet.plan) }, route: clone(route) });
    return packet;
  }

  acceptJudgment(result: JudgeResult, now: number): JudgeResult {
    const pending = this.pending;
    if (!pending || !same(result.identity, this.config.identity) || result.packetId !== pending.packet.packetId
      || pending.packet.revision !== this.revision || !this.fresh(this.builder, now) || now < pending.at) throw new Error("Stale or foreign judgment.");
    if (!["progressing", "stalled", "looping", "off_scope", "unsure"].includes(result.verdict) || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1
      || !pending.route.eligible.some((model) => same(model, result.observed))
      || !result.actionIds.every((id) => pending.packet.actions.some((action) => action.id === id))
      || (isStuck(result.verdict) && pending.packet.actions.length > 0 && result.actionIds.length === 0)) throw new Error("Unqualified judgment evidence.");
    const sanitized: JudgeResult = {
      packetId: result.packetId, identity: clone(this.config.identity), observed: clone(result.observed), verdict: result.verdict,
      confidence: result.confidence, actionIds: [...result.actionIds], diagnosis: diagnosisText(result.diagnosis, this.heldSecrets),
    };
    const state = this.states.get(this.builder.id)!;
    this.judgment = { result: sanitized, route: pending.route, revision: this.revision, turns: state.counters.turns.value, tokens: state.counters.tokens.value };
    this.pending = null;
    this.operations.push({ kind: "judge", result: clone(sanitized), now });
    return clone(sanitized);
  }

  recordNudge(deliveryId: string, now: number, controls: WatchControls): void {
    if (!textId(deliveryId) || this.operations.some((operation) => operation.kind === "nudge" && operation.deliveryId === deliveryId)
      || this.decide(now, controls).kind !== "nudge_eligible") throw new Error("No observed in-place nudge can be recorded.");
    assertSafeRecord(deliveryId, this.heldSecrets);
    assertSafeRecord(controls, this.heldSecrets);
    const state = this.states.get(this.builder.id)!;
    this.nudge = { deliveryId, observedAt: now, turns: state.at === now ? state.counters.turns.value : null };
    this.judgment = null;
    this.pending = null;
    this.operations.push({ kind: "nudge", deliveryId, now, controls: clone(controls) });
  }
}

type SessionStart = { id: string; repoId: string; ticketId: string; observedAt: number };
type SessionGuardConfig = { repoId: string; ticketStarts24h?: number; repoHourlyMultiplier?: number };
type StartCheck = { ticketId: string; now: number; usualHourlyStarts: { value: number; evidenceId: string } | null };
type GuardOperation =
  | { kind: "start"; start: SessionStart }
  | { kind: "check"; check: StartCheck }
  | { kind: "recover"; actor: "human"; scope: "repo" | "ticket"; ticketId: string | null; evidenceId: string };
export type SessionGuardSnapshot = { version: 1; config: SessionGuardConfig; operations: GuardOperation[] };

export class SessionStartGuard {
  private readonly config: SessionGuardConfig;
  private readonly starts: SessionStart[] = [];
  private readonly heldTickets = new Set<string>();
  private repoHeld = false;
  private operations: GuardOperation[] = [];

  constructor(config: SessionGuardConfig) {
    if (!textId(config.repoId) || !whole(config.ticketStarts24h ?? 20) || !whole(config.repoHourlyMultiplier ?? 5)) throw new Error("Invalid session guard configuration.");
    assertSafeRecord(config, []);
    this.config = clone(config);
  }

  static restore(config: SessionGuardConfig, snapshot: SessionGuardSnapshot): SessionStartGuard {
    if (snapshot.version !== 1 || !same(config, snapshot.config) || !Array.isArray(snapshot.operations)) throw new Error("Session guard checkpoint does not match this repo.");
    const guard = new SessionStartGuard(config);
    for (const operation of snapshot.operations) {
      switch (operation.kind) {
        case "start": guard.observeStart(operation.start); break;
        case "check": guard.checkStart(operation.check); break;
        case "recover": guard.recover(operation); break;
        default: throw new Error("Invalid session guard checkpoint operation.");
      }
    }
    return guard;
  }

  snapshot(): SessionGuardSnapshot { return clone({ version: 1, config: this.config, operations: this.operations }); }

  observeStart(start: SessionStart): void {
    if (!textId(start.id) || !textId(start.ticketId) || start.repoId !== this.config.repoId || !whole(start.observedAt)) throw new Error("Unattributed session start.");
    assertSafeRecord(start, []);
    const previous = this.starts.find((candidate) => candidate.id === start.id);
    if (previous) {
      if (!same(previous, start)) throw new Error("Conflicting session start identity.");
      return;
    }
    this.starts.push(clone(start));
    this.operations.push({ kind: "start", start: clone(start) });
  }

  checkStart(check: StartCheck): { allowed: boolean; ongoingWork: "preserve"; reason: string; ticketStarts24h: number; repoStartsHour: number; hourlyBaseline: number | null; recovery: "explicit_human" | null } {
    if (!textId(check.ticketId) || !whole(check.now)
      || (check.usualHourlyStarts !== null && (!Number.isFinite(check.usualHourlyStarts.value) || check.usualHourlyStarts.value < 0 || !textId(check.usualHourlyStarts.evidenceId)))) throw new Error("Invalid session start evidence.");
    assertSafeRecord(check, []);
    const recent = this.starts.filter((start) => start.observedAt <= check.now && check.now - start.observedAt < 86_400_000);
    const ticketStarts24h = recent.filter((start) => start.ticketId === check.ticketId).length;
    const repoStartsHour = recent.filter((start) => check.now - start.observedAt < 3_600_000).length;
    const baseline = check.usualHourlyStarts?.value ?? null;
    if (ticketStarts24h + 1 > (this.config.ticketStarts24h ?? 20)) this.heldTickets.add(check.ticketId);
    // Zero has no usable ratio; a missing or zero measured baseline stays unknown.
    if (baseline !== null && baseline > 0 && repoStartsHour + 1 > baseline * (this.config.repoHourlyMultiplier ?? 5)) this.repoHeld = true;
    const allowed = !this.repoHeld && !this.heldTickets.has(check.ticketId);
    this.operations.push({ kind: "check", check: clone(check) });
    return {
      allowed, ongoingWork: "preserve", reason: this.repoHeld ? "repo_session_start_protection" : this.heldTickets.has(check.ticketId) ? "ticket_session_start_protection" : "within_observed_start_policy",
      ticketStarts24h, repoStartsHour, hourlyBaseline: baseline === 0 ? null : baseline, recovery: allowed ? null : "explicit_human",
    };
  }

  recover(recovery: { actor: "human"; scope: "repo" | "ticket"; ticketId: string | null; evidenceId: string }): void {
    if (recovery.actor !== "human" || !textId(recovery.evidenceId)
      || (recovery.scope === "ticket" ? !textId(recovery.ticketId) : recovery.scope !== "repo" || recovery.ticketId !== null)) throw new Error("Explicit human recovery is required.");
    assertSafeRecord(recovery, []);
    if (recovery.scope === "repo") this.repoHeld = false;
    else this.heldTickets.delete(recovery.ticketId!);
    this.operations.push({ kind: "recover", ...clone(recovery) });
  }
}
