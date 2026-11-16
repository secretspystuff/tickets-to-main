import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { runAssignment } from "../src/assignment-boundary.ts";

const read = fs.readFileSync;
let paused = false;
fs.readFileSync = ((...args: Parameters<typeof read>) => {
  const value = read(...args);
  const path = join(process.argv[2]!, "assignment-intents.jsonl");
  const selected = typeof args[0] === "number" ? fs.fstatSync(args[0]).ino === fs.lstatSync(path).ino : String(args[0]) === path;
  if (!paused && selected && value.length === 0) {
    paused = true;
    process.stdout.write("observed-empty\n");
    while (!fs.existsSync(process.argv[6]!)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return value;
}) as typeof read;
syncBuiltinESMExports();
await runAssignment({
  stateDir: process.argv[2]!, raw: process.argv[3]!, secrets: [], now: () => 1000,
  adapter: { kind: "fabricated-harness", readCurrent: async () => JSON.parse(process.argv[4]!),
    execute: async () => { fs.appendFileSync(process.argv[5]!, "effect\n"); process.exit(73); }, reconcile: async () => null },
});
