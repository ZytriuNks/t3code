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
    expect(
      translate("zh-CN", "settings.general.backgroundActivity.sharedPolicySummary", {
        profile: "均衡",
      }),
    ).toBe("共享策略：均衡。");
  });

  it("keeps brand and product names in the general page copy", () => {
    expect(translate("zh-CN", "settings.general.version.title")).toBe("版本");
    expect(translate("zh-CN", "settings.general.version.nightly")).toBe("Nightly");
    expect(translate("zh-CN", "settings.general.workspace.title")).toBe("工作区");
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
