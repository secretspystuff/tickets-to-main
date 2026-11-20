import { spawn } from "node:child_process";
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runAssignment, type AssignmentAdapter, type AssignmentInput, type AssignmentRequest, type AssignmentTerminal } from "../src/assignment-boundary.ts";
import { install } from "../src/install.ts";
import { windowsOwnedNativeTransport, windowsProcessLauncher, type NativeExit, type WindowsOwnedLauncher } from "../src/native-transport.ts";
import { claimWorkspace, prepareWorkspace, processAlive } from "../src/workspace.ts";

const file = fileURLToPath(import.meta.url);
const enclosing = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const executable = realpathSync(process.execPath);
const [role, requested, parent] = process.argv.slice(2);
const input = "Fabricated writer custody";
const id = (value: number) => value.toString(16).padStart(32, "0");

function fixturePath() {
  if (process.platform !== "win32" || process.version !== "v24.18.0" || !requested) throw new Error("Unavailable.");
  const root = realpathSync(requested);
  if (dirname(root) !== enclosing || !basename(root).startsWith("ttm-job-drain-controller-loss-owned-")) throw new Error("Outside fixture.");
  const cwd = realpathSync(process.cwd());
  if (role === "controller" && process.argv.length === 5 && Number(parent) === process.ppid && cwd === root) return root;
  if ((role === "root" || role === "writer") && process.argv.length === 4 && cwd === join(root, "workspace")) return root;
  throw new Error("Wrong fixture role.");
}

function env(root: string) {
  return { SystemRoot: process.env.SystemRoot, TEMP: join(root, "tmp"), TMP: join(root, "tmp") };
}

function signal(root: string, name: string, value = "1") {
  const temporary = join(root, "control", name + ".tmp");
  writeFileSync(temporary, value, { flag: "wx" });
  renameSync(temporary, join(root, "control", name));
}

async function waitFor<T>(root: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !existsSync(join(root, "control", "abort"))) {
    const found = read();
    if (found !== undefined) return found;
    await pause(20);
  }
  throw new Error("Fixture barrier did not open.");
}

async function reader(root: string) {
  signal(root, "broker-pid", String(process.ppid));
  signal(root, "reader-pid", String(process.pid));
  process.stdout.write("reader-ready\n");
  let received = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) received += chunk;
  if (received !== input) throw new Error("Wrong fixture assignment.");
  const cwd = join(root, "workspace");
  writeFileSync(join(cwd, "received.bin"), received, { flag: "wx" });
  // Keep libuv's extra parent-exit Job from ending the fixture writer before it can write late.
  const child = spawn(executable, ["--experimental-strip-types", file, "writer", root], {
    cwd, env: env(root), shell: false, windowsHide: true, stdio: "ignore", detached: true,
  });
  let failed = false;
  child.on("error", () => { failed = true; });
  await waitFor(root, () => {
    if (failed || child.exitCode !== null) throw new Error("Late writer did not start.");
    return existsSync(join(root, "control", "writer-pid")) ? true : undefined;
  });
  child.unref();
}

async function writer(root: string) {
  signal(root, "writer-parent", String(process.ppid));
  signal(root, "writer-pid", String(process.pid));
  await waitFor(root, () => existsSync(join(root, "control", "write-once")) ? true : undefined);
  writeFileSync(join(root, "workspace", "late.bin"), "fabricated late write", { flag: "wx" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function startReader(root: string, workspace: string, owned: boolean) {
  const control = (name: string) => existsSync(join(root, "control", name));
  const ready = deferred<void>(), closed = deferred<NativeExit>();
  const staged = deferred<void>(), resume = deferred<boolean>();
  const launcher = windowsProcessLauncher();
  const launch: WindowsOwnedLauncher = owned ? {
    async start(...args) {
      const original = await launcher.start(...args);
      if (!original) return null;
      return { ...original, async activate() {
        staged.resolve();
        return await resume.promise && original.activate();
      } };
    },
  } : launcher;
  let out = "", inputFailed = false;
  const transport = windowsOwnedNativeTransport(launch).start(
    [executable, "--experimental-strip-types", file, "root", root], { cwd: workspace, env: env(root) }, {
      spawned() {}, stderr() {}, inputError() { inputFailed = true; },
      closed(exit) {
        if (control("withhold-close")) signal(root, "close-withheld");
        else closed.resolve(exit);
      },
      stdout(chunk) { out += chunk; if (out.includes("reader-ready\n")) ready.resolve(); },
    },
  );

  const execute: AssignmentAdapter["execute"] = async assignment => {
    if (assignment.workspace !== workspace) throw new Error("Wrong fixture workspace.");
    if (owned) resume.resolve(true);
    if (await Promise.race([ready.promise, closed.promise])) throw new Error("No admitted input.");
    if (owned) {
      signal(root, "owned-input-ready");
      await waitFor(root, () => control("allow-owned-input") ? true : undefined);
    }
    if (!transport.write(assignment.input)) throw new Error("No admitted input.");
    transport.endInput();
    const exit = await closed.promise;
    if (inputFailed || exit.code !== 0 || exit.signal !== null || exit.error !== null) throw new Error("Transport did not close cleanly.");
    const live = await transport.observeOriginalGroup();
    if (live.state !== "verified" || live.activeProcesses !== 1) throw new Error("Late writer was not proved in the original Job.");
    signal(root, "root-closed", "original-job-active=1");

    async function completion(): Promise<AssignmentTerminal | null> {
      const observed = await transport.observeOriginalGroup();
      return observed.state === "verified" && observed.activeProcesses === 0
        ? { id: assignment.id, sequence: assignment.sequence, result: "completed", writersContained: true } : null;
    }

    await waitFor(root, () => control("attempt-handoff") ? true : undefined);
    const premature = await completion();
    if (premature) return premature;
    signal(root, "handoff-held");
    await waitFor(root, () => {
      if (control("exit-controller")) process.exit(73);
      return control("observe-drained") ? true : undefined;
    });
    const done = await completion();
    if (!done) throw new Error("Original Job drain was not proved.");
    signal(root, "drain-receipt", "original-job-active=0");
    return done;
  };

  return {
    execute,
    async awaitPreparation() {
      if (await Promise.race([staged.promise, closed.promise])) throw new Error("The reader was not staged.");
      signal(root, "owned-staged");
      await waitFor(root, () => control("allow-owned-start") ? true : undefined);
    },
    original: { async observeOriginalGroup() {
      signal(root, "release-observation");
      await waitFor(root, () => control("allow-release-observation") ? true : undefined);
      return transport.observeOriginalGroup();
    } },
    async close() {
      transport.endInput();
      resume.resolve(false);
      await closed.promise;
      transport.closeObservation();
      if (owned) signal(root, "observer-closed");
    },
  };
}

async function run(root: string) {
  const stateDir = join(root, "state"), workspace = join(root, "workspace");
  const owned = existsSync(join(root, "control", "owned-admission"));
  install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
  prepareWorkspace(stateDir, workspace, processAlive);
  claimWorkspace(stateDir, process.pid, processAlive);
  const request: AssignmentRequest = {
    version: 1, id: id(1), sequence: 1, operation: "native.assign", input,
    binding: { board: id(3), repo: id(4), activation: id(5), connection: id(6), job: id(7),
      claim: id(8), requirements: id(9), candidate: id(10), policy: id(11), fence: 1 },
  };
  const port: NonNullable<AssignmentInput["owned"]> = {
    async prepare({ intent, workspace: admitted }) {
      if (admitted !== workspace || intent.id !== request.id || intent.sequence !== request.sequence) throw new Error("Wrong prepared assignment.");
      if (existsSync(join(root, "control", "refuse-owned-preparation"))) return null;
      const reader = startReader(root, workspace, true);
      try {
        await reader.awaitPreparation();
        return reader;
      } catch (error) {
        await reader.close();
        throw error;
      }
    },
  };
  const result = await runAssignment({
    stateDir, raw: JSON.stringify(request), secrets: [], now: () => 1000,
    ...(owned ? { owned: port } : {}),
    adapter: {
      kind: "fabricated-harness",
      readCurrent: async () => ({ binding: request.binding, nextSequence: request.sequence, authorized: true,
        seat: "member", confirmedWorkspace: workspace, writersContained: true }),
      async execute(assignment) {
        if (owned) throw new Error("Owned fixture entered legacy execution.");
        if (assignment.workspace !== workspace) throw new Error("Wrong fixture workspace.");
        const reader = startReader(root, workspace, false);
        try {
          return await reader.execute(assignment);
        } finally {
          await reader.close();
        }
      },
      async reconcile() { throw new Error("Initial controller entered recovery."); },
    },
  });
  process.stdout.write(JSON.stringify(result));
}

let watchdog: NodeJS.Timeout | undefined;
try {
  const root = fixturePath();
  // A stuck stream cannot keep a fabricated peer alive after its control barrier aborts.
  const deadline = Date.now() + 30_000;
  watchdog = setInterval(() => {
    if (existsSync(join(root, "control", "abort")) || Date.now() >= deadline) process.exit(74);
  }, 25);
  if (role === "controller") await run(root);
  else if (role === "root") await reader(root);
  else await writer(root);
} catch { process.exitCode = 1; }
finally { clearInterval(watchdog); }
