import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
