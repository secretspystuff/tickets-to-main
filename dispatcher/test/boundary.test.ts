import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
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

test("the public surface imports no private app code and opens no network stack", () => {
  const source = files(fileURLToPath(new URL("src", root))).filter((path) => path.endsWith(".ts"));
  const bin = files(fileURLToPath(new URL("bin", root)));
  const combined = [...source, ...bin];
  for (const path of combined) {
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes("secretspystuff"), false, path);
    assert.equal(text.includes("ticketsplease.dev"), false, path);
    assert.equal(text.includes("workers/data"), false, path);
    assert.equal(text.includes("node:http"), false, path);
    assert.equal(text.includes("node:https"), false, path);
    assert.equal(text.includes("node:net"), false, path);
    assert.equal(text.includes("fetch("), false, path);
    assert.equal(text.includes("shell: true"), false, path);
    assert.equal(text.includes("approvalAnswered: true"), false, path);
    assert.equal(text.includes("tp_"), false, path);
  }
  const processUsers = combined.filter((path) => readFileSync(path, "utf8").includes("node:child_process"));
  assert.deepEqual(processUsers.map((path) => basename(path)).sort(), ["command.ts", "custody.ts", "native-transport.ts"]);
  const outside = combined.flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "").filter((spec) => /src\/lib\/|workers\//.test(spec));
  });
  assert.deepEqual(outside, ["../../src/lib/ttm-protocol.ts"]);
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
