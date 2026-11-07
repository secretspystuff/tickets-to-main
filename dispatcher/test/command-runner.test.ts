import assert from "node:assert/strict";
import { test } from "node:test";
import { processRunner } from "../src/command.ts";

const closesInput = [process.execPath, "-e", 'process.stdin.destroy(); process.stdout.write("fixture-done"); setImmediate(() => process.exit(0));'];

test("a command closing unused stdin cannot crash the runner", async () => {
  const result = await processRunner().run(closesInput, { timeoutMs: 30000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "fixture-done");
  assert.equal(result.error, undefined);
});

test("a successful exit cannot conceal nonempty command input that was not delivered", async () => {
  const result = await processRunner().run(closesInput, { timeoutMs: 30000, input: "fabricated-input\n".repeat(131072) });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "fixture-done");
  assert.equal(result.error, "Command input could not be delivered.");
});
