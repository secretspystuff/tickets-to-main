import { createHash } from "node:crypto";
import { hasCredentialShape } from "./secret-text.ts";

const MAX_ENTRIES = 128;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_ENTRY_BYTES;
const MAX_NAME_BYTES = 512;
const MAX_SECRET_BYTES = 4096;
const MAX_DECODE_PASSES = 8;
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const typedByteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!;

const OUTCOMES = {
  clear: { state: "clear", reason: null, qualification: "unqualified-harness", publishable: false },
  held: { state: "held", reason: "incomplete-scan", qualification: "unqualified-harness", publishable: false },
  stopped: { state: "stopped", reason: "secret-detected", qualification: "unqualified-harness", publishable: false },
} as const;

type State = keyof typeof OUTCOMES;
type Expectation = { size: number; digest: string };

function dataProperty(object: object, key: PropertyKey): PropertyDescriptor | undefined {
  const property = Object.getOwnPropertyDescriptor(object, key);
  return property && Object.hasOwn(property, "value") ? property : undefined;
}

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Reflect.ownKeys(input).length !== keys.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const property = dataProperty(input, key);
    if (!property) return null;
    result[key] = property.value;
  }
  return result;
}

function entries(input: unknown): unknown[] | null {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return null;
  const length: unknown = dataProperty(input, "length")?.value;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > MAX_ENTRIES
    || Reflect.ownKeys(input).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const property = dataProperty(input, index);
    if (!property) return null;
    result.push(property.value);
  }
  return result;
}

function boundedUtf8(value: unknown, limit: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return false;
  const bytes = Buffer.from(value);
  return bytes.byteLength <= limit && bytes.toString("utf8") === value;
}

function expectedEntries(input: readonly unknown[]): Map<string, Expectation> | null {
  const result = new Map<string, Expectation>();
  let total = 0;
  for (const entry of input) {
    const item = fields(entry, ["name", "size", "sha256"]);
    if (!item) return null;
    const { name, size, sha256 } = item;
    if (!boundedUtf8(name, MAX_NAME_BYTES) || /[\r\n\t]/.test(name) || OPAQUE_CONTROLS.test(name) || result.has(name)
      || typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_ENTRY_BYTES
      || typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
    total += size;
    if (total > MAX_TOTAL_BYTES) return null;
    result.set(name, { size, digest: sha256 });
  }
  return result;
}

function scanText(input: string, secrets: readonly string[]): State {
  let text = input;
  for (let depth = 0; ; depth++) {
    if (OPAQUE_CONTROLS.test(text)) return "held";
    if (secrets.some(secret => text.includes(secret)) || hasCredentialShape(text)) return "stopped";
    const decoded = text.replace(/(?:%[a-f0-9]{2})+/gi, encoded => decodeURIComponent(encoded));
    if (decoded === text) return "clear";
    if (depth === MAX_DECODE_PASSES) return "held";
    text = decoded;
  }
}

function check(input: unknown): State {
  const request = fields(input, ["expected", "artifacts", "secrets"]);
  if (!request) return "held";
  const expected = entries(request.expected);
  const artifacts = entries(request.artifacts);
  const secrets = entries(request.secrets);
  if (!expected || !artifacts || expected.length === 0 || artifacts.length !== expected.length
    || !secrets || !secrets.every(secret => boundedUtf8(secret, MAX_SECRET_BYTES))) return "held";
  const remaining = expectedEntries(expected);
  if (!remaining) return "held";
  for (const entry of artifacts) {
    const item = fields(entry, ["name", "bytes"]);
    if (!item || typeof item.name !== "string") return "held";
    const plan = remaining.get(item.name);
    const supplied = item.bytes;
    if (!plan || !(supplied instanceof Uint8Array) || !ArrayBuffer.isView(supplied)
      || Reflect.apply(typedByteLength, supplied, []) !== plan.size) return "held";
    const bytes = new Uint8Array(supplied);
    if (bytes.byteLength !== plan.size || createHash("sha256").update(bytes).digest("hex") !== plan.digest) return "held";
    const content = decoder.decode(bytes);
    if (OPAQUE_CONTROLS.test(content)) return "held";
    const nameState = scanText(item.name, secrets);
    if (nameState !== "clear") return nameState;
    const contentState = scanText(content, secrets);
    if (contentState !== "clear") return contentState;
    remaining.delete(item.name);
  }
  return remaining.size === 0 ? "clear" : "held";
}

export function checkPushArtifacts(input: unknown): (typeof OUTCOMES)[State] {
  try {
    return { ...OUTCOMES[check(input)] };
  } catch {
    return { ...OUTCOMES.held };
  }
}
