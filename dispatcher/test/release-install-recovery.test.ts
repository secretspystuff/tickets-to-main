import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { install, recoverInstall } from "../src/install.ts";
import { loadLedger } from "../src/ledger.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { active, activeDirectory, assertNonInstallState, digest, FILES, fixture, installFixture, nonInstallState, rejectedUnchanged, seedRetainedLedger, snapshot } from "./release-test-fixtures.ts";

test("selecting an explicit version preserves all existing connection, tool and workspace fields", () => {
  const dir = tempDir();
  try {
    const retained = seedRetainedLedger(dir);
    const sample = fixture(dir);
    install(sample.signed(), sample.services);
    const loaded = loadLedger(dir);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) throw new Error("Fixture record unavailable.");
    assertNonInstallState(dir, retained);
    const replacement = fixture(dir, "0.3.0");
    replacement.services.releaseTrust!.keys.set(sample.manifest.keyId, sample.services.releaseTrust!.keys.get(sample.manifest.keyId)!);
    install(replacement.signed(), replacement.services);
    assertNonInstallState(dir, retained);
    assert.equal(loaded.ledger.install?.startup, "not-registered");
    assert.equal(loaded.ledger.install?.signedInstallers, "not-qualified");
  } finally { removeDir(dir); }
});

test("repeating the exact active release is idempotent", () => {
  const dir = tempDir();
  try {
    const sample = installFixture(dir);
    const before = snapshot(dir);
    install({ ...sample.signed(), nowIso: "2026-11-08T12:00:00.000Z" }, sample.services);
    assert.deepEqual(snapshot(dir), before);
  } finally { removeDir(dir); }
});

test("a deliberately selected compatible older release is allowed without rewriting other data", () => {
  const dir = tempDir();
  try {
    const retained = seedRetainedLedger(dir);
    const current = installFixture(dir, "0.3.0");
    assertNonInstallState(dir, retained);
    const previousDirectory = activeDirectory(dir);
    const selected = fixture(dir, "0.2.0");
    selected.services.releaseTrust!.keys.set(current.manifest.keyId, current.services.releaseTrust!.keys.get(current.manifest.keyId)!);
    install(selected.signed(), selected.services);
    assert.equal(active(dir).qualified, false);
    assertNonInstallState(dir, retained);
    const loaded = loadLedger(dir);
    assert.equal(loaded.ok && loaded.ledger.install?.packageVersion, "0.2.0");
    assert.equal(existsSync(previousDirectory), true, "Installation must retain the prior complete release for recovery.");
  } finally { removeDir(dir); }
});

test("replayed older response for another requested version is rejected", () => {
  const dir = tempDir();
  try {
    installFixture(dir, "0.2.0");
    const old = fixture(dir, "0.1.0");
    const request = old.signed();
    request.release!.requestedVersion = "0.3.0";
    rejectedUnchanged(dir, request, old.services);
  } finally { removeDir(dir); }
});

test("explicit downgrade to a release that cannot read the current record format is rejected", () => {
  const dir = tempDir();
  try {
    installFixture(dir, "0.3.0");
    const old = fixture(dir, "0.1.0");
    old.manifest.dataCompatibility = { min: 0, max: 0 };
    rejectedUnchanged(dir, old.signed(), old.services);
  } finally { removeDir(dir); }
});

test("a second valid signature cannot redefine the files of the same installed version", () => {
  const dir = tempDir();
  try {
    const sample = installFixture(dir);
    const bytes = Buffer.from("different signed runtime");
    sample.manifest.files[0]!.size = bytes.length;
    sample.manifest.files[0]!.sha256 = digest(bytes);
    const changed = sample.signed();
    changed.release!.artifacts[0]!.bytes = bytes;
    rejectedUnchanged(dir, changed, sample.services);
  } finally { removeDir(dir); }
});

for (const target of ["state-root", "release-root", "selected-directory", "selected-file", "ledger"]) {
  test(`planted ${target} symlink does not redirect release writes or recovery`, () => {
    const parent = tempDir();
    const dir = join(parent, "state");
    const outside = tempDir();
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(outside, "keep.txt"), "preserve external bytes", { mode: 0o600 });
    try {
      const sample = fixture(dir);
      if (target === "state-root") { symlinkSync(outside, join(parent, "linked-state")); sample.input.stateDir = join(parent, "linked-state"); }
      if (target === "release-root") symlinkSync(outside, join(dir, "releases"));
      if (target === "ledger") symlinkSync(join(outside, "keep.txt"), join(dir, "ledger.json"));
      if (target === "selected-directory" || target === "selected-file") {
        install(sample.signed(), sample.services);
        if (target === "selected-directory") {
          renameSync(activeDirectory(dir), join(dir, "retained-release"));
          symlinkSync(outside, activeDirectory(dir));
        } else {
          const path = join(activeDirectory(dir), FILES[0]!.path);
          unlinkSync(path);
          symlinkSync(join(outside, "keep.txt"), path);
        }
      }
      const outsideBefore = snapshot(outside);
      const before = snapshot(parent);
      assert.throws(() => install(sample.signed(), sample.services));
      assert.deepEqual(snapshot(parent), before);
      assert.throws(() => recoverInstall(sample.input, sample.services));
      assert.deepEqual(snapshot(parent), before);
      assert.deepEqual(snapshot(outside), outsideBefore);
    } finally { removeDir(parent); removeDir(outside); }
  });
}


for (const phase of ["staged", "published", "committed"] as const) {
  for (const firstInstall of [true, false]) {
    test(`actual subprocess termination at ${phase} recovers ${firstInstall ? "first install" : "explicit replacement"} without selecting partial files`, () => {
      const dir = tempDir();
      try {
        const retained = seedRetainedLedger(dir);
        const old = firstInstall ? null : installFixture(dir, "0.1.0");
        assertNonInstallState(dir, retained);
        const oldSelection = old ? structuredClone(active(dir)) : null;
        const childSource = `
          import { fixture } from ${JSON.stringify(new URL("./release-test-fixtures.ts", import.meta.url).href)};
          import { install } from ${JSON.stringify(new URL("../src/install.ts", import.meta.url).href)};
          const sample = fixture(process.argv[1]);
          const prior = JSON.parse(process.argv[3]);
          if (prior) {
            const { createPublicKey } = await import("node:crypto");
            sample.services.releaseTrust.keys.set(prior.keyId, createPublicKey({ key: Buffer.from(prior.publicKey, "base64"), type: "spki", format: "der" }));
          }
          const publicKey = sample.services.releaseTrust.keys.get(sample.manifest.keyId).export({ type: 'spki', format: 'der' }).toString('base64');
          process.stdout.write(JSON.stringify({ publicKey, keyId: sample.manifest.keyId }));
          sample.services.onReleaseCheckpoint = (at) => { if (at === process.argv[2]) process.exit(73); };
          install(sample.signed(), sample.services);
          process.exit(74);
        `;
        const prior = old ? { keyId: old.manifest.keyId, publicKey: old.services.releaseTrust!.keys.get(old.manifest.keyId)!.export({ type: "spki", format: "der" }).toString("base64") } : null;
        const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", childSource, dir, phase, JSON.stringify(prior)], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });
        assert.equal(child.error, undefined);
        assert.equal(child.status, 73, child.stderr);
        const emitted = JSON.parse(child.stdout.trim()) as { publicKey: string; keyId: string };
        const sample = fixture(dir);
        sample.services.releaseTrust!.keys.set(emitted.keyId, createPublicKey({ key: Buffer.from(emitted.publicKey, "base64"), type: "spki", format: "der" }));
        if (old) sample.services.releaseTrust!.keys.set(old.manifest.keyId, old.services.releaseTrust!.keys.get(old.manifest.keyId)!);
        assertNonInstallState(dir, retained);
        const interrupted = loadLedger(dir);
        if (phase === "committed") {
          assert.equal(interrupted.ok && interrupted.ledger.install?.packageVersion, "0.2.0");
        } else if (firstInstall) {
          assert.ok(!interrupted.ok || interrupted.ledger.install === null);
        } else {
          assert.deepEqual(active(dir), oldSelection);
        }
        recoverInstall(sample.input, sample.services);
        assertNonInstallState(dir, retained);
        const after = snapshot(dir);
        recoverInstall(sample.input, sample.services);
        assertNonInstallState(dir, retained);
        assert.deepEqual(snapshot(dir), after, "Recovery must be idempotent.");
        const recovered = loadLedger(dir);
        if (phase === "committed") {
          assert.equal(recovered.ok && recovered.ledger.install?.packageVersion, "0.2.0");
          for (const file of FILES) assert.deepEqual(readFileSync(join(activeDirectory(dir), file.path)), file.bytes);
        } else if (old) {
          assert.deepEqual(active(dir), oldSelection);
          for (const file of FILES) assert.deepEqual(readFileSync(join(activeDirectory(dir), file.path)), file.bytes);
        } else {
          assert.ok(!recovered.ok || recovered.ledger.install === null);
        }
        if (existsSync(join(dir, "releases"))) assert.equal(readdirSync(join(dir, "releases")).some((name) => name.startsWith(".stage-")), false);
      } finally { removeDir(dir); }
    });
  }
}

test("recovery refuses tampered active files and revoked authority without silently selecting an orphan", () => {
  for (const mutation of ["bytes", "revoked-key"]) {
    const dir = tempDir();
    try {
      const sample = installFixture(dir);
      if (mutation === "bytes") writeFileSync(join(activeDirectory(dir), FILES[0]!.path), "corrupted");
      else sample.services.releaseTrust!.revokedKeyIds = [sample.manifest.keyId];
      const before = snapshot(dir);
      assert.throws(() => recoverInstall(sample.input, sample.services));
      assert.deepEqual(snapshot(dir), before);
    } finally { removeDir(dir); }
  }
});

test("recovery preserves unrelated files and never follows an unknown staging symlink", () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    const sample = installFixture(dir);
    writeFileSync(join(dir, "releases", "person-file.txt"), "preserve");
    symlinkSync(outside, join(dir, "releases", ".stage-person-owned"));
    writeFileSync(join(outside, "keep.txt"), "preserve");
    const before = snapshot(dir);
    const external = snapshot(outside);
    try { recoverInstall(sample.input, sample.services); } catch { /* An unexpected entry may block recovery. */ }
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(snapshot(outside), external);
  } finally { removeDir(dir); removeDir(outside); }
});

test("a staged file changed after initial verification never becomes selected", () => {
  const dir = tempDir();
  try {
    const previous = installFixture(dir, "0.1.0");
    const before = structuredClone(active(dir));
    const sample = fixture(dir);
    sample.services.releaseTrust!.keys.set(previous.manifest.keyId, previous.services.releaseTrust!.keys.get(previous.manifest.keyId)!);
    let reached = false;
    sample.services.onReleaseCheckpoint = (phase, directory) => {
      if (phase === "staged") {
        reached = true;
        writeFileSync(join(directory, FILES[0]!.path), "changed after verification");
      }
    };
    assert.throws(() => install(sample.signed(), sample.services));
    assert.equal(reached, true, "The attack must reach the post-staging verification boundary.");
    assert.deepEqual(active(dir), before);
    for (const file of FILES) assert.deepEqual(readFileSync(join(activeDirectory(dir), file.path)), file.bytes);
  } finally { removeDir(dir); }
});

test("recovery refuses a planted relative-directory escape in the release selection", () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    const sample = installFixture(dir);
    writeFileSync(join(outside, "keep.txt"), "preserve");
    const persisted = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { install: { release: { directory: string } } };
    persisted.install.release.directory = relative(dir, outside);
    writeFileSync(join(dir, "ledger.json"), JSON.stringify(persisted));
    const before = snapshot(dir);
    const external = snapshot(outside);
    assert.throws(() => recoverInstall(sample.input, sample.services));
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(snapshot(outside), external);
  } finally { removeDir(dir); removeDir(outside); }
});

test("recovery refuses injected startup sidecars absent from the authenticated complete file list", () => {
  const dir = tempDir();
  try {
    const sample = installFixture(dir);
    writeFileSync(join(activeDirectory(dir), "bin", "dispatcher.mjs.config"), "fabricated startup injection");
    const before = snapshot(dir);
    assert.throws(() => recoverInstall(sample.input, sample.services));
    assert.deepEqual(snapshot(dir), before);
  } finally { removeDir(dir); }
});

for (const mutation of ["persisted-signature", "persisted-manifest", "selection-digest", "selection-version"] as const) {
  test(`recovery refuses ${mutation} tampering with unchanged artifacts and does not select a valid inactive release`, () => {
    const dir = tempDir();
    try {
      const retained = seedRetainedLedger(dir);
      const inactive = installFixture(dir, "0.1.0");
      const inactiveDirectory = activeDirectory(dir);
      const sample = fixture(dir, "0.2.0");
      sample.services.releaseTrust!.keys.set(inactive.manifest.keyId, inactive.services.releaseTrust!.keys.get(inactive.manifest.keyId)!);
      const signed = sample.signed();
      install(signed, sample.services);
      assertNonInstallState(dir, retained);
      const selectedDirectory = activeDirectory(dir);
      const unchangedArtifacts = [inactiveDirectory, selectedDirectory].map((directory) => FILES.map((file) => readFileSync(join(directory, file.path))));
      if (mutation === "persisted-signature") {
        const path = join(selectedDirectory, ".release-signature");
        const bytes = readFileSync(path);
        assert.deepEqual(bytes, signed.release!.signatureBytes, "The attack must reach the persisted authenticated signature.");
        bytes[0] = bytes[0]! ^ 1;
        writeFileSync(path, bytes);
      } else if (mutation === "persisted-manifest") {
        const path = join(selectedDirectory, ".release-manifest.json");
        assert.deepEqual(readFileSync(path), signed.release!.manifestBytes, "The attack must reach the persisted authenticated manifest.");
        writeFileSync(path, JSON.stringify({ ...sample.manifest, provenance: { ...sample.manifest.provenance, sourceCommit: "b".repeat(40) } }));
      } else {
        const persisted = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as { install: { packageVersion: string; release: { manifestDigest: string } } };
        if (mutation === "selection-digest") persisted.install.release.manifestDigest = "d".repeat(64);
        else persisted.install.packageVersion = "0.9.0";
        writeFileSync(join(dir, "ledger.json"), JSON.stringify(persisted));
      }
      const before = snapshot(dir);
      const selectedLedgerBytes = readFileSync(join(dir, "ledger.json"));
      assert.throws(() => recoverInstall(sample.input, sample.services));
      assert.deepEqual(snapshot(dir), before, "Refused recovery changed files or selected an inactive release.");
      assert.deepEqual(readFileSync(join(dir, "ledger.json")), selectedLedgerBytes);
      assert.notEqual(selectedDirectory, inactiveDirectory);
      assert.deepEqual(nonInstallState(dir), retained);
      assert.deepEqual([inactiveDirectory, selectedDirectory].map((directory) => FILES.map((file) => readFileSync(join(directory, file.path)))), unchangedArtifacts);
    } finally { removeDir(dir); }
  });
}
