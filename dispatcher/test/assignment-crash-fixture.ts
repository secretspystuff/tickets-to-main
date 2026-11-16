import { runAssignment } from "../src/assignment-boundary.ts";
import { appendFileSync } from "node:fs";
let reads = 0;
await runAssignment({
  stateDir: process.argv[2]!, raw: process.argv[3]!, secrets: [], now: () => 1000,
  adapter: {
    kind: "fabricated-harness", readCurrent: async () => {
      if (process.argv[5] && reads++ === 0) {
        process.stdout.write("ready\n");
        await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
      }
      return JSON.parse(process.argv[4]!);
    },
    execute: async () => { if (process.argv[5]) appendFileSync(process.argv[5], "effect\n"); process.exit(73); }, reconcile: async () => null,
  },
});
