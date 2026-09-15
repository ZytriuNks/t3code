import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers, type SettingInheritanceCopy } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

const zhCopy: SettingInheritanceCopy = {
  layerProject: "项目",
  layerEnvironment: "环境",
  layerDefault: "默认",
  inherits: "继承",
  on: "开",
  off: "关",
  dayCount: (count) => `${count} 天`,
  lastSelected: "上次选择",
  never: "从不",
  automatic: "自动",
  textGenerationModel: "文本生成模型",
  notSet: "未设置",
  empty: "空",
  itemCount: (count) => `${count} 项`,
  custom: "自定义",
  envModeLocal: "当前检出",
  envModeWorktree: "新工作树",
  overriddenBy: "被以下项目覆盖",
  resetOverride: (count) => (count === 1 ? "重置" : "全部重置"),
  projectOverrideSummary: (summary, count) => `${summary} · ${count} 个项目覆盖`,
  showSourceLabel: (summary) => `${summary}。查看此值的来源`,
};

describe("settingInheritanceLayers", () => {
  it("marks the built-in default effective when nothing is set", () => {
    const resolved = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, null);
    const layers = settingInheritanceLayers(
      { environmentId, label: "Laptop", projectId: null, ...resolved },
      DEFAULT_SERVER_SETTINGS,
      "defaultAutoPull",
    );
    expect(layers.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Laptop", "Inherits", false],
      ["Default", "Off", true],
    ]);
  });

  it("walks project override, environment value, then built-in default", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultAutoPull: true,
      projectSettingsOverrides: { [projectId]: { defaultAutoPull: false } },
    };
    const resolved = resolveProjectSettings(settings, projectId);
    const layers = settingInheritanceLayers(
      { environmentId, label: "Laptop", projectId, ...resolved },
      settings,
      "defaultAutoPull",
    );
    expect(layers.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Project", "Off", true],
      ["Laptop", "On", false],
      ["Default", "Off", false],
    ]);
    const inherited = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(settings, ProjectId.make("other")),
      },
      settings,
      "defaultAutoPull",
    );
    expect(inherited.map((layer) => [layer.value, layer.effective])).toEqual([
      ["Inherits", false],
      ["On", true],
      ["Off", false],
    ]);
  });

  it("keeps the layer labels and values verbatim in English by default", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true };
    const layers = settingInheritanceLayers(
      { environmentId, label: "Laptop", projectId, ...resolveProjectSettings(settings, projectId) },
      settings,
      "defaultAutoPull",
    );
    expect(layers.map((layer) => [layer.label, layer.value])).toEqual([
      ["Project", "Inherits"],
      ["Laptop", "On"],
      ["Default", "Off"],
    ]);
  });

  it("keeps the placeholder values verbatim in English by default", () => {
    expect(
      settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId,
          ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId),
        },
        DEFAULT_SERVER_SETTINGS,
        "pullRequestMergeMethod",
      ).map((layer) => layer.value),
    ).toEqual(["Inherits", "Inherits", "Last selected"]);
  });

  it("formats the layers with the supplied copy and keeps dynamic names raw", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true };
    const target = {
      environmentId,
      label: "Laptop",
      projectId,
      ...resolveProjectSettings(settings, projectId),
    };
    expect(
      settingInheritanceLayers(target, settings, "defaultAutoPull", zhCopy).map((layer) => [
        layer.label,
        layer.value,
      ]),
    ).toEqual([
      ["项目", "继承"],
      ["Laptop", "开"],
      ["默认", "关"],
    ]);
    expect(
      settingInheritanceLayers(target, settings, "pullRequestMergeMethod", zhCopy).map(
        (layer) => layer.value,
      ),
    ).toEqual(["继承", "继承", "上次选择"]);
  });

  it("keeps the workspace mode labels verbatim in English by default", () => {
    expect(
      settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId,
          ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId),
        },
        DEFAULT_SERVER_SETTINGS,
        "defaultThreadEnvMode",
      ).map((layer) => layer.value),
    ).toEqual(["Inherits", "Inherits", "Current checkout"]);
  });

  it("formats the workspace mode labels with the supplied copy", () => {
    expect(
      settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId,
          ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId),
        },
        { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
        "defaultThreadEnvMode",
        zhCopy,
      ).map((layer) => layer.value),
    ).toEqual(["继承", "新工作树", "当前检出"]);
  });
});
