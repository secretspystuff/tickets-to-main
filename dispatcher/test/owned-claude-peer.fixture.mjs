import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [mode, expected] = process.argv.slice(2);
const cwd = realpathSync(process.cwd());
assert.equal(process.platform, "win32");
assert.equal(process.version, "v24.18.0");
assert.equal(process.argv.length, 4);
assert.equal(cwd, expected);
assert.equal(basename(cwd), "workspace");
assert.ok(basename(dirname(cwd)).startsWith("ttm-owned-claude-"));

async function waitFor(name) {
  const path = join(cwd, name), deadline = Date.now() + 12_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, "The fabricated writer barrier did not open.");
    await delay(25);
  }
}

if (mode === "writer") {
  writeFileSync(join(cwd, "writer-ready"), "ready", { flag: "wx" });
  await waitFor("permit-writer");
  writeFileSync(join(cwd, "writer-finished.txt"), "fabricated late write", { flag: "wx" });
} else {
  assert.ok(["complete", "wrong input", "ordinary"].includes(mode));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  writeFileSync(join(dirname(cwd), "received.bin"), bytes, { flag: "wx" });
  const wire = bytes.toString("utf8");
  assert.equal(wire.indexOf("\n"), wire.length - 1);
  assert.ok(wire.endsWith("\n"));
  const user = JSON.parse(wire);
  assert.equal(user.type, "user");
  assert.equal(user.message.role, "user");

  if (mode === "complete") {
    // libuv's additional parent-exit Job would terminate the writer along with the peer.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "writer", cwd], {
      cwd, shell: false, windowsHide: true, stdio: "ignore", detached: true,
    });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    await waitFor("writer-ready");
  }

  const send = frame => process.stdout.write(JSON.stringify({ session_id: user.session_id, ...frame }) + "\n");
  const text = readFileSync(join(cwd, "answer.txt"), "utf8");
  send({ type: "system", subtype: "init", uuid: "fixture-init", claude_code_version: "2.1.317",
    cwd, model: "fixture-model", permissionMode: "default" });
  send({ type: "assistant", uuid: "fixture-assistant", user_message_uuid: user.uuid, parent_tool_use_id: null,
    message: { model: "fixture-model", content: [{ type: "text", text }] } });
  send({ type: "result", subtype: "success", uuid: "fixture-result",
    user_message_uuid: mode === "wrong input" ? "foreign-input" : user.uuid,
    is_error: false, num_turns: 1, result: text, stop_reason: "end_turn", permission_denials: [] });
}
