import { createHash, randomBytes } from "node:crypto";
import {
  confirmNegotiation, fail, isOpaqueId, PROTOCOL, PROTOCOL_VERSION, REPO_IDENTITY_FEATURE, sameBody, validateWire,
  type ExplicitRepoReference, type ProtocolFailure, type RefusalCode,
} from "../../src/lib/ttm-protocol.ts";
import { KEY_MARK } from "./secret-text.ts";

const ENDPOINT = "https://ticketsplease.dev/api/ttm/coordination";
const MAX_WIRE_BYTES = 65_536;
const READ_DEADLINE_MS = 10_000;

const CLIENT_COPY = {
  credential_unavailable: { error: "The approved device credential is unavailable.", fix: "Check the existing device connection.", then: "stop" },
  coordination_unavailable: { error: "Could not read current coordination.", fix: "Retry the read.", then: "retry" },
  invalid_response: { error: "The coordination reply did not match the read.", fix: "Check the coordination service before continuing.", then: "stop" },
  cancelled: { error: "The coordination read was cancelled.", fix: "Start another read when needed.", then: "stop" },
} as const;

type ClientCode = keyof typeof CLIENT_COPY;
type ClientFailure = { ok: false; code: ClientCode; field: null } & (typeof CLIENT_COPY)[ClientCode];
type Result<T> = { ok: true; body: T } | ProtocolFailure | ClientFailure;
type ReadCommand = "protocol.hello" | "repo.activation.read";
type Envelope = {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  command: ReadCommand;
  id: string;
  idempotency_key: null;
  body: Record<string, unknown>;
};

type Hello = {
  accepted_version: typeof PROTOCOL_VERSION;
  accepted_features: [typeof REPO_IDENTITY_FEATURE];
  runtime: "served";
};
type Activation = { repo: ExplicitRepoReference } & (
  { active: true; board_id: string; activation_id: string } | { active: false; board_id: null; activation_id: null }
);
type ReadContext = { bearer: string; signal: AbortSignal; order: number; credentialEpoch: object | null };
type SelectionEntry = { repo: ExplicitRepoReference; activation_id: string };
type Observation = {
  reader: object; board: string; credentialEpoch: object; entry: SelectionEntry; current: () => boolean;
};
const activeReads = new WeakMap<object, Observation>();

export function matchesObservedActivations(reader: object, boardId: string, selection: readonly SelectionEntry[], results: readonly unknown[]): boolean {
  if (!Array.isArray(selection) || !Array.isArray(results) || !selection.length || selection.length !== results.length) return false;
  const listings = new Set<string>(), identities = new Set<string>();
  let epoch: object | undefined;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (!result || typeof result !== "object") return false;
    const seen = activeReads.get(result);
    if (!seen || seen.reader !== reader || seen.board !== boardId || !seen.current()
      || (epoch && seen.credentialEpoch !== epoch) || !sameBody(selection[index], seen.entry)
      || !sameBody(result, { ok: true, body: { ...seen.entry, active: true, board_id: boardId } })) return false;
    const { board_repo_id, identity_id } = seen.entry.repo;
    if (listings.has(board_repo_id) || identities.has(identity_id)) return false;
    listings.add(board_repo_id);
    identities.add(identity_id);
    epoch = seen.credentialEpoch;
  }
  return true;
}

const WIRE_REFUSALS = new Map<number, { code: RefusalCode; field: string | null; command?: ReadCommand }>([
  [400, { code: "unsupported_protocol", field: "client_version", command: "protocol.hello" }],
  [409, { code: "repo_held", field: "repo", command: "repo.activation.read" }],
  [501, { code: "not_served", field: null }],
]);

function failure(code: ClientCode): ClientFailure {
  return { ok: false, code, field: null, ...CLIENT_COPY[code] };
}

function envelope(command: ReadCommand, body: Record<string, unknown>): Envelope {
  return { protocol: PROTOCOL, version: PROTOCOL_VERSION, command, id: randomBytes(16).toString("hex"), idempotency_key: null, body };
}

async function untilAborted<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

async function readJson(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0, finished = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) {
        finished = true;
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > MAX_WIRE_BYTES) return undefined;
      try { text += decoder.decode(part.value, { stream: true }); }
      catch { return undefined; }
    }
    try { return JSON.parse(text + decoder.decode()) as unknown; }
    catch { return undefined; }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

export function createCoordinationReads({ boardId, getDeviceBearer, send = globalThis.fetch }: {
  boardId: string;
  getDeviceBearer: () => Promise<string | null>;
  send?: typeof globalThis.fetch;
}) {
  const endpoint = isOpaqueId(boardId) ? `${ENDPOINT}?board=${boardId}` : null;
  const latestListing = new Map<string, object>(), latestIdentity = new Map<string, object>();
  let started = 0, latestLookup = 0, epochStart = 0, lastRefusal = 0;
  let credentialDigest: string | null | undefined, credentialEpoch = {};

  function observeCredential(order: number, bearer: string | null): object | null {
    const digest = bearer && createHash("sha256").update(bearer).digest("hex");
    // Credential lookups may finish out of order, including across a key rotation.
    if (order < epochStart || (order < latestLookup && digest !== credentialDigest)) return null;
    if (digest !== credentialDigest) {
      epochStart = credentialDigest === undefined ? 0 : order;
      credentialDigest = digest;
      credentialEpoch = {};
    }
    latestLookup = Math.max(order, latestLookup);
    return digest ? credentialEpoch : null;
  }

  async function authorized<T>(read: (context: ReadContext) => Promise<Result<T>>, callerSignal?: AbortSignal): Promise<Result<T>> {
    if (!endpoint) return fail(null);
    if (callerSignal?.aborted) return failure("cancelled");
    const deadline = AbortSignal.timeout(READ_DEADLINE_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    const order = ++started;
    try {
      return await untilAborted(signal, async () => {
        let bearer: string | null;
        try { bearer = await getDeviceBearer(); }
        catch { observeCredential(order, null); return failure("credential_unavailable"); }
        signal.throwIfAborted();
        if (typeof bearer !== "string" || !bearer.startsWith(KEY_MARK) || bearer.length !== KEY_MARK.length + 64
          || !/^[A-Za-z0-9]{64}$/.test(bearer.slice(KEY_MARK.length))) {
          observeCredential(order, null);
          return failure("credential_unavailable");
        }
        const observed = observeCredential(order, bearer);
        const result = await read({ bearer, signal, order, credentialEpoch: observed });
        if (!result.ok && result.code === "unauthorized" && observed === credentialEpoch) {
          lastRefusal = Math.max(lastRefusal, order);
        }
        return result;
      });
    } catch {
      return failure(callerSignal?.aborted ? "cancelled" : "coordination_unavailable");
    }
  }

  async function post(request: Envelope, { bearer, signal }: ReadContext): Promise<Result<Envelope>> {
    if (!endpoint) return fail(null);
    signal.throwIfAborted();
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > MAX_WIRE_BYTES) return fail(null);
    const response = await send(new URL(endpoint), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${bearer}` },
      redirect: "error", credentials: "omit", cache: "no-store", signal, body,
    });
    const discard = () => { void response.body?.cancel().catch(() => undefined); };
    if (signal.aborted || response.redirected || (response.url && response.url !== endpoint)) {
      discard();
      signal.throwIfAborted();
      return failure("invalid_response");
    }
    const { status } = response;
    if (status === 401 || status === 403 || status === 404) {
      discard();
      return fail(null, "unauthorized");
    }
    if (status === 429 || status === 503) {
      discard();
      return failure("coordination_unavailable");
    }
    const expected = WIRE_REFUSALS.get(status);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if ((status !== 200 && !expected) || mediaType !== "application/json" || !response.body) {
      discard();
      return failure("invalid_response");
    }
    const value = await readJson(response.body, signal);
    signal.throwIfAborted();
    if (!value || typeof value !== "object") return failure("invalid_response");
    const reply = value as Record<string, unknown>;
    if (reply.id !== request.id || reply.command !== request.command) return failure("invalid_response");
    try {
      if (!validateWire(reply, expected ? "refusal" : "response").ok) return failure("invalid_response");
    } catch {
      return failure("invalid_response");
    }
    if (!expected) return { ok: true, body: reply as Envelope };
    if (reply.code !== expected.code || reply.field !== expected.field || (expected.command && request.command !== expected.command)) {
      return failure("invalid_response");
    }
    return fail(expected.field, expected.code);
  }

  async function readHello(context: ReadContext): Promise<Result<Hello>> {
    const request = envelope("protocol.hello", { client_version: PROTOCOL_VERSION, required_features: [REPO_IDENTITY_FEATURE] });
    const reply = await post(request, context);
    if (!reply.ok) return reply;
    if (reply.body.body.runtime !== "served") return fail(null, "not_served");
    const agreed = confirmNegotiation({ request, response: reply.body });
    if (!agreed.ok) return agreed;
    return { ok: true, body: { accepted_version: agreed.accepted_version, accepted_features: [REPO_IDENTITY_FEATURE], runtime: "served" } };
  }

  const reader = {
    hello(signal?: AbortSignal): Promise<Result<Hello>> {
      return authorized(readHello, signal);
    },
    async activation(repo: ExplicitRepoReference, signal?: AbortSignal): Promise<Result<Activation>> {
      let selected: ExplicitRepoReference;
      let request: Envelope;
      try {
        selected = structuredClone(repo);
        if (!selected || !Object.hasOwn(selected, "identity_id")) return fail(null);
        request = envelope("repo.activation.read", { repo: selected });
        if (!validateWire(request, "request").ok) return fail(null);
      } catch {
        return fail(null);
      }
      if (signal?.aborted) return failure("cancelled");
      const { board_repo_id: listing, identity_id: identity } = selected;
      const attempt = {};
      latestListing.set(listing, attempt);
      latestIdentity.set(identity, attempt);
      const latest = () => latestListing.get(listing) === attempt && latestIdentity.get(identity) === attempt;
      const result = await authorized<Activation>(async context => {
        const hello = await readHello(context);
        if (!hello.ok) return hello;
        const reply = await post(request, context);
        if (!reply.ok) return reply;
        const body = reply.body.body;
        if (!sameBody(body.repo, selected)) return failure("invalid_response");
        if (body.active === false) return { ok: true, body: { repo: selected, active: false, board_id: null, activation_id: null } };
        if (body.board_id !== boardId || !isOpaqueId(body.activation_id)) return failure("invalid_response");
        const result = { ok: true, body: { repo: selected, active: true, board_id: boardId, activation_id: body.activation_id } } as const;
        const { credentialEpoch: observed, order } = context;
        // The caller owns the returned object, so retain a separate copy of the observed identity.
        if (observed && latest() && observed === credentialEpoch) activeReads.set(result, {
          reader, board: boardId, credentialEpoch: observed, entry: { repo: structuredClone(selected), activation_id: body.activation_id },
          current: () => observed === credentialEpoch && order > lastRefusal && latest(),
        });
        return result;
      }, signal);
      if (!activeReads.has(result)) {
        if (latestListing.get(listing) === attempt) latestListing.delete(listing);
        if (latestIdentity.get(identity) === attempt) latestIdentity.delete(identity);
      }
      return result;
    },
  };
  return reader;
}
