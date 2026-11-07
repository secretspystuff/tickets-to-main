import { spawn } from "node:child_process";

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type CommandRunOptions = {
  timeoutMs: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

export type CommandRunner = {
  run(argv: readonly string[], options: CommandRunOptions): Promise<CommandResult>;
};

const BLOCKED_NAMES = /^(?:TICKETS_TO_MAIN_|TICKETS_PLEASE_TOKEN$)/i;

export function toolEnv(parent: NodeJS.ProcessEnv, secrets: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  const hidden = secrets.filter((secret) => secret.length > 0);
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (BLOCKED_NAMES.test(name)) continue;
    if (hidden.some((secret) => value.includes(secret))) continue;
    env[name] = value;
  }
  return env;
}

export function processRunner(): CommandRunner {
  return {
    run(argv, options) {
      if (argv.length === 0 || argv.some((part) => part.includes("\0"))) {
        return Promise.resolve({ code: null, stdout: "", stderr: "", error: "invalid argv" });
      }
      const [file, ...args] = argv;
      if (file === undefined) return Promise.resolve({ code: null, stdout: "", stderr: "", error: "invalid argv" });
      return new Promise((resolve) => {
        const child = spawn(file, args, {
          shell: false,
          windowsHide: true,
          timeout: options.timeoutMs,
          cwd: options.cwd,
          env: options.env ?? { PATH: process.env.PATH ?? "" },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let inputFailed = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        // A tool may close stdin without reading it; only promised nonempty input can be lost.
        child.stdin.on("error", () => { inputFailed = (options.input?.length ?? 0) > 0; });
        child.stdin.end(options.input ?? "");
        child.on("error", (error) => resolve({ code: null, stdout, stderr, error: error.message }));
        child.on("close", (code) => resolve({ code, stdout, stderr, ...(inputFailed ? { error: "Command input could not be delivered." } : {}) }));
      });
    },
  };
}
