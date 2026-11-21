import { isDeepStrictEqual } from "node:util";
import { isOpaqueId, privacyFindings, type ExplicitRepoReference } from "../../src/lib/ttm-protocol.ts";
import { decodeTextEscapes, KEY_MARK, scanCredentialText } from "./secret-text.ts";

type Fields = Record<string, unknown>;
type Check = (value: unknown) => boolean;
type SelectedRepo = { repo: ExplicitRepoReference; activation_id: string };
export type RecoverySelection = SelectedRepo[];
export type RecoverySnapshot = {
  version: 1; board: string; selection: RecoverySelection; next: number; graph_revision: number; tickets: Fields[];
};

const isObject = (value: unknown): value is Fields => value !== null && typeof value === "object" && !Array.isArray(value);
const boolean = (value: unknown) => typeof value === "boolean";
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const handoff = (value: unknown) => typeof value === "string" && [
  "draft", "ready_for_agent", "in_progress", "waiting_for_human", "human_review", "saved_for_later",
].includes(value);
const status = (value: unknown) => value === "open" || value === "closed" || value === "archived";
const optional = (check: Check): Check => value => value === null || check(value);
const listOf = (check: Check): Check => value => Array.isArray(value) && value.every(check);

function fields(value: unknown, keys: readonly string[]): value is Fields {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function conforms(value: unknown, schema: Record<string, Check>): boolean {
  return fields(value, Object.keys(schema)) && Object.entries(schema).every(([key, check]) => check(value[key]));
}

function selectedEntry(value: unknown): value is SelectedRepo {
  if (!fields(value, ["repo", "activation_id"]) || !isOpaqueId(value.activation_id)) return false;
  const repo = value.repo;
  if (!fields(repo, ["board_repo_id", "identity_id", "locator"]) || !isOpaqueId(repo.identity_id)
    || typeof repo.board_repo_id !== "string" || repo.board_repo_id.length > 64
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(repo.board_repo_id) || repo.board_repo_id.startsWith("sk-")) return false;
  if (repo.locator === null) return privacyFindings(repo, "shared").length === 0;
  if (!fields(repo.locator, ["host", "owner", "name"])) return false;
  for (const [key, part] of Object.entries(repo.locator)) {
    if (typeof part !== "string" || !part.length || part.length > 300) return false;
    let form = part;
    for (;;) {
      if (/[\u0000-\u001f\u007f-\u009f]/.test(form) || (key === "host" && /[@/?#\\\s]/.test(form))) return false;
      const decoded = decodeTextEscapes(form);
      if (decoded === form) break;
      form = decoded;
    }
  }
  return privacyFindings(repo, "shared").length === 0;
}

function selection(value: unknown): value is RecoverySelection {
  return Array.isArray(value) && value.length > 0 && value.every(selectedEntry)
    && new Set(value.map(item => item.repo.board_repo_id)).size === value.length
    && new Set(value.map(item => item.repo.identity_id)).size === value.length;
}

function json(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

export function readRecoverySelection(text: string): RecoverySelection | null {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65_536) return null;
  const request = json(text);
  return fields(request, ["version", "selection"]) && request.version === 1 && selection(request.selection) ? request.selection : null;
}

function relationships(value: unknown, revision: number, repos: Set<string>): boolean {
  const selected = (id: unknown) => typeof id === "string" && repos.has(id);
  const endpoint = (extra: Record<string, Check>): Check => link => {
    if (fields(link, ["link_id", "unavailable"])) return isOpaqueId(link.link_id) && link.unavailable === true;
    return conforms(link, { link_id: isOpaqueId, unavailable: x => x === false, id: isOpaqueId,
      heading: x => typeof x === "string", repo_id: selected, status, closed: boolean, ...extra });
  };
  const ordinary = endpoint({}), hierarchy = endpoint({ handoff }), dependency = endpoint({ satisfies: boolean });
  return conforms(value, {
    revision: x => x === revision, parent: optional(hierarchy), children: listOf(hierarchy), closed_direct: uint, direct_total: uint,
    depends_on: listOf(dependency), blocks: listOf(dependency), dependencies_satisfied: boolean, related: listOf(ordinary),
    duplicate_of: x => conforms(x, { excluded: boolean, canonical: optional(ordinary) }),
    batch: optional(x => conforms(x, { id: isOpaqueId, repo_id: selected, name_seq: uint, active: boolean, held: boolean,
      members: listOf(endpoint({ handoff, held: boolean })) })),
    eligibility: x => conforms(x, { ready: boolean, eligible: boolean }),
  });
}

export function validRecoverySnapshot(value: unknown, board: string): value is RecoverySnapshot {
  if (!fields(value, ["version", "board", "selection", "next", "graph_revision", "tickets"])
    || value.version !== 1 || value.board !== board || !selection(value.selection)
    || !uint(value.next) || !uint(value.graph_revision) || !Array.isArray(value.tickets)) return false;
  const repos = new Set(value.selection.map(item => item.repo.board_repo_id));
  const ids = new Set<string>(), next = value.next, revision = value.graph_revision;
  return value.tickets.every((ticket: unknown) => {
    if (!conforms(ticket, { id: isOpaqueId, repo_id: x => typeof x === "string" && repos.has(x), status: x => x === "open",
      handoff, handoff_seq: uint, last_seq: x => uint(x) && x <= next, fast_track: boolean, manual_order: x => uint(x) && x > 0,
      relationships: x => relationships(x, revision, repos) })) return false;
    const id = (ticket as { id: string }).id;
    if (ids.has(id)) return false;
    ids.add(id);
    return true;
  });
}

export function readRecoverySnapshot(text: string, board: string, expected: RecoverySelection): RecoverySnapshot | null {
  if (typeof text !== "string") return null;
  const value = json(text);
  return validRecoverySnapshot(value, board) && isDeepStrictEqual(value.selection, expected) ? value : null;
}

export function recoveryTextIsStorable(snapshot: RecoverySnapshot, secrets: readonly string[]): boolean {
  const held = [...secrets.filter(value => value.length > 0), KEY_MARK];
  const safe = (value: unknown): boolean => {
    if (typeof value === "string") return scanCredentialText(value, held) === "clear";
    if (value === null || typeof value !== "object") return true;
    return Object.values(value).every(safe);
  };
  return safe(snapshot);
}
