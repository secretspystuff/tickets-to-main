import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const [mode, expected] = process.argv.slice(2);
const cwd = realpathSync(process.cwd()), root = dirname(cwd);
assert.equal(process.platform, "win32");
assert.equal(process.version, "v24.18.0");
assert.equal(process.argv.length, 4);
assert.equal(cwd, expected);
assert.equal(basename(cwd), "workspace");
assert.ok(basename(root).startsWith("ttm-owned-cli-"));
assert.ok(mode === "complete" || mode === "wrong result" || mode === "unsafe metadata");

const receipt = join(root, "received.bin");
for await (const chunk of process.stdin) appendFileSync(receipt, chunk);
writeFileSync(join(root, "reached-eof"), "fixture EOF", { flag: "wx" });
const input = readFileSync(receipt, "utf8");
assert.equal(input, "Read the fabricated answer file.");
const answer = readFileSync(join(cwd, "answer.txt"), "utf8");
for (const event of [
  { type: "thread.started", thread_id: mode === "unsafe metadata" ? input : "fixture-cli-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "fixture-cli-answer", type: "agent_message", text: mode === "wrong result" ? "other result" : answer } },
  { type: "turn.completed" },
]) process.stdout.write(JSON.stringify(event) + "\n");
while (!existsSync(join(root, "allow-exit"))) await pause(20);
