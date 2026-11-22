import { createHash, KeyObject, verify } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type ReleaseFile = { path: string; size: number; sha256: string };

export type ReleaseManifest = {
  schema: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  keyId: string;
  provenance: { repository: string; workflow: string; ref: string; sourceCommit: string };
  dataCompatibility: { min: number; max: number };
  files: Array<ReleaseFile & { executable: boolean }>;
};

export type WindowsPackagePolicy = {
  packageName: string;
  publisher: string;
  publisherId: string;
  applicationId: string;
  signerSha256: string;
};

export type WindowsPackageDescriptor = {
  schema: 1;
  release: { version: string; sourceCommit: string };
  archive: { path: string; sha256: string };
  package: WindowsPackagePolicy & { fullName: string; version: string; architecture: string };
  installed: { supervisor: string; guardian: string; interpreter: string; entry: string; files: ReleaseFile[] };
};

export type WindowsPackageObservation = {
  archiveSha256: string;
  appxDigest?: string;
  windowsTrustStatus: number;
  policySignerSha256?: string;
  identity: Omit<WindowsPackageDescriptor["package"], "signerSha256">;
  applicationExecutable: string;
  files: ReleaseFile[];
};

export type ReleaseRequest = {
  requestedVersion: string;
  sourceCommit: string;
  manifestBytes: Uint8Array;
  signatureBytes: Uint8Array;
  artifacts: Array<{ path: string; bytes: Uint8Array }>;
};

export type ReleaseTrust = {
  keys: Map<string, KeyObject>;
  revokedKeyIds: string[];
  repository: string;
  workflow: string;
};

export type ReleaseServices = {
  releaseTrust?: ReleaseTrust;
  onReleaseFileCheckpoint?: (phase: "file-writing" | "cleanup-file-deleted", path: string) => void;
  onReleaseCheckpoint?: (phase: "staged" | "published" | "committed", directory: string) => void;
};

export const MANIFEST_FILE = ".release-manifest.json";
export const SIGNATURE_FILE = ".release-signature";
export const WINDOWS_ARCHIVE_FILE = "windows/dispatcher.msix";
export const WINDOWS_DESCRIPTOR_FILE = "windows/admission.json";
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RELEASE_BYTES = 512 * 1024 * 1024;

export function releaseError(): Error {
  return new Error("The release operation could not finish safely. Inspect the selected installation before retrying.");
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function compactJson(bytes: Uint8Array): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) throw releaseError();
  const row: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  // One compact representation excludes duplicate members and alternate parser interpretations.
  if (!Buffer.from(JSON.stringify(row)).equals(Buffer.from(bytes))) throw releaseError();
  return row;
}

function releaseVersionParts(value: unknown): RegExpExecArray | null {
  if (typeof value !== "string" || value.length > 128) return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (match?.[4]?.split(".").some((part) => /^0[0-9]+$/.test(part))) return null;
  return match;
}

export function releaseVersion(value: unknown): value is string {
  return releaseVersionParts(value) !== null;
}

export function isNewerReleaseVersion(offered: string, selected: string): boolean {
  const offer = releaseVersionParts(offered), current = releaseVersionParts(selected);
  if (!offer || !current) return false;
  for (const index of [1, 2, 3]) {
    if (offer[index] !== current[index]) return BigInt(offer[index]!) > BigInt(current[index]!);
  }
  const offeredPrerelease = offer[4]?.split("."), selectedPrerelease = current[4]?.split(".");
  if (!offeredPrerelease || !selectedPrerelease) return offeredPrerelease === undefined && selectedPrerelease !== undefined;
  for (const [index, offeredPart] of offeredPrerelease.entries()) {
    const selectedPart = selectedPrerelease[index];
    if (selectedPart === undefined) return true;
    if (offeredPart === selectedPart) continue;
    const offeredNumeric = /^[0-9]+$/.test(offeredPart), selectedNumeric = /^[0-9]+$/.test(selectedPart);
    if (offeredNumeric !== selectedNumeric) return selectedNumeric;
    return offeredNumeric ? BigInt(offeredPart) > BigInt(selectedPart) : offeredPart > selectedPart;
  }
  return false;
}

export function portableReleasePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part.length <= 128 && /^[A-Za-z0-9_@+.-]+$/.test(part)
    && part !== "." && part !== ".." && !part.endsWith(".")
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))
    && ![MANIFEST_FILE, SIGNATURE_FILE].includes(parts[0]!.toLowerCase());
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function releaseDirectory(version: string, digest: string): string {
  return `releases/${version}-${digest}`;
}

function verifyInventory(files: unknown, hasExecutableFlag: boolean): ReleaseFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > 4096) throw releaseError();
  const keys = hasExecutableFlag ? ["path", "size", "sha256", "executable"] : ["path", "size", "sha256"];
  const paths = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (!exact(file, keys) || !portableReleasePath(file.path)
      || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ARTIFACT_BYTES
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
      || (hasExecutableFlag && typeof file.executable !== "boolean")) throw releaseError();
    const path = file.path.toLowerCase();
    if (paths.has(path)) throw releaseError();
    paths.add(path);
    total += file.size;
  }
  if (total > MAX_RELEASE_BYTES) throw releaseError();
  for (const path of paths) {
    const parts = path.split("/");
    for (let count = 1; count < parts.length; count++) if (paths.has(parts.slice(0, count).join("/"))) throw releaseError();
  }
  return files as ReleaseFile[];
}

export function verifyManifest(bytes: Uint8Array, signature: Uint8Array, trust: ReleaseTrust | undefined,
  expected: { version: string; sourceCommit?: string; platform: NodeJS.Platform; arch: string; dataVersion: number }): ReleaseManifest {
  try {
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64 || !trust
      || !(trust.keys instanceof Map) || !Array.isArray(trust.revokedKeyIds)) throw releaseError();
    const row = compactJson(bytes);
    if (!exact(row, ["schema", "version", "platform", "arch", "keyId", "provenance", "dataCompatibility", "files"])
      || row.schema !== 1 || !releaseVersion(row.version) || row.version !== expected.version
      || row.platform !== expected.platform || row.arch !== expected.arch
      || typeof row.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.keyId)
      || trust.revokedKeyIds.includes(row.keyId)) throw releaseError();
    const publicKey = trust.keys.get(row.keyId);
    if (!(publicKey instanceof KeyObject) || publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519"
      || !verify(null, bytes, publicKey, signature)) throw releaseError();
    const provenance = row.provenance;
    if (!exact(provenance, ["repository", "workflow", "ref", "sourceCommit"])
      || typeof trust.repository !== "string" || trust.repository.length === 0 || provenance.repository !== trust.repository
      || typeof trust.workflow !== "string" || trust.workflow.length === 0 || provenance.workflow !== trust.workflow
      || provenance.ref !== `refs/tags/v${row.version}`
      || typeof provenance.sourceCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(provenance.sourceCommit)
      || (expected.sourceCommit !== undefined && provenance.sourceCommit !== expected.sourceCommit)) throw releaseError();
    const compatible = row.dataCompatibility;
    if (!exact(compatible, ["min", "max"]) || !Number.isSafeInteger(compatible.min) || !Number.isSafeInteger(compatible.max)
      || (compatible.min as number) < 0 || (compatible.min as number) > expected.dataVersion || (compatible.max as number) < expected.dataVersion) throw releaseError();
    verifyInventory(row.files, true);
    return row as ReleaseManifest;
  } catch { throw releaseError(); }
}

const WINDOWS_POLICY_FIELDS = ["packageName", "publisher", "publisherId", "applicationId", "signerSha256"] as const;

export function verifyWindowsPackageDescriptor(bytes: Uint8Array, manifest: ReleaseManifest,
  archive: ReleaseFile, policy: WindowsPackagePolicy): WindowsPackageDescriptor {
  try {
    const row = compactJson(bytes);
    if (!exact(row, ["schema", "release", "archive", "package", "installed"]) || row.schema !== 1) throw releaseError();
    if (!exact(row.release, ["version", "sourceCommit"]) || row.release.version !== manifest.version
      || row.release.sourceCommit !== manifest.provenance.sourceCommit) throw releaseError();
    if (!exact(row.archive, ["path", "sha256"]) || row.archive.path !== archive.path
      || row.archive.sha256 !== archive.sha256) throw releaseError();

    const identity = row.package;
    if (!exact(identity, [...WINDOWS_POLICY_FIELDS, "fullName", "version", "architecture"])) throw releaseError();
    const fullName = parseWindowsPackageFullName(identity.fullName);
    if (!fullName || !WINDOWS_POLICY_FIELDS.every((key) => typeof policy[key] === "string" && policy[key].length > 0 && identity[key] === policy[key])
      || !/^[a-f0-9]{64}$/.test(policy.signerSha256)
      || fullName.packageName !== policy.packageName || fullName.publisherId !== policy.publisherId
      || fullName.version !== identity.version || fullName.architecture !== identity.architecture
      || identity.architecture !== manifest.arch) throw releaseError();

    const installed = row.installed;
    if (!exact(installed, ["supervisor", "guardian", "interpreter", "entry", "files"])) throw releaseError();
    const paths = new Set(verifyInventory(installed.files, false).map((file) => file.path));
    const roles = [installed.supervisor, installed.guardian, installed.interpreter, installed.entry];
    if (new Set(roles).size !== roles.length || !roles.every((path) => typeof path === "string" && paths.has(path))) throw releaseError();
    return row as WindowsPackageDescriptor;
  } catch { throw releaseError(); }
}

export function verifyWindowsPackageObservation(observation: WindowsPackageObservation | undefined,
  descriptor: WindowsPackageDescriptor): string {
  const { signerSha256, ...identity } = descriptor.package;
  if (!observation || observation.windowsTrustStatus !== 0 || observation.policySignerSha256 !== signerSha256
    || observation.archiveSha256 !== descriptor.archive.sha256
    || observation.applicationExecutable !== descriptor.installed.supervisor
    || !isDeepStrictEqual(observation.identity, identity)) throw releaseError();
  const appxDigest = observation.appxDigest;
  if (!validAppxDigest(appxDigest) || !windowsInventoryMatches(observation.files, descriptor.installed.files)) throw releaseError();
  return appxDigest;
}

export function validAppxDigest(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value)
    && Buffer.from(value, "base64").toString("base64") === value;
}

export function parseWindowsPackageFullName(value: unknown) {
  if (typeof value !== "string") return;
  const parts = /^([A-Za-z0-9.-]{3,50})_((?:0|[1-9][0-9]{0,4})(?:\.(?:0|[1-9][0-9]{0,4})){3})_([a-z0-9]{3,5})__([0-9abcdefghjkmnpqrstvwxyz]{13})$/.exec(value);
  if (!parts || parts[0] !== value) return;
  const [, packageName, version, architecture, publisherId] = parts;
  if (!packageName || !version || !publisherId || (architecture !== "x64" && architecture !== "arm64")
    || version.split(".").some((part) => Number(part) > 65535)) return;
  return { packageName, version, architecture, publisherId };
}

export function windowsInventoryMatches(files: unknown, inventory: WindowsPackageDescriptor["installed"]["files"]): boolean {
  const observed = verifyInventory(files, false);
  const expected = new Map(inventory.map((file) => [file.path, file]));
  return observed.length === expected.size && observed.every((file) => {
    const member = expected.get(file.path);
    return member?.size === file.size && member.sha256 === file.sha256;
  });
}

export function verifiedArtifacts(request: ReleaseRequest, manifest: ReleaseManifest): Map<string, Buffer> {
  if (!Array.isArray(request.artifacts) || request.artifacts.length !== manifest.files.length) throw releaseError();
  const artifacts = new Map<string, Buffer>();
  for (const item of request.artifacts) {
    if (!exact(item, ["path", "bytes"]) || !portableReleasePath(item.path) || !(item.bytes instanceof Uint8Array) || artifacts.has(item.path)) throw releaseError();
    artifacts.set(item.path, Buffer.from(item.bytes));
  }
  for (const file of manifest.files) {
    const bytes = artifacts.get(file.path);
    if (!bytes || bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw releaseError();
  }
  return artifacts;
}
