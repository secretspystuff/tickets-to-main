import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { MemoryCustody, TestKeychain, UnavailableCustody, BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT } from "../src/custody.ts";
import { CODEX_INTERFACE_RULE } from "../src/status.ts";
import { harnessIo, io, removeDir, tempDir } from "./helpers.ts";

const FIXTURE = new URL("../fixtures/device-login.json", import.meta.url);

function text(dir: string): string {
  return readFileSync(join(dir, "ledger.json"), "utf8");
}

test("install records an early linux probe and leaves startup and installers unqualified", async () => {
  const dir = tempDir();
  try {
    const context = io();
    const code = await run(["install", "--state", dir], context);
    assert.equal(code, 0);
    assert.match(context.out, /Installed 0\.1\.0\./);
    assert.match(context.out, /Operating system: linux\. Early probe\./);
    assert.match(context.out, /Signed installers: unqualified\./);
    assert.match(context.out, /Startup: unregistered\./);
    const ledger = JSON.parse(text(dir)) as { install: { startup: string; signedInstallers: string; platform: string } };
    assert.equal(ledger.install.startup, "not-registered");
    assert.equal(ledger.install.signedInstallers, "not-qualified");
    assert.equal(ledger.install.platform, "early-linux-probe");
    assert.equal((lstatSync(dir).mode & 0o777), 0o700);
    assert.equal((lstatSync(join(dir, "ledger.json")).mode & 0o777), 0o600);
  } finally {
    removeDir(dir);
  }
});

test("windows and macos installs stay unqualified", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const dir = tempDir();
    try {
      const context = io({ platform });
      await run(["install", "--state", dir], context);
      assert.match(context.out, /Unqualified\./);
      const ledger = JSON.parse(text(dir)) as { install: { platform: string } };
      assert.equal(ledger.install.platform, platform === "win32" ? "unqualified-windows" : "unqualified-macos");
    } finally {
      removeDir(dir);
    }
  }
});

test("install refuses a state directory other people can read", async () => {
  const parent = tempDir();
  const dir = join(parent, "open");
  mkdirSync(dir, { mode: 0o755 });
  chmodSync(dir, 0o755);
  try {
    const context = io();
    const code = await run(["install", "--state", dir], context);
    assert.equal(code, 1);
    assert.match(context.err, /not private/);
    assert.equal(existsSync(join(dir, "ledger.json")), false);
  } finally {
    removeDir(parent);
  }
});

test("install does not follow a planted temporary symlink", async () => {
  const dir = tempDir();
  const outside = tempDir();
  const leaked = join(outside, "leaked.json");
  writeFileSync(leaked, "kept\n", { mode: 0o666 });
  chmodSync(dir, 0o700);
  symlinkSync(leaked, join(dir, "ledger.json.tmp"));
  try {
    const context = io();
    const code = await run(["install", "--state", dir], context);
    assert.equal(code, 0, context.err);
    assert.equal(readFileSync(leaked, "utf8"), "kept\n");
    assert.equal(lstatSync(join(dir, "ledger.json")).isSymbolicLink(), false);
    assert.equal((lstatSync(join(dir, "ledger.json")).mode & 0o777), 0o600);
  } finally {
    removeDir(dir);
    removeDir(outside);
  }
});

test("connect start refuses a percent-encoded secret and does not print it", async () => {
  const dir = tempDir();
  const path = join(dir, "encoded.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    challenge: { device_code: string; verification_uri_complete: string };
  };
  fixture.challenge.device_code = "secret-device-code";
  fixture.challenge.verification_uri_complete = "https://fixture.ticketsplease.test/device?k=tp%5Ffixture%5Fkey%5Fnot%5Fa%5Freal%5Fgrant";
  writeFileSync(path, JSON.stringify(fixture));
  try {
    const context = harnessIo();
    await run(["install", "--state", dir], context);
    context.out = "";
    context.err = "";
    const code = await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", path], context);
    assert.equal(code, 1);
    assert.equal(context.out.includes("tp%5F"), false);
    assert.equal(context.out.includes("tp_fixture"), false);
    assert.match(context.err, /includes a secret/);
    assert.equal(existsSync(join(dir, "ledger.json")), true);
    assert.equal(text(dir).includes("secret-device-code"), false);
    const nested = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      challenge: { device_code: string; verification_uri_complete: string };
    };
    nested.challenge.device_code = "secret-device-code";
    nested.challenge.verification_uri_complete = "https://fixture.ticketsplease.test/device?k=tp%2525255Ffixture%2525255Fkey%2525255Fnot%2525255Fa%2525255Freal%2525255Fgrant";
    writeFileSync(path, JSON.stringify(nested));
    context.out = "";
    context.err = "";
    const nestedCode = await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", path], context);
    assert.equal(nestedCode, 1);
    assert.equal(context.out.includes("%2525255F"), false);
    assert.match(context.err, /includes a secret/);
  } finally {
    removeDir(dir);
  }
});

test("install refuses to follow a ledger symlink", async () => {
  const dir = tempDir();
  const outside = tempDir();
  const leaked = join(outside, "leaked.json");
  writeFileSync(leaked, "{\"kept\":true}\n");
  symlinkSync(leaked, join(dir, "ledger.json"));
  try {
    const context = io();
    const code = await run(["install", "--state", dir], context);
    assert.equal(code, 1);
    assert.match(context.err, /link/);
    assert.equal(readFileSync(leaked, "utf8"), "{\"kept\":true}\n");
  } finally {
    removeDir(dir);
    removeDir(outside);
  }
});

test("connect without a fixture sends nothing and does not pretend to be signed in", async () => {
  const dir = tempDir();
  try {
    const context = io();
    await run(["install", "--state", dir], context);
    context.out = "";
    const code = await run(["connect", "start", "--state", dir, "--computer", "fixture-computer"], context);
    assert.equal(code, 0);
    assert.match(context.out, /Server protocol: tickets-to-main\.coordination version 1\./);
    assert.match(context.out, /Runtime: not served\./);
    assert.match(context.out, /No network request was sent\./);
    assert.doesNotMatch(context.out, /waiting on the reviewed/);
    const status = harnessIo({ custody: context.custody });
    await run(["status", "--state", dir], status);
    assert.match(status.out, /Board: not connected/);
    assert.match(status.out, /Signed in: no/);
    assert.match(status.out, /Ready for an assignment: no/);
    assert.match(status.out, new RegExp(CODEX_INTERFACE_RULE.replace(/[.]/g, "\\.")));
  } finally {
    removeDir(dir);
  }
});

test("fixture connect stores the key only in custody and survives a restart of the record", async () => {
  const dir = tempDir();
  const keychain = join(dir, "keychain.json");
  const custody = new TestKeychain(keychain);
  try {
    const context = harnessIo({ custody });
    await run(["install", "--state", dir], context);
    const started = harnessIo({ custody });
    const start = await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], started);
    assert.equal(start, 0);
    assert.match(started.out, /Open https:\/\/fixture\.ticketsplease\.test\/device\?code=ABCD-EFGH and approve code ABCD-EFGH\./);
    assert.doesNotMatch(started.out, /fixture-device-code-not-shown/);
    assert.equal(text(dir).includes("fixture-device-code-not-shown"), false);
    assert.equal(text(dir).includes("tp_"), false);
    const early = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:00.000Z") });
    await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], early);
    assert.match(early.out, /Waiting for approval/);
    const tooSoon = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:04.000Z") });
    const waited = await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], tooSoon);
    assert.equal(waited, 0);
    assert.match(tooSoon.out, /Wait 5 seconds/);
    const approved = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:06.000Z") });
    const done = await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], approved);
    assert.equal(done, 0);
    assert.match(approved.out, /Connected to the board Fixture Board as Runner \(fixture-computer\)\./);
    assert.match(approved.out, /Connection: fixture\./);
    assert.doesNotMatch(approved.out, /tp_fixture_key_not_a_real_grant/);
    assert.equal(text(dir).includes("tp_"), false);
    assert.equal(text(dir).includes("fixture-device-code-not-shown"), false);
    assert.equal(await custody.get(BOARD_KEY_ACCOUNT), "tp_fixture_key_not_a_real_grant");
    assert.equal(await custody.get(DEVICE_CODE_ACCOUNT), null);
    const signed = harnessIo({ custody });
    await run(["status", "--state", dir], signed);
    assert.match(signed.out, /Signed in: yes/);
    assert.match(signed.out, /Keychain: test double, unqualified/);
    assert.match(signed.out, /Ready for an assignment: no/);
    assert.equal((lstatSync(keychain).mode & 0o777), 0o600);
    const restarted = harnessIo({ custody: new MemoryCustody() });
    const status = await run(["status", "--state", dir], restarted);
    assert.equal(status, 0);
    assert.match(restarted.out, /Board: Fixture Board \(fixture\)/);
    assert.match(restarted.out, /Signed in: no/);
    assert.match(restarted.out, /Keychain: secret missing/);
    assert.match(restarted.out, /Ready for an assignment: no/);
    const again = harnessIo({ custody });
    const refused = await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], again);
    assert.equal(refused, 1);
    assert.match(again.out, /already connected/);
    assert.equal(await custody.get(BOARD_KEY_ACCOUNT), "tp_fixture_key_not_a_real_grant");
  } finally {
    removeDir(dir);
  }
});

test("a denied or expired fixture saves no key", async () => {
  const dir = tempDir();
  const denied = join(dir, "denied.json");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { polls: unknown[] };
  fixture.polls = [{ error: "access_denied" }];
  writeFileSync(denied, JSON.stringify(fixture));
  const custody = new MemoryCustody();
  try {
    const context = harnessIo({ custody });
    await run(["install", "--state", dir], context);
    await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", denied], context);
    context.out = "";
    const code = await run(["connect", "poll", "--state", dir, "--fixture", denied], context);
    assert.equal(code, 0);
    assert.match(context.out, /Your human said no\./);
    assert.equal(await custody.get(BOARD_KEY_ACCOUNT), null);
    assert.equal(await custody.get(DEVICE_CODE_ACCOUNT), null);
  } finally {
    removeDir(dir);
  }
});

test("poll refuses a swapped fixture and a missing keychain", async () => {
  const dir = tempDir();
  try {
    const custody = new MemoryCustody();
    const context = harnessIo({ custody });
    await run(["install", "--state", dir], context);
    await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], context);
    const swapped = JSON.parse(readFileSync(FIXTURE, "utf8")) as { challenge: { user_code: string } };
    swapped.challenge.user_code = "ZZZZ-ZZZZ";
    const path = join(dir, "swapped.json");
    writeFileSync(path, JSON.stringify(swapped));
    const mismatch = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:10.000Z") });
    const code = await run(["connect", "poll", "--state", dir, "--fixture", path], mismatch);
    assert.equal(code, 1);
    assert.match(mismatch.out, /does not match/);
    await custody.delete(DEVICE_CODE_ACCOUNT);
    const missing = harnessIo({ custody, now: () => Date.parse("2026-10-25T00:00:20.000Z") });
    const lost = await run(["connect", "poll", "--state", dir, "--fixture", FIXTURE.pathname], missing);
    assert.equal(lost, 1);
    assert.match(missing.out, /missing from the keychain/);
  } finally {
    removeDir(dir);
  }
});

test("a fixture connection is refused unless the test switch is on", async () => {
  const dir = tempDir();
  const custody = new MemoryCustody();
  try {
    await run(["install", "--state", dir], io());
    const context = io({ custody });
    const code = await run(["connect", "start", "--state", dir, "--computer", "fixture-computer", "--fixture", FIXTURE.pathname], context);
    assert.equal(code, 1);
    assert.match(context.out, /only for the test harness/);
    assert.match(context.out, /No network request was sent\./);
    assert.equal(await custody.get(DEVICE_CODE_ACCOUNT), null);
    assert.equal(text(dir).includes("ABCD-EFGH"), false);
  } finally {
    removeDir(dir);
  }
});

test("connect start refuses when the keychain is unavailable", async () => {
  const dir = tempDir();
  try {
    const context = io({ custody: new UnavailableCustody(), secretTool: false, env: {} });
    await run(["install", "--state", dir], context);
    context.out = "";
    const code = await run(["connect", "start", "--state", dir, "--fixture", FIXTURE.pathname], context);
    assert.equal(code, 1);
    assert.match(context.out, /no key was saved to a file/);
    assert.equal(text(dir).includes("ABCD-EFGH"), false);
  } finally {
    removeDir(dir);
  }
});

test("the bin installs into a private state directory", () => {
  const dir = tempDir();
  const bin = fileURLToPath(new URL("../bin/tickets-to-main.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", bin, "install", "--state", dir], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Installed 0\.1\.0\./);
    assert.match(result.stdout, /Startup: unregistered\./);
  } finally {
    removeDir(dir);
  }
});

test("health fails until a private install exists", async () => {
  const dir = tempDir();
  try {
    const missing = io();
    const code = await run(["health", "--state", dir], missing);
    assert.equal(code, 1);
    assert.match(missing.out, /Health: not installed/);
    await run(["install", "--state", dir], io());
    const ready = io();
    const ok = await run(["health", "--state", dir], ready);
    assert.equal(ok, 0);
    assert.match(ready.out, /Health: local record ok/);
  } finally {
    removeDir(dir);
  }
});
