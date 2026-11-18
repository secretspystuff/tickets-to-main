import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

export type ProcessOwner = { pid: number; birth?: string };
export const validProcessBirth = (value: unknown): value is string => typeof value === "string"
  && (/^linux:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9][0-9]*$/.test(value) || /^win32:[1-9][0-9]{15,19}$/.test(value));
export type ProcessHost = {
  platform: string;
  alive(pid: number): boolean;
  read(path: string): string;
  run(pid: number): string;
};
const native: ProcessHost = {
  platform: process.platform,
  alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
  read: (path) => readFileSync(path, "utf8"),
  run(pid) {
    const root = process.env.SystemRoot;
    if (!root || !win32.isAbsolute(root)) throw new Error("Process observation unavailable.");
    const result = spawnSync(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; [System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)`],
      { encoding: "utf8", shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4096,
        env: { SystemRoot: root }, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.status !== 0 || result.stderr.trim() !== "") throw new Error("Process observation unavailable.");
    return result.stdout;
  },
};

export function processBirth(pid: number, host: ProcessHost = native): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (host.platform === "linux") {
      const boot = host.read("/proc/sys/kernel/random/boot_id").trim();
      const stat = host.read(`/proc/${pid}/stat`);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot) || !stat.startsWith(pid + " (")) return null;
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const ticks = fields[19];
      if (!ticks || !/^[1-9][0-9]*$/.test(ticks)) return null;
      return `linux:${boot}:${ticks}`;
    }
    if (host.platform === "win32") {
      const ticks = host.run(pid).trim();
      if (!/^[1-9][0-9]{15,19}$/.test(ticks)) return null;
      return "win32:" + ticks;
    }
    // A coarse ps timestamp cannot safely distinguish process incarnations.
    return null;
  } catch { return null; }
}

export function currentProcessOwner(): ProcessOwner {
  const birth = processBirth(process.pid);
  return { pid: process.pid, ...(birth ? { birth } : {}) };
}

export function processOwnerAlive(owner: ProcessOwner, dormantSelf = false, host: ProcessHost = native): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return true;
  if (!host.alive(owner.pid)) return false;
  const current = owner.birth ? processBirth(owner.pid, host) : null;
  if (owner.birth && current && owner.birth !== current) return false;
  if (dormantSelf && owner.pid === process.pid && (!owner.birth || owner.birth === current)) return false;
  return true;
}
