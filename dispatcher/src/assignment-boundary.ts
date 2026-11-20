import { assertPrivateDirectory } from "./fs-safety.ts";
import { assignmentDirectory, directoriesOverlap, directoryBirthTime, type DirectoryIdentity } from "./directory-identity.ts";
import { currentProcessOwner, processOwnerAlive, type ProcessOwner } from "./process-identity.ts";
import { safeNativeText } from "./adapters/native-result.ts";
import { completeAssignment, journalDigest, reserveAssignment, startAssignment, type Intent } from "./assignment-journal.ts";
import type { WindowsOwnedNativeProcess } from "./native-transport.ts";
import { bindOwnedWorkspaceClaim, releaseOwnedWorkspaceClaim, startOwnedWorkspaceClaim } from "./workspace.ts";

export type AssignmentBinding = {
  board: string; repo: string; activation: string; connection: string; job: string;
  claim: string; requirements: string; candidate: string; policy: string; fence: number;
};
export type AssignmentRequest = {
  version: 1; id: string; sequence: number; operation: "native.assign"; input: string; binding: AssignmentBinding;
};
export type CurrentAssignment = {
  binding: AssignmentBinding; nextSequence: number; authorized: boolean; seat: "owner" | "full" | "member" | "viewer";
  confirmedWorkspace: string; writersContained: boolean;
};
export type AssignmentTerminal = { id: string; sequence: number; result: "completed" | "failed"; writersContained: true };
export type AssignmentAdapter = {
  kind: "fabricated-harness";
  readCurrent(): Promise<CurrentAssignment>;
  execute(input: { id: string; sequence: number; input: string; workspace: string }): Promise<AssignmentTerminal>;
  reconcile(input: { id: string; sequence: number; requestDigest: string }): Promise<AssignmentTerminal | null>;
};
type PreparedOwnedAssignment = {
  original: Pick<WindowsOwnedNativeProcess, "observeOriginalGroup">;
  execute: AssignmentAdapter["execute"];
  close(): Promise<void>;
};
export type AssignmentInput = {
  stateDir: string; raw: string; secrets: readonly string[]; now(): number; adapter: AssignmentAdapter;
  owned?: { prepare(input: { intent: Intent; workspace: string }): Promise<PreparedOwnedAssignment | null> };
};
export type AssignmentResult = { state: "completed" | "failed" | "not-started" | "held" | "refused"; qualification: "unqualified-harness"; publishable: false };

const BINDING = ["board", "repo", "activation", "connection", "job", "claim", "requirements", "candidate", "policy", "fence"];
const active = new Set<string>();
const disposalHeld = new Set<string>();
const outcome = (state: AssignmentResult["state"]): AssignmentResult => ({ state, qualification: "unqualified-harness", publishable: false });
const opaque = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const whole = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function binding(value: unknown): value is AssignmentBinding {
  return exact(value, BINDING) && BINDING.every((key) => key === "fence" ? whole(value[key], 1) : opaque(value[key]));
}
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function unambiguous(raw: string): boolean {
  const stack: Array<{ object: boolean; keys: Set<string>; key: boolean }> = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') {
      const begin = i++;
      while (i < raw.length && raw[i] !== '"') { if (raw[i] === "\\") i++; i++; }
      const frame = stack.at(-1);
      if (frame?.object && frame.key) {
        const key: string = JSON.parse(raw.slice(begin, i + 1));
        if (frame.keys.has(key)) return false;
        frame.keys.add(key); frame.key = false;
      }
    } else if (char === "{" || char === "[") {
      stack.push({ object: char === "{", keys: new Set(), key: char === "{" });
      if (stack.length > 4) return false;
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && stack.at(-1)?.object) stack.at(-1)!.key = true;
  }
  return true;
}

function decode(raw: string, secrets: readonly string[]): AssignmentRequest | null {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 32768 || !unambiguous(raw)) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!exact(parsed, ["version", "id", "sequence", "operation", "input", "binding"]) || parsed.version !== 1
      || !opaque(parsed.id) || !whole(parsed.sequence, 1) || parsed.operation !== "native.assign" || !binding(parsed.binding)
      || typeof parsed.input !== "string" || Buffer.byteLength(parsed.input) > 16384 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(parsed.input)) return null;
    for (const value of [...Object.values(parsed), ...Object.values(parsed.binding)].filter((value): value is string => typeof value === "string")) {
      let decoded = value;
      for (let depth = 0; ; depth++) {
        if (safeNativeText(decoded, secrets) !== decoded) return null;
        const next = decoded.replace(/(?:%[a-f0-9]{2})+/gi, (bytes) => Buffer.from(bytes.replaceAll("%", ""), "hex").toString("utf8"));
        if (next === decoded) break;
        if (depth === 8) return null;
        decoded = next;
      }
    }
    return parsed as AssignmentRequest;
  } catch { return null; }
}

async function current(input: AssignmentInput, request: AssignmentRequest, stateDir: DirectoryIdentity, directory = assignmentDirectory): Promise<DirectoryIdentity | null> {
  const value: unknown = structuredClone(await input.adapter.readCurrent());
  if (!exact(value, ["binding", "nextSequence", "authorized", "seat", "confirmedWorkspace", "writersContained"])
    || value.authorized !== true || !["owner", "full", "member"].includes(value.seat as string)
    || value.writersContained !== true || !binding(value.binding) || canonical(value.binding) !== canonical(request.binding)
    || value.nextSequence !== request.sequence || typeof value.confirmedWorkspace !== "string") return null;
  const workspace = directory(value.confirmedWorkspace);
  return directoriesOverlap(stateDir, workspace) ? null : workspace;
}
function terminal(value: unknown, request: AssignmentRequest): value is AssignmentTerminal {
  return exact(value, ["id", "sequence", "result", "writersContained"]) && value.id === request.id && value.sequence === request.sequence
    && (value.result === "completed" || value.result === "failed") && value.writersContained === true;
}
const ownerAlive = (owner: ProcessOwner) => processOwnerAlive(owner, true);

export async function runAssignment(input: AssignmentInput, directory = assignmentDirectory): Promise<AssignmentResult> {
  const request = decode(input.raw, input.secrets);
  if (!request || input.adapter.kind !== "fabricated-harness") return outcome("refused");
  const locks: string[] = [];
  let workspaceKeys: string[] = [];
  let unstarted: { stateDir: string; intent: Intent } | null = null;
  let staged = false;
  let executePrepared: PreparedOwnedAssignment["execute"] | undefined;
  let closePrepared: PreparedOwnedAssignment["close"] | undefined;
  let stateIsCurrent: (() => boolean) | undefined;
  try {
    const optedIn = "owned" in input;
    const port = optedIn ? input.owned : undefined;
    const prepare = port?.prepare.bind(port);
    const state = directory(input.stateDir);
    const stateDir = state.path;
    assertPrivateDirectory(stateDir);
    if (optedIn) {
      const birth = directoryBirthTime(state);
      stateIsCurrent = () => directoryBirthTime(state) === birth;
    }
    const workspace = await current(input, request, state, directory);
    if (workspace === null) return outcome("held");
    workspaceKeys = ["path:" + workspace.path, "file:" + workspace.identity];
    const keys = workspaceKeys.map(key => state.identity + ":" + key);
    if (workspaceKeys.some(key => disposalHeld.has(key)) || keys.some(key => active.has(key))) return outcome("held");
    for (const key of keys) { active.add(key); locks.push(key); }
    const at = input.now();
    if (!whole(at, 0)) return outcome("held");
    const intent: Intent = {
      version: 4, kind: "intent", id: request.id, sequence: request.sequence, requestDigest: journalDigest(canonical(request)),
      bindingDigest: journalDigest(canonical(request.binding)), workspaceDigest: journalDigest(workspace.path), aliasDigest: journalDigest(workspace.identity),
      scopeDigest: journalDigest(canonical({ board: request.binding.board, repo: request.binding.repo, connection: request.binding.connection })), at, ...currentProcessOwner(),
    };
    const reserved = reserveAssignment(stateDir, intent, journalDigest(workspace.legacyPath), ownerAlive, stateIsCurrent);
    if (reserved.state === "new") unstarted = { stateDir, intent };
    if ((await current(input, request, state, directory))?.identity !== workspace.identity) throw new Error("Assignment authority changed.");
    if (reserved.state === "completed" || reserved.state === "failed" || reserved.state === "not-started") return outcome(reserved.state);
    if (reserved.state === "pending" && ownerAlive(reserved.intent)) return outcome("held");
    let ownedClaim: object | null = null;
    if (reserved.state === "new") {
      if (optedIn) {
        const prepared = await prepare?.({ intent: structuredClone(intent), workspace: workspace.path });
        if (!prepared) throw new Error("Owned assignment preparation is unavailable.");
        staged = true;
        closePrepared = prepared.close.bind(prepared);
        executePrepared = prepared.execute.bind(prepared);
        ownedClaim = bindOwnedWorkspaceClaim(stateDir, intent, prepared.original, stateIsCurrent);
        if (!ownedClaim || (await current(input, request, state, directory))?.identity !== workspace.identity) {
          throw new Error("Assignment authority changed.");
        }
        startOwnedWorkspaceClaim(ownedClaim, input.now());
      } else {
        startAssignment(stateDir, intent, input.now());
      }
    }
    unstarted = null;
    // An intent surviving its controller is uncertain at every age; only read-only evidence can resolve it.
    const execution = { id: request.id, sequence: request.sequence, input: request.input, workspace: workspace.path };
    const observed: unknown = structuredClone(reserved.state === "pending"
      ? await input.adapter.reconcile({ id: request.id, sequence: request.sequence, requestDigest: reserved.intent.requestDigest })
      : optedIn ? await executePrepared?.(execution) : await input.adapter.execute(execution));
    if (!terminal(observed, request) || (await current(input, request, state, directory))?.identity !== workspace.identity) return outcome("held");
    completeAssignment(stateDir, reserved.intent, observed.result, input.now(), stateIsCurrent);
    if (ownedClaim) await releaseOwnedWorkspaceClaim(ownedClaim);
    return outcome(observed.result);
  } catch {
    if (unstarted) {
      try {
        completeAssignment(unstarted.stateDir, unstarted.intent, "not-started", input.now(), stateIsCurrent);
        return outcome("not-started");
      } catch { /* Storage failure preserves uncertainty until durable evidence can be read. */ }
    }
    return outcome("held");
  }
  finally {
    if (staged) {
      try {
        if (!closePrepared) throw new Error("Owned assignment disposal is unavailable.");
        await closePrepared();
      } catch {
        // A replacement state directory cannot clear a fence on the outstanding workspace writer.
        for (const key of workspaceKeys) disposalHeld.add(key);
        return outcome("held");
      }
    }
    for (const key of locks) active.delete(key);
  }
}
