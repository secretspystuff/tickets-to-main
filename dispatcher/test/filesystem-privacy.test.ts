import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertPrivateAccess, assertPrivateDirectory, ensurePrivateDirectory } from "../src/fs-safety.ts";
import { windowsPrivacy } from "../src/windows-privacy.ts";
import { makePublic } from "./helpers.ts";

test("the current user's private native directory is accepted and stays private", (t) => {
  const root = mkdtempSync(join(tmpdir(), "filesystem-privacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensurePrivateDirectory(root);
  assert.doesNotThrow(() => assertPrivateDirectory(root));
});

test("private creation on the checkout volume does not require changing its owner", (t) => {
  const root = mkdtempSync(join(process.cwd(), ".filesystem-privacy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensurePrivateDirectory(root);
  assertPrivateDirectory(root);
  const child = join(root, "child"); mkdirSync(child, { mode: 0o700 });
  assertPrivateDirectory(child);
});

test("privacy assertions reject additional readers without repairing the directory or caching a prior pass", (t) => {
  const root = mkdtempSync(join(tmpdir(), "filesystem-privacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensurePrivateDirectory(root);
  assertPrivateDirectory(root);
  makePublic(root);
  const before = process.platform === "win32" ? windowsPrivacy(root, "snapshot") : null;
  assert.throws(() => assertPrivateDirectory(root), /not private/);
  if (before) assert.equal(windowsPrivacy(root, "snapshot"), before);
  else chmodSync(root, 0o700);
});

test("files and inherited directories use the same native access rule", (t) => {
  const root = mkdtempSync(join(tmpdir(), "filesystem-privacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensurePrivateDirectory(root);
  const child = join(root, "child"); mkdirSync(child, { mode: 0o700 });
  const file = join(child, "private.json"); writeFileSync(file, "retained", { mode: 0o600 });
  assertPrivateDirectory(child); assertPrivateAccess(file);
  makePublic(file, 0o644);
  assert.throws(() => assertPrivateAccess(file), /not private/);
});

test("a null Windows DACL is refused and its descriptor is retained", (t) => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "filesystem-null-dacl-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  ensurePrivateDirectory(root);
  const encoded = Buffer.from(root).toString("base64");
  const script = `$ErrorActionPreference='Stop'; Add-Type 'using System; using System.Runtime.InteropServices; public class TtmAclFixture { [DllImport("advapi32.dll", CharSet=CharSet.Unicode, EntryPoint="SetNamedSecurityInfoW")] public static extern uint Set(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl); }'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $r=[TtmAclFixture]::Set($p,1,4,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero,[IntPtr]::Zero); if($r -ne 0){throw 'DACL fixture failed'}`;
  const result = spawnSync(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, shell: false });
  assert.equal(result.status, 0, "the adverse fixture must actually install a null DACL: " + result.stderr);
  const before = windowsPrivacy(root, "snapshot");
  assert.throws(() => assertPrivateDirectory(root), /not private/);
  assert.equal(windowsPrivacy(root, "snapshot"), before);
});
