import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { confirmHello } from "../src/coordination.ts";
import { run } from "../src/cli.ts";
import { COMMANDS, validateWire } from "../../src/lib/ttm-protocol.ts";
import { harnessIo, removeDir, tempDir } from "./helpers.ts";

test("connect reports the reviewed protocol and sends nothing", async () => {
  const hello = confirmHello();
  assert.equal(hello.protocolLine, "Server protocol: tickets-to-main.coordination version 1.");
  assert.equal(hello.runtimeLine, "Runtime: not served.");
  assert.equal(hello.servedLine, "Commands served: none.");
  assert.equal(hello.lines.includes("No network request was sent."), true);
  const dir = tempDir();
  try {
    const context = harnessIo();
    await run(["install", "--state", dir], context);
    context.out = "";
    const code = await run(["connect", "start", "--state", dir, "--computer", "fixture-computer"], context);
    assert.equal(code, 0, context.err);
    assert.match(context.out, /Server protocol: tickets-to-main\.coordination version 1\./);
    assert.match(context.out, /Runtime: not served\./);
    assert.match(context.out, /Commands served: none\./);
    assert.match(context.out, /No network request was sent\./);
    const status = harnessIo();
    await run(["status", "--state", dir], status);
    assert.match(status.out, /Compatible: no/);
    assert.match(status.out, /Ready for an assignment: no/);
    assert.match(status.out, /Runtime: not served\./);
    assert.match(status.out, /Commands served: none\./);
    assert.equal(status.out.includes("Signed in: yes"), false);
  } finally {
    removeDir(dir);
  }
});

test("coordination lists the unserved catalog and a send saves nothing", async () => {
  const dir = tempDir();
  try {
    const context = harnessIo();
    await run(["install", "--state", dir], context);
    const before = readFileSync(join(dir, "ledger.json"));
    context.out = "";
    const shown = await run(["coordination", "show"], context);
    assert.equal(shown, 0, context.err);
    for (const command of COMMANDS) assert.match(context.out, new RegExp(`${command.replaceAll(".", "\\.")}: (read|write), not served\\.`));
    assert.equal(context.out.includes("Fabricated"), false);
    assert.equal(context.out.includes("fabricated-board"), false);
    assert.equal(context.out.includes("example.com"), false);
    assert.equal(context.out.includes("runtime-qualified"), false);
    for (const command of ["connection.status", "repo.activation.read", "settings.effective.read", "job.admit", "reservation.decide"]) {
      context.out = "";
      const refused = await run(["coordination", "send", command], context);
      assert.equal(refused, 1, command);
      assert.match(context.out, /This coordination command is not served yet\./);
      assert.match(context.out, /The server does not answer this command yet\./);
      assert.match(context.out, /Nothing was saved\./);
      assert.equal(context.out.includes("Signed in"), false, command);
      assert.equal(context.out.includes("ready_for_assignment"), false, command);
      assert.equal(context.out.includes("queued"), false, command);
      assert.equal(context.out.includes("fab0"), false, command);
      assert.equal(context.out.includes("fabricated"), false, command);
    }
    context.out = "";
    const evidence = await run(["coordination", "send", "evidence.record"], context);
    assert.equal(evidence, 1);
    assert.match(context.out, /evidence\.record: not served\./);
    assert.equal(context.out.includes("queued"), false);
    context.out = "";
    context.err = "";
    const pasted = await run(["coordination", "send", "tp_fixture_key_not_a_real_grant"], context);
    assert.equal(pasted, 1);
    assert.match(context.out, /That coordination message is not valid\./);
    assert.equal(context.out.includes("tp_"), false);
    assert.equal(context.err.includes("tp_"), false);
    context.out = "";
    context.err = "";
    const extra = await run(["coordination", "send", "job.admit", "{\"effect\":\"write\"}"], context);
    assert.equal(extra, 1);
    assert.equal(context.out.includes("effect"), false);
    assert.equal(context.err.includes("effect"), false);
    assert.deepEqual(readFileSync(join(dir, "ledger.json")), before);
  } finally {
    removeDir(dir);
  }
});

test("a served hello is not a response this build accepts", () => {
  const served = {
    protocol: "tickets-to-main.coordination",
    version: 1,
    command: "protocol.hello",
    id: "fab00000000000000000000000000001",
    idempotency_key: null,
    body: { accepted_version: 1, runtime: "served" },
  };
  assert.equal(validateWire(served, "response").ok, false);
});
