import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli.ts";
import { BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT } from "../src/custody.ts";
import { harnessIo, removeDir, tempDir } from "./helpers.ts";
import { WindowsCredentialCustody, type WindowsCredentialRunner } from "../src/windows-custody.ts";

const FIXTURE = new URL("../fixtures/device-login.json", import.meta.url);
const SCOPE = "c".repeat(64);
type Credential = { target: string; blob: string };
type Request = { operation: string; target?: string; credential?: Credential };
type Pending = Record<string, unknown>;
function pending(stateDir: string): Pending {
  return (JSON.parse(readFileSync(join(stateDir, "ledger.json"), "utf8")) as { connection: Pending }).connection;
}
function identity(value: Pending): unknown {
  return Object.fromEntries(["phase", "fixture", "protocolRevision", "origin", "computer", "userCode", "verificationUriComplete"].map((key) => [key, value[key]]));
}
function enrollmentStore(mode: "reject-write" | "persist-then-verification-error") {
  const entries = new Map<string, Credential>();
  const calls: Request[] = [];
  let verificationFailurePending = false;
  const runner: WindowsCredentialRunner = { async run(input) {
    const request = JSON.parse(input) as Request;
    calls.push(request);
    let value: unknown;
    if (request.operation === "write") {
      if (request.credential!.target.endsWith(`/${BOARD_KEY_ACCOUNT}`) && mode === "reject-write") value = { status: "error", code: 5 };
      else {
        entries.set(request.credential!.target, structuredClone(request.credential!));
        if (request.credential!.target.endsWith(`/${BOARD_KEY_ACCOUNT}`)) verificationFailurePending = true;
        value = { status: "written" };
      }
    } else if (request.operation === "delete") value = { status: entries.delete(request.target!) ? "deleted" : "not-found" };
    else if (request.target!.endsWith(`/${BOARD_KEY_ACCOUNT}`) && verificationFailurePending) {
      verificationFailurePending = false;
      value = { status: "error", code: 5 };
    } else value = entries.has(request.target!) ? { status: "found", credential: structuredClone(entries.get(request.target!)) } : { status: "not-found" };
    return { code: 0, stdout: JSON.stringify(value), stderr: "" };
  } };
  return { runner, entries, calls };
}

test("a failed board-key write preserves the exact device code and pending connection identity", async () => {
  const stateDir = tempDir();
  const store = enrollmentStore("reject-write");
  const custody = new WindowsCredentialCustody(store.runner, SCOPE);
  try {
    const context = harnessIo({ custody });
    assert.equal(await run(["install", "--state", stateDir], context), 0);
    assert.equal(await run(["connect", "start", "--state", stateDir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], context), 0);
    assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", FIXTURE.pathname], context), 0);
    const originalPending = pending(stateDir);
    const originalDevice = await custody.get(DEVICE_CODE_ACCOUNT);
    assert.ok(originalDevice);
    context.now = () => Date.parse("2026-10-25T00:00:06.000Z");
    assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", FIXTURE.pathname], context), 1);
    assert.deepEqual(identity(pending(stateDir)), identity(originalPending));
    assert.equal(await custody.get(DEVICE_CODE_ACCOUNT), originalDevice);
    assert.equal(await custody.get(BOARD_KEY_ACCOUNT), null);
    assert.equal(store.calls.some((call) => call.operation === "delete"), false);
    assert.equal(context.out.includes("Signed in: yes"), false);
    assert.equal(context.err.includes(originalDevice), false);
  } finally { removeDir(stateDir); }
});

for (const recoveryKey of ["original", "changed", "missing"] as const) {
  test(`persisted key with failed verification, restart and ${recoveryKey} key uses one-shot enrollment honestly`, async () => {
    const root = tempDir();
    const stateDir = join(root, "state");
    const fixturePath = join(root, "one-shot-enrollment.json");
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { polls: { error?: string; key?: string }[] };
    const deliveredKey = fixture.polls.find((poll) => poll.key)?.key;
    assert.ok(deliveredKey);
    writeFileSync(fixturePath, JSON.stringify(fixture));
    const store = enrollmentStore("persist-then-verification-error");
    const custody = new WindowsCredentialCustody(store.runner, SCOPE);
    try {
      const context = harnessIo({ custody });
      assert.equal(await run(["install", "--state", stateDir], context), 0);
      assert.equal(await run(["connect", "start", "--state", stateDir, "--computer", "fixture-computer", "--fixture", fixturePath], context), 0);
      assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", fixturePath], context), 0);
      const originalPending = pending(stateDir);
      const originalDevice = await custody.get(DEVICE_CODE_ACCOUNT);
      assert.ok(originalDevice);
      context.now = () => Date.parse("2026-10-25T00:00:06.000Z");
      assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", fixturePath], context), 1);
      assert.deepEqual(identity(pending(stateDir)), identity(originalPending));
      assert.equal(await custody.get(DEVICE_CODE_ACCOUNT), originalDevice);
      assert.equal(await custody.get(BOARD_KEY_ACCOUNT), deliveredKey);
      assert.equal(store.calls.some((call) => call.operation === "delete"), false);
      const boardTarget = [...store.entries.keys()].find((value) => value.endsWith(`/${BOARD_KEY_ACCOUNT}`));
      assert.ok(boardTarget);
      const stored = structuredClone(store.entries.get(boardTarget)!);
      assert.equal(stored.blob, Buffer.from(deliveredKey).toString("base64"));
      const disk = readFileSync(join(stateDir, "ledger.json"), "utf8");
      for (const secret of [originalDevice, deliveredKey]) {
        assert.equal(disk.includes(secret), false);
        assert.equal(disk.includes(Buffer.from(secret).toString("base64")), false);
        assert.equal(context.out.includes(secret), false);
        assert.equal(context.err.includes(secret), false);
      }
      fixture.polls = fixture.polls.filter((poll) => !poll.key);
      writeFileSync(fixturePath, JSON.stringify(fixture));
      if (recoveryKey === "changed") store.entries.set(boardTarget, { ...stored, blob: Buffer.from("different-fabricated-key").toString("base64") });
      if (recoveryKey === "missing") store.entries.delete(boardTarget);
      const beforeRetry = structuredClone(store.entries.get(boardTarget));
      const restarted = new WindowsCredentialCustody(store.runner, SCOPE);
      const recovered = harnessIo({ custody: restarted, now: () => Date.parse("2026-10-25T00:00:20.000Z") });
      const code = await run(["connect", "poll", "--state", stateDir, "--fixture", fixturePath], recovered);
      if (recoveryKey === "original") {
        assert.equal(code, 0);
        assert.equal(pending(stateDir).phase, "approved");
        assert.equal(await restarted.get(BOARD_KEY_ACCOUNT), deliveredKey);
        assert.equal(await restarted.get(DEVICE_CODE_ACCOUNT), null);
      } else {
        assert.equal(code, 1);
        assert.deepEqual(identity(pending(stateDir)), identity(originalPending));
        assert.equal(await restarted.get(DEVICE_CODE_ACCOUNT), originalDevice);
      }
      assert.deepEqual(store.entries.get(boardTarget), beforeRetry);
      assert.equal(store.calls.filter((call) => call.operation === "write" && call.credential!.target.endsWith(`/${BOARD_KEY_ACCOUNT}`)).length, 1);
      assert.equal(store.calls.filter((call) => call.operation === "write" && call.credential!.target.endsWith(`/${DEVICE_CODE_ACCOUNT}`)).length, 1);
      for (const secret of [originalDevice, deliveredKey]) {
        assert.equal(recovered.out.includes(secret), false);
        assert.equal(recovered.err.includes(secret), false);
      }
    } finally { removeDir(root); }
  });
}

type EnrollmentFixture = {
  challenge: { device_code: string; user_code: string; verification_uri_complete: string };
  polls: { error?: string; key?: string }[];
};
const target = (scope: string, account: string) => `TicketsToMain/dispatcher/v1/${scope}/${account}`;
function ownCredential(scope: string, account: string, secret: string) {
  return { target: target(scope, account), flags: 0, type: 1, persist: 2, username: "Tickets to Main Dispatcher v1", blob: Buffer.from(secret).toString("base64") };
}
async function uncertainEnrollment(root: string) {
  const stateDir = join(root, "state");
  const fixturePath = join(root, "one-shot-source.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as EnrollmentFixture;
  const deliveredKey = fixture.polls.find((poll) => poll.key)?.key;
  assert.ok(deliveredKey);
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const store = enrollmentStore("persist-then-verification-error");
  const custody = new WindowsCredentialCustody(store.runner, SCOPE);
  const context = harnessIo({ custody });
  assert.equal(await run(["install", "--state", stateDir], context), 0);
  assert.equal(await run(["connect", "start", "--state", stateDir, "--computer", "fixture-computer", "--fixture", fixturePath], context), 0);
  assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", fixturePath], context), 0);
  const deviceCode = await custody.get(DEVICE_CODE_ACCOUNT);
  assert.ok(deviceCode);
  context.now = () => Date.parse("2026-10-25T00:00:06.000Z");
  assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", fixturePath], context), 1);
  assert.equal(await custody.get(BOARD_KEY_ACCOUNT), deliveredKey);
  assert.equal(await custody.get(DEVICE_CODE_ACCOUNT), deviceCode);
  const receipt = pending(stateDir).deliveryReceipt;
  assert.ok(receipt && typeof receipt === "object");
  fixture.polls = fixture.polls.filter((poll) => !poll.key);
  writeFileSync(fixturePath, JSON.stringify(fixture));
  return { stateDir, fixturePath, fixture, store, custody, context, receipt, deliveredKey, deviceCode };
}

test("a fresh pending connection cannot adopt an existing key without a delivery receipt", async () => {
  const root = tempDir();
  const stateDir = join(root, "state");
  const fixturePath = join(root, "pending-without-delivery.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as EnrollmentFixture;
  const existingKey = fixture.polls.find((poll) => poll.key)?.key;
  assert.ok(existingKey);
  fixture.polls = fixture.polls.filter((poll) => !poll.key);
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const store = enrollmentStore("reject-write");
  store.entries.set(target(SCOPE, BOARD_KEY_ACCOUNT), ownCredential(SCOPE, BOARD_KEY_ACCOUNT, existingKey));
  const custody = new WindowsCredentialCustody(store.runner, SCOPE);
  try {
    const context = harnessIo({ custody });
    assert.equal(await run(["install", "--state", stateDir], context), 0);
    assert.equal(await run(["connect", "start", "--state", stateDir, "--computer", "fixture-computer", "--fixture", fixturePath], context), 0);
    assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", fixturePath], context), 0);
    const originalPending = pending(stateDir);
    assert.ok(originalPending.deliveryReceipt === undefined || originalPending.deliveryReceipt === null);
    const originalDevice = await custody.get(DEVICE_CODE_ACCOUNT);
    assert.ok(originalDevice);
    const entriesBefore = structuredClone(store.entries);
    const callsBefore = store.calls.length;
    const restarted = new WindowsCredentialCustody(store.runner, SCOPE);
    const retry = harnessIo({ custody: restarted, now: () => Date.parse("2026-10-25T00:00:20.000Z") });
    assert.equal(await run(["connect", "poll", "--state", stateDir, "--fixture", fixturePath], retry), 1);
    assert.deepEqual(pending(stateDir), originalPending);
    assert.deepEqual(store.entries, entriesBefore);
    assert.equal(await restarted.get(BOARD_KEY_ACCOUNT), existingKey);
    assert.equal(await restarted.get(DEVICE_CODE_ACCOUNT), originalDevice);
    assert.equal(store.calls.slice(callsBefore).every((call) => call.operation === "read"), true);
  } finally { removeDir(root); }
});

test("a valid delivery receipt transplanted into a different connection cannot adopt its matching key", async () => {
  const root = tempDir();
  try {
    const source = await uncertainEnrollment(root);
    const originalConnection = pending(source.stateDir);
    const ledgerPath = join(source.stateDir, "ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { connection: Pending | null };
    ledger.connection = null;
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    const freshFixture = structuredClone(source.fixture);
    freshFixture.challenge.device_code = "different-fabricated-device-code";
    freshFixture.challenge.user_code = "WXYZ-5678";
    freshFixture.challenge.verification_uri_complete = "https://fixture.ticketsplease.test/device?code=WXYZ-5678";
    const freshPath = join(root, "different-pending-connection.json");
    writeFileSync(freshPath, JSON.stringify(freshFixture));
    const context = harnessIo({ custody: source.custody });
    assert.equal(await run(["connect", "start", "--state", source.stateDir, "--computer", "fixture-computer", "--fixture", freshPath], context), 0);
    assert.equal(await run(["connect", "poll", "--state", source.stateDir, "--fixture", freshPath], context), 0);
    const fresh = pending(source.stateDir);
    assert.notEqual(fresh.userCode, source.fixture.challenge.user_code);
    assert.notEqual(await source.custody.get(DEVICE_CODE_ACCOUNT), source.deviceCode);
    fresh.deliveryReceipt = structuredClone(source.receipt);
    fresh.boardName = originalConnection.boardName;
    fresh.agentName = originalConnection.agentName;
    const saved = JSON.parse(readFileSync(ledgerPath, "utf8")) as { connection: Pending };
    saved.connection = fresh;
    writeFileSync(ledgerPath, JSON.stringify(saved));
    const entriesBefore = structuredClone(source.store.entries);
    const pendingBefore = pending(source.stateDir);
    const callsBefore = source.store.calls.length;
    const restarted = new WindowsCredentialCustody(source.store.runner, SCOPE);
    const retry = harnessIo({ custody: restarted, now: () => Date.parse("2026-10-25T00:00:20.000Z") });
    assert.equal(await run(["connect", "poll", "--state", source.stateDir, "--fixture", freshPath], retry), 1);
    assert.deepEqual(pending(source.stateDir), pendingBefore);
    assert.deepEqual(source.store.entries, entriesBefore);
    assert.equal(await restarted.get(BOARD_KEY_ACCOUNT), source.deliveredKey);
    assert.equal(await restarted.get(DEVICE_CODE_ACCOUNT), freshFixture.challenge.device_code);
    assert.equal(source.store.calls.slice(callsBefore).every((call) => call.operation === "read"), true);
  } finally { removeDir(root); }
});

test("a valid receipt replayed in a different custody scope cannot adopt matching key and device entries", async () => {
  const root = tempDir();
  const otherScope = "d".repeat(64);
  try {
    const source = await uncertainEnrollment(root);
    for (const account of [BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT]) {
      const original = source.store.entries.get(target(SCOPE, account));
      assert.ok(original);
      source.store.entries.set(target(otherScope, account), { ...structuredClone(original), target: target(otherScope, account) });
    }
    const entriesBefore = structuredClone(source.store.entries);
    const pendingBefore = pending(source.stateDir);
    const callsBefore = source.store.calls.length;
    const transplanted = new WindowsCredentialCustody(source.store.runner, otherScope);
    assert.equal(await transplanted.get(BOARD_KEY_ACCOUNT), source.deliveredKey);
    assert.equal(await transplanted.get(DEVICE_CODE_ACCOUNT), source.deviceCode);
    const retry = harnessIo({ custody: transplanted, now: () => Date.parse("2026-10-25T00:00:20.000Z") });
    assert.equal(await run(["connect", "poll", "--state", source.stateDir, "--fixture", source.fixturePath], retry), 1);
    assert.deepEqual(pending(source.stateDir), pendingBefore);
    assert.deepEqual(source.store.entries, entriesBefore);
    assert.equal(source.store.entries.size, 4);
    assert.equal(source.store.calls.slice(callsBefore).every((call) => call.operation === "read"), true);
  } finally { removeDir(root); }
});
