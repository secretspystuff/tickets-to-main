import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import workerThreads from "node:worker_threads";
import { windowsPrivacy } from "../src/windows-privacy.ts";

test("failed helper-folder privacy validation leaves no cached path for the next launch", (context) => {
  if (process.platform !== "win32") return;
  const root = fs.mkdtempSync(join(tmpdir(), "privacy-bootstrap-test-"));
  const originalSpawn = childProcess.spawnSync;
  const originalMkdtemp = fs.mkdtempSync;
  const originalExists = fs.existsSync;
  const originalWorker = workerThreads.Worker;
  const directories: string[] = [];
  const validated = new Set<string>();
  const launches: string[] = [];
  let compilations = 0;
  let folderChecks = 0;
  context.after(() => {
    childProcess.spawnSync = originalSpawn;
    fs.mkdtempSync = originalMkdtemp;
    fs.existsSync = originalExists;
    workerThreads.Worker = originalWorker;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdtempSync = ((template: string) => {
    assert.equal(basename(template), "ttm-filesystem-helper-");
    const directory = originalMkdtemp(join(root, "attempt-"));
    directories.push(directory);
    return directory;
  }) as typeof originalMkdtemp;
  fs.existsSync = ((path) => basename(String(path)) === "csc.exe" || originalExists(path)) as typeof originalExists;
  childProcess.spawnSync = ((file: string, argv: string[], options: Record<string, unknown>) => {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    let stdout = "";
    if (basename(file) === "whoami.exe") stdout = '"fabricated-user","S-1-5-21-1-2-3-1001"';
    else if (basename(file) === "icacls.exe") assert.equal(argv[0], directories.at(-1));
    else if (basename(file) === "csc.exe") {
      const output = argv.find((argument) => argument.startsWith("/out:"))?.slice(5);
      assert.equal(output, join(directories.at(-1)!, "privacy.exe"));
      fs.writeFileSync(output!, "fabricated helper bytes");
      compilations++;
    } else if (basename(file) === "privacy.exe") {
      assert.deepEqual(argv, ["check", directories.at(-1)]);
      folderChecks++;
      if (folderChecks === 1) return { status: 1, stdout: "", stderr: "" };
      validated.add(file);
    } else assert.fail("unexpected native command");
    return { status: 0, stdout, stderr: "" };
  }) as typeof originalSpawn;
  workerThreads.Worker = class {
    constructor(_url: URL, options: workerThreads.WorkerOptions) {
      const executable = options.workerData.executable as string;
      launches.push(executable);
      assert.ok(validated.has(executable), "a helper must pass folder validation before launch");
    }
    on() { return this; }
    unref() {}
    postMessage(request: { buffer: SharedArrayBuffer }) {
      Atomics.store(new Int32Array(request.buffer), 0, 1);
    }
  } as unknown as typeof originalWorker;
  syncBuiltinESMExports();

  assert.throws(() => windowsPrivacy("C:\\fabricated\\state"), /privacy could not be verified/);
  assert.equal(folderChecks, 1);
  assert.equal(launches.length, 0);
  assert.equal(windowsPrivacy("C:\\fabricated\\state"), "");
  assert.equal(folderChecks, 2);
  assert.equal(compilations, 2);
  assert.equal(directories.length, 2);
  assert.deepEqual(launches, [join(directories[1]!, "privacy.exe")]);
  assert.equal(windowsPrivacy("C:\\fabricated\\state"), "");
  assert.equal(folderChecks, 2);
  assert.equal(compilations, 2);
  assert.equal(launches.length, 1);
  fs.writeFileSync(launches[0]!, "changed fabricated helper bytes");
  assert.throws(() => windowsPrivacy("C:\\fabricated\\state"), /privacy could not be verified/);
  assert.equal(launches.length, 1);
});
