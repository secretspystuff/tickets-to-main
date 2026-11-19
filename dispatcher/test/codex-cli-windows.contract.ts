import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { test } from "node:test";
import { toolEnv } from "../src/command.ts";
import { JsonLines, processNativeTransport, type NativeExit } from "../src/native-transport.ts";
import { record } from "../src/adapters/native-result.ts";
import { removeDir, tempDir } from "./helpers.ts";

const MODEL = "gpt-6-luna";
const EFFORT = "low";
const SHA256 = "2692c8c7bb2cf8b0aefe638741fc90236f4b824c59578ce84994f9de58200993";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const OPTIONS = ["--json", "-m", MODEL, "-c", `model_reasoning_effort="${EFFORT}"`];

function resumeArgs(session: string | null): string[] {
  assert.ok(session && UUID.test(session), "resume requires the explicit fixture session UUID");
  return ["exec", "resume", ...OPTIONS, session, "-"];
}

function launchProbe(executable: string, cwd: string, env: NodeJS.ProcessEnv, args: string[], prompt: string, missingSession?: string) {
  const observed = {
    spawned: false, acceptedInput: false, invalidJson: false, thread: null as string | null,
    events: [] as string[], result: null as string | null, missingThread: false,
  };
  const parser = new JsonLines((value) => {
    const event = record(value);
    if (!event || typeof event.type !== "string") {
      observed.invalidJson = true;
      return;
    }
    observed.events.push(event.type);
    if (event.type === "thread.started" && typeof event.thread_id === "string") observed.thread = event.thread_id;
    if (event.type === "item.completed") {
      const item = record(event.item);
      if (item?.type === "agent_message" && typeof item.text === "string") observed.result = item.text.trim();
    }
  }, () => { observed.invalidJson = true; });
  return new Promise<{ exit: NativeExit; observed: typeof observed }>((resolve) => {
    let diagnosticTail = "";
    const child = processNativeTransport().start([executable, ...args], { cwd, env }, {
      spawned() { observed.spawned = true; },
      stdout(chunk) { parser.push(chunk); },
      stderr(chunk) {
        if (!missingSession) return;
        diagnosticTail = (diagnosticTail + chunk).slice(-4096);
        observed.missingThread ||= diagnosticTail.includes(`thread/resume failed: no rollout found for thread id ${missingSession} (code -32600)`);
      },
      inputError() { observed.acceptedInput = false; },
      closed(exit) { parser.finish(); resolve({ exit, observed }); },
    });
    observed.acceptedInput = child.write(prompt);
    child.endInput();
  });
}

function successfulTurn(result: Awaited<ReturnType<typeof launchProbe>>, expected: string): string {
  const { exit, observed } = result;
  assert.deepEqual(exit, { code: 0, signal: null, error: null });
  assert.ok(observed.spawned && observed.acceptedInput && !observed.invalidJson);
  assert.ok(observed.thread && UUID.test(observed.thread), "expected a native session UUID");
  assert.equal(observed.events[0], "thread.started");
  assert.equal(observed.events[1], "turn.started");
  assert.equal(observed.events.at(-1), "turn.completed");
  assert.ok(observed.events.includes("item.completed") && !observed.events.includes("turn.failed"));
  assert.ok(observed.result === expected, "native result did not match the fabricated answer");
  return observed.thread;
}

test(`pinned Windows CLI accepts explicit ${MODEL}/${EFFORT}, resumes by UUID and rejects a missing session`, async (t) => {
  assert.ok(process.platform === "win32" && process.arch === "x64", "requires native Windows x64 Node");
  const path = process.argv[2];
  assert.ok(path && isAbsolute(path) && basename(path).toLowerCase() === "codex.exe", "pass an absolute codex.exe path");
  const executable = realpathSync(path);
  assert.ok(createHash("sha256").update(readFileSync(executable)).digest("hex") === SHA256, "unexpected Codex executable hash");
  const env = toolEnv(process.env, []);
  const spawnOptions = { env, encoding: "utf8", windowsHide: true } as const;
  const version = spawnSync(executable, ["--version"], spawnOptions);
  assert.ok(version.status === 0 && version.stdout.trim() === "codex-cli 0.163.0", "unexpected Codex version");
  const auth = spawnSync(executable, ["login", "status"], spawnOptions);
  assert.ok(auth.status === 0 && (auth.stdout + auth.stderr).trim() === "Logged in using ChatGPT", "requires existing ChatGPT sign-in");

  for (const missing of [null, "", "--last", "title", "-\0"]) {
    assert.throws(() => resumeArgs(missing), /requires the explicit fixture session UUID/);
  }

  const cwd = tempDir();
  t.after(() => removeDir(cwd));
  assert.equal(spawnSync("git", ["init", "--quiet"], { ...spawnOptions, cwd }).status, 0);

  const fresh = await launchProbe(executable, cwd, env, ["exec", ...OPTIONS, "-"],
    "Fabricated values are north=9 and south=16, and the session label is LARK. Do not use tools. Return the sum, a vertical bar and the label, with nothing else.");
  const session = successfulTurn(fresh, "25|LARK");
  const resumed = await launchProbe(executable, cwd, env, resumeArgs(session),
    "From the preceding turn in this same session, return the provided label only. Do not use tools.");
  assert.ok(successfulTurn(resumed, "LARK") === session, "explicit resume returned a different session");

  const missingSession = randomUUID();
  const absent = await launchProbe(executable, cwd, env, resumeArgs(missingSession),
    "Fabricated negative case. Do not use tools or make any change.", missingSession);
  assert.deepEqual(absent.exit, { code: 1, signal: null, error: null });
  assert.ok(absent.observed.spawned && absent.observed.missingThread, "expected native missing-session refusal");
  assert.equal(absent.observed.invalidJson, false);
  assert.equal(absent.observed.events.length, 0, "missing session must not start an assignment or fall back to a new thread");
});
