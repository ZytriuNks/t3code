import { assert, describe, it } from "@effect/vitest";

import { thinkingCapabilitiesForPiModel } from "./thinkingCapabilities.ts";

describe("thinkingCapabilitiesForPiModel", () => {
  it("exposes the OpenAI Fast service tier when the extension is active", () => {
    const capabilities = thinkingCapabilitiesForPiModel({ reasoning: false }, undefined, true);
    assert.deepEqual(capabilities.optionDescriptors, [
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard" },
          { id: "priority", label: "Fast", isDefault: true },
        ],
        currentValue: "priority",
      },
    ]);
  });

  it("keeps the standard service tier selected when Fast is configured off", () => {
    const capabilities = thinkingCapabilitiesForPiModel({ reasoning: false }, undefined, false);
    const serviceTier = capabilities.optionDescriptors?.[0];
    assert.equal(serviceTier?.type, "select");
    if (serviceTier?.type !== "select") return;
    assert.equal(serviceTier.currentValue, "default");
    assert.deepEqual(serviceTier.options, [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
    ]);
  });

  it("gives every choice its real level id and tags Pi's default", () => {
    const capabilities = thinkingCapabilitiesForPiModel(
      {
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "extra_high", max: null },
      },
      "xhigh",
    );
    const descriptors = capabilities.optionDescriptors ?? [];
    const thinking = descriptors[0];
    assert.equal(thinking?.id, "thinking");
    assert.equal(thinking?.type, "select");
    if (thinking?.type !== "select") return;
    assert.deepEqual(
      thinking.options.map((option) => [option.id, option.label, option.isDefault === true]),
      [
        ["minimal", "Minimal", false],
        ["low", "Low", false],
        ["medium", "Medium", false],
        ["high", "High", false],
        ["xhigh", "Extra High", true],
      ],
    );
  });

  it("clamps Pi's default to each model's supported levels", () => {
    const capabilities = thinkingCapabilitiesForPiModel(
      {
        reasoning: true,
        thinkingLevelMap: { xhigh: "extra_high", max: null },
      },
      "max",
    );
    const thinking = capabilities.optionDescriptors?.[0];
    assert.equal(thinking?.type, "select");
    if (thinking?.type !== "select") return;
    assert.deepInclude(thinking.options, {
      id: "xhigh",
      label: "Extra High",
      isDefault: true,
    });
    assert.notInclude(
      thinking.options.map((option) => option.id),
      "max",
    );
  });
});
