import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { windowsPrivacy } from "./windows-privacy.ts";

export type NativeExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: "invalid-argv" | "spawn" | null;
};

export type NativeEvents = {
  spawned(): void;
  stdout(chunk: string): void;
  stderr(chunk: string): void;
  inputError(): void;
  closed(exit: NativeExit): void;
};

export type NativeProcess = {
  write(text: string): boolean;
  endInput(): void;
};

export type NativeTransport = {
  start(
    argv: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    events: NativeEvents,
  ): NativeProcess;
};

export function processNativeTransport(): NativeTransport {
  return {
    start(argv, options, events) {
      const [file, ...args] = argv;
      if (!file || argv.some((part) => part.includes("\0"))) {
        queueMicrotask(() => events.closed({ code: null, signal: null, error: "invalid-argv" }));
        return { write: () => false, endInput() {} };
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(file, args, {
          shell: false,
          windowsHide: true,
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        queueMicrotask(() => events.closed({ code: null, signal: null, error: "spawn" }));
        return { write: () => false, endInput() {} };
      }
      let closed = false;
      let inputClosed = false;
      let error: NativeExit["error"] = null;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.on("spawn", () => events.spawned());
      child.stdout.on("data", (chunk: string) => events.stdout(chunk));
      child.stderr.on("data", (chunk: string) => events.stderr(chunk));
      child.stdin.on("error", () => {
        inputClosed = true;
        events.inputError();
      });
      child.on("error", () => { error = "spawn"; });
      child.on("close", (code, signal) => {
        closed = true;
        events.closed({ code, signal, error });
      });
      return {
        write(text) {
          if (closed || inputClosed || child.stdin.destroyed) return false;
          child.stdin.write(text);
          return true;
        },
        endInput() {
          if (!closed && !inputClosed) {
            inputClosed = true;
            child.stdin.end();
          }
        },
      };
    },
  };
}

export type WindowsOwnedLaunch = {
  originalJob: object;
  exactChild: object;
  pipe: NativeProcess;
  verify(): Promise<{ job: object; child: object } | null>;
  activate(): Promise<boolean>;
  observe(): Promise<{ job: object; activeProcesses: number; complete: boolean } | null>;
  disposeBeforeInput(): void;
  closeObservation?(): void;
};

export type WindowsOwnedLauncher = {
  start(...args: Parameters<NativeTransport["start"]>): WindowsOwnedLaunch | null | Promise<WindowsOwnedLaunch | null>;
};

export type OriginalGroup = { state: "verified"; activeProcesses: number } | { state: "unavailable" };

export type WindowsOwnedNativeProcess = NativeProcess & {
  observeOriginalGroup(): Promise<OriginalGroup>;
  closeObservation(): void;
};

export interface WindowsOwnedNativeTransport extends NativeTransport {
  start(...args: Parameters<NativeTransport["start"]>): WindowsOwnedNativeProcess;
}

type OwnedObserver = Pick<WindowsOwnedNativeProcess, "observeOriginalGroup">;
type OwnedProcessRecord = {
  executable: string | undefined;
  options: Parameters<NativeTransport["start"]>[1];
  pipe: NativeProcess;
  available(): boolean;
  canAttach(): boolean;
  receiver: NativeEvents | null;
  last: { sample: OriginalGroup; count: number } | null;
};
const ownedProcesses = new WeakMap<object, OwnedProcessRecord>();

export function attachOwnedNativeProcess(process: WindowsOwnedNativeProcess, executable: string,
  options: Parameters<NativeTransport["start"]>[1], receiver: NativeEvents): NativeProcess {
  const record = ownedProcesses.get(process);
  if (!record || record.receiver || !record.canAttach() || record.executable !== executable || record.options.cwd !== options.cwd
    || Object.keys(record.options.env).length !== Object.keys(options.env).length
    || !Object.entries(record.options.env).every(([name, value]) => Object.hasOwn(options.env, name) && options.env[name] === value)) {
    throw new Error("The staged native process cannot be attached.");
  }
  record.receiver = receiver;
  return record.pipe;
}

export function isOwnedNativeProcess(process: NativeTransport | WindowsOwnedNativeProcess): process is WindowsOwnedNativeProcess {
  return ownedProcesses.has(process);
}

export function originalOwnedGroupObserver(process: OwnedObserver): OwnedObserver["observeOriginalGroup"] | null {
  const record = ownedProcesses.get(process);
  if (!record) return null;
  const observe = process.observeOriginalGroup.bind(process);
  return async () => {
    const previous = record.last;
    const sample = await observe();
    const current = record.last;
    return current && current !== previous && current.sample === sample && record.available()
      ? { state: "verified", activeProcesses: current.count } : { state: "unavailable" };
  };
}

export function windowsOwnedNativeTransport(launcher: WindowsOwnedLauncher): WindowsOwnedNativeTransport {
  return {
    start(argv, options, events) {
      argv = Object.freeze([...argv]);
      options = Object.freeze({ cwd: options.cwd, env: Object.freeze({ ...options.env }) });
      let state: "opening" | "active" | "held" | "closed" = "opening";
      let launch: WindowsOwnedLaunch | null = null;
      let originalJob: object | undefined;
      let launchResolved = false;
      let exit: NativeExit | null = null;
      let reported = false;
      let activated = false;
      let inputEnded = false;
      let disposalRequested = false;
      let observationClosed = false;
      const unavailable: OriginalGroup = Object.freeze({ state: "unavailable" });
      const heldExit: NativeExit = { code: null, signal: null, error: "spawn" };

      function canObserve() {
        return activated && state !== "held" && !observationClosed;
      }

      function report(result: NativeExit) {
        if (reported) return;
        reported = true;
        const exactExit = { ...result };
        events.closed(result);
        record.receiver?.closed(exactExit);
      }

      function closeObservation() {
        if (observationClosed || !reported) return;
        observationClosed = true;
        try { launch?.closeObservation?.(); }
        catch { /* The relinquished observation stays unavailable. */ }
      }

      function hold() {
        state = "held";
        if (!launchResolved) return;
        if (!launch || exit) {
          report(heldExit);
          closeObservation();
          return;
        }
        if (disposalRequested || inputEnded) return;
        disposalRequested = true;
        try {
          if (activated) launch.pipe.endInput();
          else launch.disposeBeforeInput();
        } catch { /* Wait for the owned transport to report actual cleanup. */ }
      }

      async function open() {
        if (state !== "opening" || process.platform !== "win32" || !argv[0] || argv.some(part => part.includes("\0"))) {
          launchResolved = true;
          hold();
          return;
        }
        try {
          launch = await launcher.start(argv, options, {
            spawned() {},
            stdout(chunk) {
              if (state !== "active") return;
              events.stdout(chunk);
              record.receiver?.stdout(chunk);
            },
            stderr(chunk) {
              if (state !== "active") return;
              events.stderr(chunk);
              record.receiver?.stderr(chunk);
            },
            inputError() {
              hold();
              if (!activated) return;
              events.inputError();
              record.receiver?.inputError();
            },
            closed(result) {
              if (exit) return;
              exit = result;
              if (state !== "active") hold();
              else {
                state = "closed";
                report(result);
              }
            },
          });
        } catch {
          launch = null;
        }
        launchResolved = true;
        if (state !== "opening" || !launch) { hold(); return; }

        try {
          originalJob = launch.originalJob;
          const exactChild = launch.exactChild;
          if (!originalJob || typeof originalJob !== "object" || !exactChild || typeof exactChild !== "object"
            || exactChild === originalJob) { hold(); return; }
          const membership = await launch.verify();
          if (state !== "opening" || !membership || membership.job !== originalJob || membership.child !== exactChild) {
            hold();
            return;
          }
          if (!await launch.activate() || state !== "opening") { hold(); return; }
        } catch {
          hold();
          return;
        }
        activated = true;
        state = "active";
        events.spawned();
        record.receiver?.spawned();
      }

      const pipe = Object.freeze<NativeProcess>({
        write(text) {
          if (state !== "active" || !launch || inputEnded) return false;
          try { if (launch.pipe.write(text)) return true; }
          catch { /* An owned write failure cannot trigger another launch. */ }
          hold();
          return false;
        },
        endInput() {
          if (state === "opening") hold();
          if (state !== "active" || !launch || inputEnded) return;
          try {
            launch.pipe.endInput();
            inputEnded = true;
          } catch { hold(); }
        },
      });
      const record: OwnedProcessRecord = { executable: argv[0], options, pipe, available: canObserve,
        canAttach: () => state === "opening", receiver: null, last: null };
      const child: WindowsOwnedNativeProcess = {
        ...pipe,
        async observeOriginalGroup() {
          if (!launch || !canObserve()) return unavailable;
          try {
            const sample = await launch.observe();
            if (!sample || !canObserve() || sample.job !== originalJob || sample.complete !== true
              || !Number.isSafeInteger(sample.activeProcesses) || sample.activeProcesses < 0) return unavailable;
            const observed: OriginalGroup = { state: "verified", activeProcesses: sample.activeProcesses };
            record.last = { sample: observed, count: sample.activeProcesses };
            return observed;
          } catch {
            hold();
            return unavailable;
          }
        },
        closeObservation,
      };
      ownedProcesses.set(child, record);
      queueMicrotask(() => { void open().catch(hold); });
      return child;
    },
  };
}

const launchUnavailable = () => new Error("Windows-owned launch unavailable.");
const ownedLauncherSource = fileURLToPath(new URL("../native/windows-owned-launcher.cs", import.meta.url));
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
let compiled: { directory: string; file: string; digest: string } | undefined;

function ownedLauncherExecutable(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot;
  if (!root || !win32.isAbsolute(root)) throw launchUnavailable();
  if (compiled) {
    windowsPrivacy(compiled.directory);
    windowsPrivacy(compiled.file);
    if (hash(compiled.file) !== compiled.digest) throw launchUnavailable();
    return compiled.file;
  }
  const compiler = ["Framework64", "Framework"].map(platform =>
    win32.join(root, "Microsoft.NET", platform, "v4.0.30319", "csc.exe")).find(existsSync);
  if (!compiler) throw launchUnavailable();
  const directory = mkdtempSync(join(tmpdir(), "ttm-owned-launcher-"));
  const file = join(directory, "launcher.exe");
  try {
    windowsPrivacy(directory, "protect");
    const result = spawnSync(compiler, ["/nologo", "/target:exe", "/out:" + file, ownedLauncherSource], {
      env, shell: false, windowsHide: true, stdio: "ignore", timeout: 10000,
    });
    if (result.error || result.status !== 0) throw launchUnavailable();
    windowsPrivacy(file);
    compiled = { directory, file, digest: hash(file) };
    process.once("exit", () => {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch { /* An in-use helper remains private. */ }
    });
    return file;
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw launchUnavailable();
  }
}

function field(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (value.includes("\0") || bytes.toString("utf8") !== value) throw launchUnavailable();
  return bytes.toString("base64");
}

type Answer = { kind: string; value?: string };

export function windowsProcessLauncher(): WindowsOwnedLauncher {
  return {
    async start(argv, options, events): Promise<WindowsOwnedLaunch | null> {
      const [target, ...args] = argv;
      if (process.platform !== "win32" || !target || !win32.isAbsolute(target) || !win32.isAbsolute(options.cwd)) return null;
      const envs = Object.entries(options.env).flatMap(([key, value]) => {
        if (key.length === 0 || key.includes("=")) throw launchUnavailable();
        return value === undefined ? [] : [key + "=" + value];
      });
      const launch = ["launch", String(args.length), ...[target, options.cwd, ...args, ...envs].map(field)].join("\t");
      if (launch.length > 262144) return null;

      const env = { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() };
      const broker = spawn(ownedLauncherExecutable(env), [], {
        env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      const originalJob = {}, exactChild = {};
      const output = new StringDecoder("utf8"), error = new StringDecoder("utf8");
      let pending: { resolve: (answer: Answer) => void; reject: (error: Error) => void; expects: string[] } | undefined;
      let group: Promise<Answer> | undefined;
      let line = "", running = false, closed = false, detached = false, ended = false;

      function stop(graceful = false) {
        if (detached) return;
        detached = true;
        pending?.reject(launchUnavailable());
        pending = undefined;
        if (graceful) broker.stdin.end();
        else broker.stdin.destroy();
      }

      function write(command: string) {
        if (detached || broker.stdin.destroyed || broker.stdin.writableLength > 262144) return false;
        broker.stdin.write(command + "\n");
        return true;
      }

      function request(command: string, ...expects: string[]): Promise<Answer> {
        return new Promise((resolve, reject) => {
          if (pending || detached) { reject(launchUnavailable()); return; }
          pending = { resolve, reject, expects };
          if (!write(command)) stop();
        });
      }

      function close(code: number | null) {
        if (closed) return;
        closed = true;
        const lastOut = output.end(), lastErr = error.end();
        if (lastOut) events.stdout(lastOut);
        if (lastErr) events.stderr(lastErr);
        events.closed({ code, signal: null, error: code === null ? "spawn" : null });
      }

      function frame(text: string) {
        const [kind, value, extra] = text.split("\t");
        if (!kind || extra !== undefined) { stop(); return; }
        if (pending?.expects.includes(kind)) {
          if (kind !== "group" && value !== undefined) { stop(); return; }
          const operation = pending;
          pending = undefined;
          if (kind === "active") running = true;
          operation.resolve({ kind, value });
          return;
        }
        if (!running || closed) { stop(); return; }
        // Activation resolves before a coalesced child output or close frame is delivered.
        switch (kind) {
          case "stdout":
          case "stderr":
            if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) { stop(); return; }
            const decode = kind === "stdout" ? output : error;
            const chunk = decode.write(Buffer.from(value, "base64"));
            if (chunk) setImmediate(() => events[kind](chunk));
            break;
          case "input-error":
            if (value !== undefined) { stop(); return; }
            setImmediate(() => events.inputError());
            break;
          case "closed":
            if (value !== undefined && !/^\d{1,10}$/.test(value)) { stop(); return; }
            setImmediate(() => close(value === undefined ? null : Number(value)));
            break;
          default:
            stop();
        }
      }

      broker.stdout.setEncoding("ascii");
      broker.stdout.on("data", (chunk: string) => {
        const parts = (line + chunk).split("\n");
        line = parts.pop()!;
        if (line.length > 8192) stop();
        for (const raw of parts) {
          if (detached) break;
          if (raw.length > 8192) { stop(); break; }
          frame(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
        }
      });
      broker.stdin.on("error", () => stop());
      broker.stdout.on("error", () => stop());
      broker.on("error", () => stop());
      broker.on("close", () => { stop(); close(null); });
      await request(launch, "started");

      function endInput() {
        if (ended) return;
        ended = true;
        if (!write("eof")) stop();
      }

      return {
        originalJob,
        exactChild,
        pipe: {
          write(text) {
            const bytes = Buffer.from(text, "utf8");
            return running && !ended && !closed && bytes.length <= 32768 && write("input\t" + bytes.toString("base64"));
          },
          endInput,
        },
        async verify() {
          return (await request("verify", "verified", "unverified")).kind === "verified" ? { job: originalJob, child: exactChild } : null;
        },
        async activate() {
          return (await request("activate", "active", "inactive")).kind === "active";
        },
        async observe() {
          group ??= request("observe", "group").finally(() => { group = undefined; });
          const { value } = await group;
          if (detached || value === undefined || !/^\d{1,3}$/.test(value)) return null;
          const activeProcesses = Number(value);
          return activeProcesses <= 256 ? { job: originalJob, activeProcesses, complete: true } : null;
        },
        disposeBeforeInput() {
          if (!write("dispose")) stop();
        },
        closeObservation() {
          stop(write("close"));
        },
      };
    },
  };
}

// A size bound protects the controller from malformed output without limiting native work time.
export class JsonLines {
  private pending = "";
  private failed = false;

  private readonly accept: (value: unknown) => void;
  private readonly invalid: () => void;
  private readonly maxLineLength: number;

  constructor(accept: (value: unknown) => void, invalid: () => void, maxLineLength = 1024 * 1024) {
    this.accept = accept;
    this.invalid = invalid;
    this.maxLineLength = maxLineLength;
  }

  push(chunk: string): void {
    if (this.failed) return;
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== "\n") continue;
      if (!this.append(chunk.slice(start, index))) return;
      const line = this.pending;
      this.pending = "";
      this.line(line);
      if (this.failed) return;
      start = index + 1;
    }
    this.append(chunk.slice(start));
  }

  finish(): void {
    if (!this.failed && this.pending.length > 0) this.line(this.pending);
    this.pending = "";
  }

  private append(part: string): boolean {
    if (this.pending.length + part.length > this.maxLineLength) {
      this.fail();
      return false;
    }
    this.pending += part;
    return true;
  }

  private line(line: string): void {
    if (line.trim() === "") return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { this.fail(); return; }
    this.accept(value);
  }

  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.pending = "";
    this.invalid();
  }
}
