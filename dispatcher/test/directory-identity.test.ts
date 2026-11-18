import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { assignmentDirectory, directoriesOverlap, type DirectoryHost } from "../src/directory-identity.ts";

function windowsHost(): DirectoryHost {
  const ids = new Map([["c:\\", 1n], ["c:\\state", 2n], ["c:\\work", 3n], ["c:\\work\\child", 4n], ["c:\\case\\a", 5n], ["c:\\case\\A", 6n], ["c:\\case", 7n]]);
  return { platform: "win32", paths: win32,
    realpath: (path) => path.replace(/^\\\\\?\\/, "").replace(/short~1/i, "Work"),
    readlink: () => { throw new Error("not a link"); },
    inspect: (path) => {
      const base = path.replace(/^\\\\\?\\/, "").replace(/short~1/i, "Work");
      const normalized = base.length > 3 ? base.replace(/[\\/]$/, "") : base;
      const ino = ids.get(normalized.startsWith("C:\\case") ? "c:" + normalized.slice(2) : normalized.toLowerCase());
      if (!ino) throw new Error("unknown directory");
      return { dev: 1n, ino, directory: true, link: false };
    } };
}

test("Windows case, separator, short-name and extended-path aliases have one directory identity", () => {
  const host = windowsHost();
  const values = ["C:\\Work", "c:\\work", "C:/WORK/", "C:\\short~1", "\\\\?\\C:\\Work"].map((path) => assignmentDirectory(path, host));
  assert.equal(new Set(values.map((value) => value.identity)).size, 1);
  assert.equal(directoriesOverlap(values[0]!, assignmentDirectory("C:\\work\\child", host)), true);
  assert.equal(directoriesOverlap(values[0]!, assignmentDirectory("C:\\state", host)), false);
});

test("Windows case-sensitive siblings stay distinct despite case-insensitive lexical comparison", () => {
  const host = windowsHost();
  const a = assignmentDirectory("C:\\case\\a", host);
  const b = assignmentDirectory("C:\\case\\A", host);
  assert.notEqual(a.identity, b.identity);
  assert.equal(directoriesOverlap(a, b), false);
});

function darwinHost(targets = new Map([["/var", "/private/var"], ["/tmp", "/private/tmp"]])): DirectoryHost {
  const names = ["/", "/private", "/private/var", "/private/tmp", "/private/var/state", "/private/tmp/work", "/elsewhere", "/elsewhere/work"];
  const canonical = (path: string) => { for (const [link, target] of targets) if (path === link || path.startsWith(link + "/")) return target + path.slice(link.length); return path; };
  return { platform: "darwin", paths: posix, readlink: (path) => targets.get(path)!, realpath: canonical,
    inspect: (path) => {
      if (targets.has(path)) return { dev: 1n, ino: 99n, directory: false, link: true };
      const index = names.indexOf(canonical(path));
      if (index < 0) throw new Error("unknown directory");
      return { dev: 1n, ino: BigInt(index + 1), directory: true, link: false };
    } };
}

test("macOS exact system /var and /tmp aliases reach the same canonical directory", () => {
  const host = darwinHost();
  for (const [alias, real] of [["/var/state", "/private/var/state"], ["/tmp/work", "/private/tmp/work"]]) {
    assert.equal(assignmentDirectory(alias!, host).identity, assignmentDirectory(real!, host).identity);
    assert.equal(assignmentDirectory(alias!, host).path, real);
  }
});

test("macOS exceptions reject retargeted system aliases, arbitrary links and link/dot-dot tricks", () => {
  for (const [link, target, input] of [["/tmp", "/elsewhere", "/tmp/work"], ["/var", "/private/tmp", "/var/work"], ["/alias", "/private/tmp", "/alias/work"]]) {
    assert.throws(() => assignmentDirectory(input!, darwinHost(new Map([[link!, target!]]))));
  }
  assert.throws(() => assignmentDirectory("/tmp/../elsewhere/work", darwinHost()));
  assert.throws(() => assignmentDirectory("/tmp/work", { ...darwinHost(), platform: "linux" }));
});

test("missing filesystem identity never falls back to a path spelling", () => {
  for (const ino of [0n, -1n]) assert.throws(() => assignmentDirectory("/private/tmp/work", {
    ...darwinHost(), inspect: () => ({ dev: 1n, ino, directory: true, link: false }),
  }));
});

test("native directory identities are stable and do not merge distinct real directories", (t) => {
  const root = mkdtempSync(join(tmpdir(), "directory-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = join(root, "child"); mkdirSync(child);
  const a = assignmentDirectory(root);
  const b = assignmentDirectory(child);
  assert.equal(assignmentDirectory(root).identity, a.identity);
  assert.notEqual(a.identity, b.identity);
  assert.equal(directoriesOverlap(a, b), true);
  if (process.platform === "win32") assert.equal(assignmentDirectory(root.toUpperCase()).identity, a.identity);
});
