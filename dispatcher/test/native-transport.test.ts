import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLines, processNativeTransport, type NativeExit } from "../src/native-transport.ts";
import { toolEnv } from "../src/command.ts";

test("JSON lines accepts split records and rejects forged, malformed and oversized records", () => {
  const values: unknown[] = [];
  let failures = 0;
  const parser = new JsonLines((value) => values.push(value), () => { failures += 1; }, 40);
  parser.push('{"text":"');
  parser.push('ready"}\r\n{"status":');
  parser.push('"completed"}');
  parser.finish();
  assert.deepEqual(values, [{ text: "ready" }, { status: "completed" }]);
  assert.equal(failures, 0);
  const broken = new JsonLines(() => assert.fail("invalid records must not be delivered"), () => { failures += 1; }, 20);
  broken.push('x'.repeat(21));
  broken.push('\n{"valid":true}\n');
  broken.finish();
  assert.equal(failures, 1);
  const malformed = new JsonLines(() => assert.fail(), () => { failures += 1; });
  malformed.push('{bad}\n');
  assert.equal(failures, 2);
});

test("native transport streams split UTF-8 before input closes with an explicit filtered environment", async () => {
  const script = 'process.stdout.write(Buffer.from([0xe2])); process.stdin.once("data", () => { process.stdout.write(Buffer.from([0x82,0xac])); process.stdout.write(JSON.stringify({token:process.env.TICKETS_PLEASE_TOKEN??null,home:process.env.HOME})); }); process.stdin.on("end",()=>process.exit(0)); process.stdin.resume();';
  const chunks: string[] = [];
  let signalOutput!: () => void;
  const output = new Promise<void>((resolve) => { signalOutput = resolve; });
  let end!: (exit: NativeExit) => void;
  const closed = new Promise<NativeExit>((resolve) => { end = resolve; });
  const child = processNativeTransport().start([process.execPath, "-e", script], {
    cwd: process.cwd(), env: toolEnv({ HOME: "/fixture-home", TICKETS_PLEASE_TOKEN: "fabricated-secret" }, []),
  }, {
    spawned() {},
    stdout(chunk) { chunks.push(chunk); if (chunks.join("").includes('"token":')) signalOutput(); },
    stderr() {}, inputError() { assert.fail("synthetic stdin must stay available"); }, closed: end,
  });
  try {
    assert.equal(child.write("ready"), true);
    await output;
    assert.match(chunks.join(""), /^€/);
    assert.equal(chunks.join("").includes("fabricated-secret"), false);
    assert.match(chunks.join(""), /"token":null/);
    assert.match(chunks.join(""), /fixture-home/);
  } finally {
    child.endInput();
    assert.deepEqual(await closed, { code: 0, signal: null, error: null });
  }
});

test("environment exclusion is case-insensitive and preserves native configuration and auth location", () => {
  const env = toolEnv({
    Home: "/own-home", CODEX_HOME: "/own-codex", Path: "/bin", tickets_please_token: "not-enumerated",
    Tickets_To_Main_State: "/state", DispatcherAlias: "prefix-held-secret-suffix", OPENAI_API_KEY: "native-owned",
  }, ["held-secret"]);
  assert.equal(env.tickets_please_token, undefined);
  assert.equal(env.Tickets_To_Main_State, undefined);
  assert.equal(env.DispatcherAlias, undefined);
  assert.equal(env.Home, "/own-home");
  assert.equal(env.CODEX_HOME, "/own-codex");
  assert.equal(env.OPENAI_API_KEY, "native-owned");
});

test("synchronous spawn validation and missing executables report safe failures without error payloads", async () => {
  for (const [argv, cwd] of [[[process.execPath], "\0private-path"], [["/missing-native-fixture"], process.cwd()]] as const) {
    let complete!: (value: NativeExit) => void;
    const closed = new Promise<NativeExit>((resolve) => { complete = resolve; });
    const child = processNativeTransport().start(argv, { cwd, env: {} }, {
      spawned() { assert.fail("invalid launch must not spawn"); }, stdout() { assert.fail(); }, stderr() {}, inputError() {}, closed: complete,
    });
    child.endInput();
    const exit = await closed;
    assert.equal(exit.error, "spawn");
    assert.equal(JSON.stringify(exit).includes("private-path"), false);
  }
});
