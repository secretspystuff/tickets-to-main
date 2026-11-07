import { osLabel, osWords } from "./platform.ts";
import { emptyLedger, loadLedger, saveLedger, type Ledger } from "./ledger.ts";
import { PACKAGE_VERSION } from "./version.ts";

export type InstallInput = {
  stateDir: string;
  platform: NodeJS.Platform;
  arch: string;
  nowIso: string;
};

export type InstallResult = {
  ledger: Ledger;
  lines: string[];
};

export function install(input: InstallInput): InstallResult {
  const loaded = loadLedger(input.stateDir);
  if (!loaded.ok && loaded.reason !== "missing") {
    throw new Error(loaded.reason === "unsafe"
      ? "The state directory is not private. Nothing was saved."
      : "The local record could not be read. Nothing was replaced.");
  }
  const ledger = loaded.ok ? loaded.ledger : emptyLedger();
  const platform = osLabel(input.platform);
  ledger.install = {
    packageVersion: PACKAGE_VERSION,
    platform,
    arch: input.arch,
    installedAt: ledger.install?.installedAt ?? input.nowIso,
    startup: "not-registered",
    signedInstallers: "not-qualified",
  };
  saveLedger(input.stateDir, ledger, []);
  return {
    ledger,
    lines: [
      `Installed ${PACKAGE_VERSION}.`,
      `Operating system: ${osWords(platform)}`,
      "Signed installers: unqualified.",
      "Startup: unregistered.",
    ],
  };
}
