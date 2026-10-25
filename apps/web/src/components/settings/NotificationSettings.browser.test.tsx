import { type ClientSettingsPatch } from "@t3tools/contracts";
import { render, stubGlobal } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const languageState = vi.hoisted(() => ({
  current: "zh-CN" as "system" | "en" | "zh-CN",
}));
const notificationSettings = vi.hoisted(() => ({
  current: { notificationMode: "off" },
  update: vi.fn<(patch: ClientSettingsPatch) => Promise<void>>(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: <T,>(selector?: (settings: { language: "system" | "en" | "zh-CN" }) => T) =>
    selector ? selector({ language: languageState.current }) : { language: languageState.current },
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: <T,>(
    selector?: (settings: { notificationMode: string }) => T,
  ): T | { notificationMode: string } =>
    selector ? selector(notificationSettings.current) : notificationSettings.current,
  useUpdateScopedSettings: () => notificationSettings.update,
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    readonly title?: React.ReactNode;
    readonly description?: React.ReactNode;
    readonly control?: React.ReactNode;
  }) => (
    <div data-slot="settings-row">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {control}
    </div>
  ),
}));
import { I18nProvider } from "../../i18n/I18nProvider";
import { NotificationSettings } from "./NotificationSettings";

function setup() {
  languageState.current = "zh-CN";
  notificationSettings.current = { notificationMode: "off" };
  notificationSettings.update.mockReset().mockResolvedValue(undefined);
}
function view() {
  return (
    <I18nProvider>
      <NotificationSettings />
    </I18nProvider>
  );
}

describe("notification settings", () => {
  it("shows the notification modes and row copy in Simplified Chinese", async () => {
    setup();
    await using screen = await render(view());
    const trigger = screen.getByRole("combobox");
    await expect.element(trigger).toHaveTextContent("关闭");
    await expect
      .element(
        screen.getByText(
          "线程完成、失败或需要输入或审批时发出系统提醒。在 T3 Code 打开期间适用于此设备。",
        ),
      )
      .toBeVisible();
    await trigger.click();
    for (const label of ["关闭", "仅通知", "仅声音", "通知和声音"]) {
      await expect.element(page.getByRole("option", { name: label, exact: true })).toBeVisible();
    }
  });
  it("explains unsupported browser notifications without saving the selection", async () => {
    setup();
    using _insecure = stubGlobal("isSecureContext", false);
    await using screen = await render(view());
    await screen.getByRole("combobox").click();
    await page.getByRole("option", { name: "仅通知", exact: true }).click();
    await expect
      .element(
        screen.getByText("通知需要受支持的浏览器通过 HTTPS 打开，或使用桌面应用。仍可选择仅声音。"),
      )
      .toBeVisible();
    expect(notificationSettings.update).not.toHaveBeenCalled();
  });
  it("unlocks sound and saves the granted notification mode", async () => {
    setup();
    const resume = vi.fn().mockResolvedValue(undefined);
    using _secure = stubGlobal("isSecureContext", true);
    using _notification = stubGlobal("Notification", {
      requestPermission: vi.fn().mockResolvedValue("granted"),
    });
    using _audio = stubGlobal(
      "AudioContext",
      class {
        readonly state = "running";
        readonly resume = resume;
      },
    );
    await using screen = await render(view());
    await screen.getByRole("combobox").click();
    await page.getByRole("option", { name: "通知和声音", exact: true }).click();
    await vi.waitFor(() =>
      expect(notificationSettings.update).toHaveBeenCalledExactlyOnceWith({
        notificationMode: "notifications-and-sound",
      }),
    );
    expect(resume).toHaveBeenCalledOnce();
  });
});
