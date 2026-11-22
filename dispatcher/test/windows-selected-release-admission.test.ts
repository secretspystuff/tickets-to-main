import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { install, prepareSelectedWindowsPackage, verifySelectedRelease, type InstallInput, type VerifiedSelectedRelease } from "../src/install.ts";
import { loadLedger } from "../src/ledger.ts";
import type { ReleaseTrust } from "../src/release-manifest.ts";
import { stateLeaseStatus } from "../src/state-lease.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { activeDirectory, COMMIT, digest, fixture, snapshot } from "./release-test-fixtures.ts";

const ARCHIVE_PATH = "windows/dispatcher.msix";
const DESCRIPTOR_PATH = "windows/admission.json";
const POLICY = {
  packageName: "Fabricated.Dispatcher",
  publisher: "CN=Fabricated Dispatcher",
  publisherId: "0123456789abc",
  applicationId: "Supervisor",
  signerSha256: "9".repeat(64),
};

function descriptor(version: string, packageVersion: string, archive: Uint8Array) {
  const supervisor = "Supervisor.exe";
  const guardian = "Guardian.exe";
  const interpreter = "runtime/node.exe";
  const entry = "dispatcher/bin/tickets-to-main.mjs";
  const payload = [
    { path: supervisor, content: "fabricated supervisor" },
    { path: guardian, content: "fabricated guardian" },
    { path: interpreter, content: "fabricated interpreter" },
    { path: entry, content: "fabricated entry" },
    { path: "package.json", content: '{"type":"module"}' },
    { path: "dispatcher/src/late.mjs", content: "fabricated delayed module" },
  ];
  return {
    schema: 1,
    release: { version, sourceCommit: COMMIT },
    archive: { path: ARCHIVE_PATH, sha256: digest(archive) },
    package: {
      ...POLICY,
      fullName: POLICY.packageName + "_" + packageVersion + "_x64__" + POLICY.publisherId,
      version: packageVersion,
      architecture: "x64",
    },
    installed: {
      supervisor, guardian, interpreter, entry,
      files: payload.map(({ path, content }) => {
        const bytes = Buffer.from(content);
        return { path, size: bytes.length, sha256: digest(bytes) };
      }),
    },
  };
}

type Descriptor = ReturnType<typeof descriptor>;
type Target = Pick<InstallInput, "stateDir" | "platform" | "arch">;

function ownedState(t: TestContext): string {
  const directory = tempDir();
  const root = realpathSync(tmpdir());
  assert.equal(dirname(realpathSync(directory)), root);
  t.after(() => {
    assert.equal(dirname(realpathSync(directory)), root);
    removeDir(directory);
  });
  return directory;
}

type Artifacts = NonNullable<InstallInput["release"]>["artifacts"];
type FixtureOptions = {
  releaseVersion?: string;
  packageVersion?: string;
  platform?: InstallInput["platform"];
  descriptor?: (value: Descriptor) => unknown;
  artifacts?: (artifacts: Artifacts) => Artifacts;
};

function windowsFixture(stateDir: string, options: FixtureOptions = {}) {
  const sample = fixture(stateDir, options.releaseVersion ?? "0.2.0");
  const platform = options.platform ?? sample.input.platform;
  const archive = Buffer.from("Fabricated admission archive for " + sample.manifest.version + ".\n");
  const value = descriptor(sample.manifest.version, options.packageVersion ?? "7.8.9.10", archive);
  const members = [
    { path: ARCHIVE_PATH, bytes: Buffer.from(archive) },
    { path: DESCRIPTOR_PATH, bytes: Buffer.from(JSON.stringify(options.descriptor ? options.descriptor(value) : value)) },
  ];
  const artifacts = options.artifacts ? options.artifacts(members) : members;
  const input = {
    ...sample.signed({
      ...sample.manifest, platform,
      files: artifacts.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: digest(bytes), executable: false })),
    }),
    platform,
  };
  assert.ok(input.release);
  input.release.artifacts = artifacts;
  return { sample, input, value, archive };
}

function selectedTarget({ stateDir, platform, arch }: InstallInput): Target {
  return { stateDir, platform, arch };
}

function selected(target: Target, trust: ReleaseTrust | undefined): VerifiedSelectedRelease {
  const loaded = loadLedger(target.stateDir);
  assert.ok(loaded.ok, "Expected the fabricated selected release to be persisted.");
  const verified = verifySelectedRelease(target, loaded.ledger, trust);
  assert.ok(verified, "The existing verifier must accept the signed fixture before the Windows admission check.");
  const { version, manifestDigest, sourceCommit } = verified;
  return { version, manifestDigest, sourceCommit };
}

function persistedState(stateDir: string): unknown {
  const state = snapshot(stateDir) as { entries: Record<string, unknown> };
  const { ".state-leases": _leaseEpochs, ...entries } = state.entries;
  return { ...state, entries };
}

function assertRefused(target: Target, expected: VerifiedSelectedRelease, trust: ReleaseTrust | undefined): void {
  const before = persistedState(target.stateDir);
  assert.throws(() => prepareSelectedWindowsPackage(target, expected, trust, POLICY), /release operation could not finish safely/i);
  assert.equal(stateLeaseStatus(target.stateDir, "release"), "released");
  assert.deepEqual(persistedState(target.stateDir), before, "The pre-submission check must leave the existing selection and state intact.");
}

test("a verified selected Windows release returns a synchronous data snapshot of its persisted archive, identity and inventory", (t) => {
  const { sample, input, value, archive } = windowsFixture(ownedState(t));
  install(input, sample.services);
  const target = selectedTarget(input);
  const trust = sample.services.releaseTrust;
  const expected = selected(target, trust);
  const directory = activeDirectory(target.stateDir);
  const persistedArchive = readFileSync(join(directory, ARCHIVE_PATH));
  assert.deepEqual(persistedArchive, archive);
  assert.deepEqual(JSON.parse(readFileSync(join(directory, DESCRIPTOR_PATH), "utf8")), value);
  input.release!.artifacts = [
    { path: ARCHIVE_PATH, bytes: Buffer.from("different caller-owned archive bytes") },
    { path: DESCRIPTOR_PATH, bytes: Buffer.from('{"callerOnly":true}') },
  ];
  const before = persistedState(target.stateDir);
  const leaseDirectory = join(target.stateDir, ".state-leases", "release");
  const priorEpochs = readdirSync(leaseDirectory);
  const parameterCount: 4 = prepareSelectedWindowsPackage.length as Parameters<typeof prepareSelectedWindowsPackage>["length"];
  assert.equal(parameterCount, 4, "Preparation takes only selection inputs and authority data.");

  const received = prepareSelectedWindowsPackage(target, expected, trust, POLICY);
  assert.deepEqual(Object.keys(received).sort(), ["archiveBytes", "descriptor", "selection"]);
  assert.equal("then" in received, false, "Preparation returns its data immediately.");
  assert.deepEqual(received.selection, {
    version: sample.manifest.version,
    manifestDigest: digest(input.release!.manifestBytes),
    sourceCommit: COMMIT,
  });
  assert.deepEqual(received.descriptor, value);
  assert.deepEqual(Buffer.from(received.archiveBytes), persistedArchive);
  assert.equal(stateLeaseStatus(target.stateDir, "release"), "released");
  const newEpochs = readdirSync(leaseDirectory).filter((name) => !priorEpochs.includes(name));
  assert.equal(newEpochs.length, 1);
  assert.match(newEpochs[0]!, /^epoch-[0-9]+$/);
  assert.deepEqual(persistedState(target.stateDir), before, "Preparation must leave the existing selection and state intact.");
});

const malformed: Array<{ name: string; change: (value: Descriptor) => unknown }> = [
  { name: "unsupported descriptor schema", change: (value) => ({ ...value, schema: 2 }) },
  { name: "unexpected descriptor field", change: (value) => ({ ...value, extra: true }) },
  { name: "descriptor version differs from the signed release", change: (value) => ({
    ...value, release: { ...value.release, version: "0.4.0" },
  }) },
  { name: "descriptor source commit differs from the signed release", change: (value) => ({
    ...value, release: { ...value.release, sourceCommit: "b".repeat(40) },
  }) },
  { name: "native package version differs from its exact full identity", change: (value) => ({
    ...value, package: { ...value.package, version: "7.8.9.11" },
  }) },
  { name: "self-consistent MSIX architecture differs from the signed target", change: (value) => ({
    ...value, package: {
      ...value.package, architecture: "arm64",
      fullName: value.package.fullName.replace("_x64__", "_arm64__"),
    },
  }) },
  { name: "signed descriptor names a different archive path", change: (value) => ({
    ...value, archive: { ...value.archive, path: "windows/another.msix" },
  }) },
  { name: "same declared publisher has a signer outside the independent policy", change: (value) => ({
    ...value, package: { ...value.package, signerSha256: "8".repeat(64) },
  }) },
  { name: "descriptor archive hash differs from the exact signed archive", change: (value) => ({
    ...value, archive: { ...value.archive, sha256: digest(Buffer.from("another fabricated Windows archive")) },
  }) },
  { name: "declared installed entry is absent from the signed inventory", change: (value) => ({
    ...value, installed: { ...value.installed, files: value.installed.files.filter((file) => file.path !== value.installed.entry) },
  }) },
];

for (const { name, change } of malformed) {
  test(name + " refuses Windows package preparation", (t) => {
    const { sample, input } = windowsFixture(ownedState(t), { descriptor: change });
    install(input, sample.services);
    const target = selectedTarget(input);
    assertRefused(target, selected(target, sample.services.releaseTrust), sample.services.releaseTrust);
  });
}

const companionCases: Array<{ name: string; change: (members: Artifacts) => Artifacts }> = [
  { name: "missing signed descriptor", change: (members) => members.filter((member) => member.path !== DESCRIPTOR_PATH) },
  { name: "missing signed archive", change: (members) => members.filter((member) => member.path !== ARCHIVE_PATH) },
  { name: "descriptor bytes signed under the wrong companion path", change: (members) => members.map((member) => (
    member.path === DESCRIPTOR_PATH ? { ...member, path: "windows/other-admission.json" } : member
  )) },
  { name: "multiple signed MSIX candidates", change: (members) => [
    ...members, { path: "windows/another.msix", bytes: Buffer.from("another fabricated signed archive") },
  ] },
];

for (const { name, change } of companionCases) {
  test(name + " refuses Windows package preparation", (t) => {
    const { sample, input } = windowsFixture(ownedState(t), { artifacts: change });
    install(input, sample.services);
    const target = selectedTarget(input);
    assertRefused(target, selected(target, sample.services.releaseTrust), sample.services.releaseTrust);
  });
}

test("a genuine signed non-Windows selection refuses Windows package preparation", (t) => {
  const { sample, input } = windowsFixture(ownedState(t), { platform: "linux" });
  install(input, sample.services);
  const target = selectedTarget(input);
  assertRefused(target, selected(target, sample.services.releaseTrust), sample.services.releaseTrust);
});

for (const path of [ARCHIVE_PATH, DESCRIPTOR_PATH]) {
  test("changing the persisted " + path + " after verification refuses with the original caller bytes intact", (t) => {
    const { sample, input } = windowsFixture(ownedState(t));
    install(input, sample.services);
    const target = selectedTarget(input);
    const expected = selected(target, sample.services.releaseTrust);
    const filename = join(activeDirectory(target.stateDir), path);
    const original = readFileSync(filename);
    const offered = input.release!.artifacts.find((artifact) => artifact.path === path);
    assert.ok(offered);

    const changed = path === ARCHIVE_PATH
      ? Buffer.from(original.toString("utf8").replace("Fabricated", "DifferentX"))
      : Buffer.from(original.toString("utf8").replace(digest(Buffer.from("fabricated delayed module")), "6".repeat(64)));
    assert.equal(changed.length, original.length);
    assert.notEqual(digest(changed), digest(original));
    writeFileSync(filename, changed);
    assert.deepEqual(Buffer.from(offered.bytes), original, "Only the privately persisted bytes should have changed.");
    assertRefused(target, expected, sample.services.releaseTrust);
  });
}

test("a stale exact selection refuses while the independently signed replacement prepares", (t) => {
  const dir = ownedState(t);
  const original = windowsFixture(dir);
  install(original.input, original.sample.services);
  const target = selectedTarget(original.input);
  const previousTrust = original.sample.services.releaseTrust!;
  const expected = selected(target, previousTrust);

  const replacement = windowsFixture(dir, { releaseVersion: "0.3.0", packageVersion: "7.8.9.11" });
  const trust = replacement.sample.services.releaseTrust!;
  trust.keys.set(original.sample.manifest.keyId, previousTrust.keys.get(original.sample.manifest.keyId)!);
  install(replacement.input, replacement.sample.services);
  const current = selected(target, trust);
  assert.notEqual(current.manifestDigest, expected.manifestDigest);
  assertRefused(target, expected, trust);

  const received = prepareSelectedWindowsPackage(target, current, trust, POLICY);
  assert.deepEqual(received.selection, current);
  assert.deepEqual(received.descriptor, replacement.value);
  assert.deepEqual(Buffer.from(received.archiveBytes), replacement.archive);
});

test("the portable release path still selects and verifies an ordinary signed tree with no Windows package metadata", (t) => {
  const sample = fixture(ownedState(t));
  const input = sample.signed();
  const outcome = install(input, sample.services);
  assert.equal(outcome.ledger.install?.startup, "not-registered");
  assert.equal(outcome.ledger.install?.signedInstallers, "not-qualified");
  assert.equal(outcome.ledger.install?.release?.qualified, false);
  assert.deepEqual(selected(input, sample.services.releaseTrust), {
    version: sample.manifest.version,
    manifestDigest: digest(input.release!.manifestBytes),
    sourceCommit: COMMIT,
  });
});
