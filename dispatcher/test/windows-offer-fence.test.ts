import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { updateLedger } from "../src/ledger.ts";
import { stateLeaseStatus, withStateLease } from "../src/state-lease.ts";
import { readWindowsOfferFence } from "../src/windows-offer-fence.ts";
import { removeDir, tempDir } from "./helpers.ts";
import { snapshot } from "./release-test-fixtures.ts";

const dependencies = {
  observeWindowsOffer: () => assert.fail("Fence inspection cannot invoke the observer."),
  stageWindowsOffer: () => assert.fail("Fence inspection cannot invoke staging."),
};

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

test("an absent first-use state has the exact nearest existing directory boundary", (t) => {
  const firstParent = ownedState(t);
  const secondParent = ownedState(t);
  const firstStart = snapshot(firstParent);
  const secondStart = snapshot(secondParent);
  const firstPath = join(firstParent, "missing", "state");
  const secondPath = join(secondParent, "missing", "state");
  const first = readWindowsOfferFence(firstPath, dependencies);
  const second = readWindowsOfferFence(secondPath, dependencies);

  assert.equal(first.boundary.containingDirectory.path, realpathSync.native(firstParent));
  assert.equal(second.boundary.containingDirectory.path, realpathSync.native(secondParent));
  assert.notEqual(first.boundary.containingDirectory.identity, second.boundary.containingDirectory.identity);
  assert.equal(first.boundary.ledgerPresent, false);
  assert.equal(first.boundary.releaseDirectory, null);
  assert.deepEqual(first, readWindowsOfferFence(firstPath, dependencies));
  assert.equal(existsSync(firstPath), false);
  assert.equal(existsSync(secondPath), false);
  assert.deepEqual(snapshot(firstParent), firstStart);
  assert.deepEqual(snapshot(secondParent), secondStart);
});

test("ordinary released lease observations preserve the exact epoch and owner generation", (t) => {
  const path = ownedState(t);
  const empty = readWindowsOfferFence(path, dependencies);
  assert.deepEqual(empty.leases.release, { epoch: -1n, state: "none" });
  withStateLease(path, "release", () => {});
  const first = readWindowsOfferFence(path, dependencies);
  withStateLease(path, "release", () => {});
  const second = readWindowsOfferFence(path, dependencies);

  assert.equal(stateLeaseStatus(path, "release"), "released");
  assert.equal(first.leases.release.state, "released");
  assert.equal(second.leases.release.state, "released");
  assert.equal(first.leases.release.epoch, 0n);
  assert.equal(second.leases.release.epoch, 1n);
  assert.match(first.leases.release.generation!, /^[a-f0-9]{64}$/);
  assert.match(second.leases.release.generation!, /^[a-f0-9]{64}$/);
  assert.notEqual(first.leases.release.generation, second.leases.release.generation);
  assert.deepEqual(first.leases.ledger, second.leases.ledger);
  assert.deepEqual(first.install, second.install);
  assert.notDeepEqual(first, second);
});

test("ordinary ownership snapshots retain a new claim generation with the same installation", (t) => {
  const path = ownedState(t);
  const firstGeneration = "10000000-0000-0000-0000-000000000001";
  const secondGeneration = "10000000-0000-0000-0000-000000000002";
  const firstIntent = "1".repeat(32);
  const secondIntent = "2".repeat(32);
  updateLedger(path, [], (ledger) => {
    ledger.workspace = { path, writerPid: process.pid, qualified: false, claimGeneration: firstGeneration };
    ledger.boundWorkspaceIntents = [firstIntent];
  });
  const first = readWindowsOfferFence(path, dependencies);
  updateLedger(path, [], (ledger) => {
    ledger.workspace = { path, writerPid: process.pid, qualified: false, claimGeneration: secondGeneration };
    ledger.boundWorkspaceIntents = [secondIntent];
  });
  const second = readWindowsOfferFence(path, dependencies);

  assert.deepEqual(first.install, second.install);
  assert.deepEqual(first.leases.release, second.leases.release);
  assert.equal(first.leases.ledger.state, "released");
  assert.equal(second.leases.ledger.state, "released");
  assert.equal(second.leases.ledger.epoch, first.leases.ledger.epoch + 1n);
  assert.equal(first.workspace?.claimGeneration, firstGeneration);
  assert.equal(second.workspace?.claimGeneration, secondGeneration);
  assert.deepEqual(first.boundWorkspaceIntents, [firstIntent]);
  assert.deepEqual(second.boundWorkspaceIntents, [secondIntent]);
  assert.notDeepEqual(first, second);
});

test("the fence binds the availability and identity of each configured dependency", (t) => {
  const path = ownedState(t);
  const before = snapshot(path);
  const configured = readWindowsOfferFence(path, dependencies);
  const otherObserver = readWindowsOfferFence(path, { ...dependencies, observeWindowsOffer: () => assert.fail() });
  const otherStage = readWindowsOfferFence(path, { ...dependencies, stageWindowsOffer: () => assert.fail() });

  assert.equal(configured.observeWindowsOffer, dependencies.observeWindowsOffer);
  assert.equal(configured.stageWindowsOffer, dependencies.stageWindowsOffer);
  assert.notDeepEqual(configured, otherObserver);
  assert.notDeepEqual(configured, otherStage);
  assert.throws(() => readWindowsOfferFence(path, { stageWindowsOffer: dependencies.stageWindowsOffer }),
    /release operation could not finish safely/i);
  assert.throws(() => readWindowsOfferFence(path, { observeWindowsOffer: dependencies.observeWindowsOffer }),
    /release operation could not finish safely/i);
  assert.deepEqual(snapshot(path), before);
});

test("an ordinary live state lease keeps a read-only fence unavailable", (t) => {
  const path = ownedState(t);
  for (const namespace of ["release", "ledger"] as const) {
    withStateLease(path, namespace, () => {
      assert.throws(() => readWindowsOfferFence(path, dependencies), /release operation could not finish safely/i);
    });
    assert.equal(readWindowsOfferFence(path, dependencies).leases[namespace].state, "released");
  }
});
