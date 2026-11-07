import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { install } from "../src/install.ts";
import { io, removeDir, tempDir } from "./helpers.ts";
import { run } from "../src/cli.ts";
import { activeDirectory, digest, FILES, fixture, installFixture, rejectedUnchanged, snapshot } from "./release-test-fixtures.ts";

test("generated Ed25519 release verifies through the existing installer without platform qualification", () => {
  const dir = tempDir();
  try {
    const sample = installFixture(dir);
    for (const file of FILES) assert.deepEqual(readFileSync(join(activeDirectory(dir), file.path)), file.bytes);
    assert.equal(JSON.stringify(snapshot(dir)).includes("PRIVATE KEY"), false);
    assert.equal(sample.services.releaseTrust!.keys.get(sample.manifest.keyId)?.asymmetricKeyType, "ed25519");
  } finally { removeDir(dir); }
});

for (const mutation of ["signature", "manifest", "artifact", "artifact-size", "artifact-hash", "missing-artifact", "extra-artifact", "duplicate-artifact"] as const) {
  test(`${mutation} tampering changes nothing on first install or explicit replacement`, () => {
    for (const existing of [false, true]) {
      const dir = tempDir();
      try {
        const old = existing ? installFixture(dir, "0.1.0") : null;
        const sample = fixture(dir);
        if (old) sample.services.releaseTrust!.keys.set(old.manifest.keyId, old.services.releaseTrust!.keys.get(old.manifest.keyId)!);
        const input = sample.signed();
        const release = input.release!;
        if (mutation === "signature") release.signatureBytes = Buffer.alloc(64);
        if (mutation === "manifest") release.manifestBytes = Buffer.from(JSON.stringify({ ...sample.manifest, version: "0.9.0" }));
        if (mutation === "artifact") release.artifacts[0]!.bytes = Buffer.from("changed");
        if (mutation === "artifact-size") { sample.manifest.files[0]!.size += 1; input.release = sample.signed().release; }
        if (mutation === "artifact-hash") { sample.manifest.files[0]!.sha256 = "0".repeat(64); input.release = sample.signed().release; }
        if (mutation === "missing-artifact") release.artifacts.pop();
        if (mutation === "extra-artifact") release.artifacts.push({ path: "unlisted.txt", bytes: Buffer.from("extra") });
        if (mutation === "duplicate-artifact") release.artifacts.push(release.artifacts[0]!);
        rejectedUnchanged(dir, input, sample.services);
        if (!existing) assert.equal(existsSync(join(dir, "ledger.json")), false);
      } finally { removeDir(dir); }
    }
  });
}

for (const mutation of ["version", "platform", "arch", "repository", "workflow", "ref", "source-commit", "incompatible-data", "schema", "unknown-field", "unknown-key", "revoked-key", "wrong-key", "wrong-key-type"] as const) {
  test(`even signed ${mutation} mismatch is refused before installation`, () => {
    const dir = tempDir();
    try {
      const sample = fixture(dir);
      const manifest = sample.manifest;
      if (mutation === "version") manifest.version = "0.1.0";
      if (mutation === "platform") manifest.platform = "darwin";
      if (mutation === "arch") manifest.arch = "arm64";
      if (mutation === "repository") manifest.provenance.repository += "-impostor";
      if (mutation === "workflow") manifest.provenance.workflow = ".github/workflows/untrusted.yml";
      if (mutation === "ref") manifest.provenance.ref = "refs/heads/main";
      if (mutation === "source-commit") manifest.provenance.sourceCommit = "b".repeat(40);
      if (mutation === "incompatible-data") manifest.dataCompatibility = { min: 2, max: 3 };
      if (mutation === "schema") Object.assign(manifest, { schema: 2 });
      if (mutation === "unknown-field") Object.assign(manifest, { verified: true });
      if (mutation === "unknown-key") manifest.keyId = "untrusted-key";
      if (mutation === "revoked-key") sample.services.releaseTrust!.revokedKeyIds = [manifest.keyId];
      if (mutation === "wrong-key") sample.services.releaseTrust!.keys.set(manifest.keyId, generateKeyPairSync("ed25519").publicKey);
      if (mutation === "wrong-key-type") sample.services.releaseTrust!.keys.set(manifest.keyId, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
      rejectedUnchanged(dir, sample.signed(), sample.services);
    } finally { removeDir(dir); }
  });
}

test("request booleans, manifest-supplied trust and missing authority cannot authorize a release", () => {
  const dir = tempDir();
  try {
    const sample = fixture(dir);
    const request = sample.signed();
    Object.assign(request.release!, { verified: true, releaseVerified: true, trusted: true, publicKey: sample.services.releaseTrust!.keys.get(sample.manifest.keyId) });
    rejectedUnchanged(dir, request, {});
    rejectedUnchanged(dir, sample.signed(), { releaseTrust: { ...sample.services.releaseTrust!, keys: new Map() } });
  } finally { removeDir(dir); }
});

for (const raw of ["{", "null", "[]", '{"schema":1,"schema":1}', '{"schema":1,"version":"0.2.0","version":"0.1.0"}']) {
  test(`malformed or ambiguous authenticated manifest ${raw.slice(0, 24)} installs nothing`, () => {
    const dir = tempDir();
    try {
      const sample = fixture(dir);
      rejectedUnchanged(dir, sample.signed(sample.manifest, Buffer.from(raw)), sample.services);
    } finally { removeDir(dir); }
  });
}

test("a complete otherwise-valid manifest with duplicate member is refused", () => {
  const dir = tempDir();
  try {
    const sample = fixture(dir);
    const raw = JSON.stringify(sample.manifest).replace('"schema":1,', '"schema":1,"schema":1,');
    rejectedUnchanged(dir, sample.signed(sample.manifest, Buffer.from(raw)), sample.services);
  } finally { removeDir(dir); }
});

for (const path of ["../outside", "/absolute", "C:/absolute", "C:relative", "\\\\server\\share", "bin\\..\\outside", "bin/../outside", "bin//runtime", "./runtime", "bin/runtime.", "bin/runtime ", "bin/runtime:ads", "CON", "bin/NUL.txt", ".release-manifest.json", "bin/\u0000runtime"]) {
  test(`signed artifact path ${JSON.stringify(path)} cannot escape or alias installation files`, () => {
    const parent = tempDir();
    const dir = join(parent, "state");
    mkdirSync(dir, { mode: 0o700 });
    const outside = join(parent, "outside.txt");
    writeFileSync(outside, "preserve external bytes");
    const attackPath = path === "/absolute" ? outside : path;
    try {
      const sample = fixture(dir);
      sample.manifest.files[0]!.path = attackPath;
      const input = sample.signed();
      input.release!.artifacts[0]!.path = attackPath;
      const before = snapshot(parent);
      rejectedUnchanged(dir, input, sample.services);
      assert.deepEqual(snapshot(parent), before);
    } finally { removeDir(parent); }
  });
}

test("case collisions and file/directory collisions are refused before writing", () => {
  for (const path of ["BIN/DISPATCHER.MJS", "bin"]) {
    const dir = tempDir();
    try {
      const sample = fixture(dir);
      const bytes = Buffer.from("collision");
      sample.manifest.files.push({ path, size: bytes.length, sha256: digest(bytes), executable: false });
      const input = sample.signed();
      input.release!.artifacts.push({ path, bytes });
      rejectedUnchanged(dir, input, sample.services);
    } finally { removeDir(dir); }
  }
});

test("a different signing algorithm cannot replace Ed25519 even when its key is in the trust map", () => {
  const dir = tempDir();
  try {
    const sample = fixture(dir);
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    sample.services.releaseTrust!.keys.set(sample.manifest.keyId, pair.publicKey);
    const input = sample.signed();
    input.release!.signatureBytes = sign("sha256", input.release!.manifestBytes, pair.privateKey);
    rejectedUnchanged(dir, input, sample.services);
  } finally { removeDir(dir); }
});

test("status and health never replace an installation when release-looking environment values are present", async () => {
  const dir = tempDir();
  try {
    installFixture(dir);
    const before = snapshot(dir);
    const context = io({ platform: "win32", env: { TICKETS_TO_MAIN_RELEASE_VERSION: "9.9.9", TICKETS_TO_MAIN_RELEASE_VERIFIED: "1" } });
    for (const command of ["status", "health"]) {
      await run([command, "--state", dir], context);
      assert.deepEqual(snapshot(dir), before);
    }
    assert.doesNotMatch(context.out, /updat(?:ed|ing) to 9\.9\.9/i);
  } finally { removeDir(dir); }
});

for (const version of ["", "latest", "*", "../outside", "0.2.0/../outside", "C:version"]) {
  test(`an explicit request must pin a valid release version: ${JSON.stringify(version)}`, () => {
    const parent = tempDir();
    const dir = join(parent, "state");
    mkdirSync(dir, { mode: 0o700 });
    try {
      const sample = fixture(dir, version);
      const before = snapshot(parent);
      rejectedUnchanged(dir, sample.signed(), sample.services);
      assert.deepEqual(snapshot(parent), before);
    } finally { removeDir(parent); }
  });
}

test("bare install cannot silently replace a selected release with the running bootstrap package", async () => {
  const dir = tempDir();
  try {
    installFixture(dir);
    const before = snapshot(dir);
    const context = io({ platform: "win32" });
    await run(["install", "--state", dir], context);
    assert.deepEqual(snapshot(dir), before);
  } finally { removeDir(dir); }
});
