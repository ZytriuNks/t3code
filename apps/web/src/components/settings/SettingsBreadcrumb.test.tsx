import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const settingsState = vi.hoisted(() => ({ language: "zh-CN" as "system" | "en" | "zh-CN" }));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector: (settings: typeof settingsState) => T) =>
    selector(settingsState),
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";

function renderBreadcrumb(language: "en" | "zh-CN") {
  settingsState.language = language;
  return renderToStaticMarkup(
    <I18nProvider>
      <SettingsBreadcrumb
        pathname="/settings/appearance"
        scope={{
          value: {},
          groups: [],
          environments: [],
          onChange: vi.fn(),
        }}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  settingsState.language = "zh-CN";
});

describe("SettingsBreadcrumb", () => {
  it("renders the settings header and broad scopes in Simplified Chinese", () => {
    const markup = renderBreadcrumb("zh-CN");

    expect(markup).toContain('aria-label="设置面包屑"');
    expect(markup).toContain("设置");
    expect(markup).toContain("外观");
    expect(markup).toContain("全部环境");
    expect(markup).toContain("全部项目");
  });

  it("keeps the existing English copy", () => {
    const markup = renderBreadcrumb("en");

    expect(markup).toContain('aria-label="Settings breadcrumb"');
    expect(markup).toContain("Settings");
    expect(markup).toContain("Appearance");
    expect(markup).toContain("All environments");
    expect(markup).toContain("All projects");
  });
});
