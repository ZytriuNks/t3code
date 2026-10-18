import { describe, expect, it } from "vite-plus/test";

import { resolveAppLanguage, resolveSystemLocale } from "./locale";

describe("resolveAppLanguage", () => {
  it.each(["zh-CN", "zh-SG", "zh-Hans", "zh"])(
    "uses simplified Chinese for the supported system locale %s",
    (systemLocale) => {
      expect(resolveAppLanguage("system", systemLocale)).toBe("zh-CN");
    },
  );

  it.each(["zh-TW", "zh-HK", "zh-Hant", "en-US", "de-DE", null, undefined])(
    "falls back to English for the unsupported system locale %s",
    (systemLocale) => {
      expect(resolveAppLanguage("system", systemLocale)).toBe("en");
    },
  );

  it("keeps an explicit language independent of the system locale", () => {
    expect(resolveAppLanguage("en", "zh-CN")).toBe("en");
    expect(resolveAppLanguage("zh-CN", "en-US")).toBe("zh-CN");
  });
});

describe("resolveSystemLocale", () => {
  it("prefers the desktop host locale over the browser locale", () => {
    expect(
      resolveSystemLocale({
        desktopLocale: "zh-CN",
        browserLanguages: ["en-US"],
      }),
    ).toBe("zh-CN");
  });

  it("uses the first browser locale when the host reports none", () => {
    expect(resolveSystemLocale({ desktopLocale: null, browserLanguages: ["zh-SG", "en-US"] })).toBe(
      "zh-SG",
    );
  });
});
