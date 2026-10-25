import type { ReactNode } from "react";
import { render } from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));

vi.mock("../../i18n/I18nProvider", async (original) => {
  const { translate } = await import("../../i18n/messages");
  return {
    ...(await original<typeof import("../../i18n/I18nProvider")>()),
    useI18n: () => ({
      language: state.language,
      t: (
        key: import("../../i18n/messages").MessageKey,
        values?: import("../../i18n/messages").MessageValues,
      ) => translate(state.language, key, values),
    }),
  };
});
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironmentProviders: () => new Map(),
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    target: null,
    targets: [],
    connectedEnvironments: [{ environmentId: "primary" }],
  }),
}));
vi.mock("./useScopedSettings", async (original) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  return {
    ...(await original<typeof import("./useScopedSettings")>()),
    useScopedSettings: () => ({ ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "full-access" }),
    useScopedSettingsMixed: () => false,
    useScopedSettingSource: () => null,
    useUpdateScopedSettings: () => vi.fn(),
  };
});
vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingResetButton: () => null,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ title, control }: { title?: ReactNode; control?: ReactNode }) => (
    <div>
      <h3>{title}</h3>
      {control}
    </div>
  ),
}));
import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";

describe("Default permissions localization", () => {
  it("translates the permission picker and its options without remounting", async () => {
    state.language = "en";
    await using screen = await render(<ProjectDefaultsSettings category="general" />);
    await expect
      .element(screen.getByRole("heading", { name: "Permissions", exact: true }))
      .toBeVisible();
    const trigger = screen.getByRole("combobox", { name: "Default permissions" });
    await expect.element(trigger).toHaveTextContent("Full access");
    await trigger.click();
    await expect.element(page.getByRole("option", { name: /Supervised/ })).toBeVisible();
    await expect
      .element(page.getByText("Ask before commands and file changes.", { exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    state.language = "zh-CN";
    await screen.rerender(<ProjectDefaultsSettings category="general" />);
    await expect.element(screen.getByRole("heading", { name: "权限", exact: true })).toBeVisible();
    const translatedTrigger = screen.getByRole("combobox", { name: "默认权限" });
    await expect.element(translatedTrigger).toHaveTextContent("完全访问");
    await translatedTrigger.click();
    await expect.element(page.getByRole("option", { name: /监督模式/ })).toBeVisible();
    await expect
      .element(page.getByText("执行命令和更改文件前先询问。", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Full access", { exact: true })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await screen.getByRole("combobox", { name: "默认工作区" }).click();
    await expect.element(page.getByRole("option", { name: "当前检出", exact: true })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "新工作树", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await screen.getByRole("combobox", { name: "工作树子模块" }).click();
    await expect.element(page.getByRole("option", { name: "递归", exact: true })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "仅顶层", exact: true })).toBeVisible();
  });
});
