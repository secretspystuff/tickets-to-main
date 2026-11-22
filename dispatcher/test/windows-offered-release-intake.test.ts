import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import * as installer from "../src/install.ts";
import type { InstallInput, VerifiedSelectedRelease } from "../src/install.ts";
import { emptyLedger, LEDGER_FILE, loadLedger } from "../src/ledger.ts";
import {
  verifiedArtifacts, verifyManifest, verifyWindowsPackageDescriptor, WINDOWS_ARCHIVE_FILE, WINDOWS_DESCRIPTOR_FILE,
  type ReleaseRequest, type ReleaseServices, type ReleaseTrust, type WindowsPackageDescriptor, type WindowsPackagePolicy,
} from "../src/release-manifest.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { COMMIT, digest, fixture, snapshot } from "./release-test-fixtures.ts";

type OfferInput = InstallInput & { release: ReleaseRequest };
type PackageIdentity = Omit<WindowsPackageDescriptor["package"], "signerSha256">;
type NativeObservation = {
  archiveSha256: string;
  appxDigest?: string;
  windowsTrustStatus: number;
  policySignerSha256?: string;
  identity: PackageIdentity;
  applicationExecutable: string;
  files: WindowsPackageDescriptor["installed"]["files"];
};
type VerifiedOffer = {
  release: VerifiedSelectedRelease;
  archiveSha256: string;
  appxDigest: string;
  packageFullName: string;
  signerSha256: string;
};
type BoundOffer = {
  release: VerifiedSelectedRelease;
  descriptor: WindowsPackageDescriptor;
  archiveBytes: Uint8Array;
};
type NativeInstallServices = ReleaseServices & {
  publisherPolicy?: WindowsPackagePolicy;
  observeWindowsOffer?: (offer: BoundOffer) => NativeObservation | undefined;
  stageWindowsOffer: (offer: BoundOffer, appxDigest: string) => void;
  launchWindowsPackage: () => void;
};
type InstallWindowsRelease = (input: OfferInput, services: NativeInstallServices) => VerifiedOffer;

const PUBLISHER_POLICY: WindowsPackagePolicy = {
  packageName: "Fabricated.Dispatcher",
  publisher: "CN=Fabricated Intake Publisher",
  publisherId: "0123456789abc",
  applicationId: "Supervisor",
  signerSha256: "9".repeat(64),
};
const NATIVE_VERSION = "7.8.9.10";
const APPX_DIGEST = Buffer.alloc(32, 17).toString("base64");
const OFFER_VERSION = "0.2.0";

function nativeInstall(): InstallWindowsRelease {
  const candidate = (installer as typeof installer & { installWindowsRelease?: InstallWindowsRelease }).installWindowsRelease;
  assert.equal(typeof candidate, "function", "Explicit Windows release installation entry is unavailable.");
  return candidate!;
}

function ownedState(t: TestContext): string {
  const path = tempDir();
  const root = realpathSync(tmpdir());
  assert.equal(dirname(realpathSync(path)), root);
  assert.match(basename(path), /^tickets-to-main-/);
  t.after(() => {
    assert.equal(dirname(realpathSync(path)), root);
    removeDir(path);
  });
  return path;
}

function fabricatedOffer(stateDir: string, arch = "x64") {
  const sample = fixture(stateDir, OFFER_VERSION);
  const archive = Buffer.from("Fabricated Windows offer archive bytes\n");
  const { signerSha256, ...policyIdentity } = PUBLISHER_POLICY;
  const identity: PackageIdentity = {
    ...policyIdentity, fullName: PUBLISHER_POLICY.packageName + "_" + NATIVE_VERSION + "_" + arch + "__" + PUBLISHER_POLICY.publisherId,
    version: NATIVE_VERSION, architecture: arch,
  };
  const roles = { supervisor: "Supervisor.exe", guardian: "Guardian.exe", interpreter: "node.exe", entry: "entry.mjs" };
  const files = [...Object.values(roles), "late.mjs"].map((path) => {
    const bytes = Buffer.from("Fabricated payload for " + path + "\n");
    return { path, size: bytes.length, sha256: digest(bytes) };
  });
  const descriptor: WindowsPackageDescriptor = {
    schema: 1,
    release: { version: OFFER_VERSION, sourceCommit: COMMIT },
    archive: { path: WINDOWS_ARCHIVE_FILE, sha256: digest(archive) },
    package: { ...identity, signerSha256 },
    installed: { ...roles, files },
  };
  const artifacts = [
    { path: WINDOWS_ARCHIVE_FILE, bytes: archive },
    { path: WINDOWS_DESCRIPTOR_FILE, bytes: Buffer.from(JSON.stringify(descriptor)) },
  ];
  const manifest = {
    ...sample.manifest, arch,
    files: artifacts.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: digest(bytes), executable: false })),
  };
  const request = sample.signed(manifest).release!;
  request.artifacts = artifacts;
  const observation: NativeObservation = {
    archiveSha256: digest(archive),
    appxDigest: APPX_DIGEST,
    windowsTrustStatus: 0,
    policySignerSha256: signerSha256,
    identity,
    applicationExecutable: roles.supervisor,
    files: structuredClone(files),
  };
  return {
    sample, descriptor, archive, observation,
    input: { ...sample.input, arch, release: request } satisfies OfferInput,
    releaseTrust: sample.services.releaseTrust!,
  };
}

function context(t: TestContext, previousSelection: boolean, arch = "x64") {
  const stateDir = ownedState(t);
  const offered = fabricatedOffer(stateDir, arch);
  if (previousSelection) {
    const previous = fixture(stateDir, "0.1.0");
    const previousTrust = previous.services.releaseTrust!;
    offered.releaseTrust.keys.set(previous.manifest.keyId, previousTrust.keys.get(previous.manifest.keyId)!);
    const result = installer.install(previous.signed(), previous.services);
    const selected = installer.verifySelectedRelease(offered.sample.input, result.ledger, offered.releaseTrust);
    assert.equal(selected?.version, "0.1.0");
    assert.equal(result.ledger.install?.startup, "not-registered");
    assert.equal(result.ledger.install?.signedInstallers, "not-qualified");
    return { ...offered, selected };
  }
  assert.equal(existsSync(join(stateDir, LEDGER_FILE)), false);
  assert.deepEqual(loadLedger(stateDir), { ok: true, ledger: emptyLedger() });
  return { ...offered, selected: undefined };
}

function checkStateUnchanged(offered: ReturnType<typeof context>, before: unknown): void {
  assert.deepEqual(snapshot(offered.input.stateDir), before,
    "Preflight must preserve the complete local state, including its ledger, releases and release lease entries.");
  const ledger = loadLedger(offered.input.stateDir);
  if (offered.selected) {
    assert.ok(ledger.ok);
    assert.equal(ledger.ledger.install?.startup, "not-registered");
    assert.equal(ledger.ledger.install?.signedInstallers, "not-qualified");
    assert.deepEqual(installer.verifySelectedRelease(offered.sample.input, ledger.ledger, offered.releaseTrust), offered.selected);
  } else {
    assert.equal(existsSync(join(offered.input.stateDir, LEDGER_FILE)), false);
    assert.deepEqual(ledger, { ok: true, ledger: emptyLedger() });
  }
}

type Attempt = {
  input: OfferInput;
  releaseTrust: ReleaseTrust | undefined;
  publisherPolicy: WindowsPackagePolicy | undefined;
  observation: NativeObservation | undefined;
  observerConfigured: boolean;
};

function attemptFor(offered: ReturnType<typeof context>): Attempt {
  return {
    input: offered.input, releaseTrust: offered.releaseTrust, publisherPolicy: PUBLISHER_POLICY,
    observation: offered.observation, observerConfigured: true,
  };
}

function probes(attempt: Attempt) {
  const events: string[] = [];
  const observed: BoundOffer[] = [];
  const staged: Array<{ offer: BoundOffer; appxDigest: string }> = [];
  const services: NativeInstallServices = {
    releaseTrust: attempt.releaseTrust,
    publisherPolicy: attempt.publisherPolicy,
    stageWindowsOffer(offer, appxDigest) { events.push("stage"); staged.push({ offer: structuredClone(offer), appxDigest }); },
    onReleaseFileCheckpoint(phase) { events.push("file:" + phase); },
    onReleaseCheckpoint(phase) { events.push("release:" + phase); },
    launchWindowsPackage() { events.push("launch"); },
  };
  if (attempt.observerConfigured) {
    services.observeWindowsOffer = (offer) => {
      events.push("observe");
      observed.push(structuredClone(offer));
      return structuredClone(attempt.observation);
    };
  }
  return { events, observed, staged, services };
}

function checkBoundOffer(bound: BoundOffer, offered: ReturnType<typeof context>): void {
  const request = offered.input.release;
  assert.deepEqual(bound.release, {
    version: request.requestedVersion, manifestDigest: digest(request.manifestBytes), sourceCommit: request.sourceCommit,
  });
  assert.deepEqual(bound.descriptor, offered.descriptor);
  assert.deepEqual(Buffer.from(bound.archiveBytes), offered.archive);
}

function checkPurePrimitives(offered: ReturnType<typeof context>): void {
  const loaded = loadLedger(offered.input.stateDir);
  assert.ok(loaded.ok);
  const { input, releaseTrust } = offered;
  const { release, platform, arch } = input;
  const manifest = verifyManifest(release.manifestBytes, release.signatureBytes, releaseTrust, {
    version: release.requestedVersion, sourceCommit: release.sourceCommit, platform, arch, dataVersion: loaded.ledger.version,
  });
  const members = verifiedArtifacts(release, manifest);
  const archive = manifest.files.find((file) => file.path === WINDOWS_ARCHIVE_FILE)!;
  assert.deepEqual(Buffer.from(members.get(WINDOWS_ARCHIVE_FILE)!), offered.archive);
  const descriptor = verifyWindowsPackageDescriptor(members.get(WINDOWS_DESCRIPTOR_FILE)!, manifest, archive, PUBLISHER_POLICY);
  assert.deepEqual(descriptor, offered.descriptor);
}

const cases: Array<{
  name: string; arch?: string; beforeObserver?: true; mayRejectCallerFields?: true; change?: (attempt: Attempt) => void;
}> = [
  { name: "an invalid outer release signature", beforeObserver: true, change: ({ input }) => {
    input.release.signatureBytes = Buffer.alloc(64);
  } },
  { name: "a signed offer for a different requested version", beforeObserver: true, change: ({ input }) => {
    input.release.requestedVersion = "0.3.0";
  } },
  { name: "a signed offer for a different requested source", beforeObserver: true, change: ({ input }) => {
    input.release.sourceCommit = "b".repeat(40);
  } },
  { name: "different offered archive bytes under an unchanged signed manifest", beforeObserver: true, change: ({ input }) => {
    const bytes = Buffer.from(input.release.artifacts[0]!.bytes);
    bytes[0] = bytes[0]! ^ 1;
    input.release.artifacts[0]!.bytes = bytes;
  } },
  { name: "different offered companion bytes under an unchanged signed manifest", beforeObserver: true, change: ({ input }) => {
    const companion = input.release.artifacts[1]!;
    const value = JSON.parse(Buffer.from(companion.bytes).toString("utf8")) as WindowsPackageDescriptor;
    const { schema, ...fields } = value;
    const reordered = Buffer.from(JSON.stringify({ ...fields, schema }));
    assert.equal(reordered.length, companion.bytes.length);
    assert.notEqual(digest(reordered), digest(companion.bytes));
    assert.deepEqual(JSON.parse(reordered.toString("utf8")), value);
    companion.bytes = reordered;
  } },
  { name: "missing independent release trust", beforeObserver: true, change: (attempt) => { attempt.releaseTrust = undefined; } },
  { name: "missing independent publisher policy", beforeObserver: true, change: (attempt) => { attempt.publisherPolicy = undefined; } },
  { name: "a caller-authored success claim without the independently configured observer", beforeObserver: true, change: (attempt) => {
    Object.assign(attempt.input, { observation: structuredClone(attempt.observation), windowsTrustStatus: 0 });
    attempt.observerConfigured = false;
  } },
  { name: "a caller-authored success claim when the independent observer refuses", mayRejectCallerFields: true, change: (attempt) => {
    Object.assign(attempt.input, { observation: structuredClone(attempt.observation), windowsTrustStatus: 0 });
    attempt.observation!.windowsTrustStatus = 0x800b0109;
  } },
  { name: "a self-consistent signed arm64 offer outside the supported Windows x64 native target", arch: "arm64", beforeObserver: true },
  { name: "missing native trust evidence", change: (attempt) => { attempt.observation = undefined; } },
  { name: "an untrusted Windows result even with matching identity and signer", change: ({ observation }) => {
    observation!.windowsTrustStatus = 0x800b0109;
  } },
  { name: "an unsigned native result despite matching manifest identity", change: ({ observation }) => {
    observation!.windowsTrustStatus = 0x800b0100;
    delete observation!.policySignerSha256;
  } },
  { name: "Windows success for a different actual signer", change: ({ observation }) => {
    observation!.policySignerSha256 = "8".repeat(64);
  } },
  { name: "Windows success with no policy signer evidence", change: ({ observation }) => {
    delete observation!.policySignerSha256;
  } },
  { name: "a valid native full name for a different package version", change: ({ observation }) => {
    observation!.identity.version = "7.8.9.11";
    observation!.identity.fullName = observation!.identity.fullName.replace("_7.8.9.10_", "_7.8.9.11_");
  } },
  { name: "a different observed native publisher", change: ({ observation }) => {
    observation!.identity.publisher = "CN=Different Fabricated Publisher";
  } },
  { name: "a different observed native application ID", change: ({ observation }) => {
    observation!.identity.applicationId = "OtherSupervisor";
  } },
  { name: "a different native application executable", change: ({ observation }) => {
    observation!.applicationExecutable = "Guardian.exe";
  } },
  { name: "native inspection of other archive bytes", change: ({ observation }) => {
    observation!.archiveSha256 = digest(Buffer.from("Different fabricated Windows archive"));
  } },
  { name: "a missing native payload row", change: ({ observation }) => {
    observation!.files = observation!.files.filter((file) => file.path !== "late.mjs");
  } },
  { name: "a different native payload digest at the exact path and size", change: ({ observation }) => {
    observation!.files.find((file) => file.path === "late.mjs")!.sha256 = "b".repeat(64);
  } },
  { name: "a different native payload size at the exact path and digest", change: ({ observation }) => {
    observation!.files.find((file) => file.path === "late.mjs")!.size += 1;
  } },
  { name: "an unlisted native payload file alongside the exact signed inventory", change: ({ observation }) => {
    const contents = Buffer.from("Fabricated extra file");
    observation!.files.push({ path: "extra.mjs", size: contents.length, sha256: digest(contents) });
  } },
  { name: "a missing canonical Appx digest", change: ({ observation }) => { delete observation!.appxDigest; } },
  { name: "an empty Appx digest", change: ({ observation }) => { observation!.appxDigest = ""; } },
  { name: "an Appx digest with invalid Base64 syntax", change: ({ observation }) => {
    observation!.appxDigest = "Not an Appx digest";
  } },
  { name: "a canonical Base64 Appx digest with the wrong decoded length", change: ({ observation }) => {
    observation!.appxDigest = Buffer.alloc(31, 17).toString("base64");
  } },
  { name: "a noncanonical Appx digest spelling that decodes to the same bytes", change: ({ observation }) => {
    observation!.appxDigest = APPX_DIGEST + "\n";
    assert.deepEqual(Buffer.from(observation!.appxDigest, "base64"), Buffer.from(APPX_DIGEST, "base64"));
  } },
];

for (const previousSelection of [false, true]) {
  const phase = previousSelection ? "with an existing selected release" : "before first installation";

  test("existing pure release primitives validate the fabricated offer " + phase, (t) => {
    const offered = context(t, previousSelection);
    const before = snapshot(offered.input.stateDir);
    checkPurePrimitives(offered);
    checkStateUnchanged(offered, before);
  });

  test("explicit Windows install stages a bound fabricated offer after trusted observation " + phase, (t) => {
    const offered = context(t, previousSelection);
    const before = snapshot(offered.input.stateDir);
    const inputBefore = structuredClone(offered.input);
    const request = offered.input.release;
    const spies = probes(attemptFor(offered));
    const result = nativeInstall()(offered.input, spies.services);
    assert.deepEqual(spies.events, ["observe", "stage"]);
    assert.equal(spies.observed.length, 1);
    checkBoundOffer(spies.observed[0]!, offered);
    assert.equal(spies.staged.length, 1);
    checkBoundOffer(spies.staged[0]!.offer, offered);
    assert.equal(spies.staged[0]!.appxDigest, APPX_DIGEST);
    assert.deepEqual(result, {
      release: { version: request.requestedVersion, manifestDigest: digest(request.manifestBytes), sourceCommit: request.sourceCommit },
      archiveSha256: digest(offered.archive),
      appxDigest: APPX_DIGEST,
      packageFullName: offered.descriptor.package.fullName,
      signerSha256: PUBLISHER_POLICY.signerSha256,
    });
    assert.deepEqual(structuredClone(offered.input), inputBefore);
    checkStateUnchanged(offered, before);
  });

  for (const { name, arch, beforeObserver, mayRejectCallerFields, change } of cases) {
    test(name + " refuses explicit Windows install " + phase + " before any effect", (t) => {
      const offered = context(t, previousSelection, arch);
      const before = snapshot(offered.input.stateDir);
      if (arch) {
        checkPurePrimitives(offered);
        assert.equal(offered.observation.identity.architecture, offered.input.arch);
        assert.equal(offered.observation.identity.fullName, offered.descriptor.package.fullName);
      }
      const attempt = attemptFor(offered);
      change?.(attempt);
      const inputBefore = structuredClone(attempt.input);
      const spies = probes(attempt);
      const install = nativeInstall();
      assert.throws(() => install(attempt.input, spies.services),
        /release operation could not finish safely/i);
      const expectedEvents = beforeObserver || (mayRejectCallerFields && spies.events.length === 0) ? [] : ["observe"];
      assert.deepEqual(spies.events, expectedEvents, "Refusal may reach only the independently configured read-only observer.");
      assert.deepEqual(spies.staged, []);
      assert.equal(spies.observed.length, expectedEvents.length);
      if (spies.observed.length > 0) checkBoundOffer(spies.observed[0]!, offered);
      assert.deepEqual(structuredClone(attempt.input), inputBefore);
      checkStateUnchanged(offered, before);
    });
  }
}

test("ordinary Windows portable installation keeps its current route with native services configured", (t) => {
  const offered = context(t, false);
  const request = offered.sample.signed();
  const spies = probes(attemptFor(offered));
  const result = installer.install(request, spies.services);
  assert.equal(result.ledger.install?.startup, "not-registered");
  assert.equal(result.ledger.install?.signedInstallers, "not-qualified");
  assert.equal(result.ledger.install?.release?.qualified, false);
  const selected = installer.verifySelectedRelease(request, result.ledger, offered.releaseTrust);
  assert.deepEqual(selected, {
    version: request.release!.requestedVersion,
    sourceCommit: request.release!.sourceCommit,
    manifestDigest: digest(request.release!.manifestBytes),
  });
  assert.deepEqual(spies.events.filter((event) => event.startsWith("release:")), ["release:staged", "release:published", "release:committed"]);
  assert.ok(spies.events.some((event) => event === "file:file-writing"));
  assert.ok(spies.events.every((event) => event.startsWith("file:") || event.startsWith("release:")));
  assert.deepEqual(spies.observed, []);
  assert.deepEqual(spies.staged, []);
});
