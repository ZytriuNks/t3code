import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type OrchestrationV2Subagent,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveSubagentModelInfo } from "./SubagentModelInfo";

const instanceId = ProviderInstanceId.make("codex-work");
const provider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  displayName: "Work account",
  models: [
    {
      slug: "gpt-6.1-sol",
      name: "Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            type: "select",
            label: "Reasoning",
            options: [{ id: "xhigh", label: "Extra High" }],
          },
          { id: "fastMode", type: "boolean", label: "Fast", currentValue: true },
        ],
      },
    },
  ],
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  slashCommands: [],
  skills: [],
} satisfies ServerProvider;

function selection(options: ModelSelection["options"]): ModelSelection {
  return { instanceId, model: "gpt-6.1-sol", ...(options ? { options } : {}) };
}

describe("resolveSubagentModelInfo", () => {
  it("uses the selected instance and model labels ahead of the dispatch record", () => {
    const info = resolveSubagentModelInfo({
      modelSelection: selection([
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "priority" },
      ]),
      subagent: { driver: "pi", model: "old-model" } as OrchestrationV2Subagent,
      providers: [provider],
    });
    expect(info).toEqual({
      providerLabel: "Work account",
      modelLabel: "Sol",
      effortLabel: "Extra High",
      fast: true,
    });
  });

  it.each(["effort", "thinking", "variant"])("reads the provider's %s option", (id) => {
    expect(
      resolveSubagentModelInfo({
        modelSelection: selection([{ id, value: "high" }]),
        providers: [],
      }).effortLabel,
    ).toBe("high");
  });

  it.each([
    { id: "fastMode", value: true },
    { id: "serviceTier", value: "priority" },
    { id: "serviceTier", value: "fast" },
  ] satisfies ProviderOptionSelection[])("recognizes saved Fast selections %j", (option) => {
    expect(
      resolveSubagentModelInfo({ modelSelection: selection([option]), providers: [] }).fast,
    ).toBe(true);
  });

  it("keeps an explicit disabled Fast option and does not assume live catalog defaults", () => {
    expect(
      resolveSubagentModelInfo({
        modelSelection: selection([
          { id: "fastMode", value: false },
          { id: "serviceTier", value: "priority" },
        ]),
        providers: [provider],
      }).fast,
    ).toBe(false);
    expect(
      resolveSubagentModelInfo({ modelSelection: selection(undefined), providers: [provider] }),
    ).toMatchObject({
      fast: false,
      effortLabel: "",
    });
  });

  it("retains dispatch metadata when no child configuration is available", () => {
    expect(
      resolveSubagentModelInfo({
        modelSelection: null,
        subagent: {
          providerInstanceId: "pi",
          driver: "pi",
          model: "sol",
        } as OrchestrationV2Subagent,
        providers: [],
      }),
    ).toEqual({ providerLabel: "Pi", modelLabel: "sol", effortLabel: "", fast: false });
  });
});
