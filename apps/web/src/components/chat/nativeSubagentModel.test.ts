import { describe, expect, it } from "vite-plus/test";
import { NodeId, ProviderInstanceId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import {
  resolveNativeSubagentConversationModel,
  resolveNativeSubagentComposerModel,
} from "./nativeSubagentModel";

const parent = {
  id: ThreadId.make("parent"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" },
};
const child = {
  id: ThreadId.make("child"),
  providerInstanceId: parent.modelSelection.instanceId,
  creationSource: "provider" as const,
  modelSelection: parent.modelSelection,
  lineage: {
    parentThreadId: parent.id,
    relationshipToParent: "subagent" as const,
    rootThreadId: parent.id,
  },
  forkedFrom: { type: "node" as const, nodeId: NodeId.make("task") },
};
const task = {
  id: child.forkedFrom.nodeId,
  childThreadId: child.id,
  providerInstanceId: parent.modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  origin: "provider_native" as const,
  model: "gpt-6-luna",
};

describe("native subagent conversation model", () => {
  it("uses the reported model when opening an existing child with an inherited selection", () => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent,
        subagents: [task],
        driver: task.driver,
        hasIndependentTurn: false,
      }),
    ).toBe("gpt-6-luna");
  });
  it.each([null, "", "   "])("keeps an unreported model %s unknown", (model) => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent,
        subagents: [{ ...task, model }],
        driver: task.driver,
        hasIndependentTurn: false,
      }),
    ).toBeNull();
  });
  it("keeps the model unknown while the parent projection is loading", () => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent: null,
        subagents: [],
        driver: task.driver,
        hasIndependentTurn: false,
      }),
    ).toBeNull();
  });
  it("switches from unknown to the child model when metadata arrives", () => {
    const input = { thread: child, parent, driver: task.driver, hasIndependentTurn: false };
    expect(
      resolveNativeSubagentConversationModel({ ...input, subagents: [{ ...task, model: null }] }),
    ).toBeNull();
    expect(resolveNativeSubagentConversationModel({ ...input, subagents: [task] })).toBe(
      "gpt-6-luna",
    );
  });
  it("keeps the native child model when its parent changes models after spawning", () => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent: { ...parent, modelSelection: { ...parent.modelSelection, model: "gpt-6.1-sol" } },
        subagents: [task],
        driver: task.driver,
        hasIndependentTurn: false,
      }),
    ).toBe("gpt-6-luna");
  });
  it("preserves an instance selected after the native child was created", () => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: {
          ...child,
          modelSelection: {
            instanceId: ProviderInstanceId.make("other-codex"),
            model: "gpt-6-luna",
          },
        },
        parent,
        subagents: [task],
        driver: task.driver,
        hasIndependentTurn: false,
      }),
    ).toBeUndefined();
  });
  it("preserves the independent child's turn model", () => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent,
        subagents: [task],
        driver: task.driver,
        hasIndependentTurn: true,
      }),
    ).toBeUndefined();
  });
  it("does not alter app-owned tasks or other providers", () => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent,
        subagents: [{ ...task, origin: "app_owned" }],
        driver: task.driver,
        hasIndependentTurn: false,
      }),
    ).toBeUndefined();
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent,
        subagents: [task],
        driver: ProviderDriverKind.make("pi"),
        hasIndependentTurn: false,
      }),
    ).toBeUndefined();
  });
  it("does not borrow a model from another child", () => {
    expect(
      resolveNativeSubagentConversationModel({
        thread: child,
        parent,
        subagents: [{ ...task, childThreadId: ThreadId.make("other") }],
        driver: task.driver,
        hasIndependentTurn: false,
      }),
    ).toBeNull();
  });
  it("uses the observed model for both picker selection and dispatch", () => {
    expect(
      resolveNativeSubagentComposerModel({
        reportedModel: "gpt-6-luna",
        selectedModel: "gpt-6-astra",
        explicitSelection: false,
      }),
    ).toEqual({ model: "gpt-6-luna", modelLabel: undefined, requiresModelSelection: false });
  });
  it("requires an explicit choice before dispatching with an unknown native model", () => {
    expect(
      resolveNativeSubagentComposerModel({
        reportedModel: null,
        selectedModel: "gpt-6-astra",
        explicitSelection: false,
      }),
    ).toEqual({ model: "gpt-6-astra", modelLabel: "Not reported", requiresModelSelection: true });
    expect(
      resolveNativeSubagentComposerModel({
        reportedModel: null,
        selectedModel: "gpt-6.1-sol",
        explicitSelection: true,
      }),
    ).toEqual({ model: "gpt-6.1-sol", modelLabel: undefined, requiresModelSelection: false });
  });
  it("preserves a deliberate composer selection when new model metadata arrives", () => {
    expect(
      resolveNativeSubagentComposerModel({
        reportedModel: "gpt-6-luna",
        selectedModel: "gpt-6.1-sol",
        explicitSelection: true,
      }),
    ).toEqual({ model: "gpt-6.1-sol", modelLabel: undefined, requiresModelSelection: false });
  });
});
