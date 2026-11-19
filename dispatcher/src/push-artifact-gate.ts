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
const PERCENT_CHARACTER = /%(?:[cd][0-9a-f]%[89ab][0-9a-f]|e[0-9a-f](?:%[89ab][0-9a-f]){2}|f[0-4](?:%[89ab][0-9a-f]){3}|[0-9a-f]{2})/gi;
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
  try {
    const property = Object.getOwnPropertyDescriptor(object, key);
    return property && Object.hasOwn(property, "value") ? property : undefined;
  } catch {
    return undefined;
  }
}

function fields(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
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
  } catch {
    return null;
  }
}

function entries(input: unknown): { values: unknown[]; complete: boolean } | null {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return null;
    const length: unknown = dataProperty(input, "length")?.value;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > MAX_ENTRIES) return null;
    let complete = Reflect.ownKeys(input).length === length + 1;
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const property = dataProperty(input, index);
      if (property) values.push(property.value);
      else complete = false;
    }
    return { values, complete };
  } catch {
    return null;
  }
}

function boundedUtf8(value: unknown, limit: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return false;
  const bytes = Buffer.from(value);
  return bytes.byteLength <= limit && bytes.toString("utf8") === value;
}

function expectedEntries(input: readonly unknown[]): { plan: Map<string, Expectation>; complete: boolean } {
  const plan = new Map<string, Expectation>();
  const seen = new Set<string>();
  let complete = input.length > 0;
  for (const entry of input) {
    const item = fields(entry, ["name", "size", "sha256"]);
    const name = item?.name;
    if (!item || !boundedUtf8(name, MAX_NAME_BYTES) || /[\r\n\t]/.test(name) || OPAQUE_CONTROLS.test(name)) {
      complete = false;
      continue;
    }
    if (seen.has(name)) {
      plan.delete(name);
      complete = false;
      continue;
    }
    seen.add(name);
    const { size, sha256 } = item;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || size > MAX_ENTRY_BYTES
      || typeof sha256 !== "string" || !SHA256.test(sha256)) {
      complete = false;
      continue;
    }
    plan.set(name, { size, digest: sha256 });
  }
  const total = [...plan.values()].reduce((sum, item) => sum + item.size, 0);
  if (total > MAX_TOTAL_BYTES) return { plan: new Map(), complete: false };
  return { plan, complete };
}

function scanText(input: string, secrets: readonly string[]): State {
  const rawState = OPAQUE_CONTROLS.test(input) ? "held" : "clear";
  let text = input;
  for (let depth = 0; ; depth++) {
    if (secrets.some(secret => text.includes(secret)) || hasCredentialShape(text)) return "stopped";
    const decoded = text.replace(PERCENT_CHARACTER, encoded => {
      try { return decodeURIComponent(encoded); }
      catch {
        // A lone surrogate separates malformed escapes without matching verified UTF-8 or held values.
        return "\ud800";
      }
    });
    if (decoded === text) return rawState;
    if (depth === MAX_DECODE_PASSES) return "held";
    text = decoded;
  }
}

function verifiedText(expected: Expectation | undefined, supplied: unknown): string | null {
  try {
    if (!expected || !ArrayBuffer.isView(supplied) || !(supplied instanceof Uint8Array)
      || Reflect.apply(typedByteLength, supplied, []) !== expected.size) return null;
    const bytes = new Uint8Array(supplied);
    if (bytes.byteLength !== expected.size || createHash("sha256").update(bytes).digest("hex") !== expected.digest) return null;
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function check(input: unknown): State {
  const request = fields(input, ["expected", "artifacts", "secrets"]);
  if (!request) return "held";
  const expected = entries(request.expected);
  const artifacts = entries(request.artifacts);
  if (!artifacts) return "held";
  const held = entries(request.secrets);
  const scanSecrets = held?.values.filter(secret => boundedUtf8(secret, MAX_SECRET_BYTES)) ?? [];
  const secretsComplete = held?.complete && scanSecrets.length === held.values.length;
  const { plan, complete } = expectedEntries(expected?.values ?? []);
  let incomplete = !expected?.complete || !artifacts.complete || !secretsComplete || !complete;
  const seen = new Set<string>();
  const verified = new Set<string>();
  for (const entry of artifacts.values) {
    const item = fields(entry, ["name", "bytes"]);
    if (!item || !boundedUtf8(item.name, MAX_NAME_BYTES)) {
      incomplete = true;
      continue;
    }
    const nameState = scanText(item.name, scanSecrets);
    if (nameState === "stopped") return "stopped";
    if (nameState === "held" || seen.has(item.name)) incomplete = true;
    seen.add(item.name);
    if (verified.has(item.name)) continue;
    const content = verifiedText(plan.get(item.name), item.bytes);
    if (content === null) {
      incomplete = true;
      continue;
    }
    verified.add(item.name);
    const contentState = scanText(content, scanSecrets);
    if (contentState === "stopped") return "stopped";
    if (contentState === "held") incomplete = true;
  }
  return incomplete || seen.size !== plan.size ? "held" : "clear";
}

export function checkPushArtifacts(input: unknown): (typeof OUTCOMES)[State] {
  try {
    return { ...OUTCOMES[check(input)] };
  } catch {
    return { ...OUTCOMES.held };
  }
}
