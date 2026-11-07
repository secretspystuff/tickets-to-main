import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyHarnessEvidence, checkClaim, claimCovers } from "../src/adapters/contract.ts";
import {
  CODEX_INTERFACE_RULE,
  discoverCodex,
  documentedCodexClaim,
  runCodexCliAssignment,
} from "../src/adapters/codex.ts";
import { discoverStub, stubClaim } from "../src/adapters/stub.ts";
import { run } from "../src/cli.ts";
import { toolEnv } from "../src/command.ts";
import { io, removeDir, scriptedRunner, tempDir } from "./helpers.ts";
import { CLI_RESULT, scriptedTransport } from "./native-fixtures.ts";

test("Codex cli and app-server are separate documented interfaces", async () => {
  const cli = scriptedRunner((argv) => {
    if (argv[1] === "exec") return { code: 0, stdout: "usage\n", stderr: "" };
    return { code: 0, stdout: "codex-cli 0.163.0\n", stderr: "" };
  });
  const discoveredCli = await discoverCodex("cli", cli);
  assert.deepEqual(cli.calls.map((call) => call.argv), [["codex", "--version"], ["codex", "exec", "--help"]]);
  assert.equal(discoveredCli.claim.interfaceId, "cli");
  assert.equal(discoveredCli.claim.qualification, "documented");
  assert.equal(discoveredCli.version, "0.163.0");
  assert.deepEqual(discoveredCli.claim.interchangeableWith, []);
  assert.equal(discoveredCli.claim.capabilities.assignment, "unknown");

  const appServer = scriptedRunner((argv) => {
    if (argv[1] === "app-server") return { code: 0, stdout: "app-server experimental\n", stderr: "" };
    return { code: 0, stdout: "codex-cli 0.163.0\n", stderr: "" };
  });
  const discoveredApp = await discoverCodex("app-server", appServer);
  assert.deepEqual(appServer.calls.map((call) => call.argv), [["codex", "--version"], ["codex", "app-server", "--help"]]);
  assert.equal(discoveredApp.claim.experimental, true);
  assert.equal(discoveredApp.claim.interfaceId, "app-server");
  assert.equal(CODEX_INTERFACE_RULE.includes("separate interfaces"), true);
});

test("cli harness evidence cannot qualify app-server and never includes the prompt", async () => {
  const runner = scriptedTransport((_input, events) => events.stdout(CLI_RESULT));
  const observation = await runCodexCliAssignment(
    { assignmentId: "fixture-1", prompt: "Say ready.", workspace: "/work/fixture", model: null, effort: null },
    runner,
    { HOME: "/home/fixture", PATH: "/usr/bin", TP_KEY: "tp_fixture_key_not_a_real_grant", TICKETS_TO_MAIN_STATE: "/tmp/state" },
    ["tp_fixture_key_not_a_real_grant"],
  );
  assert.equal(observation.interfaceId, "cli");
  assert.deepEqual(observation.argv, ["codex", "exec", "--json", "-"]);
  assert.equal(observation.stdin, "");
  assert.equal(JSON.stringify(observation).includes("Say ready."), false);
  assert.equal(runner.calls[0]?.input.join(""), "Say ready.");
  assert.equal(runner.calls[0]?.env?.TP_KEY, undefined);
  assert.equal(runner.calls[0]?.env?.TICKETS_TO_MAIN_STATE, undefined);
  assert.equal(runner.calls[0]?.env?.HOME, "/home/fixture");
  const cli = applyHarnessEvidence(documentedCodexClaim("cli"), observation);
  assert.equal(cli.qualification, "harness-passed");
  assert.equal(cli.capabilities.assignment, "supported");
  assert.equal(claimCovers({ vendor: "codex", interfaceId: "app-server", capability: "assignment" }, cli), false);
  assert.throws(() => applyHarnessEvidence(documentedCodexClaim("app-server"), observation), /Evidence for cli cannot qualify app-server/);
});

test("unknown model and effort are refused before a process starts, and secrets are not sent", async () => {
  const runner = scriptedTransport(() => {});
  const model = await runCodexCliAssignment(
    { assignmentId: "fixture-1", prompt: "Say ready.", workspace: "/work/fixture", model: "gpt-6", effort: null },
    runner,
    {},
    [],
  );
  assert.equal(model.spawned, false);
  assert.match(model.reason ?? "", /Model selection is unknown/);
  assert.equal(runner.calls.length, 0);
  const secret = await runCodexCliAssignment(
    { assignmentId: "fixture-1", prompt: "use tp_fixture_key_not_a_real_grant", workspace: "/work/fixture", model: null, effort: null },
    runner,
    {},
    ["tp_fixture_key_not_a_real_grant"],
  );
  assert.equal(secret.spawned, false);
  assert.match(secret.reason ?? "", /Dispatcher secret/);
});

test("discovery does not read workspace instructions", () => {
  const dir = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "SECRET_INSTRUCTION do not copy");
    const found = discoverStub(dir);
    assert.equal(found.includes("SECRET_INSTRUCTION"), false);
  } finally {
    removeDir(dir);
  }
});

test("the stub is not person-facing and runtime qualification is rejected", () => {
  assert.equal(checkClaim(stubClaim()).length, 0);
  assert.equal(checkClaim({ ...stubClaim(), personFacing: true }).some((failure) => failure.code === "stub"), true);
  assert.equal(checkClaim({ ...documentedCodexClaim("cli"), interchangeableWith: ["app-server"] }).some((failure) => failure.code === "interchangeable"), true);
  assert.equal(checkClaim({ ...documentedCodexClaim("cli"), qualification: "runtime-qualified" }).some((failure) => failure.code === "runtime"), true);
});

test("toolEnv drops dispatcher secrets and keeps the person's home", () => {
  const env = toolEnv({ HOME: "/home/fixture", PATH: "/bin", TP_KEY: "tp_fixture_key_not_a_real_grant" }, ["tp_fixture_key_not_a_real_grant"]);
  assert.equal(env.HOME, "/home/fixture");
  assert.equal(env.TP_KEY, undefined);
});

test("status keeps a discovered cli distinct from undiscovered app-server", async () => {
  const dir = tempDir();
  try {
    const runner = scriptedRunner((argv) => {
      if (argv[1] === "--version") return { code: 0, stdout: "codex-cli 0.163.0\n", stderr: "" };
      return { code: 0, stdout: "usage\n", stderr: "" };
    });
    const context = io({ runner });
    await run(["install", "--state", dir], context);
    const code = await run(["tool", "discover", "codex", "--interface", "cli", "--state", dir], context);
    assert.equal(code, 0);
    assert.match(context.out, /Codex cli: documented\./);
    assert.match(context.out, /separate interfaces/);
    assert.match(context.out, /Ready for an assignment: no/);
    const status = io();
    await run(["status", "--state", dir], status);
    assert.match(status.out, /Codex cli: documented/);
    assert.match(status.out, /Codex app-server: undiscovered/);
    assert.match(status.out, /Ready for an assignment: no/);
    const missing = io({ runner: scriptedRunner(() => ({ code: null, stdout: "", stderr: "", error: "spawn codex ENOENT" })) });
    const unavailable = await run(["tool", "discover", "codex", "--interface", "app-server", "--state", dir], missing);
    assert.equal(unavailable, 0);
    assert.match(missing.out, /Codex app-server: unavailable\./);
  } finally {
    removeDir(dir);
  }
});
