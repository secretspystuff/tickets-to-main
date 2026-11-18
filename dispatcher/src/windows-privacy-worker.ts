import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let pending: SharedArrayBuffer | null = null;
let dead = false;
function reply(ok: boolean, value = "") {
  if (!pending) return;
  const buffer = pending; pending = null;
  const flags = new Int32Array(buffer, 0, 2);
  const bytes = Buffer.from(value);
  if (bytes.length > buffer.byteLength - 8) ok = false;
  if (ok) new Uint8Array(buffer, 8, bytes.length).set(bytes);
  Atomics.store(flags, 1, ok ? bytes.length : 0);
  Atomics.store(flags, 0, ok ? 1 : 2);
  Atomics.notify(flags, 0);
}
const bytes = readFileSync(workerData.executable);
if (createHash("sha256").update(bytes).digest("hex") !== workerData.digest) throw new Error("Privacy helper unavailable.");
const child = spawn(workerData.executable, ["serve"], { shell: false, windowsHide: true,
  env: workerData.env, stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  stdout += chunk;
  if (stdout.length > 16384) { dead = true; reply(false); child.kill(); return; }
  const end = stdout.indexOf("\n");
  if (end < 0) return;
  const line = stdout.slice(0, end).trim(); stdout = stdout.slice(end + 1);
  const parts = line.split("\t");
  reply(parts[0] === "0", parts[1] ? Buffer.from(parts[1], "base64").toString("utf8") : "");
});
child.stderr.on("data", () => { dead = true; reply(false); });
child.on("error", () => { dead = true; reply(false); });
child.on("exit", () => { dead = true; reply(false); });
child.stdin.on("error", () => { dead = true; reply(false); });
parentPort!.on("message", (request: { buffer: SharedArrayBuffer; action: string; path: string }) => {
  pending = request.buffer;
  if (dead || !["check", "protect", "snapshot"].includes(request.action) || request.path.includes("\0")) { reply(false); return; }
  child.stdin.write(request.action + "\t" + Buffer.from(request.path).toString("base64") + "\n");
});
