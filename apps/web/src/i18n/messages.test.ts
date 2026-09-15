import { describe, expect, it } from "vite-plus/test";

import { EN_MESSAGES, ZH_CN_MESSAGES, translate } from "./messages";

describe("translation messages", () => {
  it("keeps the English and Simplified Chinese dictionaries complete", () => {
    expect(Object.keys(ZH_CN_MESSAGES).sort()).toEqual(Object.keys(EN_MESSAGES).sort());
  });

  it("translates static copy", () => {
    expect(translate("zh-CN", "settings.language.title")).toBe("语言");
    expect(translate("en", "settings.language.title")).toBe("Language");
    expect(translate("zh-CN", "connection.switchedOff")).toBe("已关闭");
  });

  it("translates the upstream queue-message action", () => {
    expect(Object.entries(ZH_CN_MESSAGES)).toContainEqual([
      "composer.queueMessage",
      "将消息加入队列",
    ]);
  });

  it("translates settings search item titles and keywords", () => {
    expect(Object.entries(ZH_CN_MESSAGES)).toContainEqual([
      "settings.search.item.default-model.title",
      "默认模型",
    ]);
    expect(Object.entries(ZH_CN_MESSAGES)).toContainEqual([
      "settings.search.item.default-model.keywords",
      expect.stringContaining("新线程"),
    ]);
    expect(Object.entries(ZH_CN_MESSAGES)).toContainEqual([
      "settings.search.item.wsl-backend.title",
      "WSL 后端",
    ]);
    expect(Object.entries(ZH_CN_MESSAGES)).toContainEqual([
      "settings.search.item.t3-connect.title",
      "T3 Connect",
    ]);
  });

  it("translates settings header and scope copy without changing dynamic names", () => {
    expect(Object.entries(ZH_CN_MESSAGES)).toContainEqual([
      "settings.header.restoreDeviceDefaults",
      "恢复设备默认值",
    ]);
    expect(Object.entries(ZH_CN_MESSAGES)).toContainEqual([
      "settings.scope.allEnvironments",
      "全部环境",
    ]);
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.scope.reconnectEnvironment")?.replace(
        "{environment}",
        "Dev Box",
      ),
    ).toBe("请重新连接 Dev Box 后再更改其设置。");
  });

  it("translates the settings row copy and general page copy", () => {
    expect(translate("zh-CN", "settings.row.copy.defaultTooltip")).toBe("重置为默认值");
    expect(translate("zh-CN", "settings.row.copy.inheritedLabel", { label: "默认模型" })).toBe(
      "将默认模型重置为继承值",
    );
    expect(translate("zh-CN", "settings.row.copy.builtInDefault")).toBe("内置默认值");
    expect(translate("zh-CN", "settings.general.section.organization")).toBe("组织");
    expect(translate("zh-CN", "settings.general.notifications.mode.notifications")).toBe("仅通知");
    expect(translate("zh-CN", "settings.general.streaming.token")).toBe("逐 Token 显示（旧版）");
  });

  it("keeps brand and product names in the general page copy", () => {
    expect(translate("zh-CN", "settings.general.version.title")).toBe("版本");
    expect(
      translate("zh-CN", "settings.general.version.installConfirmationWithVersion", {
        version: "1.1.1",
      }),
    ).toContain("T3 Code");
    expect(translate("zh-CN", "settings.general.workspace.title")).toBe("工作区");
  });

  it("translates the release channel labels and keeps the English dictionary verbatim", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.general.version.stable")).toBe("Stable");
    expect(Reflect.get(EN_MESSAGES, "settings.general.version.latest")).toBe("Latest");
    expect(Reflect.get(EN_MESSAGES, "settings.general.version.nightly")).toBe("Nightly");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.version.stable")).toBe("稳定版");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.version.latest")).toBe("最新版");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.version.nightly")).toBe("每夜版");
  });

  it("translates the shared inheritance chain copy and keeps dynamic values interpolated", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.layerProject")).toBe("Project");
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.inherits")).toBe("Inherits");
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.lastSelected")).toBe("Last selected");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.layerProject")).toBe("项目");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.layerEnvironment")).toBe("环境");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.layerDefault")).toBe("默认");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.overriddenBy")).toBe("被以下项目覆盖");
    expect(
      translate("zh-CN", "settings.row.copy.projectOverrideSummaryOne", {
        summary: "内置默认值",
        count: 1,
      }),
    ).toBe("内置默认值 · 1 个项目覆盖");
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.showSourceLabel")?.replace(
        "{summary}",
        "内置默认值",
      ),
    ).toBe("内置默认值。查看此值的来源");
  });

  it("translates the desktop update tooltips and keeps versions interpolated", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.general.version.tooltip.upToDate")).toBe(
      "Up to date",
    );
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.version.tooltip.upToDate")).toBe(
      "已是最新",
    );
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.general.version.tooltip.downloaded")?.replace(
        "{version}",
        "1.1.1",
      ),
    ).toBe("更新 1.1.1 已下载。点击重启并安装。");
    expect(
      Reflect.get(
        ZH_CN_MESSAGES,
        "settings.general.version.installConfirmationWithVersion",
      )?.replace("{version}", "1.1.1"),
    ).toContain("安装更新 1.1.1");
    expect(Reflect.get(EN_MESSAGES, "settings.general.version.installConfirmation")).toContain(
      "Install update and restart T3 Code?",
    );
  });

  it("keeps the update-check fallback distinct from the unsupported-build copy", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.general.version.checkFailedFallback")).toBe(
      "Update check failed.",
    );
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.version.checkFailedFallback")).toBe(
      "检查更新失败。",
    );
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.version.checkFailedDescription")).toBe(
      "此构建不支持自动更新。",
    );
  });

  it("translates the restore-defaults dialog copy without drifting the English labels", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.restore.title")).toBe("Restore default settings?");
    expect(
      Reflect.get(EN_MESSAGES, "settings.restore.body")?.replace("{labels}", "Theme, Language"),
    ).toBe("This will reset: Theme, Language.");
    expect(Reflect.get(EN_MESSAGES, "settings.restore.label.projectGrouping")).toBe(
      "Project Grouping",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.restore.themeFailedTitle")).toBe(
      "Couldn’t restore theme settings",
    );
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.restore.body")?.replace("{labels}", "主题、语言"),
    ).toBe("将重置：主题、语言。");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.restore.label.textGenerationModel")).toBe(
      "文本生成模型",
    );
  });

  it("drops the general-page keys that no component reads", () => {
    expect(Reflect.has(ZH_CN_MESSAGES, "settings.general.workspace.mixed")).toBe(false);
    expect(
      Reflect.has(ZH_CN_MESSAGES, "settings.general.backgroundActivity.gitFetchInterval"),
    ).toBe(false);
    expect(Reflect.has(ZH_CN_MESSAGES, "settings.general.workspace.unavailable")).toBe(true);
  });

  it("keeps the shared permission and workspace option labels verbatim in English", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.general.permissions.mode.supervised")).toBe(
      "Supervised",
    );
    expect(
      Reflect.get(EN_MESSAGES, "settings.general.permissions.mode.supervisedDescription"),
    ).toBe("Ask before commands and file changes.");
    expect(Reflect.get(EN_MESSAGES, "settings.general.permissions.mode.autoAcceptEdits")).toBe(
      "Auto-accept edits",
    );
    expect(
      Reflect.get(EN_MESSAGES, "settings.general.permissions.mode.autoAcceptEditsDescription"),
    ).toBe("Auto-approve edits, ask before other actions.");
    expect(Reflect.get(EN_MESSAGES, "settings.general.permissions.mode.auto")).toBe("Auto");
    expect(Reflect.get(EN_MESSAGES, "settings.general.permissions.mode.fullAccess")).toBe(
      "Full access",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.general.workspace.mode.local")).toBe(
      "Current checkout",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.general.workspace.mode.worktree")).toBe(
      "New worktree",
    );
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.permissions.mode.autoAcceptEdits")).toBe(
      "自动接受编辑",
    );
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.workspace.mode.worktree")).toBe(
      "新工作树",
    );
  });

  it("keeps the merged advanced-policy sentence and the model advice interpolated", () => {
    expect(
      Reflect.get(EN_MESSAGES, "settings.general.backgroundActivity.advancedDescription")?.replace(
        "{profile}",
        "Balanced",
      ),
    ).toBe("Uses custom intervals. Shared policy: Balanced.");
    expect(
      Reflect.get(
        ZH_CN_MESSAGES,
        "settings.general.backgroundActivity.advancedDescription",
      )?.replace("{profile}", "均衡"),
    ).toBe("使用自定义间隔。共享策略：均衡。");
    expect(
      Reflect.get(
        ZH_CN_MESSAGES,
        "settings.general.defaultModel.unavailableOnEnvironment",
      )?.replace("{environment}", "Laptop"),
    ).toBe("此模型在 Laptop 上不可用。请选择该环境以单独选择其模型。");
    expect(Reflect.get(EN_MESSAGES, "settings.general.defaultModel.notSaved")).toBe(
      "Default model not saved",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.general.legacy.title")).toBe("Legacy features");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.general.legacy.title")).toBe("旧版功能");
  });

  it("interpolates values without changing unknown user content", () => {
    expect(
      translate("zh-CN", "connection.reconnectingWithReason", {
        reason: "Socket closed.",
      }),
    ).toBe("连接失败，正在重新连接… 原因：Socket closed.");
    expect(
      translate("zh-CN", "connection.updateAvailable", {
        serverVersion: "1.2.3",
        clientVersion: "1.2.4",
      }),
    ).toBe("有可用更新：1.2.3 → 1.2.4");
  });
});
