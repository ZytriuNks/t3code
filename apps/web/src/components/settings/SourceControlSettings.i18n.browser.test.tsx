import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const localeState = vi.hoisted(() => ({ language: "zh-CN" as "zh-CN" | "en" }));

vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, language: localeState.language };
    return selector ? selector(settings) : settings;
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
  }),
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SourceControlWritingSettings", () => ({
  SourceControlWritingSettingsSection: () => null,
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingsSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  PolicyTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingResetButton: () => null,
  SettingsSearchTarget: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSettingsSearchTargetId: () => "source-control",
}));

import { SourceControlSettingsPanel } from "./SourceControlSettings";
import { I18nProvider } from "../../i18n/I18nProvider";

function panel() {
  return (
    <I18nProvider>
      <SourceControlSettingsPanel />
    </I18nProvider>
  );
}

describe("SourceControlSettings localization", () => {
  it("renders the server environment empty state in Simplified Chinese", async () => {
    localeState.language = "zh-CN";
    await using screen = await render(panel());
    await expect.element(screen.getByText("服务器环境", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("连接一个环境以检查其版本控制工具和托管集成。"))
      .toBeVisible();
  });

  it("follows language changes without remounting the settings page", async () => {
    localeState.language = "zh-CN";
    await using screen = await render(panel());
    localeState.language = "en";
    await screen.rerender(panel());
    await expect.element(screen.getByText("Server environment", { exact: true })).toBeVisible();
    await expect
      .element(
        screen.getByText(
          "Connect an environment to inspect its version control tools and hosting integrations.",
        ),
      )
      .toBeVisible();
    localeState.language = "zh-CN";
    await screen.rerender(panel());
    await expect.element(screen.getByText("服务器环境", { exact: true })).toBeVisible();
  });
});
