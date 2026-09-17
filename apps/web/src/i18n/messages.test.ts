import { describe, expect, it } from "vite-plus/test";

import { EN_MESSAGES, ZH_CN_MESSAGES, translate } from "./messages";

describe("translation messages", () => {
  it("keeps the English and Simplified Chinese dictionaries complete", () => {
    expect(Object.keys(ZH_CN_MESSAGES).sort()).toEqual(Object.keys(EN_MESSAGES).sort());
  });

  it("translates integration and device settings copy", () => {
    expect(translate("zh-CN", "settings.integrations.section.browser")).toBe("浏览器");
    expect(translate("zh-CN", "settings.browserImport.importFrom", { source: "Helium" })).toBe(
      "从 Helium 导入",
    );
    expect(translate("zh-CN", "settings.devices.section.title")).toBe("设备");
  });

  it("translates the remaining settings pages shown in the review", () => {
    expect(translate("zh-CN", "settings.keybindings.command.composerWorkspace")).toBe(
      "输入区：工作区",
    );
    expect(translate("zh-CN", "settings.keybindings.countOther", { count: 59 })).toBe(
      "59 个快捷键",
    );
    expect(translate("zh-CN", "settings.snapshots.description")).toBe("捕获窗口并附加到当前草稿。");
    expect(translate("zh-CN", "settings.providers.field.shadowHomePath")).toBe("影子主目录路径");
    expect(
      translate("zh-CN", "settings.providers.limitedPermissionsDescription", {
        environment: "Dev Box",
      }),
    ).toBe("此会话可以查看 Dev Box 的提供商，但无法更改其设置。");
    expect(translate("zh-CN", "settings.defaults.agentBrowserAccess")).toBe("代理浏览器访问");
    expect(translate("zh-CN", "settings.defaults.automaticPull")).toBe("自动拉取");
    expect(translate("zh-CN", "settings.connections.local.ariaLabel")).toBe("本地环境");
    expect(translate("zh-CN", "settings.archive.empty")).toBe("没有已归档线程");
  });

  it("translates source control settings copy", () => {
    expect(translate("zh-CN", "settings.sourceControl.section.serverEnvironment")).toBe(
      "服务器环境",
    );
    expect(translate("zh-CN", "settings.sourceControl.github.readWrite")).toBe("可读取并操作");
    expect(translate("zh-CN", "settings.sourceControl.writing.writeAll")).toBe(
      "为全部环境编写自定义指令",
    );
  });

  it("translates project and connection settings copy", () => {
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.project.name")).toBe("名称");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.project.icon")).toBe("项目图标");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.project.actions")).toBe("操作");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.environments")).toBe("环境");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.addEnvironment")).toBe("添加环境");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.creating")).toBe("正在创建…");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.applying")).toBe("正在应用…");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.remoteLink")).toBe("远程链接");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.wslBackend")).toBe("WSL 后端");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.tailscaleHttps")).toBe(
      "Tailscale HTTPS",
    );
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.networkAccess")).toBe("网络访问");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.authorizedClients")).toBe(
      "已授权客户端",
    );
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.connections.t3Connect")).toBe("T3 Connect");
    expect(Reflect.get(EN_MESSAGES, "settings.project.name")).toBe("Name");
    expect(Reflect.get(EN_MESSAGES, "settings.connections.addEnvironment")).toBe("Add environment");
  });

  it("translates the toolbar and follow-up behavior copy", () => {
    expect(translate("zh-CN", "toolbar.environment.runOn")).toBe("运行于");
    expect(translate("zh-CN", "toolbar.environment.autoBalance")).toBe("自动均衡");
    expect(translate("zh-CN", "toolbar.workspace.title")).toBe("工作区");
    expect(
      translate("zh-CN", "toolbar.workspace.previousWorktreeWithBranch", { branch: "feat/i18n" }),
    ).toBe("上一个工作树（feat/i18n）");
    expect(translate("zh-CN", "toolbar.branch.createRef", { ref: "feat/i18n" })).toBe(
      "创建新引用“feat/i18n”",
    );
    expect(translate("zh-CN", "toolbar.branch.showingRefs", { shown: 20, total: 42 })).toBe(
      "显示 42 个引用中的 20 个",
    );
    expect(translate("zh-CN", "settings.general.followUpBehavior.description")).toBe(
      "智能体运行时将跟进消息排队，或用消息引导当前回合。",
    );
    expect(translate("zh-CN", "settings.general.followUpBehavior.option.queue")).toBe("排队");
    expect(translate("zh-CN", "settings.general.followUpBehavior.option.steer")).toBe("引导");

    expect(translate("en", "toolbar.environment.runOn")).toBe("Run on");
    expect(translate("en", "toolbar.workspace.title")).toBe("Workspace");
    expect(translate("en", "toolbar.branch.createRef", { ref: "feat/i18n" })).toBe(
      'Create new ref "feat/i18n"',
    );
    expect(translate("en", "settings.general.followUpBehavior.option.queue")).toBe("Queue");
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

  it("labels the inherited runtime and streaming enums raw in English and friendly in Chinese", () => {
    expect(
      Reflect.get(EN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.approvalRequired"),
    ).toBe("approval-required");
    expect(
      Reflect.get(EN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.autoAcceptEdits"),
    ).toBe("auto-accept-edits");
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.auto")).toBe(
      "auto",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.fullAccess")).toBe(
      "full-access",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.settingValue.streamingMode.turn")).toBe(
      "turn",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.settingValue.streamingMode.paragraph")).toBe(
      "paragraph",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.row.copy.settingValue.streamingMode.token")).toBe(
      "token",
    );
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.approvalRequired"),
    ).toBe(Reflect.get(ZH_CN_MESSAGES, "settings.general.permissions.mode.supervised"));
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.autoAcceptEdits"),
    ).toBe("自动接受编辑");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.auto")).toBe(
      Reflect.get(ZH_CN_MESSAGES, "settings.general.permissions.mode.auto"),
    );
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.settingValue.runtimeMode.fullAccess"),
    ).toBe("完全访问");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.settingValue.streamingMode.turn")).toBe(
      "等待完整响应",
    );
    expect(
      Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.settingValue.streamingMode.paragraph"),
    ).toBe("显示已完成的段落");
    expect(Reflect.get(ZH_CN_MESSAGES, "settings.row.copy.settingValue.streamingMode.token")).toBe(
      Reflect.get(ZH_CN_MESSAGES, "settings.general.streaming.token"),
    );
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

  it("translates the appearance copy and keeps the English words verbatim", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.colorsAndThemes.title")).toBe(
      "Colors & themes",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.interface.title")).toBe("Interface");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.motion.title")).toBe("Motion");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.typography.title")).toBe("Typography");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.contrast.description")).toBe(
      "Adjust the contrast of colors and borders across the interface.",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.panelAnimations.description")).toBe(
      "Set how fast panels open and close.",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.panelAnimations.durationAriaLabel")).toBe(
      "Panel animation duration",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.typography.advanced")).toBe("Advanced");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.typography.systemDefault")).toBe(
      "System default",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.typography.systemMonospace")).toBe(
      "System monospace",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.monospaceFont.title")).toBe(
      "Monospace font",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.wordWrap.ariaLabel")).toBe(
      "Wrap code, tables, diffs, and file previews by default",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.motion.replayPreview")).toBe(
      "Replay panel animation preview",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.terminalFont.previewLabel")).toBe(
      "Terminal font preview",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.promptFont.previewPlaceholder")).toBe(
      "Ask for changes, send follow-ups, or attach images",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.fontPicker.searchPlaceholder")).toBe(
      "Search fonts…",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.fontPicker.empty")).toBe(
      "No fonts found.",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.fontPicker.defaultBadge")).toBe("default");

    expect(translate("zh-CN", "settings.appearance.colorsAndThemes.title")).toBe("颜色与主题");
    expect(translate("zh-CN", "settings.appearance.interfaceFont.description")).toBe(
      "代码块和终端之外的所有内容。",
    );
    expect(
      translate("zh-CN", "settings.appearance.environmentIdentification.option.versionPill"),
    ).toBe("版本标签");
    expect(translate("zh-CN", "settings.appearance.diffColors.option.blueOrange")).toBe("蓝橙配色");
    expect(translate("zh-CN", "settings.appearance.fontPicker.searchPlaceholder")).toBe(
      "搜索字体…",
    );
    expect(translate("zh-CN", "settings.appearance.fontPicker.empty")).toBe("未找到字体。");
    expect(translate("zh-CN", "settings.appearance.fontPicker.defaultBadge")).toBe("默认");
    expect(
      translate("en", "settings.appearance.fontFamily.familyAriaLabel", {
        title: "Interface font",
      }),
    ).toBe("Interface font family");
    expect(
      translate("zh-CN", "settings.appearance.fontFamily.familyAriaLabel", { title: "界面字体" }),
    ).toBe("界面字体（字体族）");
  });

  it("translates the composer and terminal accessible copy and keeps dynamic values verbatim", () => {
    // Every caller that does not pass its own copy keeps these exact strings.
    expect(Reflect.get(EN_MESSAGES, "composer.accessible.mentionPreview")).toBe("Preview {path}");
    expect(Reflect.get(EN_MESSAGES, "composer.accessible.skillLabel")).toBe("Skill {skill}");
    expect(Reflect.get(EN_MESSAGES, "composer.accessible.showDetailsSuffix")).toBe(
      ". Show details",
    );
    expect(Reflect.get(EN_MESSAGES, "composer.accessible.skillNoDescription")).toBe(
      "No description is available for this skill.",
    );
    expect(Reflect.get(EN_MESSAGES, "composer.accessible.skillViewInstructions")).toBe(
      "View instructions",
    );
    expect(Reflect.get(EN_MESSAGES, "terminal.accessible.input")).toBe("Terminal input");
    expect(Reflect.get(EN_MESSAGES, "terminal.accessible.scrollback")).toBe("Terminal scrollback");

    // The path and the skill's own name stay exactly as the app spells them.
    expect(
      translate("zh-CN", "composer.accessible.mentionPreview", {
        path: "apps/web/src/terminal/ghostty/surface.test.ts",
      }),
    ).toBe("预览 apps/web/src/terminal/ghostty/surface.test.ts");
    expect(
      translate("zh-CN", "composer.accessible.mentionPreview", {
        path: "apps/web/src/components/settings/SettingsPanels.tsx",
      }),
    ).toBe("预览 apps/web/src/components/settings/SettingsPanels.tsx");
    expect(translate("zh-CN", "composer.accessible.skillLabel", { skill: "Frontend Design" })).toBe(
      "技能 Frontend Design",
    );
    expect(translate("zh-CN", "composer.accessible.showDetailsSuffix")).toBe("。显示详情");
    expect(translate("zh-CN", "composer.accessible.skillNoDescription")).toBe("此技能暂无描述。");
    expect(translate("zh-CN", "composer.accessible.skillViewInstructions")).toBe("查看说明");
    expect(translate("zh-CN", "terminal.accessible.input")).toBe("终端输入");
    expect(translate("zh-CN", "terminal.accessible.scrollback")).toBe("终端回滚区");
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

  it("translates the theme library copy and keeps the English words verbatim", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.mode.system")).toBe("System");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.mode.light")).toBe("Light");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.mode.dark")).toBe("Dark");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.create")).toBe("Create theme");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.add")).toBe("Add theme");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.duplicate")).toBe("Duplicate theme");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.edit")).toBe("Edit theme");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.exportFile")).toBe(
      "Export theme file",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.remove")).toBe("Remove theme");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.removeMany")).toBe("Remove themes");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.removeThemeDescription")).toBe(
      "You can bring it back anytime by importing its JSON file.",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.saveSelectionFailed")).toBe(
      "Couldn’t save theme selection",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.removeFailed")).toBe(
      "Couldn’t remove theme",
    );

    expect(translate("zh-CN", "settings.appearance.theme.mode.system")).toBe("跟随系统");
    expect(translate("zh-CN", "settings.appearance.theme.mode.light")).toBe("浅色");
    expect(translate("zh-CN", "settings.appearance.theme.mode.dark")).toBe("深色");
    expect(translate("zh-CN", "settings.appearance.theme.create")).toBe("创建主题");
    expect(translate("zh-CN", "settings.appearance.theme.add")).toBe("添加主题");
    expect(translate("zh-CN", "settings.appearance.theme.duplicate")).toBe("复制主题");
    expect(translate("zh-CN", "settings.appearance.theme.edit")).toBe("编辑主题");
    expect(translate("zh-CN", "settings.appearance.theme.exportFile")).toBe("导出主题文件");
    expect(translate("zh-CN", "settings.appearance.theme.remove")).toBe("移除主题");
    expect(translate("zh-CN", "settings.appearance.theme.removeMany")).toBe("移除主题");
    expect(translate("zh-CN", "settings.appearance.theme.saveSelectionFailed")).toBe(
      "无法保存主题选择",
    );
    expect(translate("zh-CN", "settings.appearance.theme.removeFailed")).toBe("无法移除主题");
    expect(translate("zh-CN", "settings.appearance.theme.tryAgain")).toBe("请重试。");
  });

  it("keeps theme names, modes and raw errors interpolated in the theme copy", () => {
    expect(translate("zh-CN", "settings.appearance.theme.useTheme", { name: "Aurora" })).toBe(
      "使用 Aurora 主题",
    );
    expect(translate("zh-CN", "settings.appearance.theme.duplicateLabel", { name: "Aurora" })).toBe(
      "复制 Aurora",
    );
    expect(
      translate("zh-CN", "settings.appearance.theme.removeThemeTitle", { name: "Aurora" }),
    ).toBe("移除“Aurora”？");
    expect(
      translate("zh-CN", "settings.appearance.theme.removeCollectionTitle", {
        collection: "Dracula",
      }),
    ).toBe("移除“Dracula”中的主题？");
    expect(translate("zh-CN", "settings.appearance.theme.useForDarkOnly")).toBe("仅用于深色模式");
    expect(translate("zh-CN", "settings.appearance.theme.created", { name: "Aurora" })).toBe(
      "Aurora 已创建",
    );
    expect(translate("zh-CN", "settings.appearance.theme.nowActive")).toBe("现已启用。");
    expect(translate("zh-CN", "settings.appearance.theme.darkPaletteAdded")).toBe(
      "已添加其深色配色。",
    );
    expect(translate("zh-CN", "settings.appearance.theme.nowDarkTheme")).toBe(
      "现在它是你的深色主题。",
    );
    expect(translate("zh-CN", "settings.appearance.theme.storageUnavailable")).toBe(
      "浏览器存储不可用，因此更改未保存。",
    );
    expect(
      translate("zh-CN", "settings.appearance.theme.extensionMeta", {
        publisher: "Dracula Theme",
        count: "1.2M",
      }),
    ).toBe("Dracula Theme · 1.2M 次下载");
    // The sentences that name a mode inline keep the exact English the theme
    // library has always shown.
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.useLightMode")).toBe(
      "Use light mode",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.useDarkMode")).toBe("Use dark mode");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.useForLightOnly")).toBe(
      "Use for light mode only",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.useForDarkOnly")).toBe(
      "Use for dark mode only",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.usePreviewDark")).toBe(
      "Use {name} dark mode",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.lightPaletteAdded")).toBe(
      "Its light palette was added.",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.darkPaletteAdded")).toBe(
      "Its dark palette was added.",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.nowDarkTheme")).toBe(
      "It’s now your dark theme.",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.panel.addDarkPalette")).toBe(
      "Add dark palette",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.panel.missingDarkPalette")).toBe(
      "“{name}” has no dark palette. Create a theme with the same name to add one.",
    );
    expect(translate("zh-CN", "settings.appearance.theme.searchResultOne", { count: 1 })).toBe(
      "找到 1 个支持的主题。",
    );
    expect(translate("zh-CN", "settings.appearance.theme.searchResultOther", { count: 4 })).toBe(
      "找到 4 个支持的主题。",
    );
    // The Open VSX name and the raw parser detail stay exactly as the API and
    // the parser produce them.
    expect(translate("zh-CN", "settings.appearance.theme.searchDescription")).toContain("Open VSX");
    expect(
      translate("zh-CN", "settings.appearance.theme.fileTooLarge", {
        size: "100.0 MB",
        limit: "256 KB",
      }),
    ).toBe("该文件为 100.0 MB。主题文件通常只有几 KB，因此未读取该文件（上限 256 KB）。");
    expect(
      translate("en", "settings.appearance.theme.fileTooLarge", {
        size: "100.0 MB",
        limit: "256 KB",
      }),
    ).toBe(
      "That file is 100.0 MB. Theme files are only a few KB, so this one was not read (limit 256 KB).",
    );
  });

  it("translates the theme import and Open VSX search copy", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.addTitle")).toBe("Add a theme");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.jsonLabel")).toBe("Theme JSON");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.chooseFiles")).toBe("Choose files");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.reading")).toBe("Reading…");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.alreadyInstalled")).toBe(
      "Already installed",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.searchPlaceholder")).toBe(
      "Search themes...",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.installing")).toBe("Installing...");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.updateTitle")).toBe(
      "Update “{name}”?",
    );

    expect(translate("zh-CN", "settings.appearance.theme.addTitle")).toBe("添加主题");
    expect(translate("zh-CN", "settings.appearance.theme.orImportFile")).toBe("或导入文件");
    expect(translate("zh-CN", "settings.appearance.theme.jsonLabel")).toBe("主题 JSON");
    expect(translate("zh-CN", "settings.appearance.theme.fileLabel")).toBe("主题文件");
    expect(translate("zh-CN", "settings.appearance.theme.chooseFiles")).toBe("选择文件");
    expect(translate("zh-CN", "settings.appearance.theme.reading")).toBe("正在读取…");
    expect(translate("zh-CN", "settings.appearance.theme.alreadyInstalled")).toBe("已安装");
    expect(translate("zh-CN", "settings.appearance.theme.updateExisting")).toBe("更新现有");
    expect(translate("zh-CN", "settings.appearance.theme.keepBoth")).toBe("两者都保留");
    expect(translate("zh-CN", "settings.appearance.theme.back")).toBe("返回");
    expect(translate("zh-CN", "settings.appearance.theme.searchHeading")).toBe("搜索社区主题");
    expect(translate("zh-CN", "settings.appearance.theme.searchLabel")).toBe("搜索 Open VSX 主题");
    expect(translate("zh-CN", "settings.appearance.theme.searchPlaceholder")).toBe("搜索主题...");
    expect(translate("zh-CN", "settings.appearance.theme.popular")).toBe("热门");
    expect(translate("zh-CN", "settings.appearance.theme.sort")).toBe("排序");
    expect(translate("zh-CN", "settings.appearance.theme.sortLabel")).toBe("主题排序");
    expect(translate("zh-CN", "settings.appearance.theme.sortMostDownloaded")).toBe("下载最多");
    expect(translate("zh-CN", "settings.appearance.theme.sortBestRated")).toBe("评分最高");
    expect(translate("zh-CN", "settings.appearance.theme.sortNewest")).toBe("最新");
    expect(translate("zh-CN", "settings.appearance.theme.sortMostRelevant")).toBe("最相关");
    expect(translate("zh-CN", "settings.appearance.theme.searching")).toBe("正在搜索主题...");
    expect(translate("zh-CN", "settings.appearance.theme.noResults")).toBe("未找到支持的开源主题");
    expect(translate("zh-CN", "settings.appearance.theme.broaderSearch")).toBe(
      "请尝试更宽泛的搜索。",
    );
    expect(translate("zh-CN", "settings.appearance.theme.install")).toBe("安装");
    expect(translate("zh-CN", "settings.appearance.theme.update")).toBe("更新");
    expect(translate("zh-CN", "settings.appearance.theme.installing")).toBe("正在安装...");
    expect(translate("zh-CN", "settings.appearance.theme.updating")).toBe("正在更新...");
    expect(translate("zh-CN", "settings.appearance.theme.updateTheme")).toBe("更新主题");
    expect(translate("zh-CN", "settings.appearance.theme.installAction", { name: "Dracula" })).toBe(
      "安装 Dracula",
    );
    expect(translate("zh-CN", "settings.appearance.theme.viewSource", { name: "Dracula" })).toBe(
      "查看 Dracula 的源代码",
    );
    expect(translate("zh-CN", "settings.appearance.theme.updateTitle", { name: "Dracula" })).toBe(
      "更新“Dracula”？",
    );
  });

  it("labels the theme editor groups, roles and color picker in the current language", () => {
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.group.foundation")).toBe(
      "Foundation",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.group.brandContent")).toBe(
      "Brand & content",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.family.raisedSurface")).toBe(
      "Raised surface",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.role.accent")).toBe("Accent color");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.role.surfaceRaised")).toBe(
      "Surface Raised",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.role.terminalScrollbarHover")).toBe(
      "Terminal Scrollbar Hover",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.panel.themeName")).toBe(
      "Theme name",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.panel.simpleHint")).toBe(
      "Two colors, rest derived",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.panel.advanced")).toBe("Advanced");
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.panel.saveChanges")).toBe(
      "Save changes",
    );
    expect(Reflect.get(EN_MESSAGES, "settings.appearance.theme.picker.chooseColor")).toBe(
      "Choose a color",
    );

    expect(translate("zh-CN", "settings.appearance.theme.group.foundation")).toBe("基础");
    expect(translate("zh-CN", "settings.appearance.theme.group.brandContent")).toBe("品牌与内容");
    expect(translate("zh-CN", "settings.appearance.theme.group.context")).toBe("上下文");
    expect(translate("zh-CN", "settings.appearance.theme.group.status")).toBe("状态");
    expect(translate("zh-CN", "settings.appearance.theme.family.background")).toBe("背景");
    expect(translate("zh-CN", "settings.appearance.theme.family.raisedSurface")).toBe("上层表面");
    expect(translate("zh-CN", "settings.appearance.theme.family.accent")).toBe("强调色");
    expect(translate("zh-CN", "settings.appearance.theme.family.terminalBackground")).toBe(
      "终端背景",
    );
    expect(translate("zh-CN", "settings.appearance.theme.family.error")).toBe("错误");
    expect(translate("zh-CN", "settings.appearance.theme.family.warning")).toBe("警告");
    expect(translate("zh-CN", "settings.appearance.theme.role.canvas")).toBe("背景");
    expect(translate("zh-CN", "settings.appearance.theme.role.mutedForeground")).toBe("弱化文本");
    expect(translate("zh-CN", "settings.appearance.theme.role.sidebarRowSelected")).toBe(
      "侧边栏行选中",
    );
    expect(translate("zh-CN", "settings.appearance.theme.panel.themeName")).toBe("主题名称");
    expect(translate("zh-CN", "settings.appearance.theme.panel.themeNameHint")).toBe("例如 Aurora");
    expect(translate("zh-CN", "settings.appearance.theme.panel.appearance")).toBe("外观");
    expect(translate("zh-CN", "settings.appearance.theme.panel.colors")).toBe("颜色");
    expect(translate("zh-CN", "settings.appearance.theme.panel.simpleHint")).toBe(
      "两种颜色，其余自动推导",
    );
    expect(translate("zh-CN", "settings.appearance.theme.panel.filterColors")).toBe("筛选颜色");
    expect(translate("zh-CN", "settings.appearance.theme.panel.advanced")).toBe("高级");
    expect(translate("zh-CN", "settings.appearance.theme.panel.saveChanges")).toBe("保存更改");
    expect(translate("zh-CN", "settings.appearance.theme.panel.noMatches")).toBe("无匹配项。");
    expect(translate("zh-CN", "settings.appearance.theme.panel.selectElement")).toBe(
      "选择元素 · 按 Esc 取消",
    );
    expect(translate("zh-CN", "settings.appearance.theme.panel.selectColor")).toBe(
      "在下方选择颜色",
    );
    expect(translate("zh-CN", "settings.appearance.theme.panel.inspect")).toBe("检查");
    expect(translate("zh-CN", "settings.appearance.theme.panel.inspectLabel")).toBe("检查应用颜色");
    expect(translate("zh-CN", "settings.appearance.theme.panel.minimize")).toBe("最小化主题编辑器");
    expect(translate("zh-CN", "settings.appearance.theme.panel.close")).toBe("关闭主题编辑器");
    expect(
      translate("zh-CN", "settings.appearance.theme.panel.usageOther", {
        label: "背景",
        count: 3,
      }),
    ).toBe("背景 · 3 处使用");
    expect(
      translate("zh-CN", "settings.appearance.theme.panel.mergeInto", { name: "Aurora" }),
    ).toBe("合并到“Aurora”");
    expect(
      translate("zh-CN", "settings.appearance.theme.panel.missingDarkPalette", {
        name: "Aurora",
      }),
    ).toBe("“Aurora”没有深色配色。创建一个同名主题即可添加。");
    expect(
      translate("zh-CN", "settings.appearance.theme.panel.mergeDarkCollision", {
        name: "Aurora",
      }),
    ).toBe("“Aurora”已有深色配色。请换一个名称。");
    expect(translate("zh-CN", "settings.appearance.theme.panel.activateFailed")).toBe(
      "主题已保存，但无法启用。请重试。",
    );
    expect(translate("zh-CN", "settings.appearance.theme.picker.chooseColor")).toBe("选择颜色");
    expect(
      translate("zh-CN", "settings.appearance.theme.picker.chooseColorLabel", { label: "背景" }),
    ).toBe("选择背景颜色");
    expect(
      translate("zh-CN", "settings.appearance.theme.picker.saturationBrightness", {
        label: "背景",
      }),
    ).toBe("背景 饱和度和亮度");
    expect(
      translate("zh-CN", "settings.appearance.theme.picker.saturationBrightnessValue", {
        saturation: 40,
        brightness: 90,
      }),
    ).toBe("饱和度 40%，亮度 90%");
    expect(translate("zh-CN", "settings.appearance.theme.picker.hue", { label: "背景" })).toBe(
      "背景 色相",
    );
    expect(
      translate("zh-CN", "settings.appearance.theme.picker.hideUsage", { label: "背景" }),
    ).toBe("隐藏背景的用途");
    expect(
      translate("zh-CN", "settings.appearance.theme.picker.hideUsageTooltip", {
        label: "背景",
      }),
    ).toBe("隐藏背景的使用位置");
    expect(translate("zh-CN", "settings.appearance.theme.picker.hexValue", { label: "背景" })).toBe(
      "背景 HEX 值",
    );
  });
});
