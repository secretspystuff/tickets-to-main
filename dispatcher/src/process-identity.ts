import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

export type ProcessOwner = { pid: number; birth?: string };
export const validProcessBirth = (value: unknown): value is string => typeof value === "string"
  && (/^linux:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}:[1-9][0-9]*$/.test(value) || /^win32:[1-9][0-9]{15,19}$/.test(value)
    || (value.startsWith("darwin:") && macStart(value.slice(7)) !== null));
export type ProcessHost = {
  platform: string;
  alive(pid: number): boolean;
  read(path: string): string;
  run(pid: number): string;
};
export const nativeProcessHost = (platform: NodeJS.Platform = process.platform): ProcessHost => ({
  platform,
  alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  },
  read: (path) => readFileSync(path, "utf8"),
  run(pid) {
    if (platform === "darwin") {
      const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8", shell: false, timeout: 5000, maxBuffer: 4096,
        env: { LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error || result.status !== 0 || result.stderr.trim() !== "") throw new Error("Process observation unavailable.");
      return result.stdout;
    }
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
});
const native = nativeProcessHost();

function macStart(value: string): string | null {
  const match = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+([0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(value.trim());
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[2]!);
  const [day, hour, minute, second, year] = match.slice(3).map(Number);
  const date = new Date(Date.UTC(year!, month, day!, hour!, minute!, second!));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return `${match[1]} ${match[2]} ${day} ${match[4]}:${match[5]}:${match[6]} ${match[7]}`;
}

let ownBirth: string | null = null;

export function processBirth(pid: number, host: ProcessHost = native): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (host === native && pid === process.pid && ownBirth) return ownBirth;
  try {
    if (host.platform === "linux") {
      const boot = host.read("/proc/sys/kernel/random/boot_id").trim();
      const stat = host.read(`/proc/${pid}/stat`);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot) || !stat.startsWith(pid + " (")) return null;
      const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      const ticks = fields[19];
      if (!ticks || !/^[1-9][0-9]*$/.test(ticks)) return null;
      const value = `linux:${boot}:${ticks}`;
      if (host === native && pid === process.pid) ownBirth = value;
      return value;
    }
    if (host.platform === "win32") {
      const ticks = host.run(pid).trim();
      if (!/^[1-9][0-9]{15,19}$/.test(ticks)) return null;
      const value = "win32:" + ticks;
      if (host === native && pid === process.pid) ownBirth = value;
      return value;
    }
    if (host.platform === "darwin") {
      const start = macStart(host.run(pid));
      if (!start) return null;
      const value = "darwin:" + start;
      if (host === native && pid === process.pid) ownBirth = value;
      return value;
    }
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
