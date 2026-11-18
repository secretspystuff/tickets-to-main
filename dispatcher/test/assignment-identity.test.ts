import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reserveAssignment, startAssignment, journalDigest, type Intent } from "../src/assignment-journal.ts";
import { currentProcessOwner, processOwnerAlive } from "../src/process-identity.ts";

test("one physical workspace holds competing Windows spellings and scopes after intent and start", (t) => {
  const root = mkdtempSync(join(tmpdir(), "assignment-identity-")); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const intent: Intent = { version: 3, kind: "intent", id: "1".repeat(32), sequence: 1,
    requestDigest: "2".repeat(64), bindingDigest: "3".repeat(64), scopeDigest: "4".repeat(64),
    workspaceDigest: journalDigest("disk-id:directory-id"), at: 1000, ...currentProcessOwner() };
  const legacy = ["C:\\Work", "c:\\work", "\\\\?\\C:\\WORK", "C:\\WORK~1"].map(journalDigest);
  const pending = reserveAssignment(root, intent, legacy[0]!, (owner) => processOwnerAlive(owner));
  assert.equal(pending.state, "new");
  for (const started of [false, true]) {
    if (started) startAssignment(root, intent, 1000);
    const before = readFileSync(join(root, "assignment-intents.jsonl"));
    for (const path of legacy) {
      assert.equal(reserveAssignment(root, intent, path, (owner) => processOwnerAlive(owner)).state, "pending");
      assert.throws(() => reserveAssignment(root, { ...intent, id: "a".repeat(32), sequence: 2, scopeDigest: "b".repeat(64) }, path, (owner) => processOwnerAlive(owner)));
    }
    assert.deepEqual(readFileSync(join(root, "assignment-intents.jsonl")), before);
  }
});
