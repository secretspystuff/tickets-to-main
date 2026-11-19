import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("..", import.meta.url);

function files(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...files(path));
    else found.push(path);
  }
  return found;
}

test("the public surface imports no private app code and isolates network access to the two-read client", () => {
  const source = files(fileURLToPath(new URL("src", root))).filter((path) => path.endsWith(".ts"));
  const bin = files(fileURLToPath(new URL("bin", root)));
  const combined = [...source, ...bin];
  const outside: [string, string][] = [];
  for (const path of combined) {
    const text = readFileSync(path, "utf8");
    const isClient = basename(path) === "coordination-client.ts";
    const imports = [...text.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)].map(match => match[1] ?? "");
    for (const specifier of imports.filter(specifier => /src\/lib\/|workers\//.test(posix.normalize(specifier.replaceAll("\\", "/"))))) {
      outside.push([basename(path), specifier]);
    }
    assert.equal(text.includes("secretspystuff"), false, path);
    assert.equal(text.includes("ticketsplease.dev"), isClient, path);
    assert.equal(text.includes(["workers", "data"].join("/")), false, path);
    assert.doesNotMatch(text, /(?:["'](?:node:)?(?:http2?|https|net|tls|dgram|dns|undici|ws)(?:["'/])|\bWebSocket\b)/, path);
    assert.doesNotMatch(text, /\b(?:import|require|createRequire)\s*\(/, path);
    assert.doesNotMatch(text, /["'][^"']*coordination-client(?:\.ts)?["']/, path);
    assert.equal(/\bfetch\b/.test(text), isClient, path);
    if (isClient) assert.deepEqual(imports.sort(), ["../../src/lib/ttm-protocol.ts", "./secret-text.ts", "node:crypto"]);
    assert.equal(text.includes("shell: true"), false, path);
    assert.equal(text.includes("approvalAnswered: true"), false, path);
    assert.equal(text.includes("tp_"), false, path);
  }
  const processUsers = combined.filter((path) => readFileSync(path, "utf8").includes("node:child_process"));
  assert.deepEqual(processUsers.map((path) => basename(path)).sort(), ["command.ts", "custody.ts", "native-transport.ts", "process-identity.ts", "windows-privacy-worker.ts", "windows-privacy.ts"]);
  assert.deepEqual(outside.sort((a, b) => a[0].localeCompare(b[0])), [
    ["check-attempt.ts", "../../src/lib/ttm-protocol.ts"],
    ["coordination-client.ts", "../../src/lib/ttm-protocol.ts"],
    ["coordination.ts", "../../src/lib/ttm-protocol.ts"],
  ]);
});

test("fixtures name the two Codex interfaces and one fabricated key", () => {
  const fixtureDir = fileURLToPath(new URL("fixtures", root));
  const bodies = files(fixtureDir).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.match(bodies, /"interfaceId": "cli"/);
  assert.match(bodies, /"interfaceId": "app-server"/);
  assert.equal(bodies.includes("tp_fixture_key_not_a_real_grant"), true);
  assert.equal(bodies.includes("tp_") , true);
  const otherKeys = bodies.match(/tp_[A-Za-z0-9_-]+/g) ?? [];
  assert.deepEqual([...new Set(otherKeys)], ["tp_fixture_key_not_a_real_grant"]);
});

test("the artifact gate has only local hash and text helpers and no runtime caller", () => {
  const source = files(fileURLToPath(new URL("src", root))).filter(path => path.endsWith(".ts"));
  const gate = fileURLToPath(new URL("src/push-artifact-gate.ts", root));
  const helper = fileURLToPath(new URL("src/secret-text.ts", root));
  for (const [file, allowed] of [[gate, ["./secret-text.ts", "node:crypto"]], [helper, []]] as const) {
    const code = readFileSync(file, "utf8");
    const imports = [...code.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)].map(match => match[1]);
    assert.deepEqual(imports.sort(), allowed);
    assert.doesNotMatch(code, /\b(?:process|console|globalThis|eval|Function|require|createRequire)\b|\bimport\s*\(/, file);
  }
  for (const path of [...source, ...files(fileURLToPath(new URL("bin", root)))]) {
    if (path !== gate) assert.doesNotMatch(readFileSync(path, "utf8"), /\bpush-artifact-gate\b/, path);
  }
});
