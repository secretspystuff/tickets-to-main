import type { AssignmentObservation } from "./contract.ts";

export type NativeOutcome = "starting" | "running" | "completed" | "failed" | "interrupted" | "held" | "disconnected" | "protocol-error" | "refused";
export type NativeObservation = AssignmentObservation & {
  outcome: NativeOutcome;
  writerState: "unknown";
  interruptRequest: "not-requested" | "pending" | "acknowledged" | "rejected" | "unavailable" | "unconfirmed";
  helpers: "unknown" | "active-observed" | "terminal-observed";
  resultText: string | null;
  threadId: string | null;
  turnId: string | null;
  requestedModel: string | null;
  observedModel: string | null;
  requestedEffort: string | null;
};

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function opaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
}

export function hasHeldSecret(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && value.includes(secret));
}

function redactPrivateKeys(value: string): string {
  return value.replace(/-*\bBEGIN[^\r\n]*?PRIVATE KEY-*[^]*?(?:-*\bEND[^\r\n]*?PRIVATE KEY-*|$)/g, "[redacted]");
}

export function safeNativeText(value: string, secrets: readonly string[], prompt?: string): string {
  // Replacing a held header fragment first would hide the start of a private-key block.
  let text = redactPrivateKeys(value);
  if (prompt) text = text.split(redactPrivateKeys(prompt)).join("[assignment input omitted]");
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]");
  }
  return text.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|(?:tp|tpj|tps)_[A-Za-z0-9_-]{20,}|(?:sk-ant-|sk-proj-|sk-|xai-)[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/g, "[redacted]");
}

export function nativeObservation(interfaceId: "cli" | "app-server"): NativeObservation {
  return {
    vendor: "codex", interfaceId, spawned: false, argv: [], stdin: "", observed: {}, reason: null,
    approvalAnswered: false, outcome: "starting", writerState: "unknown", interruptRequest: "not-requested", helpers: "unknown",
    resultText: null, threadId: null, turnId: null, requestedModel: null, observedModel: null, requestedEffort: null,
  };
}

export function copyObservation(value: NativeObservation): NativeObservation {
  return { ...value, argv: [...value.argv], observed: { ...value.observed } };
}
