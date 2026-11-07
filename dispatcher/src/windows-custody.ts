import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT, type Custody, type CustodyDescription } from "./custody.ts";
import { StateError } from "./fs-safety.ts";

export type WindowsCredentialRunner = {
  run(input: string): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }>;
};
export type WindowsCredentialPin = { executable: string; sha256: string; releaseVerified: boolean };
export type WindowsCredentialLaunch = { argv: readonly string[]; env: NodeJS.ProcessEnv; shell: false; expectedSha256: string };
export type WindowsCredentialHost = {
  executableSha256(executable: string): Promise<string>;
  invoke(launch: WindowsCredentialLaunch, input: string): ReturnType<WindowsCredentialRunner["run"]>;
};

const PREFIX = "TicketsToMain/dispatcher/v1/";
const OWNER = "Tickets to Main Dispatcher v1";
const ACCOUNTS = new Set([BOARD_KEY_ACCOUNT, DEVICE_CODE_ACCOUNT]);
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BLOB = 2560;
const MAX_REPLY = 16384;
const decoder = new TextDecoder("utf-8", { fatal: true });

function fail(): never { throw new StateError("Windows Credential Manager could not complete the operation. No file fallback was used."); }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function absolutePath(value: string): boolean {
  if (value.includes("\0")) return false;
  const root = win32.parse(value).root;
  return /^[A-Za-z]:[\\/]$/.test(root) || /^\\\\[^\\]+\\[^\\]+\\$/.test(root);
}

export function windowsCredentialScope(canonicalStateDir: string): string {
  if (!absolutePath(canonicalStateDir)) fail();
  return createHash("sha256").update(win32.normalize(canonicalStateDir).toLowerCase()).digest("hex");
}

export function windowsCredentialLaunch(pin: WindowsCredentialPin | null, parent: NodeJS.ProcessEnv): WindowsCredentialLaunch | null {
  if (pin === null || pin.releaseVerified !== true) return null;
  if (!absolutePath(pin.executable) || !/\.exe$/i.test(pin.executable) || !DIGEST.test(pin.sha256)) fail();
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (name.toLowerCase() === "systemroot" || name.toLowerCase() === "windir") {
      if (!absolutePath(value)) fail();
      env[name.toLowerCase() === "systemroot" ? "SystemRoot" : "WINDIR"] = value;
    }
  }
  return { argv: [pin.executable], env, shell: false, expectedSha256: pin.sha256 };
}

export function createWindowsCredentialRunner(pin: WindowsCredentialPin | null, parent: NodeJS.ProcessEnv, host: WindowsCredentialHost): WindowsCredentialRunner {
  const launch = windowsCredentialLaunch(pin, parent);
  return {
    async run(input) {
      if (!launch) fail();
      try {
        const executable = launch.argv[0];
        if (!executable || await host.executableSha256(executable) !== launch.expectedSha256) fail();
        return await host.invoke({ ...launch, argv: [...launch.argv], env: { ...launch.env } }, input);
      } catch { fail(); }
    },
  };
}

export class WindowsCredentialCustody implements Custody {
  readonly scopeId: string;
  private readonly runner: WindowsCredentialRunner;

  constructor(runner: WindowsCredentialRunner, scope: string) {
    if (!DIGEST.test(scope)) fail();
    this.runner = runner;
    this.scopeId = scope;
  }

  describe(): CustodyDescription { return { kind: "windows-credential-manager", qualified: false }; }

  private target(account: string): string {
    if (!ACCOUNTS.has(account)) fail();
    return `${PREFIX}${this.scopeId}/${account}`;
  }

  private async request(input: unknown): Promise<Record<string, unknown>> {
    try {
      const result = await this.runner.run(JSON.stringify(input));
      if (result.code !== 0 || result.error !== undefined || typeof result.stdout !== "string" || typeof result.stderr !== "string"
        || result.stderr !== "" || result.stdout.length > MAX_REPLY) fail();
      const reply = object(JSON.parse(result.stdout));
      if (!reply) fail();
      return reply;
    } catch { fail(); }
  }

  private async read(target: string): Promise<string | null> {
    const reply = await this.request({ operation: "read", target, type: 1, flags: 0 });
    if (reply.status === "not-found" && exact(reply, ["status"])) return null;
    if (reply.status !== "found" || !exact(reply, ["status", "credential"])) fail();
    const credential = object(reply.credential);
    if (!credential || !exact(credential, ["target", "type", "persist", "flags", "username", "blob"])
      || credential.target !== target || credential.type !== 1 || credential.persist !== 2 || credential.flags !== 0
      || credential.username !== OWNER || typeof credential.blob !== "string" || credential.blob.length > Math.ceil(MAX_BLOB / 3) * 4) fail();
    try {
      const bytes = Buffer.from(credential.blob, "base64");
      if (bytes.length === 0 || bytes.length > MAX_BLOB || bytes.toString("base64") !== credential.blob) fail();
      return decoder.decode(bytes);
    } catch { fail(); }
  }

  async get(account: string): Promise<string | null> { return this.read(this.target(account)); }

  async put(account: string, secret: string): Promise<void> {
    const target = this.target(account);
    if (secret.length === 0 || Buffer.byteLength(secret, "utf8") > MAX_BLOB) fail();
    const bytes = Buffer.from(secret, "utf8");
    if (decoder.decode(bytes) !== secret) fail();
    await this.read(target);
    const reply = await this.request({ operation: "write", flags: 0, credential: { target, type: 1, persist: 2, flags: 0, username: OWNER, blob: bytes.toString("base64") } });
    if (reply.status !== "written" || !exact(reply, ["status"])) fail();
    if (await this.read(target) !== secret) fail();
  }

  async delete(account: string): Promise<void> {
    const target = this.target(account);
    if (await this.read(target) === null) return;
    const reply = await this.request({ operation: "delete", target, type: 1, flags: 0 });
    if (!exact(reply, ["status"]) || (reply.status !== "deleted" && reply.status !== "not-found")) fail();
    if (await this.read(target) !== null) fail();
  }
}
