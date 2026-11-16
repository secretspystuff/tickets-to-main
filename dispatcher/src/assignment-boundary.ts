export type AssignmentBinding = {
  board: string; repo: string; activation: string; connection: string; job: string;
  claim: string; requirements: string; candidate: string; policy: string; fence: number;
};
export type AssignmentRequest = {
  version: 1; id: string; sequence: number; operation: "native.assign"; input: string; binding: AssignmentBinding;
};
export type CurrentAssignment = {
  binding: AssignmentBinding; nextSequence: number; authorized: boolean; seat: "owner" | "full" | "member" | "viewer";
  confirmedWorkspace: string; writersContained: boolean;
};
export type AssignmentTerminal = { id: string; sequence: number; result: "completed" | "failed"; writersContained: true };
export type AssignmentAdapter = {
  kind: "fabricated-harness";
  readCurrent(): Promise<CurrentAssignment>;
  execute(input: { id: string; sequence: number; input: string; workspace: string }): Promise<AssignmentTerminal>;
  reconcile(input: { id: string; sequence: number; requestDigest: string }): Promise<AssignmentTerminal | null>;
};
export type AssignmentInput = { stateDir: string; raw: string; secrets: readonly string[]; now(): number; adapter: AssignmentAdapter };
export type AssignmentResult = { state: "completed" | "failed" | "held" | "refused"; qualification: "unqualified-harness"; publishable: false };

export async function runAssignment(_input: AssignmentInput): Promise<AssignmentResult> {
  return { state: "held", qualification: "unqualified-harness", publishable: false };
}
