import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { checkPushArtifacts } from "../src/push-artifact-gate.ts";

const text = [{ name: "candidate.patch", bytes: Buffer.from("fictional patch: 100% ready\n") }];
const zero = { name: "empty.txt", bytes: Buffer.alloc(0) };
const second = { name: "commit message.txt", bytes: Buffer.from("fabricated revision\r\n") };
const held = "fabricated-held-value";
const incomplete = { state: "held", reason: "incomplete-scan", qualification: "unqualified-harness", publishable: false };
const stopped = { state: "stopped", reason: "secret-detected", qualification: "unqualified-harness", publishable: false };
const clear = { state: "clear", reason: null, qualification: "unqualified-harness", publishable: false };

function assertOutcome(actual: unknown, expected: typeof clear | typeof incomplete | typeof stopped): void {
  assert.deepEqual(actual, expected);
  assert.ok(actual && typeof actual === "object");
  assert.equal(Object.getPrototypeOf(actual), Object.prototype);
  assert.deepEqual(Reflect.ownKeys(actual).sort(), Object.keys(expected).sort());
}

type Artifact = { name: string; bytes: Uint8Array };
function inventory(artifacts: readonly Artifact[]) {
  return artifacts.map(({ name, bytes }) => ({
    name, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
}

function check(artifacts: readonly Artifact[], secrets: readonly string[] | null = []) {
  return checkPushArtifacts({ expected: inventory(artifacts), artifacts, secrets });
}

test("scans the exact named plaintext artifacts, including empty files and ordinary percent signs", () => {
  const artifacts = Object.freeze([...text, zero, second]);
  const expected = Object.freeze(inventory(artifacts).reverse());
  const before = artifacts.map(({ bytes }) => Buffer.from(bytes));
  assertOutcome(checkPushArtifacts({ expected, artifacts, secrets: [held] }), clear);
  assert.deepEqual(artifacts.map(({ bytes }) => bytes), before);
  const wide = [{ name: "notes with spaces.txt", bytes: new TextEncoder().encode("café\t50% complete\r\n+100% and %25\n") }];
  assertOutcome(check(wide), clear);
});

test("stops the whole batch on a held value in any outgoing name or byte payload and returns no input", () => {
  const hiddenInName = { ...second, name: `metadata-${held}.txt` };
  const hiddenInBytes = { ...second, bytes: Buffer.from(`start\n${held}\nend`) };
  const nonAscii = "fabricated・全・secret";
  const bom = "\uFEFF" + held;
  const fixtures = [
    { artifacts: [...text, hiddenInName, zero], secrets: [held] },
    { artifacts: [...text, zero, hiddenInBytes], secrets: [held] },
    { artifacts: [...text, { ...second, bytes: Buffer.from(`begin ${nonAscii} end`) }], secrets: [nonAscii] },
    { artifacts: [...text, { ...second, bytes: Buffer.from(bom) }], secrets: [bom] },
    { artifacts: [...text, { ...second, bytes: Buffer.from("[redacted]") }], secrets: ["[redacted]"] },
  ];
  for (const item of fixtures) {
    const before = item.artifacts.map(entry => Buffer.from(entry.bytes));
    const result = check(item.artifacts, item.secrets);
    assertOutcome(result, stopped);
    const shown = JSON.stringify(result);
    assert.equal(item.secrets.some(secret => shown.includes(secret)), false);
    assert.equal(item.artifacts.some(entry => shown.includes(entry.name)), false);
    assert.deepEqual(item.artifacts.map(entry => entry.bytes), before);
  }
});

test("recognizes every configured credential family and an unclosed private-key header", () => {
  const sample = "aB09";
  const values = [
    ...["ghp", "gho", "ghu", "ghs", "ghr"].map(mark => [mark, sample.repeat(9)].join("_")),
    ["github", "pat", sample.repeat(6).slice(0, 22)].join("_"),
    ...["tp", "tpj", "tps"].map(mark => [mark, "aB09_-".repeat(4).slice(0, 20)].join("_")),
    ...["sk-ant", "sk-proj", "sk", "xai"].map(mark => [mark, "aB09_-".repeat(4).slice(0, 20)].join("-")),
    ["AI", "za", "aB09_-".repeat(6).slice(0, 35)].join(""),
    ["AK", "IA", "AB09".repeat(4)].join(""),
    ...["a", "b", "p", "r", "s"].map(mark => ["xox", mark, "-", "aB09-".repeat(2)].join("")),
    ["-".repeat(5), "BEGIN", " FABRICATED PRIVATE", " KEY", "-".repeat(5)].join(""),
  ];
  for (const value of values) {
    const encoded = `%${value.charCodeAt(0).toString(16)}${value.slice(1)}`;
    for (const form of [value, encoded]) {
      assertOutcome(check([...text, { ...second, bytes: Buffer.from(`prefix${form}\n`) }]), stopped);
      assertOutcome(check([{ ...second, name: `prefix${form}.txt` }]), stopped);
    }
  }
  assertOutcome(check([{ ...second, bytes: Buffer.from("normal identifiers: sk-short, TP test, and KEY documentation\n") }]), clear);
});

test("scans the raw and nested percent-decoded text without rewriting either artifact", () => {
  const key = ["tp", "aBc0".repeat(6)].join("_");
  const twice = key.replace("_", "%255f");
  const input = { name: `candidate-${twice}.txt`, bytes: Buffer.from("plain") };
  assertOutcome(check([input]), stopped);
  assertOutcome(check([{ ...second, bytes: Buffer.from(`50% and ${twice}`) }]), stopped);
  for (const form of [held.replace("-", "%2d"), held.replace("-", "%252d")]) {
    assertOutcome(check([{ ...second, name: `before-${form}.txt` }], [held]), stopped);
    assertOutcome(check([{ ...second, bytes: Buffer.from(`50% and ${form}`) }], [held]), stopped);
  }
  const coveredRaw = "%255f";
  assertOutcome(check([{ ...second, bytes: Buffer.from(`literal ${coveredRaw}`) }], [coveredRaw]), stopped);
  assertOutcome(check([{ ...second, bytes: Buffer.from("occasionally %E9 is unsupported UTF-8") }]), incomplete);
  assertOutcome(check([{ ...second, bytes: Buffer.from("opaque%00control") }]), incomplete);
  const nested = "%" + "25".repeat(11) + "5f";
  assertOutcome(check([{ ...second, bytes: Buffer.from(nested) }]), incomplete);
});

test("holds missing, extra, duplicate or malformed inventory and replaced bytes", () => {
  const artifacts = [...text, second];
  const expected = inventory(artifacts);
  const request = { expected, artifacts, secrets: [held] };
  const sameSize = { ...second, bytes: Buffer.alloc(second.bytes.length, 42) };
  const cases: unknown[] = [
    undefined, null, { ...request, expected: null }, { ...request, artifacts: null },
    { ...request, expected: [], artifacts: [] }, { ...request, artifacts: [text[0]] },
    { ...request, artifacts: [...artifacts, zero] }, { ...request, expected: expected.slice(1) },
    { ...request, expected: [expected[0], expected[0]] }, { ...request, artifacts: [text[0], text[0]] },
    { ...request, expected: [expected[0], expected[0]], artifacts: [text[0], text[0]] },
    { ...request, artifacts: [text[0], { ...second, extra: held }] },
    { ...request, expected: [expected[0], { ...expected[1], extra: held }] },
    { ...request, expected: [expected[0], { ...expected[1], name: "broken\0name" }] },
    { ...request, expected: [expected[0], { ...expected[1], size: second.bytes.length + 1 }] },
    { ...request, expected: [expected[0], { ...expected[1], size: -1 }] },
    { ...request, expected: [expected[0], { ...expected[1], sha256: held }] },
    { ...request, artifacts: [text[0], { ...second, name: "different-name" }] },
    { ...request, artifacts: [text[0], { ...second, name: second.name.toUpperCase() }] },
    { ...request, artifacts: [text[0], { ...second, bytes: "fabricated revision\r\n" }] },
    { ...request, artifacts: [text[0], { ...second, bytes: new Uint16Array([42]) }] },
    { ...request, artifacts: [text[0], { ...second, bytes: Buffer.from("short") }] },
    { ...request, artifacts: [text[0], sameSize] },
    { ...request, expected: new Array(2) }, { ...request, artifacts: new Array(2) },
    { ...request, unexamined: held },
  ];
  for (const value of cases) {
    assertOutcome(checkPushArtifacts(value), incomplete);
  }
  const nfc = { name: "café.txt", bytes: second.bytes };
  assertOutcome(checkPushArtifacts({ expected: inventory([nfc]), artifacts: [{ ...nfc, name: nfc.name.normalize("NFD") }], secrets: [] }), incomplete);
});

test("holds opaque, invalid or oversized bytes and refuses an incomplete held-secret source", () => {
  for (const bytes of [Buffer.of(0xff), Buffer.of(0xc3, 0x28), Buffer.from("binary\0content"), Buffer.from(`\0${held}`), Buffer.of(0x7f), Buffer.alloc(1_048_577, 32)]) {
    assertOutcome(check([{ ...second, bytes }], [held]), incomplete);
  }
  assertOutcome(check([{ ...second, name: "\ud800.txt" }]), incomplete);
  const tooManyEntries = Array.from({ length: 129 }, (_, index) => ({ ...zero, name: `file-${index}.txt` }));
  assertOutcome(check(tooManyEntries), incomplete);
  assertOutcome(check(tooManyEntries.slice(0, 128)), clear);
  const validLimit = Array.from({ length: 4 }, (_, index) => ({ name: `at-limit-${index}.txt`, bytes: Buffer.alloc(1_048_576, 32) }));
  assertOutcome(check(validLimit), clear);
  assertOutcome(check([...validLimit, { ...second, bytes: Buffer.of(32) }]), incomplete);
  assertOutcome(check(text, ["é".repeat(2048)]), clear);
  assertOutcome(check(text, null), incomplete);
  for (const secrets of [undefined, "not-an-array", [""], [false], new Array(1), ["a".repeat(4097)], ["é".repeat(2049)]]) {
    assertOutcome(checkPushArtifacts({ expected: inventory(text), artifacts: text, secrets }), incomplete);
  }
});

test("unstable inputs are held before any accessor can substitute an artifact", () => {
  let reads = 0;
  const untrusted = {
    name: text[0]!.name,
    get bytes() { reads += 1; return text[0]!.bytes; },
  };
  assertOutcome(checkPushArtifacts({ expected: inventory(text), artifacts: [untrusted], secrets: [] }), incomplete);
  const inspected = { expected: inventory(text), artifacts: text, get secrets() { reads += 1; return []; } };
  assertOutcome(checkPushArtifacts(inspected), incomplete);
  const slots: Artifact[] = new Array(1);
  Object.defineProperty(slots, 0, { enumerable: true, get() { reads += 1; return text[0]; } });
  assertOutcome(checkPushArtifacts({ expected: inventory(text), artifacts: slots, secrets: [] }), incomplete);
  const claimed = { ...inventory(text)[0], get sha256() { reads += 1; return held; } };
  assertOutcome(checkPushArtifacts({ expected: [claimed], artifacts: text, secrets: [] }), incomplete);
  const claimedSlots = new Array(1);
  Object.defineProperty(claimedSlots, 0, { enumerable: true, get() { reads += 1; return inventory(text)[0]; } });
  assertOutcome(checkPushArtifacts({ expected: claimedSlots, artifacts: text, secrets: [] }), incomplete);
  const secretSlots = new Array(1);
  Object.defineProperty(secretSlots, 0, { enumerable: true, get() { reads += 1; return held; } });
  assertOutcome(checkPushArtifacts({ expected: inventory(text), artifacts: text, secrets: secretSlots }), incomplete);
  assert.equal(reads, 0);
  const unusable = new Proxy({}, { ownKeys() { throw new Error(held); } });
  assertOutcome(checkPushArtifacts(unusable), incomplete);
});
