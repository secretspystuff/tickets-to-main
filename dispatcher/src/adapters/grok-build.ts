import { win32 } from "node:path";
import type { NativeTransport } from "../native-transport.ts";
import { absoluteWindowsPath, startAcpAssignment, type AcpAssignmentHandle } from "./acp-session.ts";
import { unknownCapabilities, type AssignmentRequest, type InterfaceClaim } from "./contract.ts";

export const GROK_BUILD_ACP_VERSION = "1.0.70";
export type GrokBuildAcpLaunch = { executable: string; version: string };

export function documentedGrokBuildAcpClaim(): InterfaceClaim {
  return {
    vendor: "grok-build", interfaceId: "acp", interchangeableWith: [], qualification: "documented",
    capabilities: unknownCapabilities(), personFacing: false, experimental: "unknown",
    limit: "Grok Build ACP has fabricated protocol coverage only. Native authentication, input recovery, helpers/background work, custody and Windows/macOS qualification remain unproven; Grok Bot and other CLI modes are separate.",
  };
}

export function startGrokBuildAcpAssignment(
  request: AssignmentRequest, transport: NativeTransport, parentEnv: NodeJS.ProcessEnv, secrets: readonly string[], launch: GrokBuildAcpLaunch,
): AcpAssignmentHandle {
  const directory = win32.dirname(launch.executable);
  const valid = launch.version === GROK_BUILD_ACP_VERSION && absoluteWindowsPath(launch.executable)
    && win32.basename(launch.executable).toLowerCase() === "grok.exe"
    && win32.basename(directory).toLowerCase() === "bin"
    && win32.basename(win32.dirname(directory)).toLowerCase() === ".grok";
  return startAcpAssignment(request, transport, parentEnv, secrets, {
    vendor: "grok-build", argv: [launch.executable, "agent", "stdio"], valid,
    authHandoff: "Grok Build reports authentication required. Use its supported native sign-in; this adapter did not authenticate or substitute an API key.",
  });
}
