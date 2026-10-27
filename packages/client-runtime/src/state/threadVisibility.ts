import type { OrchestrationV2AppThreadLineage } from "@t3tools/contracts";

export function isIndependentThread(thread: {
  readonly lineage: OrchestrationV2AppThreadLineage;
}): boolean {
  return thread.lineage.relationshipToParent !== "subagent";
}
