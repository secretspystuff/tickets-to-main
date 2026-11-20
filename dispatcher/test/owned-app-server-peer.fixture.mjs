import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [mode, expected] = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
assert.equal(process.platform, "win32");
assert.equal(process.version, "v24.18.0");
assert.equal(process.argv.length, 4);
assert.equal(cwd, expected);
assert.equal(basename(cwd), "workspace");
assert.ok(basename(dirname(cwd)).startsWith("ttm-owned-app-server-"));
assert.ok(["complete", "wrong workspace", "invalid initialize", "wrong turn", "wrong thread", "interrupt", "late writer"].includes(mode));

const root = dirname(cwd);
const writerReady = join(root, "writer-ready"), allowWrite = join(root, "allow-write"), abortWriter = join(root, "abort-writer");
async function waitFor(check) {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "The fabricated writer did not reach its barrier.");
    await pause(20);
  }
}

if (mode === "late writer") {
  writeFileSync(writerReady, "ready", { flag: "wx" });
  await waitFor(() => existsSync(allowWrite) || existsSync(abortWriter));
  if (!existsSync(abortWriter)) writeFileSync(join(cwd, "late-marker.txt"), "fabricated late write", { flag: "wx" });
}

const received = join(root, "requests.jsonl");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const threadId = "fixture-thread", turnId = "fixture-turn";
const stages = ["initialize", "initialized", "thread/start", "turn/start"];
if (mode === "interrupt") stages.push("turn/interrupt");
let stage = 0;
const requests = mode === "late writer" ? [] : createInterface({ input: process.stdin });
for await (const line of requests) {
  const message = JSON.parse(line);
  appendFileSync(received, JSON.stringify(message) + "\n");
  assert.equal(message.method, stages[stage++]);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture", platformFamily: "windows",
      platformOs: mode === "invalid initialize" ? "other" : "windows", codexHome: join(dirname(cwd), "fixture-profile") } });
  } else if (message.method === "thread/start") {
    assert.equal(message.params.cwd, cwd);
    send({ id: message.id, result: { thread: { id: threadId }, model: "fixture-model", modelProvider: "fixture",
      cwd: mode === "wrong workspace" ? join(dirname(cwd), "other-workspace") : cwd,
      approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite" } } });
  } else if (message.method === "turn/start") {
    assert.equal(message.params.threadId, threadId);
    if (mode === "interrupt") {
      // The original Job must still see the writer after libuv's parent exits.
      const writer = spawn(realpathSync(process.execPath), [fileURLToPath(import.meta.url), "late writer", cwd], {
        cwd, shell: false, windowsHide: true, stdio: "ignore", detached: true,
      });
      let spawnError;
      writer.once("error", error => { spawnError = error; });
      await waitFor(() => {
        if (spawnError) throw spawnError;
        assert.equal(writer.exitCode, null);
        return existsSync(writerReady);
      });
      writer.unref();
      send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
      continue;
    }
    const text = readFileSync(join(cwd, "answer.txt"), "utf8");
    send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { id: "fixture-answer", type: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId: mode === "wrong thread" ? "other-thread" : threadId,
      turn: { id: mode === "wrong turn" ? "other-turn" : turnId, status: "completed", items: [] } } });
  } else if (message.method === "turn/interrupt") {
    assert.deepEqual(message, { id: 4, method: "turn/interrupt", params: { threadId, turnId } });
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [] } } });
  }
}
