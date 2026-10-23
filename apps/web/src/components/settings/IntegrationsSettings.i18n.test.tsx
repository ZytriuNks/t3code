import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type BrowserImportSource,
  type DeviceServiceState,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

// Popups and dialogs portal out of the test renderer, so the primitives
// render their content inline; the production component drives open state.
vi.mock("../ui/menu", () => ({
  Menu: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div data-menu="" data-on-open-change={onOpenChange}>
      {children}
    </div>
  ),
  MenuTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuGroupLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  MenuSeparator: () => null,
  MenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogClose: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => (
    <button type="button" aria-label={props["aria-label"]}>
      {children}
    </button>
  ),
  SelectValue: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectGroupLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: () => null,
}));
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
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/environments", () => ({
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
import { Badge } from "../ui/badge";
import { IntegrationsSettingsPanel } from "./IntegrationsSettings";

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  mocks.language.current = "zh-CN";
  mocks.listBrowserImportSources
    .mockReset()
    .mockResolvedValue([{ id: "chrome", name: "Chrome" } as unknown as BrowserImportSource]);
  mocks.clearCookies.mockReset().mockResolvedValue(undefined);
  mocks.clearCache.mockReset().mockResolvedValue(undefined);
  mocks.toastAdd.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const panel = () => (
  <I18nProvider>
    <IntegrationsSettingsPanel />
  </I18nProvider>
);

async function mount() {
  await act(() => {
    renderer = create(panel());
  });
}

function textContents(): string[] {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") collected.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object" && "children" in node)
      walk((node as { children: unknown }).children);
  };
  walk(renderer?.toJSON());
  return collected;
}

const text = () => textContents().join("");
const ariaLabels = () =>
  renderer!.root
    .findAll(
      (node) => typeof node.type === "string" && typeof node.props["aria-label"] === "string",
    )
    .map((node) => node.props["aria-label"] as string);

function buttonNamed(label: string): ReactTestInstance {
  const matches = renderer!.root.findAll(
    (node) => node.type === "button" && flatText(node) === label,
  );
  expect(matches.length, `button "${label}"`).toBeGreaterThan(0);
  return matches[0]!;
}

function flatText(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map(flatText).join("");
}

async function openProfilesMenu() {
  const menu = renderer!.root.find(
    (node) =>
      node.props["data-menu"] === "" && typeof node.props["data-on-open-change"] === "function",
  );
  await act(async () => {
    (menu.props["data-on-open-change"] as (open: boolean) => void)(true);
  });
}

describe("Integrations settings localization", () => {
  it("renders the browser profiles menu and saved profile row in Simplified Chinese", async () => {
    await mount();
    expect(text()).toContain("添加配置文件");
    expect(text()).toContain("空白配置文件");
    expect(text()).toContain("导入来源");
    expect(text()).toContain("正在查找浏览器…");
    expect(renderer!.root.findAllByType(Badge).map(flatText)).toEqual(["默认"]);
    expect(text()).toContain("设为默认");
    expect(text()).toContain("清除 Cookie 和缓存");
    expect(text()).toContain("移除配置文件和数据");
    expect(ariaLabels()).toContain("重命名Work");
    expect(ariaLabels()).toContain("Work选项");
    expect(ariaLabels()).toContain("Default选项");

    await openProfilesMenu();
    expect(mocks.listBrowserImportSources).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Chrome");
    expect(text()).toContain("连接环境后才能导入 Cookie");
  });

  it("localizes the remaining browser and device controls", async () => {
    await mount();
    expect(text()).toContain("标准");
    expect(text()).toContain("浅色");
    expect(text()).toContain("默认浏览器");
    expect(text()).toContain("刷新");
    expect(text()).toContain("Mac的状态。选择环境以查看其模拟器支持情况。");
    expect(text()).toContain(
      "启用此环境即可打开模拟器和仿真器，无论它们运行在本机还是远程设备主机上。",
    );
    const labels = ariaLabels();
    expect(labels).toContain("旋转为横向");
    expect(labels).toContain("链接打开位置");
    expect(labels).toContain("自动显示浮动预览");
    expect(labels).toContain("设备中心");
    expect(labels).toContain("代理设备访问");
  });

  it("localizes clearing and removing a saved profile", async () => {
    await mount();
    await act(async () => {
      buttonNamed("清除 Cookie 和缓存").props.onClick();
    });
    expect(mocks.toastAdd).toHaveBeenCalledWith({
      type: "success",
      title: "已清除Default的 Cookie 和缓存",
    });

    const removeButtons = renderer!.root.findAll(
      (node) => node.type === "button" && flatText(node) === "移除配置文件和数据",
    );
    // Only the user profile can be removed; the built-in Default has no remove item.
    expect(removeButtons).toHaveLength(1);
    await act(async () => {
      removeButtons[0]!.props.onClick();
    });
    expect(text()).toContain("要移除“Work”吗？");
    // The upstream description now covers server tabs; that copy stays untranslated.
    expect(text()).toContain("server browser tabs close now");

    mocks.clearCookies.mockRejectedValueOnce(new Error("locked"));
    const confirm = renderer!.root
      .findAll((node) => node.type === "button" && flatText(node) === "移除配置文件和数据")
      .at(-1)!;
    await act(async () => {
      confirm.props.onClick();
    });
    expect(text()).toContain("无法删除配置文件数据。请重试。");
  });

  it("follows a switch from English to Simplified Chinese without remounting", async () => {
    mocks.language.current = "en";
    await mount();
    expect(text()).toContain("Add profile");
    expect(text()).toContain("Import from");
    expect(text()).toContain("Set as default");
    expect(text()).toContain("Standard");
    expect(text()).toContain("Refresh");
    expect(ariaLabels()).toContain("Work options");
    expect(ariaLabels()).toContain("Rename Work");
    expect(ariaLabels()).toContain("Device hub");

    mocks.language.current = "zh-CN";
    await act(() => {
      renderer!.update(panel());
    });
    expect(text()).toContain("添加配置文件");
    expect(text()).toContain("导入来源");
    expect(text()).toContain("设为默认");
    expect(text()).toContain("标准");
    expect(text()).toContain("刷新");
    expect(text()).not.toContain("Add profile");
    expect(ariaLabels()).toContain("Work选项");
    expect(ariaLabels()).toContain("重命名Work");
    expect(ariaLabels()).toContain("设备中心");
  });
});
