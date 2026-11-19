import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

let helper: { executable: string; digest: string } | null = null;
let service: Worker | null = null;
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const unavailable = () => new Error("Filesystem privacy could not be verified.");
function run(file: string, args: string[]) {
  const root = process.env.SystemRoot;
  const result = spawnSync(file, args, { encoding: "utf8", shell: false, windowsHide: true, timeout: 10000, maxBuffer: 8192,
    env: { SystemRoot: root, TEMP: tmpdir(), TMP: tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw unavailable();
  return result.stdout;
}
function executable(): string {
  if (process.platform !== "win32") throw unavailable();
  if (helper) {
    if (digest(helper.executable) !== helper.digest) throw unavailable();
    return helper.executable;
  }
  const root = process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root)) throw unavailable();
  const identity = run(win32.join(root, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = identity.match(/S-1-5-[0-9-]+/g);
  if (!sid || sid.length !== 1) throw unavailable();
  const directory = mkdtempSync(join(tmpdir(), "ttm-filesystem-helper-"));
  run(win32.join(root, "System32", "icacls.exe"), [directory, "/inheritance:r", "/grant:r",
    `*${sid[0]}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
  const source = join(directory, "privacy.cs");
  const output = join(directory, "privacy.exe");
  writeFileSync(source, readFileSync(fileURLToPath(new URL("../native/filesystem-privacy.cs", import.meta.url))));
  const compilers = ["Framework64", "Framework"].map((platform) => win32.join(root, "Microsoft.NET", platform, "v4.0.30319", "csc.exe"));
  const compiler = compilers.find(existsSync);
  if (!compiler) throw unavailable();
  run(compiler, ["/nologo", "/target:exe", "/out:" + output, source]);
  const candidate = { executable: output, digest: digest(output) };
  run(output, ["check", directory]);
  helper = candidate;
  process.once("exit", () => {
    try { unlinkSync(output); unlinkSync(source); rmdirSync(directory); } catch { /* A busy helper remains private. */ }
  });
  return output;
}

export function windowsPrivacy(path: string, action: "check" | "protect" | "snapshot" = "check"): string {
  if (!win32.isAbsolute(path) || path.includes("\0")) throw unavailable();
  const file = executable();
  if (!service) {
    service = new Worker(new URL("./windows-privacy-worker.ts", import.meta.url), { workerData: {
      executable: file, digest: helper!.digest, env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() },
    }, env: { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() }, execArgv: [] });
    service.on("error", () => { service = null; });
    service.unref();
  }
  const buffer = new SharedArrayBuffer(16384);
  const flags = new Int32Array(buffer, 0, 2);
  service.postMessage({ buffer, action, path });
  Atomics.wait(flags, 0, 0, 10000);
  if (Atomics.load(flags, 0) !== 1) {
    void service.terminate(); service = null;
    throw unavailable();
  }
  return Buffer.from(new Uint8Array(buffer, 8, Atomics.load(flags, 1))).toString("utf8");
}
