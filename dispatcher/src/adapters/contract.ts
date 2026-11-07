/** Capabilities the common harness can score. Unknown stays unknown. */
export const CAPABILITIES = [
  "assignment",
  "freshContext",
  "resume",
  "streamResult",
  "cancel",
  "modelSelection",
  "effortSelection",
  "nativeApproval",
  "usageObservation",
  "helperCompletion",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type CapabilityState = "supported" | "unavailable" | "unknown";

export type VendorId = "stub" | "codex" | "claude-code" | "cursor" | "grok-build" | "grok-bot";

export type QualificationLevel = "unknown" | "documented" | "harness-passed" | "runtime-qualified" | "unavailable";

export type InterfaceClaim = {
  vendor: VendorId;
  interfaceId: string;
  /** Empty. A non-empty list means this build treats two interfaces as the same, which it must not. */
  interchangeableWith: readonly string[];
  qualification: QualificationLevel;
  capabilities: Record<Capability, CapabilityState>;
  personFacing: boolean;
  experimental: true | "unknown";
  limit: string;
};

export type AssignmentRequest = {
  assignmentId: string;
  prompt: string;
  workspace: string;
  model: string | null;
  effort: string | null;
};

export type AssignmentObservation = {
  vendor: VendorId;
  interfaceId: string;
  spawned: boolean;
  argv: readonly string[];
  stdin: string;
  observed: Partial<Record<Capability, Exclude<CapabilityState, "unknown">>>;
  reason: string | null;
  approvalAnswered: boolean;
};

export function unknownCapabilities(): Record<Capability, CapabilityState> {
  return {
    assignment: "unknown",
    freshContext: "unknown",
    resume: "unknown",
    streamResult: "unknown",
    cancel: "unknown",
    modelSelection: "unknown",
    effortSelection: "unknown",
    nativeApproval: "unknown",
    usageObservation: "unknown",
    helperCompletion: "unknown",
  };
}

export type ConformanceFailure = { code: string; detail: string };

/** A claim that says runtime-qualified, or that two interfaces stand in for each other, fails. */
export function checkClaim(claim: InterfaceClaim): ConformanceFailure[] {
  const failures: ConformanceFailure[] = [];
  if (claim.interfaceId.trim() === "") failures.push({ code: "interface", detail: "The interface id is empty." });
  if (claim.interchangeableWith.length > 0) {
    failures.push({ code: "interchangeable", detail: "Interfaces are separate. interchangeableWith must be empty." });
  }
  if (claim.vendor === "stub" && claim.personFacing) {
    failures.push({ code: "stub", detail: "The stub adapter is for tests and is not offered." });
  }
  if (claim.qualification === "runtime-qualified") {
    failures.push({ code: "runtime", detail: "This build cannot mark an interface runtime-qualified." });
  }
  for (const capability of CAPABILITIES) {
    const state = claim.capabilities[capability];
    if (state !== "supported" && state !== "unavailable" && state !== "unknown") {
      failures.push({ code: "capability", detail: `${capability} is missing.` });
    }
  }
  if (claim.qualification !== "harness-passed") {
    for (const capability of CAPABILITIES) {
      if (claim.capabilities[capability] === "supported") {
        failures.push({ code: "unearned", detail: `${capability} is supported without harness evidence.` });
      }
    }
  }
  return failures;
}

/**
 * Evidence qualifies only the interface that produced it.
 * Codex cli evidence throws when applied to app-server, and the reverse.
 */
export function applyHarnessEvidence(claim: InterfaceClaim, evidence: AssignmentObservation): InterfaceClaim {
  if (evidence.vendor !== claim.vendor || evidence.interfaceId !== claim.interfaceId) {
    throw new Error(`Evidence for ${evidence.interfaceId} cannot qualify ${claim.interfaceId}.`);
  }
  const failures = checkClaim({ ...claim, qualification: "documented", capabilities: unknownCapabilities() });
  if (failures.some((failure) => failure.code === "interchangeable" || failure.code === "stub" || failure.code === "interface")) {
    throw new Error(failures[0]?.detail ?? "The claim failed.");
  }
  const capabilities = unknownCapabilities();
  for (const capability of CAPABILITIES) {
    const observed = evidence.observed[capability];
    if (observed) capabilities[capability] = observed;
  }
  return {
    ...claim,
    qualification: "harness-passed",
    capabilities,
    personFacing: false,
    interchangeableWith: [],
  };
}

export function claimCovers(
  required: { vendor: VendorId; interfaceId: string; capability: Capability },
  evidence: InterfaceClaim,
): boolean {
  if (evidence.vendor !== required.vendor || evidence.interfaceId !== required.interfaceId) return false;
  if (evidence.qualification !== "harness-passed") return false;
  return evidence.capabilities[required.capability] === "supported";
}
