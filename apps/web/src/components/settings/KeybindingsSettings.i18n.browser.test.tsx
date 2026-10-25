import type { ReactNode } from "react";
import { render } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const localeState = vi.hoisted(() => ({ language: "zh-CN" as "zh-CN" | "en" }));

vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  return {
    useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
      const settings = { ...DEFAULT_CLIENT_SETTINGS, language: localeState.language };
      return selector ? selector(settings) : settings;
    },
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: { upsertKeybinding: vi.fn(), removeKeybinding: vi.fn() },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set(["primary"]),
}));
vi.mock("./SettingsScopeContext", () => {
  const environment = {
    environmentId: "primary",
    serverConfig: { keybindings: [], keybindingsConfigPath: "/fixture/keybindings.json" },
  };
  return {
    useSettingsScope: () => ({ environment, connectedEnvironments: [environment] }),
  };
});
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title?: ReactNode;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ title, control }: { title: ReactNode; control?: ReactNode }) => (
    <div>
      <span>{title}</span>
      {control}
    </div>
  ),
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

function panel() {
  return (
    <I18nProvider>
      <KeybindingsSettingsPanel />
    </I18nProvider>
  );
}

describe("Keybindings panel localization", () => {
  it("renders actions and filters by localized command labels", async () => {
    localeState.language = "zh-CN";
    await using screen = await render(panel());
    await expect.element(screen.getByRole("heading", { name: "快捷键" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "添加快捷键" })).toBeVisible();
    await expect.element(screen.getByText("侧栏: 切换", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("预览: 聚焦地址栏", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "打开 keybindings.json" }))
      .toBeVisible();
    await userEvent.type(screen.getByRole("searchbox", { name: "搜索快捷键" }), "侧栏");
    await expect.element(screen.getByText("侧栏: 切换", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("预览: 聚焦地址栏", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("follows a language change without remounting", async () => {
    localeState.language = "zh-CN";
    await using screen = await render(panel());
    localeState.language = "en";
    await screen.rerender(panel());
    await expect.element(screen.getByRole("heading", { name: "Keybindings" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add keybinding" })).toBeVisible();
    await expect.element(screen.getByText("Sidebar: Toggle", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Preview: Focus URL", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("searchbox", { name: "Search keybindings" }))
      .toBeVisible();
  });
});
