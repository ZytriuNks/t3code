import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { settingInheritanceLayers, type SettingInheritanceCopy } from "./SettingInheritance";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

const zhRuntimeModeLabels: Record<string, string> = {
  "approval-required": "监督模式",
  "auto-accept-edits": "自动接受编辑",
  auto: "自动",
  "full-access": "完全访问",
};

const zhResponseStreamingLabels: Record<string, string> = {
  turn: "等待完整响应",
  paragraph: "显示已完成的段落",
  token: "逐 Token 显示（旧版）",
};

const zhCopy: SettingInheritanceCopy = {
  settingValueLabel: (key, value) =>
    key === "defaultRuntimeMode"
      ? (zhRuntimeModeLabels[value] ?? value)
      : key === "responseStreamingMode"
        ? (zhResponseStreamingLabels[value] ?? value)
        : value,
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
    ).toEqual(["Inherits", "Inherits", "Inherits", "Current checkout"]);
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
    ).toEqual(["继承", "新工作树", "继承", "当前检出"]);
  });

  it("keeps the stored runtime and streaming enums verbatim in English by default", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultRuntimeMode: "auto-accept-edits" as const,
      responseStreamingMode: "turn" as const,
    };
    const target = {
      environmentId,
      label: "Laptop",
      projectId,
      ...resolveProjectSettings(settings, projectId),
    };
    expect(
      settingInheritanceLayers(target, settings, "defaultRuntimeMode").map((layer) => layer.value),
    ).toEqual(["Inherits", "auto-accept-edits", "full-access"]);
    expect(
      settingInheritanceLayers(target, settings, "responseStreamingMode").map(
        (layer) => layer.value,
      ),
    ).toEqual(["Inherits", "turn", "paragraph"]);
  });

  it("maps the stored runtime mode with the supplied copy", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultRuntimeMode: "auto-accept-edits" as const,
    };
    expect(
      settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId,
          ...resolveProjectSettings(settings, projectId),
        },
        settings,
        "defaultRuntimeMode",
        zhCopy,
      ).map((layer) => layer.value),
    ).toEqual(["继承", "自动接受编辑", "完全访问"]);
  });

  it("maps each response streaming value with the supplied copy", () => {
    for (const [mode, label] of [
      ["turn", "等待完整响应"],
      ["paragraph", "显示已完成的段落"],
    ] as const) {
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        responseStreamingMode: "turn" as const,
        projectSettingsOverrides: { [projectId]: { responseStreamingMode: mode } },
      };
      expect(
        settingInheritanceLayers(
          {
            environmentId,
            label: "Laptop",
            projectId,
            ...resolveProjectSettings(settings, projectId),
          },
          settings,
          "responseStreamingMode",
          zhCopy,
        ).map((layer) => layer.value),
      ).toEqual([label, "等待完整响应", "显示已完成的段落"]);
    }
  });

  it("keeps unmapped stored strings such as paths raw under the supplied copy", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      addProjectBaseDirectory: "/home/laptop/projects",
    };
    expect(
      settingInheritanceLayers(
        {
          environmentId,
          label: "Laptop",
          projectId,
          ...resolveProjectSettings(settings, projectId),
        },
        settings,
        "addProjectBaseDirectory",
        zhCopy,
      ).map((layer) => layer.value),
    ).toEqual(["/home/laptop/projects", "空"]);
  });
  it("shows the checkout's t3.json as a layer for file-backed keys", () => {
    const file = { defaultThreadEnvMode: "worktree" as const };
    const fromFile = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(DEFAULT_SERVER_SETTINGS, projectId, null, file),
      },
      DEFAULT_SERVER_SETTINGS,
      "defaultThreadEnvMode",
    );
    expect(fromFile.map((layer) => [layer.label, layer.value, layer.effective])).toEqual([
      ["Project", "Inherits", false],
      ["Laptop", "Inherits", false],
      ["t3.json", "New worktree", true],
      ["Default", "Current checkout", false],
    ]);
    const settings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "local" as const };
    const fromEnvironment = settingInheritanceLayers(
      {
        environmentId,
        label: "Laptop",
        projectId,
        ...resolveProjectSettings(settings, projectId, null, file),
      },
      settings,
      "defaultThreadEnvMode",
    );
    expect(fromEnvironment.map((layer) => [layer.value, layer.effective])).toEqual([
      ["Inherits", false],
      ["Current checkout", true],
      ["Inherits", false],
      ["Current checkout", false],
    ]);
  });
});
