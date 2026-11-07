import { checkClaim, unknownCapabilities, type InterfaceClaim } from "./contract.ts";

/** In-memory adapter for the harness. It is never offered to a person. */
export function stubClaim(): InterfaceClaim {
  return {
    vendor: "stub",
    interfaceId: "script",
    interchangeableWith: [],
    qualification: "unknown",
    capabilities: unknownCapabilities(),
    personFacing: false,
    experimental: "unknown",
    limit: "The stub adapter is for tests and is not offered.",
  };
}

export function assertStubHidden(): void {
  const failures = checkClaim({ ...stubClaim(), personFacing: true });
  if (!failures.some((failure) => failure.code === "stub")) {
    throw new Error("The stub adapter was offered.");
  }
}

/** Discovery records that a workspace exists and does not read files inside it. */
export function discoverStub(workspace: string): string {
  return JSON.stringify({ vendor: "stub", interfaceId: "script", workspaceListed: workspace.length > 0 });
}
