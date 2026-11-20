import children, { type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [file, role, requested, parent] = process.argv.slice(1);
const controller = fileURLToPath(new URL("./windows-owned-handoff.fixture.ts", import.meta.url));
const repo = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
if (process.platform !== "win32" || process.version !== "v24.18.0" || file !== controller
  || role !== "controller" || Number(parent) !== process.ppid || !requested) throw new Error("Outside handoff probe.");
const root = realpathSync(requested);
if (dirname(root) !== repo || !basename(root).startsWith("ttm-job-drain-controller-loss-owned-")
  || realpathSync(process.cwd()) !== root) throw new Error("Outside handoff probe.");

const control = join(root, "control"), state = join(root, "state");
const spawn = children.spawn;
let launches = 0;
function record(name: string, value: unknown) {
  const target = join(control, name), temporary = target + ".tmp";
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx" });
  renameSync(temporary, target);
}

function assignmentState() {
  const rows = readFileSync(join(state, "assignment-intents.jsonl"), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const ledger = JSON.parse(readFileSync(join(state, "ledger.json"), "utf8"));
  return { rows, workspace: ledger.workspace, bindings: ledger.boundWorkspaceIntents };
}

children.spawn = ((command: string, ...args: unknown[]) => {
  const ordinal = ++launches;
  const directory = dirname(command);
  const broker = basename(command) === "launcher.exe" && basename(directory).startsWith("ttm-owned-launcher-")
    && dirname(directory) === join(root, "tmp");
  record(`native-launch-${ordinal}`, { broker });
  const child: ChildProcess = Reflect.apply(spawn, children, [command, ...args]);
  if (!broker || !child.stdin || !child.stdout) return child;
  record(`native-broker-${ordinal}`, { pid: child.pid });
  let unprocessed = "";
  child.stdout.on("data", (chunk: string | Buffer) => {
    const lines = (unprocessed + chunk.toString()).split("\n");
    unprocessed = lines.pop()!;
    for (const line of lines) {
      if (line === "verified" || line === "verified\r") record(`native-verified-${ordinal}`, true);
    }
  });
  const stdin = child.stdin;
  const write = stdin.write;
  let writes = 0;
  stdin.write = ((chunk: string | Buffer, ...options: unknown[]) => {
    const command = typeof chunk === "string" ? chunk : chunk.subarray(0, 9).toString("ascii");
    if (command === "activate\n") {
      record(`native-resume-${ordinal}`, { broker: child.pid,
        permitted: existsSync(join(control, "allow-owned-start")), ...assignmentState() });
    }
    if (command.startsWith("input\t")) {
      record(`native-input-${++writes}`, { broker: child.pid,
        permitted: existsSync(join(control, "allow-owned-input")), ...assignmentState() });
    }
    return Reflect.apply(write, stdin, [chunk, ...options]);
  }) as typeof stdin.write;
  return child;
}) as typeof spawn;
syncBuiltinESMExports();
record("native-probe-open", true);
