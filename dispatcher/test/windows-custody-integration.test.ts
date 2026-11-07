import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { openCustody, processWindowsCredentialHost, type SecretToolRunner } from "../src/custody.ts";
import { emptyLedger, parseLedger } from "../src/ledger.ts";
import { createWindowsCredentialRunner } from "../src/windows-custody.ts";
import { removeDir, tempDir } from "./helpers.ts";

const DIGEST = "a".repeat(64);
function pendingLedger(): ReturnType<typeof emptyLedger> {
  return {
    ...emptyLedger(),
    connection: {
      phase: "pending", fixture: true, protocolRevision: "waiting-on-t1", origin: "https://fixture.test", computer: "fixture",
      userCode: "ABCD-EFGH", verificationUriComplete: "https://fixture.test/device?code=ABCD-EFGH",
      boardName: null, agentName: null, lastPollAt: null, fixturePollIndex: 0,
    },
  };
}

test("Windows default custody stays unavailable without a signed helper even when secret-tool is present", async () => {
  let called = false;
  const runner: SecretToolRunner = { async run() { called = true; return { code: 0, stdout: "" }; } };
  const custody = openCustody({}, true, runner, "win32");
  assert.deepEqual(custody.describe(), { kind: "unavailable", qualified: false });
  await assert.rejects(() => custody.put("board-key", "fabricated-sentinel"), /not available/);
  assert.equal(called, false);
});

test("older pending records load and optional Windows delivery receipts survive only with strict nonsecret fields", () => {
  const ledger = pendingLedger();
  assert.ok(parseLedger(JSON.stringify(ledger)));
  ledger.connection!.enrollmentId = "b".repeat(32);
  ledger.connection!.deliveryReceipt = {
    version: 1, scopeId: DIGEST, enrollmentId: "b".repeat(32), bindingDigest: DIGEST, credentialDigest: DIGEST,
    boardName: "Fabricated Board", agentName: "Dispatcher fixture",
  };
  const roundtrip = parseLedger(JSON.stringify(ledger));
  assert.deepEqual(roundtrip?.connection, ledger.connection);
  for (const patch of [{ version: 2 }, { scopeId: "*" }, { enrollmentId: "short" }, { credentialDigest: "not-a-digest" }, { secret: "must-not-persist" }, { boardName: 12 }]) {
    const changed = JSON.parse(JSON.stringify(ledger)) as { connection: { deliveryReceipt: Record<string, unknown> } };
    changed.connection.deliveryReceipt = { ...changed.connection.deliveryReceipt, ...patch };
    assert.equal(parseLedger(JSON.stringify(changed)), null);
  }
});


test("unchanged helper bytes with an injected CLR config or unpinned dependency receive no secret input", async () => {
  const directory = tempDir();
  const executable = join(directory, "credential-helper.exe");
  writeFileSync(executable, "fabricated executable bytes; never executed");
  const expected = createHash("sha256").update(readFileSync(executable)).digest("hex");
  const actualHost = processWindowsCredentialHost();
  let inputs = 0;
  const runner = createWindowsCredentialRunner({ executable: "C:\\VerifiedInstall\\credential-helper.exe", sha256: expected, releaseVerified: true }, { SystemRoot: "C:\\Windows" }, {
    executableSha256() { return actualHost.executableSha256(executable); },
    async invoke() { inputs += 1; return { code: 0, stdout: '{"status":"written"}', stderr: "" }; },
  });
  try {
    await runner.run("fabricated-sentinel");
    assert.equal(inputs, 1);
    for (const name of ["credential-helper.exe.config", "Unpinned.dll", "private"]) {
      const sidecar = join(directory, name);
      if (name === "private") mkdirSync(sidecar);
      else writeFileSync(sidecar, '<configuration><runtime><appDomainManagerAssembly value="Unpinned"/><appDomainManagerType value="Injected"/></runtime></configuration>');
      assert.equal(createHash("sha256").update(readFileSync(executable)).digest("hex"), expected);
      await assert.rejects(() => runner.run("fabricated-sentinel"), /could not complete/);
      assert.equal(inputs, 1);
      const refused = await actualHost.invoke({ argv: [executable], shell: false, env: {}, expectedSha256: expected }, "fabricated-sentinel");
      assert.equal(refused.code, null);
      assert.equal(refused.stdout, "");
      assert.equal(refused.stderr, "");
      if (name === "private") rmdirSync(sidecar); else unlinkSync(sidecar);
      assert.equal(await actualHost.executableSha256(executable), expected);
    }
  } finally { removeDir(directory); }
});
