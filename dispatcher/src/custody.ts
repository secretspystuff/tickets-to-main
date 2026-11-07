import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { WindowsCredentialHost } from "./windows-custody.ts";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { StateError, writePrivateFile } from "./fs-safety.ts";

export type CustodyKind = "test-double" | "secret-tool" | "windows-credential-manager" | "unavailable";

export type CustodyDescription = {
  kind: CustodyKind;
  qualified: false;
};

export type Custody = {
  readonly scopeId?: string;
  describe(): CustodyDescription;
  put(account: string, secret: string): Promise<void>;
  get(account: string): Promise<string | null>;
  delete(account: string): Promise<void>;
};

export const BOARD_KEY_ACCOUNT = "board-key";
export const DEVICE_CODE_ACCOUNT = "device-code";

export class MemoryCustody implements Custody {
  private readonly values = new Map<string, string>();

  describe(): CustodyDescription {
    return { kind: "test-double", qualified: false };
  }

  put(account: string, secret: string): Promise<void> {
    this.values.set(account, secret);
    return Promise.resolve();
  }

  get(account: string): Promise<string | null> {
    return Promise.resolve(this.values.get(account) ?? null);
  }

  delete(account: string): Promise<void> {
    this.values.delete(account);
    return Promise.resolve();
  }
}

export class TestKeychain implements Custody {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  describe(): CustodyDescription {
    return { kind: "test-double", qualified: false };
  }

  private read(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") values[key] = value;
      }
      return values;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async put(account: string, secret: string): Promise<void> {
    const values = this.read();
    values[account] = secret;
    writePrivateFile(this.path, `${JSON.stringify(values)}\n`);
  }

  async get(account: string): Promise<string | null> {
    return this.read()[account] ?? null;
  }

  async delete(account: string): Promise<void> {
    const values = this.read();
    delete values[account];
    writePrivateFile(this.path, `${JSON.stringify(values)}\n`);
  }
}

export type SecretToolRunner = {
  run(argv: readonly string[], input: string): Promise<{ code: number | null; stdout: string; error?: string }>;
};

export class SecretToolCustody implements Custody {
  private readonly runner: SecretToolRunner;

  constructor(runner: SecretToolRunner) {
    this.runner = runner;
  }

  describe(): CustodyDescription {
    return { kind: "secret-tool", qualified: false };
  }

  async put(account: string, secret: string): Promise<void> {
    const result = await this.runner.run(
      ["secret-tool", "store", "--label", "Tickets to Main", "service", "tickets-to-main", "account", account],
      secret,
    );
    if (result.code !== 0) throw new StateError("The keychain did not save the secret.");
    if (result.stdout.includes(secret)) throw new StateError("The keychain echoed the secret. It was refused.");
  }

  async get(account: string): Promise<string | null> {
    const result = await this.runner.run(
      ["secret-tool", "lookup", "service", "tickets-to-main", "account", account],
      "",
    );
    if (result.code !== 0) return null;
    const secret = result.stdout.replace(/\n$/, "");
    return secret.length > 0 ? secret : null;
  }

  async delete(account: string): Promise<void> {
    const result = await this.runner.run(["secret-tool", "clear", "service", "tickets-to-main", "account", account], "");
    if (result.stdout.length > 0) throw new StateError("The keychain echoed a secret. It was not cleared.");
    if (result.code !== 0) throw new StateError("The keychain did not remove the secret.");
    const still = await this.get(account);
    if (still !== null) throw new StateError("The keychain did not remove the secret.");
  }
}

export class UnavailableCustody implements Custody {
  describe(): CustodyDescription {
    return { kind: "unavailable", qualified: false };
  }

  put(): Promise<void> {
    return Promise.reject(new StateError("The keychain is not available. Nothing was saved to a file."));
  }

  get(): Promise<string | null> {
    return Promise.resolve(null);
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}

export function processSecretTool(): SecretToolRunner {
  return {
    run(argv, input) {
      const [file, ...args] = argv;
      if (file !== "secret-tool") return Promise.resolve({ code: null, stdout: "", error: "invalid argv" });
      if (args.some((part) => part.includes("\0"))) return Promise.resolve({ code: null, stdout: "", error: "invalid argv" });
      return new Promise((resolve) => {
        const child = spawn(file, args, {
          shell: false,
          windowsHide: true,
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}),
        },
        });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stdin.end(input);
        child.on("error", (error) => resolve({ code: null, stdout, error: error.message }));
        child.on("close", (code) => resolve({ code, stdout }));
      });
    },
  };
}

export function openCustody(env: NodeJS.ProcessEnv, secretTool: boolean, runner: SecretToolRunner, platform: NodeJS.Platform = process.platform): Custody {
  if (env.TICKETS_TO_MAIN_TEST_CUSTODY === "1") {
    const path = env.TICKETS_TO_MAIN_TEST_KEYCHAIN;
    if (!path || !path.startsWith("/")) throw new StateError("The test keychain path is missing.");
    return new TestKeychain(path);
  }
  if (env.TICKETS_TO_MAIN_TEST_CUSTODY !== undefined) throw new StateError("The test keychain switch is not valid.");
  if (platform === "win32") return new UnavailableCustody();
  if (secretTool) return new SecretToolCustody(runner);
  return new UnavailableCustody();
}

export function secretToolPresent(): boolean {
  const result = spawnSync("secret-tool", ["--version"], { timeout: 1000, windowsHide: true, stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}

// CLR startup can load sibling configuration before Main; the helper directory therefore contains only its pinned image.
function helperSha256(executable: string): string {
  const directory = dirname(executable);
  const image = lstatSync(executable);
  const folder = lstatSync(directory);
  const entries = readdirSync(directory, { withFileTypes: true });
  if (!image.isFile() || image.isSymbolicLink() || !folder.isDirectory() || folder.isSymbolicLink()
    || realpathSync(directory) !== resolve(directory) || entries.length !== 1
    || entries[0]?.name !== basename(executable) || !entries[0].isFile() || entries[0].isSymbolicLink()) {
    throw new StateError("The credential helper installation boundary could not be verified.");
  }
  return createHash("sha256").update(readFileSync(executable)).digest("hex");
}

export function processWindowsCredentialHost(): WindowsCredentialHost {
  return {
    async executableSha256(executable) {
      return helperSha256(executable);
    },
    async invoke(launch, input) {
      const unavailable = { code: null, stdout: "", stderr: "", error: "The pinned Windows credential helper is unavailable." };
      try {
        const executable = launch.argv[0];
        if (!executable || launch.argv.length !== 1 || launch.shell !== false || input.length > 16384
          || Object.keys(launch.env).some((name) => name !== "SystemRoot" && name !== "WINDIR")
          || helperSha256(executable) !== launch.expectedSha256) return unavailable;
        return await new Promise((resolve) => {
          const child = spawn(executable, [], { shell: false, windowsHide: true, timeout: 5000, cwd: dirname(executable), env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          let error: string | undefined;
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            if (stdout.length + chunk.length > 16384) error = "The credential helper reply was too large.";
            else if (!error) stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
            if (stderr.length + chunk.length > 1024) error = "The credential helper returned unexpected diagnostics.";
            else if (!error) stderr += chunk;
          });
          child.stdin.on("error", () => { error = "The credential helper input was interrupted."; });
          child.on("error", () => { error = "The credential helper could not start."; });
          child.on("close", (code, signal) => resolve({ code, stdout, stderr, ...(error || signal ? { error: error ?? "The credential helper was interrupted." } : {}) }));
          child.stdin.end(input);
        });
      } catch { return unavailable; }
    },
  };
}
