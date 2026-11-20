import assert from "node:assert/strict";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const [mode, expected] = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
assert.equal(process.platform, "win32");
assert.equal(process.version, "v24.18.0");
assert.equal(process.argv.length, 4);
assert.equal(cwd, expected);
assert.equal(basename(cwd), "workspace");
assert.ok(basename(dirname(cwd)).startsWith("ttm-owned-app-server-"));
assert.ok(["complete", "wrong workspace", "invalid initialize", "wrong turn"].includes(mode));

const received = join(dirname(cwd), "requests.jsonl");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const threadId = "fixture-thread", turnId = "fixture-turn";
const stages = ["initialize", "initialized", "thread/start", "turn/start"];
let stage = 0;
for await (const line of createInterface({ input: process.stdin })) {
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
    const text = readFileSync(join(cwd, "answer.txt"), "utf8");
    send({ id: message.id, result: { turn: { id: turnId, items: [], status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId, turnId, item: { id: "fixture-answer", type: "agentMessage", text } } });
    send({ method: "turn/completed", params: { threadId,
      turn: { id: mode === "wrong turn" ? "other-turn" : turnId, status: "completed", items: [] } } });
  }
}
