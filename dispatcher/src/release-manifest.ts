import { createHash, KeyObject, verify } from "node:crypto";

export type ReleaseManifest = {
  schema: 1;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  keyId: string;
  provenance: { repository: string; workflow: string; ref: string; sourceCommit: string };
  dataCompatibility: { min: number; max: number };
  files: Array<{ path: string; size: number; sha256: string; executable: boolean }>;
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

export function releaseVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  return match !== null && (match[4] === undefined || match[4].split(".").every((part) => !/^0[0-9]+$/.test(part)));
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

export function verifyManifest(bytes: Uint8Array, signature: Uint8Array, trust: ReleaseTrust | undefined,
  expected: { version: string; sourceCommit?: string; platform: NodeJS.Platform; arch: string; dataVersion: number }): ReleaseManifest {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES
      || !(signature instanceof Uint8Array) || signature.byteLength !== 64 || !trust
      || !(trust.keys instanceof Map) || !Array.isArray(trust.revokedKeyIds)) throw releaseError();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const row: unknown = JSON.parse(decoded);
    // Signing one compact representation also excludes duplicate members and alternate parser interpretations.
    if (!Buffer.from(JSON.stringify(row)).equals(Buffer.from(bytes))
      || !exact(row, ["schema", "version", "platform", "arch", "keyId", "provenance", "dataCompatibility", "files"])
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
    if (!Array.isArray(row.files) || row.files.length === 0 || row.files.length > 4096) throw releaseError();
    const paths = new Set<string>();
    let total = 0;
    for (const file of row.files) {
      if (!exact(file, ["path", "size", "sha256", "executable"]) || !portableReleasePath(file.path)
        || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > MAX_ARTIFACT_BYTES
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.executable !== "boolean") throw releaseError();
      const path = file.path.toLowerCase();
      if (paths.has(path)) throw releaseError();
      paths.add(path);
      total += file.size as number;
    }
    if (total > MAX_RELEASE_BYTES) throw releaseError();
    for (const path of paths) {
      const parts = path.split("/");
      for (let count = 1; count < parts.length; count++) if (paths.has(parts.slice(0, count).join("/"))) throw releaseError();
    }
    return row as ReleaseManifest;
  } catch { throw releaseError(); }
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
