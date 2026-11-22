import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as installer from "../src/install.ts";
import * as privateJournal from "../src/private-journal.ts";
import { WINDOWS_RELEASE_JOURNAL, type withPrivateJournal } from "../src/private-journal.ts";
import { parseWindowsPackageFullName } from "../src/release-manifest.ts";
import { observeStateLease } from "../src/state-lease.ts";
import * as disposition from "../src/windows-release-disposition.ts";
import { removeDir, tempDir } from "./helpers.ts";

const fullName = "Fabricated.NativeRelease_1.0.4.0_x64__0123456789abc";
const activityId = "{12345678-0000-0000-0000-000000000001}";
const attempt = {
  release: { version: "0.2.0", manifestDigest: "a".repeat(64), sourceCommit: "b".repeat(40) },
  archiveSha256: "c".repeat(64),
  appxDigest: Buffer.alloc(32, 17).toString("base64"),
  packageFullName: fullName,
  leaseEpoch: "0",
  leaseGeneration: "d".repeat(64),
};

const intent = (value: typeof attempt) => JSON.stringify({ phase: "intent", attempt: value }) + "\n";
const registered = (value: typeof attempt) => intent(value) + JSON.stringify({ phase: "registered", attempt: value, activityId }) + "\n";

test("Windows submission exposes only the verified entry and passive journal access", () => {
  const genericCanWriteWindows: typeof WINDOWS_RELEASE_JOURNAL extends Parameters<typeof withPrivateJournal>[1] ? true : false = false;
  assert.equal(genericCanWriteWindows, false);
  assert.deepEqual(Object.keys(privateJournal).sort(), [
    "WINDOWS_RELEASE_JOURNAL", "inspectPrivateJournal", "readExistingPrivateJournalUnderLease", "withPrivateJournal",
  ]);
  assert.deepEqual(Object.keys(disposition).sort(), [
    "assertPortableSelectionMayChange", "classifyWindowsStageReceipt", "matchingWindowsDisposition",
    "readWindowsReleaseDisposition", "readWindowsReleaseHistory", "validWindowsReleaseAttempt",
  ]);
  assert.equal(Object.hasOwn(installer, "recordNewWindowsSubmission"), false);
  assert.equal(typeof installer.submitWindowsRelease, "function");
});

test("passive Windows disposition inspection leaves an unused state unclaimed", (t) => {
  const stateDir = tempDir();
  t.after(() => removeDir(stateDir));
  assert.deepEqual(installer.readWindowsReleaseDisposition(stateDir), { state: "none" });
  assert.equal(observeStateLease(stateDir, "release").state, "none");
  assert.equal(observeStateLease(stateDir, "ledger").state, "none");
  assert.equal(existsSync(join(stateDir, "windows-release-submission")), false);
});

test("native history recognizes the canonical supported identity in intent and registered evidence", () => {
  assert.deepEqual(parseWindowsPackageFullName(fullName), {
    packageName: "Fabricated.NativeRelease", version: "1.0.4.0", architecture: "x64", publisherId: "0123456789abc",
  });
  assert.deepEqual(disposition.readWindowsReleaseHistory(intent(attempt)), { state: "held", attempt });
  assert.deepEqual(disposition.readWindowsReleaseHistory(registered(attempt)), { state: "registered", attempt, activityId });
});

for (const [label, packageFullName] of [
  ["unstructured name", "Fabricated.NativeRelease"],
  ["noncanonical version", fullName.replace("1.0.4.0", "1.0.04.0")],
  ["version outside the Windows range", fullName.replace("1.0.4.0", "1.0.65536.0")],
  ["unsupported native target", fullName.replace("_x64_", "_arm64_")],
  ["resource package identifier", fullName.replace("__", "_resource_")],
  ["invalid publisher identity", fullName.replace("0123456789abc", "0123456789abu")],
] as const) {
  test("native history refuses an ordinary " + label + " in saved disposition", () => {
    const candidate = { ...attempt, packageFullName };
    assert.throws(() => disposition.readWindowsReleaseHistory(intent(candidate)), /release operation could not finish safely/i);
    assert.throws(() => disposition.readWindowsReleaseHistory(registered(candidate)), /release operation could not finish safely/i);
  });
}
