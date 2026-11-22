import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const cwd = realpathSync(process.cwd());
const root = dirname(cwd);
assert.equal(process.platform, "win32");
assert.equal(process.version, "v24.18.0");
assert.deepEqual(process.argv.slice(2), [cwd]);
assert.equal(basename(cwd), "workspace");
assert.ok(basename(root).startsWith("ttm-cli-cursor-"));
assert.deepEqual(Object.keys(process.env).sort(), ["SystemRoot", "TEMP", "TMP"]);
assert.equal(process.env.TEMP, join(root, "tmp"));
assert.equal(process.env.TMP, process.env.TEMP);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);
assert.deepEqual(input, Buffer.from("Read the fabricated answer file."));
writeFileSync(join(root, "received.bin"), input, { flag: "wx" });
writeFileSync(join(root, "reached-eof"), "fixture EOF", { flag: "wx" });

const answer = readFileSync(join(cwd, "answer.txt"), "utf8");
for (const event of [
  { type: "thread.started", thread_id: "fixture-cli-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { id: "fixture-cli-answer", type: "agent_message", text: answer } },
  { type: "turn.completed" },
]) process.stdout.write(JSON.stringify(event) + "\n");

const expires = performance.now() + 10_000;
while (!existsSync(join(root, "allow-exit")) && performance.now() < expires) await pause(20);
assert.ok(existsSync(join(root, "allow-exit")), "the fixture's live Job sample did not finish");
