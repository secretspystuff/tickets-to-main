import type { CodexDiscovery } from "./adapters/codex.ts";
import type { Ledger, ToolRecord } from "./ledger.ts";

/** Store a discovery. Harness passes and runtime qualification are not local facts. */
export function rememberCodex(ledger: Ledger, discovery: CodexDiscovery): void {
  const { claim, version } = discovery;
  if (claim.interfaceId !== "cli" && claim.interfaceId !== "app-server") {
    throw new Error("Only a Codex cli or app-server discovery can be stored.");
  }
  if (claim.qualification !== "documented" && claim.qualification !== "unavailable" && claim.qualification !== "unknown") {
    throw new Error("Discovery cannot store a qualification this build has not earned.");
  }
  const record: ToolRecord = {
    vendor: "codex",
    interfaceId: claim.interfaceId,
    qualification: claim.qualification,
    experimental: claim.experimental,
    version,
    limit: claim.limit,
  };
  ledger.tools = [...ledger.tools.filter((tool) => tool.interfaceId !== claim.interfaceId), record];
}
