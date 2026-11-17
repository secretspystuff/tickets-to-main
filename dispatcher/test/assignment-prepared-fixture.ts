import { appendFileSync } from "node:fs";
import { runAssignment } from "../src/assignment-boundary.ts";

let reads = 0;
const request = JSON.parse(process.argv[3]!);
await runAssignment({
  stateDir: process.argv[2]!, raw: process.argv[3]!, secrets: [], now: () => 1000,
  adapter: {
    kind: "fabricated-harness",
    readCurrent: async () => {
      if (++reads === 2) {
        process.stdout.write("prepared\n");
        const command = await new Promise<Buffer>((resolve) => process.stdin.once("data", resolve));
        if (command.toString().trim() === "crash") process.exit(74);
      }
      return JSON.parse(process.argv[4]!);
    },
    execute: async () => {
      appendFileSync(process.argv[5]!, "effect\n");
      return { id: request.id, sequence: request.sequence, result: "completed", writersContained: true };
    },
    reconcile: async () => null,
  },
});
