import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { documentedClaudeClaim } from "../src/adapters/claude.ts";
import { processNativeTransport, type NativeEvents, type NativeTransport } from "../src/native-transport.ts";
import { startClaudeWindowsProbe, type ClaudeWindowsProbeOptions } from "./claude-windows-probe.ts";
import { scriptedTransport } from "./native-fixtures.ts";

const WORKSPACE = "C:\\fixture-resume";
const MARKER = "T3-RESUME-MARKER-61";
const OPTIONS: ClaudeWindowsProbeOptions = {
  executable: "C:\\fixture-tools\\2.1.326\\claude.exe", version: "2.1.326", workspace: WORKSPACE,
  planOnlyVerified: true, env: {}, mode: "fresh",
};
type Input = { session_id: string; uuid: string; message: { content: string } };
type Reply = Record<string, unknown>;
type FrameEdits = { init?: Reply; beforeAssistant?: Reply; result?: Reply };

function send(events: NativeEvents, input: Input, frame: Reply): void {
  events.stdout(JSON.stringify({ session_id: input.session_id, ...frame }) + "\n");
}

function emitResult(events: NativeEvents, input: Input, result: string, edits: FrameEdits = {}): void {
  const { init, beforeAssistant, result: resultEdits } = edits;
  send(events, input, {
    type: "system", subtype: "init", uuid: "init-fixture", claude_code_version: "2.1.326",
    cwd: WORKSPACE, apiKeySource: "none", permissionMode: "default", model: "claude-haiku-5-5", ...init,
  });
  if (beforeAssistant) send(events, input, beforeAssistant);
  send(events, input, {
    type: "assistant", uuid: "assistant-fixture", user_message_uuid: input.uuid, parent_tool_use_id: null,
    message: { model: "claude-haiku-5-5", content: [] },
  });
  send(events, input, {
    type: "result", uuid: "result-fixture", user_message_uuid: input.uuid, subtype: "success",
    is_error: false, num_turns: 1, permission_denials: [], stop_reason: "end_turn", result, ...resultEdits,
  });
}

function fixture(resumeEdits: (previous: Input, current: Input) => FrameEdits = () => ({}), freshResult = "T3-FIXTURE-OK") {
  const inputs: Input[] = [];
  const transport = scriptedTransport((text, events) => {
    const input: Input = JSON.parse(text);
    const previous = inputs[0];
    inputs.push(input);
    emitResult(events, input, previous ? MARKER : freshResult, previous ? resumeEdits(previous, input) : {});
  });
  return { transport, inputs };
}

test("resume waits for a clean fresh close and reuses that session once with bound launch options", async () => {
  const { transport, inputs } = fixture();
  const options = { ...OPTIONS, env: { SystemRoot: "fabricated-profile" } };
  const handle = startClaudeWindowsProbe(options, transport);
  assert.equal(handle.resumeFixture(), null);
  const first = await handle.closed;
  assert.equal(first.execution, "fresh");
  assert.equal(first.outcome, "root-result");

  assert.equal(documentedClaudeClaim().capabilities.resume, "unavailable");
  first.outcome = "failed";
  options.workspace = "C:\\mutated-checkout";
  options.env.SystemRoot = "fabricated-mutated-profile";
  const { env: firstLaunchEnv } = transport.calls[0]!;
  firstLaunchEnv.SystemRoot = "fabricated-mutated-transport";
  transport.start = () => assert.fail("a replacement transport must not receive the resume");
  const resumed = handle.resumeFixture();
  assert.ok(resumed);
  assert.equal(handle.resumeFixture(), null);
  const outcome = await resumed.closed;

  const initialInput = inputs[0]!;
  const nextInput = inputs[1]!;
  assert.ok(initialInput.message.content.includes(MARKER));
  assert.ok(!nextInput.message.content.includes(MARKER));
  assert.equal(initialInput.session_id, nextInput.session_id);
  assert.notEqual(initialInput.uuid, nextInput.uuid);
  const firstLaunch = transport.calls[0]!;
  const secondLaunch = transport.calls[1]!;
  assert.deepEqual(secondLaunch.argv, firstLaunch.argv.map(arg => arg === "--session-id" ? "--resume" : arg));
  assert.equal(secondLaunch.cwd, WORKSPACE);
  assert.deepEqual(secondLaunch.env, { SystemRoot: "fabricated-profile" });
  assert.equal(outcome.outcome, "root-result");
  assert.equal(outcome.execution, "explicit-resume");
  assert.equal(outcome.writerState, "unknown");
  assert.equal(outcome.resultMatches, true);
  assert.ok(!JSON.stringify(outcome).includes(initialInput.session_id));
  assert.ok(!JSON.stringify(outcome).includes(MARKER));
  assert.equal(resumed.resumeFixture(), null);
  assert.equal(transport.calls.length, 2);
});

test("mutating a failed observation or losing the fixture transport cannot create a resume", async () => {
  const wrong = fixture(undefined, "wrong marker");
  const failed = startClaudeWindowsProbe(OPTIONS, wrong.transport);
  const observation = await failed.closed;
  assert.equal(observation.outcome, "failed");
  observation.outcome = "root-result";
  assert.equal(failed.resumeFixture(), null);
  const disconnected = scriptedTransport((_input, events) => {
    events.closed({ code: null, signal: null, error: "spawn" });
  });
  const lost = startClaudeWindowsProbe(OPTIONS, disconnected);
  assert.equal((await lost.closed).outcome, "disconnected");
  assert.equal(lost.resumeFixture(), null);
  assert.equal(wrong.transport.calls.length, 1);
  assert.equal(disconnected.calls.length, 1);
});

test("same-session resume rejects a stale input, automatic continuation, foreign session or wrong recalled text", async () => {
  const examples: { change: (previous: Input) => Reply; outcome: "protocol-error" | "failed" }[] = [
    { change: previous => ({ user_message_uuid: previous.uuid }), outcome: "protocol-error" },
    { change: previous => ({ user_message_uuids: [previous.uuid] }), outcome: "protocol-error" },
    { change: () => ({ resume_reason: "interrupted_turn" }), outcome: "protocol-error" },
    { change: () => ({ origin: { kind: "task-notification" } }), outcome: "protocol-error" },
    { change: () => ({ session_id: "fabricated-foreign-session" }), outcome: "protocol-error" },
    { change: () => ({ result: "T3-FIXTURE-OK" }), outcome: "failed" },
  ];
  for (const { change, outcome } of examples) {
    const { transport } = fixture(previous => ({ result: change(previous) }));
    const handle = startClaudeWindowsProbe(OPTIONS, transport);
    assert.equal((await handle.closed).outcome, "root-result");
    const resumed = handle.resumeFixture();
    assert.ok(resumed);
    const result = await resumed.closed;
    assert.equal(result.outcome, outcome);
    assert.equal(result.resultMatches, null);
    assert.equal(result.writerState, "unknown");
    assert.equal(resumed.resumeFixture(), null);
  }
});

test("stale assistant, stream, lifecycle and receipt frames cannot be combined with the new resume result", async () => {
  for (const previousFrame of [
    (previous: Input) => ({
      type: "assistant", uuid: "stale-assistant", parent_tool_use_id: null, user_message_uuids: [previous.uuid],
      message: { model: "claude-haiku-5-5", content: [] },
    }),
    (_previous: Input) => ({
      type: "assistant", uuid: "auto-assistant", parent_tool_use_id: null, resume_reason: "interrupted_turn",
      message: { model: "claude-haiku-5-5", content: [] },
    }),
    (_previous: Input) => ({
      type: "stream_event", uuid: "auto-stream", parent_tool_use_id: null,
      resume_reason: "interrupted_turn", event: { type: "message_start" },
    }),
    (previous: Input) => ({ type: "command_lifecycle", uuid: "stale-start", command_uuid: previous.uuid, state: "queued" }),
    (_previous: Input) => ({
      type: "control_response", response: { request_id: "stale-control", subtype: "success", response: { still_queued: [] } },
    }),
  ]) {
    const { transport } = fixture(previous => ({ beforeAssistant: previousFrame(previous) }));
    const fresh = startClaudeWindowsProbe(OPTIONS, transport);
    assert.equal((await fresh.closed).outcome, "root-result");
    const resumed = fresh.resumeFixture();
    assert.ok(resumed);
    const result = await resumed.closed;
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.resultMatches, null);
    assert.equal(result.writerState, "unknown");
  }
});

test("automatic init and lifecycle or unrelated helper frames invalidate explicit resume", async () => {
  const edits: ((previous: Input, current: Input) => FrameEdits)[] = [
    () => ({ init: { resume_reason: "interrupted_turn" } }),
    (_previous, current) => ({
      beforeAssistant: {
        type: "command_lifecycle", uuid: "auto-lifecycle", state: "queued",
        command_uuid: current.uuid, resume_reason: "interrupted_turn",
      },
    }),
    previous => ({
      beforeAssistant: {
        type: "assistant", uuid: "stale-helper", parent_tool_use_id: "fabricated-helper",
        user_message_uuid: previous.uuid, message: { model: "claude-haiku-5-5", content: [] },
      },
    }),
    () => ({
      beforeAssistant: {
        type: "stream_event", uuid: "auto-helper", parent_tool_use_id: "fabricated-helper",
        resume_reason: "interrupted_turn", event: { type: "message_start" },
      },
    }),
  ];
  for (const edit of edits) {
    const { transport } = fixture(edit);
    const fresh = startClaudeWindowsProbe(OPTIONS, transport);
    assert.equal((await fresh.closed).outcome, "root-result");
    const resumed = fresh.resumeFixture();
    assert.ok(resumed);
    const result = await resumed.closed;
    assert.equal(result.outcome, "protocol-error");
    assert.equal(result.resultMatches, null);
    assert.equal(result.writerState, "unknown");
  }
});

function cliFixture(workspace: string): void {
  // This function is serialized into an independent Node subprocess.
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const reader = require("node:readline").createInterface({ input: process.stdin });
  reader.once("line", (line: string) => {
    const input: Input = JSON.parse(line);
    const args = process.argv.slice(1);
    const freshAt = args.indexOf("--session-id");
    const resumeAt = args.indexOf("--resume");
    assert.notEqual(freshAt >= 0, resumeAt >= 0);
    assert.equal(args[(freshAt >= 0 ? freshAt : resumeAt) + 1], input.session_id);
    let result: string;
    if (freshAt >= 0) {
      const marker = input.message.content.match(/\bT3-RESUME-MARKER-\d+\b/)?.[0];
      assert.ok(marker);
      fs.writeFileSync("fixture-context.json", JSON.stringify({ session: input.session_id, input: input.uuid, marker }), { flag: "wx" });
      result = "T3-FIXTURE-OK";
    } else {
      const context = JSON.parse(fs.readFileSync("fixture-context.json", "utf8"));
      assert.equal(context.session, input.session_id);
      assert.notEqual(context.input, input.uuid);
      assert.ok(!input.message.content.includes(context.marker));
      result = context.marker;
    }
    const send = (frame: Reply): void => {
      process.stdout.write(JSON.stringify({ session_id: input.session_id, ...frame }) + "\n");
    };
    send({ type: "system", subtype: "init", uuid: "init-fixture", claude_code_version: "2.1.326",
      cwd: workspace, apiKeySource: "none", permissionMode: "default", model: "claude-haiku-5-5" });
    send({ type: "assistant", uuid: "assistant-fixture", user_message_uuid: input.uuid, parent_tool_use_id: null,
      message: { model: "claude-haiku-5-5", content: [] } });
    send({ type: "result", uuid: "result-fixture", user_message_uuid: input.uuid, subtype: "success",
      is_error: false, num_turns: 1, stop_reason: "end_turn", permission_denials: [], result });
    reader.close();
  });
}

async function withRealPipes(check: (transport: NativeTransport, statePath: string, launchCount: () => number) => Promise<void>) {
  const temporary = await mkdtemp(join(tmpdir(), "ttm-claude-resume-fixture-"));
  const statePath = join(temporary, "fixture-context.json");
  const subprocess = processNativeTransport();
  const fixtureProgram = "(" + cliFixture.toString() + ")(" + JSON.stringify(WORKSPACE) + ")";
  let runs = 0;
  const transport: NativeTransport = {
    start(argv, options, events) {
      assert.equal(argv[0], OPTIONS.executable);
      assert.equal(options.cwd, WORKSPACE);
      runs++;
      return subprocess.start([process.execPath, "-e", fixtureProgram, "--", ...argv.slice(1)], {
        cwd: temporary, env: { SystemRoot: process.env.SystemRoot },
      }, events);
    },
  };
  try {
    await check(transport, statePath, () => runs);
  } finally {
    await unlink(statePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(temporary);
  }
}

test("explicit resume reads the same fabricated context through a second Node subprocess", async () => {
  await withRealPipes(async (transport, _statePath, launchCount) => {
    const fresh = startClaudeWindowsProbe(OPTIONS, transport);
    assert.equal((await fresh.closed).outcome, "root-result");
    const resumed = fresh.resumeFixture();
    assert.ok(resumed);
    const result = await resumed.closed;
    assert.equal(result.outcome, "root-result");
    assert.equal(result.execution, "explicit-resume");
    assert.equal(result.writerState, "unknown");
    assert.equal(launchCount(), 2);
  });
});

test("a missing or foreign saved fixture cannot generate a successful resumed result", async () => {
  const replaceWithForeign = (file: string) => writeFile(file, JSON.stringify({
    session: "fabricated-other-session", input: "fabricated-other-input", marker: MARKER,
  }));
  for (const change of [unlink, replaceWithForeign]) {
    await withRealPipes(async (transport, statePath, launchCount) => {
      const fresh = startClaudeWindowsProbe(OPTIONS, transport);
      assert.equal((await fresh.closed).outcome, "root-result");
      await change(statePath);
      const resumed = fresh.resumeFixture();
      assert.ok(resumed);
      const result = await resumed.closed;
      assert.equal(result.outcome, "disconnected");
      assert.equal(result.resultMatches, null);
      assert.equal(launchCount(), 2);
    });
  }
});
