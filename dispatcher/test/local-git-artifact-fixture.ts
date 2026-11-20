import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { removeDir, tempDir } from "./helpers.ts";

export const historicalMarker = "fabricated-local-git-artifact-marker";
const objectId = /^[0-9a-f]{40}$/;
const bundleLimit = 1024 * 1024;
const sourceRef = "refs/heads/fabricated-artifact";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function git(directory: string, args: readonly string[], input?: string | Buffer): Buffer {
  const result = spawnSync("git", ["--no-replace-objects", "-c", "protocol.allow=never", ...args], {
    cwd: directory, input, maxBuffer: 4 * bundleLimit, windowsHide: true,
    env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_AUTHOR_NAME: "Artifact Fixture", GIT_COMMITTER_NAME: "Artifact Fixture",
      GIT_AUTHOR_EMAIL: "fixture@fixture.invalid", GIT_COMMITTER_EMAIL: "fixture@fixture.invalid", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `Fabricated Git setup failed at ${args[0]}.`);
  return result.stdout;
}

function bareRepository(t: TestContext): string {
  const directory = tempDir();
  t.after(() => removeDir(directory));
  const template = join(directory, "empty-template");
  mkdirSync(template);
  git(directory, ["init", "--quiet", "--bare", "--object-format=sha1", `--template=${template}`]);
  return directory;
}

export function localBundle(t: TestContext, historicalHit: boolean) {
  const source = bareRepository(t);
  const archive = tempDir();
  t.after(() => removeDir(archive));
  const out = (args: readonly string[], input?: string) => git(source, args, input).toString("ascii").trim();
  assert.equal(out(["remote"]), "");
  const historicalBlob = out(["hash-object", "-w", "--stdin"], historicalHit ? historicalMarker : "fabricated history");
  const baseTree = out(["mktree"], `100644 blob ${historicalBlob}\tolder.txt\n`);
  const base = out(["commit-tree", baseTree], "fabricated base\n");
  const tipBlob = out(["hash-object", "-w", "--stdin"], "fabricated candidate");
  const tipTree = out(["mktree"], `100644 blob ${tipBlob}\tcandidate.txt\n`);
  const candidate = out(["commit-tree", tipTree, "-p", base], "fabricated tip\n");
  git(source, ["update-ref", sourceRef, candidate]);
  const file = join(archive, "captured.bundle");
  git(source, ["bundle", "create", "--version=2", file, sourceRef]);
  const digest = sha256(readFileSync(file));
  const refValue = () => out(["show-ref", "--verify", "--hash", sourceRef]);
  return { source, base, candidate, historicalBlob, file, digest, refValue };
}

export function localBundleInventory(t: TestContext, bytes: Buffer, digest: string, candidate: string) {
  assert.ok(bytes.length <= bundleLimit && objectId.test(candidate));
  assert.equal(sha256(bytes), digest);
  const header = Buffer.from(`# v2 git bundle\n${candidate} ${sourceRef}\n\n`);
  assert.deepEqual(bytes.subarray(0, header.length), header);
  const pack = bytes.subarray(header.length);
  assert.ok(pack.length >= 32 && pack.toString("ascii", 0, 4) === "PACK" && pack.readUInt32BE(4) === 2);
  const count = pack.readUInt32BE(8);
  assert.ok(count > 0 && count <= 64);
  const isolated = bareRepository(t);
  const installed = git(isolated, ["index-pack", "--stdin", "--strict", "--threads=1"], pack).toString("ascii").trimEnd();
  const packId = installed.match(/^pack\t([0-9a-f]{40})$/)?.[1];
  assert.ok(packId);
  assert.deepEqual(readFileSync(join(isolated, "objects", "pack", `pack-${packId}.pack`)), pack);
  const objects = git(isolated, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"])
    .toString("ascii").trimEnd().split("\n").map(line => line.split(" "));
  const reachable = git(isolated, ["rev-list", "--objects", "--no-object-names", candidate]).toString("ascii").trimEnd().split("\n").sort();
  assert.equal(objects.length, count);
  assert.deepEqual(objects.map(([id]) => id).sort(), reachable);
  const artifacts: { name: string; bytes: Buffer }[] = [{ name: "bundle-ref", bytes: Buffer.from(sourceRef) }];
  for (const [id, kind] of objects) {
    assert.ok(id && objectId.test(id));
    if (kind === "commit" || kind === "blob") {
      artifacts.push({ name: `${kind}-${id}`, bytes: git(isolated, ["cat-file", kind, id]) });
    } else {
      assert.equal(kind, "tree");
      const entries = git(isolated, ["ls-tree", "-z", id]);
      let start = 0;
      for (let end = entries.indexOf(0, start); end !== -1; end = entries.indexOf(0, start)) {
        const tab = entries.indexOf(9, start);
        assert.ok(tab > start && tab < end);
        assert.match(entries.toString("ascii", start, tab), /^(?:040000 tree|100(?:644|755) blob) [0-9a-f]{40}$/);
        artifacts.push({ name: `tree-${id}-${start}`, bytes: entries.subarray(tab + 1, end) });
        start = end + 1;
      }
      assert.equal(start, entries.length);
    }
  }
  return { expected: artifacts.map(({ name, bytes }) => ({ name, size: bytes.length, sha256: sha256(bytes) })), artifacts, secrets: [historicalMarker] };
}
