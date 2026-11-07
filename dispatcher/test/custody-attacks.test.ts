import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFixture } from "../src/protocol.ts";
import { openCustody, SecretToolCustody, type SecretToolRunner } from "../src/custody.ts";
import { assertPublicRecord, parseLedger } from "../src/ledger.ts";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/device-login.json", import.meta.url), "utf8")) as unknown;

test("the bundled fixture is fabricated and is not a live server", () => {
  const parsed = parseFixture(fixture);
  assert.equal(parsed.serverIntegration, false);
  assert.equal(parsed.protocolRevision, "waiting-on-t1");
  assert.equal(parsed.origin, "https://fixture.ticketsplease.test");
});

test("a fixture cannot point at a live origin, claim a server, or add a field", () => {
  const live = structuredClone(fixture) as { origin: string; challenge: { verification_uri_complete: string } };
  live.origin = "https://ticketsplease.dev";
  live.challenge.verification_uri_complete = "https://ticketsplease.dev/device?code=ABCD-EFGH";
  assert.throws(() => parseFixture(live), /not a \.test or localhost/);
  const claimed = structuredClone(fixture) as { serverIntegration: boolean };
  claimed.serverIntegration = true;
  assert.throws(() => parseFixture(claimed), /live server/);
  const extra = { ...(fixture as object), boardId: "board-1" };
  assert.throws(() => parseFixture(extra), /field this build does not accept/);
});

test("a percent-encoded key or device code is refused before it is shown", () => {
  const encoded = structuredClone(fixture) as {
    challenge: { device_code: string; verification_uri_complete: string };
  };
  encoded.challenge.device_code = "secret-device-code";
  encoded.challenge.verification_uri_complete = "https://fixture.ticketsplease.test/device?k=tp%5Ffixture%5Fkey%5Fnot%5Fa%5Freal%5Fgrant";
  assert.throws(() => parseFixture(encoded), /includes a secret/);
  const encodedDevice = structuredClone(fixture) as { challenge: { device_code: string; verification_uri_complete: string } };
  encodedDevice.challenge.device_code = "secret-device-code";
  encodedDevice.challenge.verification_uri_complete = "https://fixture.ticketsplease.test/device?k=secret%2Ddevice%2Dcode";
  assert.throws(() => parseFixture(encodedDevice), /includes a secret/);
  const nested = structuredClone(fixture) as { challenge: { device_code: string; verification_uri_complete: string } };
  nested.challenge.device_code = "secret-device-code";
  nested.challenge.verification_uri_complete = "https://fixture.ticketsplease.test/device?k=tp%2525255Ffixture%2525255Fkey%2525255Fnot%2525255Fa%2525255Freal%2525255Fgrant";
  assert.throws(() => parseFixture(nested), /includes a secret/);
  const nestedDevice = structuredClone(fixture) as { challenge: { device_code: string; verification_uri_complete: string } };
  nestedDevice.challenge.device_code = "secret-device-code";
  nestedDevice.challenge.verification_uri_complete = "https://fixture.ticketsplease.test/device?k=secret%2525252Ddevice%2525252Dcode";
  assert.throws(() => parseFixture(nestedDevice), /includes a secret/);
  let buried = "tp_fixture_key_not_a_real_grant";
  for (let i = 0; i < 12; i += 1) buried = buried.replaceAll("%", "%25").replaceAll("_", "%5F");
  const tooDeep = structuredClone(fixture) as { challenge: { verification_uri_complete: string } };
  tooDeep.challenge.verification_uri_complete = `https://fixture.ticketsplease.test/device?k=${buried}`;
  assert.throws(() => parseFixture(tooDeep), /could not be read/);
  assert.throws(() => assertPublicRecord({ note: buried }, []), /could not be read safely/);
  assert.throws(() => assertPublicRecord({
    note: "https://fixture.ticketsplease.test/device?k=tp%2525255Ffixture%2525255Fkey%2525255Fnot%2525255Fa%2525255Freal%2525255Fgrant",
  }, []), /cannot store a key/);
});

test("the local record rejects keys, device codes and secret field names", () => {
  assert.throws(() => assertPublicRecord({ note: "tp_fixture_key_not_a_real_grant" }, []), /cannot store a key/);
  assert.throws(() => assertPublicRecord({ device_code: "fixture-device-code-not-shown" }, []), /cannot store device_code/);
  assert.throws(() => assertPublicRecord({ board: "prefix fixture-device-code-not-shown suffix" }, ["fixture-device-code-not-shown"]), /included a secret/);
  const tampered = JSON.stringify({
    version: 1,
    install: null,
    connection: null,
    tools: [],
    key: "tp_fixture_key_not_a_real_grant",
  });
  assert.equal(parseLedger(tampered), null);
});

test("openCustody uses the test double only for the explicit test switch", () => {
  const runner: SecretToolRunner = { run: () => Promise.resolve({ code: 0, stdout: "" }) };
  assert.equal(openCustody({}, false, runner).describe().kind, "unavailable");
  assert.equal(openCustody({}, true, runner).describe().kind, "secret-tool");
  assert.throws(() => openCustody({ TICKETS_TO_MAIN_TEST_CUSTODY: "yes" }, false, runner), /not valid/);
  const custody = openCustody({ TICKETS_TO_MAIN_TEST_CUSTODY: "1", TICKETS_TO_MAIN_TEST_KEYCHAIN: "/tmp/tickets-to-main-test-keychain.json" }, true, runner);
  assert.equal(custody.describe().kind, "test-double");
  assert.equal(custody.describe().qualified, false);
});

test("secret-tool receives the secret on stdin and not as an argument", async () => {
  const calls: { argv: readonly string[]; input: string }[] = [];
  const runner: SecretToolRunner = {
    run(argv, input) {
      calls.push({ argv, input });
      assert.equal(argv.includes("tp_fixture_key_not_a_real_grant"), false);
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };
  const custody = new SecretToolCustody(runner);
  await custody.put("board-key", "tp_fixture_key_not_a_real_grant");
  assert.deepEqual(calls[0]?.argv, ["secret-tool", "store", "--label", "Tickets to Main", "service", "tickets-to-main", "account", "board-key"]);
  assert.equal(calls[0]?.input, "tp_fixture_key_not_a_real_grant");
});
