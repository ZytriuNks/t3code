import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type BrowserImportSource,
  type DeviceServiceState,
} from "@t3tools/contracts";
import { StrictMode, type ReactNode } from "react";
import "~/index.css";
import { render } from "../../../test/render";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  language: { current: "zh-CN" as "en" | "zh-CN" },
  listBrowserImportSources: vi.fn(),
  clearCookies: vi.fn(),
  clearCache: vi.fn(),
  toastAdd: vi.fn(),
}));

const primaryId = EnvironmentId.make("env-mac");
const secondaryId = EnvironmentId.make("env-linux");
const connected = (environmentId: EnvironmentId, label: string) => ({
  environmentId,
  label,
  connection: { phase: "connected" },
  serverConfig: { settings: { enableDeviceSupport: true } },
});

vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toastManager: { add: mocks.toastAdd },
}));
vi.mock("../preview/previewBridge", () => ({
  previewBridge: {
    listBrowserImportSources: mocks.listBrowserImportSources,
    clearCookies: mocks.clearCookies,
    clearCache: mocks.clearCache,
  },
}));
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({
    environments: [connected(primaryId, "Mac"), connected(secondaryId, "Linux")],
    isReady: true,
  }),
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../state/device", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/device")>()),
  useDeviceState: (): { state: DeviceServiceState; loaded: boolean } => ({
    state: {
      hosts: [],
      hostStatus: "ready",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: true,
      agentAccessEnabled: false,
      hubBasePath: "/api/device-hub",
      revision: 0,
    },
    loaded: true,
  }),
}));
vi.mock("../device/DeviceHostUpdates", () => ({ DeviceHostUpdates: () => null }));
vi.mock("./DeviceHostsSettings", () => ({ DeviceHostsSettings: () => null }));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Connect to an environment",
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      language: mocks.language.current,
      browserProfiles: [{ id: "profile-work", name: "Work", kind: "persistent" as const }],
      browserDefaultViewport: { _tag: "freeform" as const, width: 390, height: 844 },
    };
    return selector ? selector(settings) : settings;
  },
  getClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    browserProfiles: [{ id: "profile-work", name: "Work", kind: "persistent" as const }],
  }),
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useScopedSettings: () => ({ ...DEFAULT_UNIFIED_SETTINGS, enableDeviceSupport: true }),
  useUpdateScopedSettings: () => vi.fn(),
  useScopedSettingsMixed: () => false,
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [primaryId, secondaryId] },
    search: {},
    environment: connected(primaryId, "Mac"),
    environments: [],
    target: null,
    connectedEnvironments: [connected(primaryId, "Mac"), connected(secondaryId, "Linux")],
    targets: [],
  }),
  useOptionalSettingsScope: () => null,
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { IntegrationsSettingsPanel } from "./IntegrationsSettings";

vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => vi.fn(),
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useServerConfigs: () => new Map(),
}));
function setup() {
  mocks.language.current = "zh-CN";
  mocks.listBrowserImportSources.mockReset().mockResolvedValue([{ id: "chrome", name: "Chrome" }]);
  mocks.clearCookies.mockReset().mockResolvedValue(undefined);
  mocks.clearCache.mockReset().mockResolvedValue(undefined);
  mocks.toastAdd.mockReset();
}
const panel = () => (
  <StrictMode>
    <I18nProvider>
      <IntegrationsSettingsPanel />
    </I18nProvider>
  </StrictMode>
);

describe("Integrations settings localization", () => {
  it("renders browser sections in Chinese and places devices after the browser", async () => {
    setup();
    await using screen = await render(panel());
    for (const label of ["浏览器", "浏览器配置文件", "默认浏览器视口", "设备"]) {
      await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
    }
    const sections = [...screen.container.querySelectorAll("section[id]")].map((node) => node.id);
    expect(sections.indexOf("devices")).toBeGreaterThan(sections.indexOf("browser"));
  });
  it("does not scan browser files when entering or revisiting settings", async () => {
    setup();
    await using screen = await render(panel());
    expect(mocks.listBrowserImportSources).not.toHaveBeenCalled();
    await screen.unmount();
    await using _reopened = await render(panel());
    expect(mocks.listBrowserImportSources).not.toHaveBeenCalled();
  });
  it("loads import sources only when opening the translated profiles menu", async () => {
    setup();
    let resolveSources!: (sources: BrowserImportSource[]) => void;
    mocks.listBrowserImportSources.mockReturnValue(
      new Promise<BrowserImportSource[]>((resolve) => {
        resolveSources = resolve;
      }),
    );
    await using screen = await render(panel());
    await expect.element(screen.getByText("默认", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "重命名Work" })).toBeVisible();
    await screen.getByRole("button", { name: "添加配置文件" }).click();
    await expect.element(page.getByText("空白配置文件", { exact: true })).toBeVisible();
    await expect.element(page.getByText("导入来源", { exact: true })).toBeVisible();
    await expect.element(page.getByText("正在查找浏览器…", { exact: true })).toBeVisible();
    expect(mocks.listBrowserImportSources).toHaveBeenCalledOnce();
    resolveSources([{ id: "chrome", name: "Chrome" } as BrowserImportSource]);
    await expect.element(page.getByRole("menuitem", { name: "Chrome" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "Chrome" })).toBeDisabled();
    await expect
      .element(page.getByText("连接环境后才能导入 Cookie", { exact: true }))
      .toBeVisible();
  });
  it("localizes the browser and device controls", async () => {
    setup();
    await using screen = await render(panel());
    await screen.getByRole("combobox", { name: "默认浏览器视口", exact: true }).click();
    await expect.element(page.getByText("标准", { exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await screen.getByRole("combobox", { name: "默认浏览器外观", exact: true }).click();
    await expect.element(page.getByRole("option", { name: "浅色", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("combobox", { name: "链接打开位置" }))
      .toHaveTextContent("默认浏览器");
    for (const label of [
      "旋转为横向",
      "链接打开位置",
      "自动显示浮动预览",
      "设备中心",
      "代理设备访问",
    ]) {
      await expect.element(screen.getByLabelText(label, { exact: true })).toBeVisible();
    }
    await expect.element(screen.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
  });
  it("clears a built-in profile and reports a saved profile removal failure", async () => {
    setup();
    await using screen = await render(panel());
    await screen.getByRole("button", { name: "Default选项" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "移除配置文件和数据" }))
      .not.toBeInTheDocument();
    await page.getByRole("menuitem", { name: "清除 Cookie 和缓存" }).click();
    await vi.waitFor(() =>
      expect(mocks.toastAdd).toHaveBeenCalledWith({
        type: "success",
        title: "已清除Default的 Cookie 和缓存",
      }),
    );
    await screen.getByRole("button", { name: "Work选项" }).click();
    await expect.element(page.getByRole("menuitem", { name: "设为默认" })).toBeVisible();
    await page.getByRole("menuitem", { name: "移除配置文件和数据" }).click();
    await expect
      .element(page.getByRole("heading", { name: "要移除“Work”吗？", exact: true }))
      .toBeVisible();
    expect(page.getByRole("alertdialog").element().textContent).toContain(
      "server browser tabs close now",
    );
    mocks.clearCookies.mockRejectedValueOnce(new Error("locked"));
    await page.getByRole("button", { name: "移除配置文件和数据", exact: true }).click();
    await expect
      .element(page.getByText("无法删除配置文件数据。请重试。", { exact: true }))
      .toBeVisible();
  });
  it("follows a switch from English to Chinese without remounting", async () => {
    setup();
    mocks.language.current = "en";
    await using screen = await render(panel());
    await expect.element(screen.getByRole("button", { name: "Add profile" })).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "Rename Work" })).toBeVisible();
    await screen.getByRole("button", { name: "Work options" }).click();
    await expect.element(page.getByRole("menuitem", { name: "Set as default" })).toBeVisible();
    mocks.language.current = "zh-CN";
    await screen.rerender(panel());
    await expect.element(page.getByRole("menuitem", { name: "设为默认" })).toBeVisible();
    await expect
      .element(page.getByRole("menuitem", { name: "Set as default" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByRole("button", { name: "添加配置文件" })).toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "重命名Work" })).toBeVisible();
    await expect.element(screen.getByLabelText("设备中心", { exact: true })).toBeVisible();
  });
});

import { platformSetupStatus } from "../device/DeviceSetup";
import { translate } from "../../i18n/messages";
const english = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
  translate("en", key, values);
const chinese = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
  translate("zh-CN", key, values);

const deviceState = (overrides: Partial<DeviceServiceState> = {}): DeviceServiceState => ({
  hosts: [
    {
      id: "local",
      kind: "local",
      label: "This machine",
      hubInstalled: false,
      agentDeviceInstalled: false,
      platforms: [
        { platform: "ios", available: true },
        { platform: "android", available: true },
      ],
    },
  ],
  hostStatus: "ready",
  hostStatuses: {},
  devices: [],
  sessions: [],
  onboardingCompleted: false,
  agentAccessEnabled: false,
  hubBasePath: "/api/device-hub",
  revision: 0,
  ...overrides,
});

describe("device setup guidance", () => {
  it("localizes the platform guidance using the supplied copy", () => {
    expect(platformSetupStatus(deviceState(), "ios", chinese).message).toBe(
      "已安装 Xcode，但没有可用的 iOS 模拟器。请在 Xcode 设置 → 组件中安装运行时。",
    );
  });

  it("directs users to install an iOS runtime and create an Android virtual device", () => {
    expect(platformSetupStatus(deviceState(), "ios", english).message).toContain("Xcode Settings");
    expect(platformSetupStatus(deviceState(), "android", english).message).toContain(
      "Device Manager",
    );
  });

  it("preserves a specific missing-tool explanation from the server", () => {
    const state = deviceState({
      hosts: [
        {
          ...deviceState().hosts[0]!,
          platforms: [
            { platform: "ios", available: true },
            { platform: "android", available: false, reason: "Android Emulator is missing." },
          ],
        },
      ],
    });
    expect(platformSetupStatus(state, "android", english).message).toBe(
      "Android Emulator is missing.",
    );
  });
});
