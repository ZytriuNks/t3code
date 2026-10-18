import type {
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
  ProviderDriverKind,
} from "@t3tools/contracts";

export function resolveNativeSubagentConversationModel(input: {
  thread: Pick<
    OrchestrationV2AppThread,
    "id" | "providerInstanceId" | "modelSelection" | "creationSource" | "lineage" | "forkedFrom"
  > | null;
  parent: Pick<OrchestrationV2AppThread, "id" | "modelSelection"> | null;
  subagents: ReadonlyArray<
    Pick<
      OrchestrationV2Subagent,
      "id" | "childThreadId" | "providerInstanceId" | "origin" | "driver" | "model"
    >
  >;
  driver: ProviderDriverKind | undefined;
  hasIndependentTurn: boolean;
}): string | null | undefined {
  const thread = input.thread;
  if (
    thread === null ||
    input.driver !== "codex" ||
    input.hasIndependentTurn ||
    thread.creationSource !== "provider" ||
    thread.lineage.relationshipToParent !== "subagent"
  )
    return undefined;
  const task = input.subagents.find((subagent) => subagent.childThreadId === thread.id);
  if (input.parent && input.parent.id !== thread.lineage.parentThreadId) return undefined;
  if (thread.modelSelection.instanceId !== thread.providerInstanceId) return undefined;
  if (
    task &&
    (task.origin !== "provider_native" ||
      task.driver !== "codex" ||
      task.providerInstanceId !== thread.providerInstanceId ||
      thread.forkedFrom?.type !== "node" ||
      thread.forkedFrom.nodeId !== task.id)
  )
    return undefined;
  const model = task?.model?.trim() || null;
  return model;
}

export function resolveNativeSubagentComposerModel(input: {
  reportedModel: string | null | undefined;
  selectedModel: string;
  explicitSelection: boolean;
}) {
  const unknown = input.reportedModel === null && !input.explicitSelection;
  return {
    model:
      !input.explicitSelection && input.reportedModel ? input.reportedModel : input.selectedModel,
    modelLabel: unknown ? "Not reported" : undefined,
    requiresModelSelection: unknown,
  };
}
