import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoordinationReads } from "../src/coordination-client.ts";
import * as coordination from "../src/coordination-client.ts";
import { readRecoverySelection } from "../src/board-feed-recovery.ts";

const protocol = "tickets-to-main.coordination";
const feature = "explicit_repo_identity_v1";
const board = "bB82".repeat(8);
const otherBoard = "dD20".repeat(8);
const repo = {
  identity_id: "iI36".repeat(8),
  board_repo_id: "fabricated-repo",
  locator: { host: "repository.example", owner: "fabricated-owner", name: "fabricated-repo" },
};
const bearer = ["tp", "aZ09".repeat(16)].join("_");
const newBearer = ["tp", "nJ17".repeat(16)].join("_");
const helloBody = { accepted_version: 1, accepted_features: [feature], runtime: "served" };
const activeBody = { repo, active: true, board_id: board, activation_id: "gG75".repeat(8) };
const inactiveBody = { repo, active: false, board_id: null, activation_id: null };
const reads = ["protocol.hello", "repo.activation.read"] as const;

type Call = { url: URL; options: RequestInit; request: Record<string, unknown> };
type Reply = (call: Call) => Response | Promise<Response>;

function harness(reply: Reply, input: { boardId?: string; getDeviceBearer?: () => Promise<string | null> } = {}) {
  const calls: Call[] = [];
  let credentialReads = 0;
  const client = createCoordinationReads({
    boardId: input.boardId ?? board,
    getDeviceBearer: async () => {
      credentialReads += 1;
      return input.getDeviceBearer ? await input.getDeviceBearer() : bearer;
    },
    send: async (address, options) => {
      assert.ok(address instanceof URL);
      assert.ok(options);
      assert.equal(typeof options.body, "string");
      const call = { url: address, options, request: JSON.parse(options.body as string) as Record<string, unknown> };
      calls.push(call);
      return await reply(call);
    },
  });
  return { client, calls, credentialReads: () => credentialReads };
}

function envelope(call: Call, body: unknown): Record<string, unknown> {
  return { protocol, version: 1, command: call.request.command, id: call.request.id, idempotency_key: null, body };
}

function answer(call: Call, body: unknown): Response {
  return Response.json(envelope(call, body));
}

function successfulBody(call: Call) {
  return call.request.command === "protocol.hello" ? helloBody : activeBody;
}

function forRead(command: typeof reads[number], reply: Reply) {
  const { client, calls } = harness(call => call.request.command === command ? reply(call) : answer(call, helloBody));
  return { calls, read: (signal?: AbortSignal) => command === "protocol.hello" ? client.hello(signal) : client.activation(repo, signal) };
}

function refusal(call: Call, status: number, body: Record<string, unknown>): Response {
  const { body: _unused, ...identity } = envelope(call, null);
  return Response.json({ ...identity, ...body }, { status });
}

const held = {
  error: "Another board already coordinates this repo.", code: "repo_held", field: "repo",
  fix: "Use the board that already coordinates it, or turn coordination off there.", then: "stop",
};
const notServed = {
  error: "This coordination command is not served yet.", code: "not_served", field: null,
  fix: "Use the contract. The server does not answer this command yet.", then: "stop",
};
const unsupported = {
  error: "This program speaks a coordination version the server does not.", code: "unsupported_protocol", field: "client_version",
  fix: "Update Tickets to Main and try again.", then: "stop",
};

test("a parsed recovery selection matches only the original active observations from one device reader", async () => {
  type Selection = NonNullable<ReturnType<typeof readRecoverySelection>>;
  type Match = (boardId: string, selection: Selection, observations: readonly unknown[]) => boolean;
  const match = (coordination as unknown as { matchesObservedActivations?: Match }).matchesObservedActivations;
  assert.equal(typeof match, "function");
  if (!match) throw new Error("The observed activation matcher is missing");
  let device = bearer;
  let available = true;
  let generation = activeBody.activation_id;
  const second = { board_repo_id: "second-repo", identity_id: "z".repeat(32), locator: null };
  const secondGeneration = "y".repeat(32);
  const reply = (call: Call) => {
    if (call.request.command === "protocol.hello") return answer(call, helloBody);
    const selected = (call.request.body as { repo: typeof second }).repo;
    if (!available) return answer(call, { ...inactiveBody, repo: selected });
    return answer(call, { repo: selected, active: true, board_id: board,
      activation_id: selected.board_repo_id === repo.board_repo_id ? generation : secondGeneration });
  };
  const local = harness(reply, { getDeviceBearer: async () => device });
  const elsewhere = harness(reply);
  const observed = [await local.client.activation(repo), await local.client.activation(second)];
  const selection = readRecoverySelection(JSON.stringify({ version: 1, selection: [
    { repo, activation_id: activeBody.activation_id }, { repo: second, activation_id: secondGeneration },
  ] }));
  assert.ok(selection);
  const readsBefore = local.credentialReads();
  assert.equal(match(board, selection, observed), true);
  assert.equal(match(otherBoard, selection, observed), false);
  assert.equal(match(board, selection, observed.slice(1)), false);
  assert.equal(match(board, selection, [observed[0], observed[0]]), false);
  assert.equal(match(board, selection, structuredClone(observed)), false);
  assert.equal(match(board, [], []), false);
  const changed = structuredClone(selection);
  changed[0]!.activation_id = "r".repeat(32);
  assert.equal(match(board, changed, observed), false);
  assert.equal(local.calls.length, 4);
  assert.equal(local.credentialReads(), readsBefore);
  const anotherReader = await elsewhere.client.activation(second);
  assert.deepEqual(anotherReader, observed[1]);
  assert.equal(match(board, selection, [observed[0], anotherReader]), false);
  device = newBearer;
  const anotherDevice = await local.client.activation(second);
  assert.deepEqual(anotherDevice, observed[1]);
  assert.equal(match(board, selection, [observed[0], anotherDevice]), false);
  assert.equal(match(board, selection, observed), false);
  device = bearer;
  const current = [await local.client.activation(repo), await local.client.activation(second)];
  assert.equal(match(board, selection, current), true);
  generation = "v".repeat(32);
  await local.client.activation(repo);
  assert.equal(match(board, selection, current), false);
  available = false;
  const inactive = await local.client.activation(second);
  assert.equal(match(board, [selection[1]!], [current[1]]), false);
  assert.equal(match(board, [selection[1]!], [inactive]), false);
});

function refused(result: unknown, code: string, then = "stop"): void {
  assert.ok(result && typeof result === "object");
  assert.equal(Reflect.get(result, "ok"), false);
  assert.equal(Reflect.get(result, "code"), code);
  assert.equal(Reflect.get(result, "then"), then);
  assert.equal("body" in result, false);
  const text = JSON.stringify(result);
  assert.equal(text.includes(bearer), false);
  assert.equal(text.includes(otherBoard), false);
  assert.equal(text.includes("private-error-sentinel"), false);
}

test("only the two scoped POST reads send; the approved bearer appears only in the authorization header", async () => {
  const { client, calls, credentialReads } = harness(call => answer(call, call.request.command === "protocol.hello" ? helloBody : activeBody));
  assert.deepEqual(Object.keys(client).sort(), ["activation", "hello"]);
  assert.deepEqual(await client.hello(), { ok: true, body: helloBody });
  assert.deepEqual(await client.activation(repo), { ok: true, body: activeBody });
  assert.equal(credentialReads(), 2);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(call => call.request.id)).size, 3);
  for (const [i, call] of calls.entries()) {
    const requestId = call.request.id;
    assert.match(String(requestId), /^[a-zA-Z0-9]{32}$/);
    assert.equal(call.url.href, `https://ticketsplease.dev/api/ttm/coordination?board=${board}`);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.cache, "no-store");
    assert.ok(call.options.signal instanceof AbortSignal);
    const headers = new Headers(call.options.headers);
    assert.equal(headers.get("authorization") === `Bearer ${bearer}`, true);
    headers.delete("authorization");
    assert.deepEqual(Object.fromEntries(headers), { accept: "application/json", "content-type": "application/json" });
    assert.deepEqual(call.request, {
      protocol, version: 1, command: i < 2 ? "protocol.hello" : "repo.activation.read", id: requestId, idempotency_key: null,
      body: i < 2 ? { client_version: 1, required_features: [feature] } : { repo },
    });
    assert.equal(JSON.stringify(call.request).includes(bearer), false);
  }
});

test("activation binds to the exact identity, locator, board and generation and reads current state", async () => {
  const nullLocator = { ...repo, locator: null };
  const newestBody = { ...inactiveBody, repo: nullLocator };
  let activationCalls = 0;
  const { client, calls } = harness(call => {
    if (call.request.command === "protocol.hello") return answer(call, helloBody);
    activationCalls += 1;
    return answer(call, activationCalls === 1 ? {
      ...activeBody,
      repo: { locator: { name: repo.locator.name, owner: repo.locator.owner, host: repo.locator.host }, board_repo_id: repo.board_repo_id, identity_id: repo.identity_id },
    } : newestBody);
  });
  assert.deepEqual(await client.activation(repo), { ok: true, body: activeBody });
  assert.deepEqual(await client.activation(nullLocator), { ok: true, body: newestBody });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3]?.request.body, { repo: nullLocator });
  assert.equal(new Set(calls.map(call => call.request.id)).size, 4);

  for (const body of [
    { ...activeBody, repo: { ...repo, identity_id: "F".repeat(32) } },
    { ...activeBody, repo: { ...repo, board_repo_id: "different-repo" } },
    { ...activeBody, repo: { ...repo, locator: { ...repo.locator, name: "other-repo" } } },
    { ...activeBody, repo: { ...repo, seat: "owner" } },
    { ...activeBody, repo: { ...repo, locator: { ...repo.locator, branch: "private-error-sentinel" } } },
    { ...activeBody, repo: nullLocator },
    { ...activeBody, repo: { ...repo.locator, board_repo_id: repo.board_repo_id }, activation_id: undefined },
    { ...activeBody, board_id: otherBoard },
    { ...activeBody, board_id: null },
    { ...activeBody, board_id: undefined },
    { ...activeBody, board_id: 1 },
    { ...activeBody, activation_id: null },
    { ...activeBody, activation_id: undefined },
    { ...activeBody, activation_id: 7 },
    { ...activeBody, activation_id: "not-an-opaque-generation" },
    { ...activeBody, active: 1 },
    { ...inactiveBody, active: undefined },
    { ...inactiveBody, active: 0 },
    { ...inactiveBody, activation_id: "G".repeat(32) },
    { ...inactiveBody, activation_id: undefined },
    { ...inactiveBody, activation_id: 0 },
    { ...inactiveBody, repo: nullLocator },
    { ...inactiveBody, board_id: board },
    { ...inactiveBody, board_id: undefined },
    { ...inactiveBody, board_id: 0 },
    { ...inactiveBody, ready_for_assignment: true },
    { ...activeBody, repo: { ...repo, locator: { ...repo.locator, name: bearer } } },
  ]) {
    const { client: bad } = harness(call => answer(call, call.request.command === "protocol.hello" ? helloBody : body));
    refused(await bad.activation(repo), "invalid_response");
  }
});

test("activation rejects a reply with a changed envelope, including the preceding hello id", async () => {
  for (const change of [
    { protocol: "different" }, { version: 2 }, { command: "protocol.hello" }, { idempotency_key: "unexpected-effect-key" },
    { body: undefined }, { unrelated: true },
  ]) {
    const { client } = harness(call => call.request.command === "protocol.hello"
      ? answer(call, helloBody) : Response.json({ ...envelope(call, activeBody), ...change }));
    refused(await client.activation(repo), "invalid_response");
  }
  let helloId: unknown;
  const swapped = harness(call => {
    if (call.request.command === "protocol.hello") {
      helloId = call.request.id;
      return answer(call, helloBody);
    }
    return Response.json({ ...envelope(call, activeBody), id: helloId });
  });
  refused(await swapped.client.activation(repo), "invalid_response");
});

test("an in-flight caller edit cannot retarget the activation that was validated", async () => {
  const selected = structuredClone(repo);
  const { client, calls } = harness(call => {
    if (call.request.command === "protocol.hello") {
      selected.identity_id = "F".repeat(32);
      selected.locator.name = "different-repo";
      return answer(call, helloBody);
    }
    return answer(call, activeBody);
  });
  assert.deepEqual(await client.activation(selected), { ok: true, body: activeBody });
  assert.deepEqual(calls[1]?.request.body, { repo });
});

test("wrong, unserved or downgraded hello prevents an activation call", async () => {
  for (const [change, code] of [
    [{ body: { ...helloBody, runtime: "not-served" } }, "not_served"],
    [{ body: { ...helloBody, accepted_features: undefined } }, "unsupported_protocol"],
    [{ body: { ...helloBody, accepted_features: feature } }, "invalid_response"],
    [{ body: { ...helloBody, accepted_features: [] } }, "invalid_response"],
    [{ body: { ...helloBody, accepted_features: [feature, feature] } }, "invalid_response"],
    [{ body: { ...helloBody, accepted_features: [feature, "fabricated-other-feature"] } }, "invalid_response"],
    [{ body: { ...helloBody, runtime: "unknown" } }, "invalid_response"],
    [{ body: { ...helloBody, accepted_version: 2 } }, "invalid_response"],
    [{ body: { ...helloBody, ready_for_assignment: true } }, "invalid_response"],
    [{ command: "repo.activation.read", body: activeBody }, "invalid_response"],
    [{ id: "M".repeat(32) }, "invalid_response"],
    [{ protocol: "different" }, "invalid_response"],
    [{ version: 2 }, "invalid_response"],
    [{ idempotency_key: "unexpected-effect-key" }, "invalid_response"],
  ] as const) {
    const { client, calls } = harness(call => Response.json({ ...envelope(call, helloBody), ...change }));
    refused(await client.activation(repo), code);
    assert.equal(calls.length, 1);
  }
});

test("privacy-safe protocol and access refusals never return an activation or retry automatically", async () => {
  const helloRejected = harness(call => refusal(call, 400, unsupported));
  refused(await helloRejected.client.activation(repo), "unsupported_protocol");
  assert.equal(helloRejected.calls.length, 1);

  const cases: Array<[number, Reply, string, string?]> = [
    [409, call => refusal(call, 409, held), "repo_held"],
    [501, call => refusal(call, 501, notServed), "not_served"],
    [409, call => refusal(call, 409, { ...held, id: "M".repeat(32) }), "invalid_response"],
    [409, call => refusal(call, 409, { ...held, command: "protocol.hello" }), "invalid_response"],
    [409, call => refusal(call, 409, { ...held, body: { board_id: otherBoard } }), "invalid_response"],
    [409, call => refusal(call, 409, { ...held, error: bearer }), "invalid_response"],
    [409, call => refusal(call, 409, { ...held, fix: "private-error-sentinel" }), "invalid_response"],
    [409, call => refusal(call, 409, { ...held, field: null }), "invalid_response"],
    [409, call => refusal(call, 409, { ...held, then: "retry" }), "invalid_response"],
    [409, call => refusal(call, 409, { ...held, detail: bearer }), "invalid_response"],
    [409, call => refusal(call, 409, notServed), "invalid_response"],
    [200, call => refusal(call, 200, held), "invalid_response"],
    [401, call => Response.json(envelope(call, activeBody), { status: 401 }), "unauthorized"],
    [403, () => Response.json({ error: bearer }, { status: 403 }), "unauthorized"],
    [404, () => Response.json({ error: otherBoard }, { status: 404 }), "unauthorized"],
    [429, () => Response.json({ then: "retry" }, { status: 429 }), "coordination_unavailable", "retry"],
    [503, () => Response.json({ code: "coordination_unavailable", then: "retry", body: inactiveBody }, { status: 503 }), "coordination_unavailable", "retry"],
    [418, call => Response.json(envelope(call, activeBody), { status: 418 }), "invalid_response"],
    [500, call => Response.json(envelope(call, activeBody), { status: 500 }), "invalid_response"],
    [502, call => Response.json(envelope(call, activeBody), { status: 502 }), "invalid_response"],
  ];
  for (const [status, reply, code, then] of cases) {
    const { client, calls } = harness(call => call.request.command === "protocol.hello" ? answer(call, helloBody) : reply(call));
    refused(await client.activation(repo), code, then);
    assert.equal(calls.length, 2, `HTTP ${status} triggered another attempt`);
  }
});

test("every canonical wire refusal is bound to the exact status, command and envelope", async () => {
  for (const [status, body, command] of [
    [400, unsupported, "protocol.hello"],
    [409, held, "repo.activation.read"],
    [501, notServed, "repo.activation.read"],
  ] as const) {
    for (const change of [
      { id: "M".repeat(32) }, { protocol: "different" }, { version: 2 }, { idempotency_key: "unexpected-effect-key" },
      { command: command === "protocol.hello" ? "repo.activation.read" : "protocol.hello" },
      { then: "retry" }, { fix: "private-error-sentinel" }, { error: bearer }, { active: false },
      { field: body.field === null ? "repo" : null },
    ]) {
      const { client, calls } = harness(call => call.request.command === command
        ? refusal(call, status, { ...body, ...change }) : answer(call, helloBody));
      refused(await client.activation(repo), "invalid_response");
      assert.equal(calls.length, command === "protocol.hello" ? 1 : 2);
    }
  }

  const wrongCommand = harness(call => refusal(call, 409, held));
  refused(await wrongCommand.client.activation(repo), "invalid_response");
  assert.equal(wrongCommand.calls.length, 1);
  const wrongRead = harness(call => call.request.command === "protocol.hello"
    ? answer(call, helloBody) : refusal(call, 400, unsupported));
  refused(await wrongRead.client.activation(repo), "invalid_response");
});

test("invalid scope or repo input never obtains or sends the bearer", async () => {
  const unreachable = () => { throw new Error("Unexpected HTTP request"); };
  for (const boardId of ["", "fabricated&board=other", "https://malicious.example", bearer]) {
    const { client, credentialReads, calls } = harness(unreachable, { boardId });
    refused(await client.hello(), "invalid");
    assert.equal(credentialReads(), 0);
    assert.equal(calls.length, 0);
  }
  const { client, credentialReads, calls } = harness(unreachable);
  for (const badRepo of [
    null,
    { ...repo.locator, board_repo_id: repo.board_repo_id },
    { ...repo, identity_id: "identity-looking-text" },
    { ...repo, identity_id: undefined },
    { ...repo, board_repo_id: undefined },
    { ...repo, board_repo_id: { text: "private-error-sentinel" } },
    { ...repo, board_repo_id: bearer },
    { ...repo, locator: undefined },
    { ...repo, seat: "owner" },
    { ...repo, locator: { ...repo.locator, host: "unsafe.example/path" } },
    { ...repo, locator: { ...repo.locator, branch: "private-error-sentinel" } },
    { ...repo, locator: { ...repo.locator, name: undefined } },
    { ...repo, locator: { ...repo.locator, name: bearer.replace("_", "%255F") } },
  ]) {
    refused(await client.activation(badRepo as typeof repo), "invalid");
  }
  assert.equal(credentialReads(), 0);
  assert.equal(calls.length, 0);
});

test("credential errors stay out of failures and fresh reads never fall back to an old credential", async () => {
  let current: string | null = bearer;
  const { client, calls } = harness(call => answer(call, helloBody), { getDeviceBearer: async () => current });
  assert.deepEqual(await client.hello(), { ok: true, body: helloBody });
  current = newBearer;
  assert.deepEqual(await client.hello(), { ok: true, body: helloBody });
  assert.equal(new Headers(calls[1]?.options.headers).get("authorization") === `Bearer ${newBearer}`, true);
  for (const unusable of [
    null, "", "tp_fixture_key_not_a_real_grant", ` Bearer ${bearer}`, `${bearer}\n`, `${bearer}A`, bearer.slice(0, -1),
    `${bearer.slice(0, -1)}-`, `${bearer.slice(0, -1)}_`, `${bearer.slice(0, -1)}é`, bearer.toUpperCase(),
  ]) {
    current = unusable;
    refused(await client.hello(), "credential_unavailable");
  }
  assert.equal(calls.length, 2);
  const lost = harness(call => answer(call, helloBody), { getDeviceBearer: async () => { throw new Error(bearer); } });
  refused(await lost.client.hello(), "credential_unavailable");
  assert.equal(lost.calls.length, 0);
});

test("redirects, transport failures and invalid content never become success or expose response detail", async () => {
  for (const [reply, code, then] of [
    [() => Response.redirect("https://malicious.example/", 307), "invalid_response", "stop"],
    [(call: Call) => {
      const redirected = answer(call, successfulBody(call));
      Object.defineProperty(redirected, "redirected", { value: true });
      return redirected;
    }, "invalid_response", "stop"],
    [(call: Call) => {
      const foreign = answer(call, successfulBody(call));
      Object.defineProperty(foreign, "url", { value: "https://malicious.example/api/ttm/coordination" });
      return foreign;
    }, "invalid_response", "stop"],
    [() => { throw new Error(`private-error-sentinel ${bearer}`); }, "coordination_unavailable", "retry"],
    [(call: Call) => new Response(JSON.stringify(envelope(call, successfulBody(call))), { headers: { "content-type": "text/html" } }), "invalid_response", "stop"],
    [() => new Response(`private-error-sentinel ${bearer}`, { headers: { "content-type": "application/json" } }), "invalid_response", "stop"],
    [(call: Call) => Response.json(envelope(call, successfulBody(call)), { status: 201 }), "invalid_response", "stop"],
    [(call: Call) => Response.json(envelope(call, successfulBody(call)), { status: 203 }), "invalid_response", "stop"],
    [() => new Response(null, { status: 204 }), "invalid_response", "stop"],
    [(call: Call) => Response.json(envelope(call, successfulBody(call)), { status: 206 }), "invalid_response", "stop"],
    [() => new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } }), "invalid_response", "stop"],
  ] as const) {
    for (const [i, command] of reads.entries()) {
      const { read, calls } = forRead(command, reply);
      refused(await read(), code, then);
      assert.equal(calls.length, i + 1);
      assert.equal(calls.at(-1)?.request.command, command);
    }
  }
});

test("both streamed responses are capped even without a Content-Length", async () => {
  function chunked(call: Call, bytes: number): Response {
    const json = JSON.stringify(envelope(call, successfulBody(call)));
    const padded = json.padEnd(bytes, " ");
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(padded.slice(offset, offset + 1024)));
        offset += 1024;
        if (offset >= padded.length) controller.close();
      },
    }), { headers: { "content-type": "application/json" } });
  }
  for (const [i, command] of reads.entries()) {
    let cancelled = false;
    const singleChunk = forRead(command, () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("é".repeat(32769)));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } }));
    refused(await singleChunk.read(), "invalid_response");
    assert.equal(cancelled, true);
    assert.equal(singleChunk.calls.length, i + 1);

    const bounded = forRead(command, call => chunked(call, 65536));
    assert.deepEqual(await bounded.read(), { ok: true, body: i === 0 ? helloBody : activeBody });
    const tooLarge = forRead(command, call => chunked(call, 65537));
    refused(await tooLarge.read(), "invalid_response");
    assert.equal(tooLarge.calls.length, i + 1);
  }
});

test("invalid UTF-8 inside an otherwise matching locator is refused", async () => {
  const replacement = "\uFFFD";
  const selected = { ...repo, locator: { ...repo.locator, name: `fabricated-${replacement}` } };
  const body = { ...activeBody, repo: selected };
  const valid = harness(call => answer(call, call.request.command === "protocol.hello" ? helloBody : body));
  assert.deepEqual(await valid.client.activation(selected), { ok: true, body });
  const invalid = harness(call => {
    if (call.request.command === "protocol.hello") return answer(call, helloBody);
    const payload = Buffer.from(JSON.stringify(envelope(call, body)), "utf8");
    const offset = payload.indexOf(replacement);
    assert.ok(offset >= 0);
    const bytes = Buffer.concat([payload.subarray(0, offset), Buffer.of(0xff), payload.subarray(offset + 3)]);
    return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/json" } });
  });
  refused(await invalid.client.activation(selected), "invalid_response");
});

function stalledBody(call: Call, abort: () => void): Response {
  return new Response(new ReadableStream({
    start(stream) {
      const signal = call.options.signal!;
      signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
    },
    pull() { queueMicrotask(abort); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "application/json" } });
}

const stalledReads = [
  { name: "standalone hello", standalone: true, command: "protocol.hello", calls: 1 },
  { name: "activation handshake", standalone: false, command: "protocol.hello", calls: 1 },
  { name: "activation data", standalone: false, command: "repo.activation.read", calls: 2 },
] as const;

test("each public read uses one deadline that covers every response body", async t => {
  for (const stalled of stalledReads) {
    await t.test(stalled.name, async t => {
      const timeout = new AbortController();
      const deadline = t.mock.method(AbortSignal, "timeout", () => timeout.signal);
      const { client, calls } = harness(call => call.request.command === stalled.command
        ? stalledBody(call, () => timeout.abort(new DOMException("Fabricated deadline", "TimeoutError")))
        : answer(call, helloBody));
      refused(await (stalled.standalone ? client.hello() : client.activation(repo)), "coordination_unavailable", "retry");
      assert.equal(calls.length, stalled.calls);
      assert.equal(calls.at(-1)?.request.command, stalled.command);
      assert.equal(calls.every(call => call.options.signal?.aborted === true), true);
      assert.equal(deadline.mock.callCount(), 1);
      assert.ok(Number(deadline.mock.calls[0]?.arguments[0]) > 0);
      assert.ok(Number(deadline.mock.calls[0]?.arguments[0]) <= 30_000);
    });
  }
});

test("cancellation prevents a request or a follow-up and never falls back to a retry", async () => {
  const stopped = new AbortController();
  stopped.abort(new Error(bearer));
  const early = harness(call => answer(call, helloBody));
  refused(await early.client.hello(stopped.signal), "cancelled");
  refused(await early.client.activation(repo, stopped.signal), "cancelled");
  assert.equal(early.calls.length, 0);
  assert.equal(early.credentialReads(), 0);

  for (const stalled of stalledReads) {
    const inFlight = new AbortController();
    const { client, calls } = harness(call => call.request.command === stalled.command
      ? stalledBody(call, () => inFlight.abort(new Error(bearer))) : answer(call, helloBody));
    refused(await (stalled.standalone ? client.hello(inFlight.signal) : client.activation(repo, inFlight.signal)), "cancelled");
    assert.equal(calls.length, stalled.calls);
    assert.equal(calls.at(-1)?.request.command, stalled.command);
    assert.equal(calls.every(call => call.options.signal?.aborted === true), true);
  }
});
