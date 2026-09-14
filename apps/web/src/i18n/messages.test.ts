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
