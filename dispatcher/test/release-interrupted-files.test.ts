import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { install, recoverInstall } from "../src/install.ts";
import { loadLedger } from "../src/ledger.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { active, activeDirectory, assertNonInstallState, FILES, fixture, installFixture, seedRetainedLedger, snapshot } from "./release-test-fixtures.ts";

const installModule = new URL("../src/install.ts", import.meta.url).href;
const fixtureModule = new URL("./release-test-fixtures.ts", import.meta.url).href;
type PublicKeyDescriptor = { keyId: string; publicKey: string };

function publicDescriptor(sample: ReturnType<typeof fixture>): PublicKeyDescriptor {
  return { keyId: sample.manifest.keyId, publicKey: sample.services.releaseTrust!.keys.get(sample.manifest.keyId)!.export({ type: "spki", format: "der" }).toString("base64") };
}

function interrupted(dir: string, operation: "install" | "recover", stop: string, keys: PublicKeyDescriptor[]): PublicKeyDescriptor {
  const source = `
    import { createPublicKey } from 'node:crypto';
    import { install, recoverInstall } from ${JSON.stringify(installModule)};
    import { fixture } from ${JSON.stringify(fixtureModule)};
    const sample = fixture(process.argv[1]);
    for (const key of JSON.parse(process.argv[4])) sample.services.releaseTrust.keys.set(key.keyId, createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), type: 'spki', format: 'der' }));
    const publicKey = sample.services.releaseTrust.keys.get(sample.manifest.keyId).export({ type: 'spki', format: 'der' }).toString('base64');
    process.stdout.write(JSON.stringify({ publicKey, keyId: sample.manifest.keyId }));
    sample.services.onReleaseFileCheckpoint = (phase) => { if (phase === process.argv[3]) process.exit(73); };
    if (process.argv[2] === 'install') install(sample.signed(), sample.services);
    else recoverInstall(sample.input, sample.services);
    process.exit(74);
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, dir, operation, stop, JSON.stringify(keys)], {
    encoding: "utf8", env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 73, child.stderr);
  return JSON.parse(child.stdout) as PublicKeyDescriptor;
}

for (const firstInstall of [true, false]) {
  for (const stopDuringCleanup of [true, false]) {
    test(`owned ${firstInstall ? "first-install" : "replacement"} staging recovers after partial artifact write${stopDuringCleanup ? " and partial cleanup" : ""}`, () => {
      const dir = tempDir();
      try {
        const retained = seedRetainedLedger(dir);
        const old = firstInstall ? null : installFixture(dir, "0.1.0");
        const beforeSelection = old ? structuredClone(active(dir)) : null;
        const keys = old ? [publicDescriptor(old)] : [];
        keys.push(interrupted(dir, "install", "file-writing", keys));
        assertNonInstallState(dir, retained);
        const stages = readdirSync(join(dir, "releases")).filter((name) => name.startsWith(".stage-"));
        assert.equal(stages.length, 1, "The crash must leave the owned partial stage.");
        const stage = join(dir, "releases", stages[0]!);
        const bytes = readFileSync(join(stage, FILES[0]!.path));
        assert.ok(bytes.length > 0 && bytes.length < FILES[0]!.bytes.length, "The artifact must be only partly written.");
        if (stopDuringCleanup) {
          interrupted(dir, "recover", "cleanup-file-deleted", keys);
          assertNonInstallState(dir, retained);
          assert.equal(existsSync(join(stage, FILES[0]!.path)), false, "Cleanup must have deleted its first exact owned file before the crash.");
        }
        const authority = fixture(dir);
        for (const key of keys) authority.services.releaseTrust!.keys.set(key.keyId, createPublicKey({ key: Buffer.from(key.publicKey, "base64"), type: "spki", format: "der" }));
        recoverInstall(authority.input, authority.services);
        assertNonInstallState(dir, retained);
        assert.equal(existsSync(stage), false);
        const loaded = loadLedger(dir);
        assert.equal(loaded.ok, true);
        if (old) {
          assert.deepEqual(active(dir), beforeSelection);
          for (const file of FILES) assert.deepEqual(readFileSync(join(activeDirectory(dir), file.path)), file.bytes);
        } else assert.equal(loaded.ok && loaded.ledger.install, null);
        const after = snapshot(dir);
        recoverInstall(authority.input, authority.services);
        assert.deepEqual(snapshot(dir), after);
        assertNonInstallState(dir, retained);
      } finally { removeDir(dir); }
    });
  }
}

test("an unrelated file inside a durably owned interrupted stage blocks cleanup without deletion", () => {
  const dir = tempDir();
  try {
    const retained = seedRetainedLedger(dir);
    const key = interrupted(dir, "install", "file-writing", []);
    const stage = readdirSync(join(dir, "releases")).find((name) => name.startsWith(".stage-"));
    assert.ok(stage);
    writeFileSync(join(dir, "releases", stage, "person-file.txt"), "preserve unrelated file", { mode: 0o600 });
    const authority = fixture(dir);
    authority.services.releaseTrust!.keys.set(key.keyId, createPublicKey({ key: Buffer.from(key.publicKey, "base64"), type: "spki", format: "der" }));
    const before = snapshot(dir);
    assert.throws(() => recoverInstall(authority.input, authority.services));
    assert.deepEqual(snapshot(dir), before);
    assertNonInstallState(dir, retained);
  } finally { removeDir(dir); }
});

for (const versions of [["0.2.0-rc.1", "0.2.0"], ["0.2.0", "0.2.0-rc.1"]] as const) {
  test(`exact authenticated versions allow compatible ${versions[0]} to ${versions[1]} and back`, () => {
    const dir = tempDir();
    try {
      const retained = seedRetainedLedger(dir);
      const old = installFixture(dir, versions[0]);
      const selected = fixture(dir, versions[1]);
      selected.services.releaseTrust!.keys.set(old.manifest.keyId, old.services.releaseTrust!.keys.get(old.manifest.keyId)!);
      install(selected.signed(), selected.services);
      assert.equal(loadLedger(dir).ok && active(dir).qualified, false);
      const loaded = loadLedger(dir);
      assert.equal(loaded.ok && loaded.ledger.install?.packageVersion, versions[1]);
      assertNonInstallState(dir, retained);
      old.services.releaseTrust!.keys.set(selected.manifest.keyId, selected.services.releaseTrust!.keys.get(selected.manifest.keyId)!);
      install(old.signed(), old.services);
      const returned = loadLedger(dir);
      assert.equal(returned.ok && returned.ledger.install?.packageVersion, versions[0]);
      assertNonInstallState(dir, retained);
    } finally { removeDir(dir); }
  });
}
