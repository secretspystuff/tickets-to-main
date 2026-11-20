import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { runAssignment, type AssignmentRequest, type AssignmentTerminal } from "../src/assignment-boundary.ts";
import { install } from "../src/install.ts";
import { claimWorkspace, prepareWorkspace, processAlive } from "../src/workspace.ts";

type Observation = { group: string; active: number; terminal: AssignmentTerminal };
type Recovery = { next: boolean; authorized: boolean; observation: Observation | null };

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const [action, requested, controller, group] = process.argv.slice(2);
const id = (value: number) => value.toString(16).padStart(32, "0");

function fixturePath(): string {
  const parent = Number(controller);
  if (process.platform !== "win32" || process.argv.length !== 6 || !requested
    || !Number.isSafeInteger(parent) || parent !== process.ppid || parent <= 0
    || (group !== "loss-origin" && group !== "control-origin")) throw new Error("Unavailable.");
  const fixture = realpathSync(requested);
  if (dirname(fixture) !== root || !basename(fixture).startsWith("ttm-job-drain-controller-loss-")
    || realpathSync(process.cwd()) !== fixture) throw new Error("Outside fixture.");
  return fixture;
}

function assignment(sequence: number): AssignmentRequest {
  return {
    version: 1, id: id(sequence), sequence, operation: "native.assign", input: "Fabricated writer custody",
    binding: { board: id(3), repo: id(4), activation: id(5), connection: id(6), job: id(7),
      claim: id(8), requirements: id(9), candidate: id(10), policy: id(11), fence: 1 },
  };
}

async function run(): Promise<void> {
  const fixture = fixturePath();
  const stateDir = join(fixture, "state"), workspace = join(fixture, "workspace"), control = join(fixture, "control");
  const starting = action === "controller";
  if (!starting && action !== "recover") throw new Error("Unknown fixture action.");
  const recovery: Recovery = starting ? { next: false, authorized: true, observation: null }
    : JSON.parse(readFileSync(0, "utf8")) as Recovery;
  const request = assignment(recovery.next ? 2 : 1);
  let effects = 0;
  let reconciliations = 0;
  let readDigest: string | null = null;
  if (starting) {
    install({ stateDir, platform: process.platform, arch: process.arch, nowIso: new Date(0).toISOString() });
    prepareWorkspace(stateDir, workspace, processAlive);
    claimWorkspace(stateDir, process.pid, processAlive);
  }

  const result = await runAssignment({
    stateDir, raw: JSON.stringify(request), secrets: [], now: () => 1000,
    adapter: {
      kind: "fabricated-harness",
      readCurrent: async () => ({
        binding: request.binding, nextSequence: request.sequence, authorized: recovery.authorized,
        seat: "member", confirmedWorkspace: workspace, writersContained: true,
      }),
      execute: async () => {
        effects++;
        if (!starting) throw new Error("Recovery attempted execution.");
        writeFileSync(join(control, "controller-started"), "started", { flag: "wx" });
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !existsSync(join(control, "abort"))) {
          if (existsSync(join(control, "controller-exit"))) process.exit(73);
          await pause(15);
        }
        throw new Error("Fixture barrier did not open.");
      },
      reconcile: async ({ id: observedId, sequence, requestDigest }) => {
        reconciliations++;
        if (observedId !== request.id || sequence !== request.sequence) throw new Error("Wrong recovery scope.");
        readDigest = requestDigest;
        // This receipt belongs to the fabricated observer, outside the workspace ledger.
        const observed = recovery.observation;
        return observed && observed.group === group && observed.active === 0 ? observed.terminal : null;
      },
    },
  });
  if (starting) throw new Error("The controller returned a terminal result.");
  process.stdout.write(JSON.stringify({ result, effects, reconciliations, readDigest }));
}

try { await run(); }
catch { process.exitCode = 1; }
