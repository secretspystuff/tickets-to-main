import { win32 } from "node:path";
import type { NativeTransport } from "../native-transport.ts";
import { absoluteWindowsPath, startAcpAssignment, type AcpAssignmentHandle } from "./acp-session.ts";
import { unknownCapabilities, type AssignmentRequest, type InterfaceClaim } from "./contract.ts";

export const CURSOR_ACP_VERSION = "2026.10.22-27dcf5f";
export type CursorAcpLaunch = { executable: string; entrypoint: string; version: string };

export function documentedCursorAcpClaim(): InterfaceClaim {
  return {
    vendor: "cursor", interfaceId: "acp", interchangeableWith: [], qualification: "documented",
    capabilities: unknownCapabilities(), personFacing: false, experimental: "unknown",
    limit: "Cursor ACP has fabricated protocol coverage only. Native authentication, input recovery, lifecycle, custody and Windows/macOS qualification remain unproven; CLI print and editor paths are separate.",
  };
}

export function startCursorAcpAssignment(
  request: AssignmentRequest, transport: NativeTransport, parentEnv: NodeJS.ProcessEnv, secrets: readonly string[], launch: CursorAcpLaunch,
): AcpAssignmentHandle {
  const directory = win32.dirname(launch.executable);
  const valid = launch.version === CURSOR_ACP_VERSION && absoluteWindowsPath(launch.executable) && absoluteWindowsPath(launch.entrypoint)
    && win32.basename(launch.executable).toLowerCase() === "node.exe"
    && win32.basename(directory) === CURSOR_ACP_VERSION
    && win32.basename(win32.dirname(directory)).toLowerCase() === "versions"
    && win32.basename(win32.dirname(win32.dirname(directory))).toLowerCase() === "cursor-agent"
    && win32.normalize(launch.entrypoint).toLowerCase() === win32.join(directory, "index.js").toLowerCase();
  return startAcpAssignment(request, transport, parentEnv, secrets, {
    vendor: "cursor", argv: [launch.executable, launch.entrypoint, "acp"], valid,
    authHandoff: "Cursor reports authentication required. Use its supported native sign-in; this adapter did not authenticate or change accounts.",
  });
}
