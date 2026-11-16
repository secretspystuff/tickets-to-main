import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertPrivateDirectory } from "./fs-safety.ts";
import { safeNativeText } from "./adapters/native-result.ts";
import { unfold } from "./secret-text.ts";
import { completeAssignment, journalDigest, reserveAssignment, type Intent } from "./assignment-journal.ts";

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
export type AssignmentInput = { stateDir: string; raw: string; secrets: readonly string[]; now(): number; adapter: AssignmentAdapter };
export type AssignmentResult = { state: "completed" | "failed" | "held" | "refused"; qualification: "unqualified-harness"; publishable: false };

const BINDING = ["board", "repo", "activation", "connection", "job", "claim", "requirements", "candidate", "policy", "fence"];
const active = new Set<string>();
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
    const decoded = unfold(canonical(parsed));
    if (decoded === null || safeNativeText(decoded, secrets) !== decoded) return null;
    return parsed as AssignmentRequest;
  } catch { return null; }
}

function directory(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) throw new Error("Workspace unavailable.");
  let parent = resolve(path);
  for (;;) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Workspace unavailable.");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return realpathSync(path);
}
function within(parent: string, child: string): boolean {
  const delta = relative(parent, child);
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(".." + sep));
}

async function current(input: AssignmentInput, request: AssignmentRequest, stateDir: string): Promise<string | null> {
  const value: unknown = structuredClone(await input.adapter.readCurrent());
  if (!exact(value, ["binding", "nextSequence", "authorized", "seat", "confirmedWorkspace", "writersContained"])
    || value.authorized !== true || !["owner", "full", "member"].includes(value.seat as string)
    || value.writersContained !== true || !binding(value.binding) || canonical(value.binding) !== canonical(request.binding)
    || value.nextSequence !== request.sequence || typeof value.confirmedWorkspace !== "string") return null;
  const workspace = directory(value.confirmedWorkspace);
  return within(stateDir, workspace) || within(workspace, stateDir) ? null : workspace;
}
function terminal(value: unknown, request: AssignmentRequest): value is AssignmentTerminal {
  return exact(value, ["id", "sequence", "result", "writersContained"]) && value.id === request.id && value.sequence === request.sequence
    && (value.result === "completed" || value.result === "failed") && value.writersContained === true;
}
function ownerAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function runAssignment(input: AssignmentInput): Promise<AssignmentResult> {
  const request = decode(input.raw, input.secrets);
  if (!request || input.adapter.kind !== "fabricated-harness") return outcome("refused");
  let lock: string | null = null;
  try {
    const stateDir = directory(input.stateDir);
    assertPrivateDirectory(stateDir);
    const workspace = await current(input, request, stateDir);
    if (workspace === null) return outcome("held");
    lock = stateDir + ":" + journalDigest(workspace);
    if (active.has(lock)) { lock = null; return outcome("held"); }
    active.add(lock);
    const at = input.now();
    if (!whole(at, 0)) return outcome("held");
    const intent: Intent = {
      kind: "intent", id: request.id, sequence: request.sequence, requestDigest: journalDigest(canonical(request)),
      bindingDigest: journalDigest(canonical(request.binding)), workspaceDigest: journalDigest(workspace),
      scopeDigest: journalDigest(canonical({ board: request.binding.board, repo: request.binding.repo, connection: request.binding.connection })), at, pid: process.pid,
    };
    const reserved = reserveAssignment(stateDir, intent);
    if (await current(input, request, stateDir) !== workspace) return outcome("held");
    if (reserved.state === "completed" || reserved.state === "failed") return outcome(reserved.state);
    if (reserved.state === "pending" && ownerAlive(reserved.owner)) return outcome("held");
    // An intent surviving its controller is uncertain at every age; only read-only evidence can resolve it.
    const observed: unknown = structuredClone(reserved.state === "pending"
      ? await input.adapter.reconcile({ id: request.id, sequence: request.sequence, requestDigest: intent.requestDigest })
      : await input.adapter.execute({ id: request.id, sequence: request.sequence, input: request.input, workspace }));
    if (!terminal(observed, request) || await current(input, request, stateDir) !== workspace) return outcome("held");
    completeAssignment(stateDir, intent, observed.result, input.now());
    return outcome(observed.result);
  } catch { return outcome("held"); }
  finally { if (lock !== null) active.delete(lock); }
}
