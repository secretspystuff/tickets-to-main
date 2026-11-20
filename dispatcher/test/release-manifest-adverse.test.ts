import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { install } from "../src/install.ts";
import { loadLedger, saveLedger } from "../src/ledger.ts";
import { releaseDirectory, SIGNATURE_FILE, type ReleaseManifest } from "../src/release-manifest.ts";
import { statusOf } from "../src/status.ts";
import { io, removeDir, tempDir } from "./helpers.ts";
import { run } from "../src/cli.ts";
import { active, activeDirectory, digest, FILES, fixture, installFixture, rejectedUnchanged, snapshot } from "./release-test-fixtures.ts";

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

test("status verifies the exact selected release with separate fixture trust", async () => {
  const dir = tempDir();
  try {
    const sample = installFixture(dir, "0.4.2");
    const before = snapshot(dir);
    const status = await statusOf(dir, io().custody!, undefined, {
      platform: sample.input.platform, arch: sample.input.arch, trust: sample.services.releaseTrust,
    });
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(status.releaseVerification, {
      state: "verified",
      version: sample.manifest.version,
      manifestDigest: active(dir).manifestDigest,
      sourceCommit: sample.manifest.provenance.sourceCommit,
    });
    assert.equal(status.exitCode, 0);
    assert.ok(status.lines.includes("Selected release: 0.4.2 verified."));
    assert.ok(status.lines.includes("Startup: unregistered."));
    assert.ok(status.lines.includes("Signed installers: unqualified."));
    assert.equal(status.readyForAssignment, false);
  } finally { removeDir(dir); }
});

for (const problem of [
  "missing trust", "revoked trust", "invalid signature", "changed content", "missing content",
  "wrong platform", "wrong architecture", "wrong version",
] as const) {
  test("selected release preflight refuses " + problem + " without changing state", async () => {
    const dir = tempDir();
    try {
      const sample = installFixture(dir);
      const trust = sample.services.releaseTrust!;
      const artifact = join(activeDirectory(dir), FILES[0]!.path);
      if (problem === "invalid signature" || problem === "changed content") {
        const path = problem === "invalid signature" ? join(activeDirectory(dir), SIGNATURE_FILE) : artifact;
        const bytes = readFileSync(path);
        bytes[0] = bytes[0]! ^ 1;
        writeFileSync(path, bytes);
      }
      if (problem === "missing content") unlinkSync(artifact);
      if (problem === "wrong version") {
        const loaded = loadLedger(dir);
        assert.ok(loaded.ok && loaded.ledger.install?.release);
        const record = loaded.ledger.install;
        const selected = record.release!;
        const oldDirectory = selected.directory;
        record.packageVersion = "0.4.2";
        selected.directory = releaseDirectory(record.packageVersion, selected.manifestDigest);
        renameSync(join(dir, oldDirectory), join(dir, selected.directory));
        saveLedger(dir, loaded.ledger, []);
      }
      const before = snapshot(dir);
      const status = await statusOf(dir, io().custody!, undefined, {
        platform: problem === "wrong platform" ? "darwin" : sample.input.platform,
        arch: problem === "wrong architecture" ? "arm64" : sample.input.arch,
        trust: problem === "missing trust" ? undefined : problem === "revoked trust" ? {
          ...trust, revokedKeyIds: [sample.manifest.keyId],
        } : trust,
      });
      assert.deepEqual(snapshot(dir), before);
      const unavailable = problem === "missing trust";
      assert.deepEqual(status.releaseVerification, { state: unavailable ? "unavailable" : "refused" });
      assert.equal(status.exitCode, 1);
      assert.ok(status.lines.includes(unavailable ? "Selected release: verification unavailable." : "Selected release: verification refused."));
      assert.equal(status.readyForAssignment, false);
    } finally { removeDir(dir); }
  });
}

test("release preflight preserves bootstrap and leaves existing callers unchanged", async () => {
  const dir = tempDir();
  try {
    const sample = fixture(dir);
    install(sample.input);
    const before = snapshot(dir);
    const custody = io().custody!;
    const legacy = await statusOf(dir, custody);
    const checked = await statusOf(dir, custody, undefined, {
      platform: sample.input.platform, arch: sample.input.arch,
    });
    assert.deepEqual(snapshot(dir), before);
    assert.equal(legacy.releaseVerification, undefined);
    assert.equal(legacy.exitCode, 0);
    assert.deepEqual(checked.releaseVerification, { state: "bootstrap" });
    assert.equal(checked.exitCode, 0);
    assert.ok(checked.lines.includes("Selected release: none (bootstrap)."));
    assert.equal(checked.readyForAssignment, false);

    installFixture(dir);
    const selected = snapshot(dir);
    const oldReader = await statusOf(dir, custody);
    assert.equal(oldReader.releaseVerification, undefined);
    assert.equal(oldReader.exitCode, 0);
    assert.ok(oldReader.lines.includes("Health: local record ok"));
    assert.equal(oldReader.readyForAssignment, false);
    assert.deepEqual(snapshot(dir), selected);
  } finally { removeDir(dir); }
});

const suppliedCommit = "d".repeat(40);

function suppliedMetadata(sample: ReturnType<typeof fixture>, changes: Partial<ReleaseManifest> = {}) {
  const release = sample.signed({ ...sample.manifest, provenance: { ...sample.manifest.provenance, sourceCommit: suppliedCommit },
    ...changes }).release!;
  return { requestedVersion: release.requestedVersion, sourceCommit: suppliedCommit,
    manifestBytes: release.manifestBytes, signatureBytes: release.signatureBytes };
}

function combinedReleaseTrust(selected: ReturnType<typeof fixture>, supplied: ReturnType<typeof fixture>) {
  const trust = selected.services.releaseTrust!;
  return { ...trust, keys: new Map([...trust.keys, ...supplied.services.releaseTrust!.keys]) };
}

function announcement(status: Awaited<ReturnType<typeof statusOf>>): unknown {
  return Reflect.get(status, "newerSuppliedRelease");
}

for (const [installed, offered, newer] of [
  ["1.9.0", "1.10.0", true], ["1.10.1", "1.9.9", false], ["1.3.0", "1.3.0", false],
  ["1.3.0+original", "1.3.0+foreign", false], ["1.3.0-rc.2", "1.3.0-rc.10", true],
  ["1.3.0-1", "1.3.0-beta", true], ["1.3.0-alpha", "1.3.0-alpha.1", true],
  ["1.3.0-release-B", "1.3.0-release-a", true], ["1.3.0", "1.3.0-rc.1", false],
  ["1.3.0-rc.1", "1.3.0", true], ["9007199254740992.0.0", "9007199254740993.0.0", true],
] as const) {
  test(`supplied release announcement uses signed precedence for ${installed} and ${offered}`, async () => {
    const dir = tempDir();
    try {
      const selected = installFixture(dir, installed), supplied = fixture(dir, offered);
      const before = snapshot(dir);
      const context = { platform: selected.input.platform, arch: selected.input.arch, trust: combinedReleaseTrust(selected, supplied),
        offeredRelease: suppliedMetadata(supplied) };
      const status = await statusOf(dir, io().custody!, undefined, context);
      assert.deepEqual(status.releaseVerification, { state: "verified", version: installed, manifestDigest: active(dir).manifestDigest,
        sourceCommit: selected.manifest.provenance.sourceCommit });
      assert.deepEqual(announcement(status), newer ? { version: offered, sourceCommit: suppliedCommit } : undefined);
      assert.equal(status.lines.includes(`Verified newer release ${offered} was supplied.`), newer);
      assert.ok(status.lines.includes("Startup: unregistered."));
      assert.ok(status.lines.includes("Signed installers: unqualified."));
      assert.equal(status.readyForAssignment, false);
      assert.equal(status.exitCode, 0);
      assert.deepEqual(snapshot(dir), before);
    } finally { removeDir(dir); }
  });
}

for (const problem of [
  "invalid signature", "untrusted signing key", "revoked signing key", "wrong repository", "wrong workflow", "wrong tag",
  "wrong source commit", "absent source commit", "wrong version", "wrong platform", "wrong architecture", "incompatible state",
] as const) {
  test(`supplied release announcement omits ${problem} without changing a verified selection`, async () => {
    const dir = tempDir();
    try {
      const selected = installFixture(dir, "1.2.0"), supplied = fixture(dir, "1.3.0");
      const trust = combinedReleaseTrust(selected, supplied);
      const provenance = supplied.manifest.provenance;
      let offeredRelease = suppliedMetadata(supplied);
      if (problem === "invalid signature") offeredRelease.signatureBytes = Buffer.alloc(64);
      if (problem === "untrusted signing key") trust.keys.delete(supplied.manifest.keyId);
      if (problem === "revoked signing key") trust.revokedKeyIds = [supplied.manifest.keyId];
      if (problem === "wrong repository") offeredRelease = suppliedMetadata(supplied, { provenance: { ...provenance, sourceCommit: suppliedCommit, repository: "https://fabricated.invalid" } });
      if (problem === "wrong workflow") offeredRelease = suppliedMetadata(supplied, { provenance: { ...provenance, sourceCommit: suppliedCommit, workflow: ".github/workflows/other.yml" } });
      if (problem === "wrong tag") offeredRelease = suppliedMetadata(supplied, { provenance: { ...provenance, sourceCommit: suppliedCommit, ref: "refs/tags/v1.3.1" } });
      if (problem === "wrong source commit") offeredRelease.sourceCommit = "e".repeat(40);
      if (problem === "absent source commit") Reflect.deleteProperty(offeredRelease, "sourceCommit");
      if (problem === "wrong version") offeredRelease.requestedVersion = "1.3.1";
      if (problem === "wrong platform") offeredRelease = suppliedMetadata(supplied, { platform: "darwin" });
      if (problem === "wrong architecture") offeredRelease = suppliedMetadata(supplied, { arch: "arm64" });
      if (problem === "incompatible state") offeredRelease = suppliedMetadata(supplied, { dataCompatibility: { min: 2, max: 2 } });
      const before = snapshot(dir);
      const custody = io().custody!;
      const context = { platform: selected.input.platform, arch: selected.input.arch, trust };
      const withOffer = { ...context, offeredRelease };
      assert.deepEqual(await statusOf(dir, custody, undefined, withOffer), await statusOf(dir, custody, undefined, context));
      assert.deepEqual(snapshot(dir), before);
    } finally { removeDir(dir); }
  });
}

for (const issue of ["bootstrap", "missing trust", "changed selected tree"] as const) {
  test(`supplied release announcement requires a verified selection over ${issue}`, async () => {
    const dir = tempDir();
    try {
      const selected = issue === "bootstrap" ? fixture(dir, "1.2.0") : installFixture(dir, "1.2.0");
      if (issue === "bootstrap") install(selected.input);
      if (issue === "changed selected tree") writeFileSync(join(activeDirectory(dir), FILES[0]!.path), "fabricated changed content");
      const supplied = fixture(dir, "1.3.0");
      const before = snapshot(dir);
      const custody = io().custody!;
      const context = { platform: selected.input.platform, arch: selected.input.arch,
        trust: issue === "missing trust" ? undefined : combinedReleaseTrust(selected, supplied) };
      const withOffer = { ...context, offeredRelease: suppliedMetadata(supplied) };
      assert.deepEqual(await statusOf(dir, custody, undefined, withOffer), await statusOf(dir, custody, undefined, context));
      assert.deepEqual(snapshot(dir), before);
    } finally { removeDir(dir); }
  });
}
