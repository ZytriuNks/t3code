import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ language: "zh-CN" as "zh-CN" | "en" }));
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
vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "unavailable", message: "Hidden by the current selection", environmentIds: [] },
    environments: [],
    connectedEnvironments: [],
    environment: null,
    targets: [],
    target: null,
  }),
}));

import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

describe("Scheduled tasks panel localization", () => {
  it("renders the create action and unavailable selection in Simplified Chinese", async () => {
    state.language = "zh-CN";
    await using screen = await render(<ScheduledTasksSettings />);
    await expect
      .element(screen.getByRole("heading", { name: "计划任务", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "新建任务", exact: true }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("heading", { name: "选择不可用", exact: true }))
      .toBeVisible();
  });

  it("follows a language change without remounting", async () => {
    state.language = "zh-CN";
    await using screen = await render(<ScheduledTasksSettings />);
    await expect
      .element(screen.getByRole("heading", { name: "计划任务", exact: true }))
      .toBeVisible();
    state.language = "en";
    await screen.rerender(<ScheduledTasksSettings />);
    await expect
      .element(screen.getByRole("heading", { name: "Scheduled tasks", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "New task", exact: true }))
      .toBeDisabled();
  });
});
