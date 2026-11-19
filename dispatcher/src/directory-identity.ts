import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

type DirectoryInfo = { dev: bigint; ino: bigint; directory: boolean; link: boolean };
export type DirectoryHost = {
  platform: string; paths: typeof posix;
  inspect(path: string): DirectoryInfo;
  realpath(path: string): string;
  legacyPath?(path: string): string;
  readlink(path: string): string;
};
export type DirectoryIdentity = { path: string; legacyPath: string; identity: string; ancestors: readonly string[] };
const native: DirectoryHost = {
  platform: process.platform, paths: process.platform === "win32" ? win32 : posix,
  inspect(path) {
    const stat = lstatSync(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), link: stat.isSymbolicLink() };
  },
  realpath: (path) => realpathSync.native(path), legacyPath: (path) => realpathSync(path), readlink: readlinkSync,
};
const unavailable = () => new Error("Workspace identity is unavailable.");

function walk(path: string, host: DirectoryHost): string[] {
  const identities: string[] = [];
  let parent = path;
  for (;;) {
    const stat = host.inspect(parent);
    if (stat.link) {
      const target = parent === "/var" ? "/private/var" : parent === "/tmp" ? "/private/tmp" : null;
      if (host.platform !== "darwin" || target === null
        || host.paths.resolve(host.paths.dirname(parent), host.readlink(parent)) !== target
        || host.realpath(parent) !== target) throw unavailable();
    } else {
      if (!stat.directory || stat.dev < 0n || stat.ino <= 0n) throw unavailable();
      identities.push(`${stat.dev}:${stat.ino}`);
    }
    const next = host.paths.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  return identities;
}

export function assignmentDirectory(path: string, host: DirectoryHost = native): DirectoryIdentity {
  if (typeof path !== "string" || path.length > 4096 || !host.paths.isAbsolute(path)
    || path.split(host.platform === "win32" ? /[\\/]/ : /\//).some((part) => part === "." || part === "..")) throw unavailable();
  const requested = host.paths.resolve(path);
  walk(requested, host);
  const canonical = host.realpath(requested);
  const ancestors = walk(canonical, host);
  const stat = host.inspect(canonical);
  if (stat.link || !stat.directory || ancestors.length === 0) throw unavailable();
  return { path: canonical, legacyPath: host.legacyPath?.(path) ?? canonical, identity: ancestors[0]!, ancestors };
}

export function directoryBirthTime(directory: DirectoryIdentity): bigint {
  const current = lstatSync(directory.path, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || `${current.dev}:${current.ino}` !== directory.identity) throw unavailable();
  const { birthtimeNs, ctimeNs } = current;
  // Node can substitute the epoch or change time when creation time is unavailable.
  if (typeof birthtimeNs !== "bigint" || typeof ctimeNs !== "bigint" || birthtimeNs <= 0n || birthtimeNs >= ctimeNs) throw unavailable();
  return birthtimeNs;
}

export function directoriesOverlap(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.ancestors.includes(b.identity) || b.ancestors.includes(a.identity);
}
