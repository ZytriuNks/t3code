import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type DeviceServiceState,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, StrictMode, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { languageState, listBrowserImportSources } = vi.hoisted(() => ({
  languageState: { current: "zh-CN" as "system" | "en" | "zh-CN" },
  listBrowserImportSources: vi.fn().mockResolvedValue([]),
}));

vi.mock("../preview/previewBridge", () => ({
  previewBridge: { listBrowserImportSources },
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [], isReady: true }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Connect to an environment",
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, language: languageState.current };
    return selector ? selector(settings) : settings;
  },
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: () => DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
}));
// The scoped agent-access rows need the settings layout's scope provider;
// this test covers the device-local browser sections only.
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  }),
  useOptionalSettingsScope: () => null,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";
import { platformSetupStatus } from "../device/DeviceSetup";
import { I18nProvider } from "../../i18n/I18nProvider";
import { translate } from "../../i18n/messages";

let renderer: ReactTestRenderer | undefined;
const english = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
  translate("en", key, values);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: { href: "http://localhost/" },
    history: {
      scrollRestoration: "auto",
      replaceState: vi.fn(),
      pushState: vi.fn(),
    },
  });
  vi.stubGlobal("self", globalThis.window);
  vi.stubGlobal("history", {
    scrollRestoration: "auto",
    replaceState: vi.fn(),
    pushState: vi.fn(),
  });
  vi.stubGlobal("document", {
    documentElement: { lang: "en" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn().mockReturnValue(null),
  });
  listBrowserImportSources.mockClear();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(() => {
    renderer = create(
      <StrictMode>
        <I18nProvider>
          <RouterProvider router={router} />
        </I18nProvider>
      </StrictMode>,
    );
  });
  expect(renderer!.root.findByType(IntegrationsSettingsPanel)).toBeDefined();
}

function textContents(): string[] {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      collected.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer?.toJSON());
  return collected;
}

describe("Integrations browser discovery", () => {
  it("renders the browser and device sections in Simplified Chinese", async () => {
    await openSettings();
    expect(textContents()).toContain("浏览器");
    expect(textContents()).toContain("浏览器配置文件");
    expect(textContents()).toContain("默认浏览器视口");
    expect(textContents()).toContain("设备");
    expect(
      renderer!.root.findAll((node) => node.props["aria-label"] === "默认浏览器视口"),
    ).not.toHaveLength(0);
  });

  it("does not scan browser files when entering or revisiting settings", async () => {
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();

    await act(() => renderer?.unmount());
    await openSettings();
    expect(listBrowserImportSources).not.toHaveBeenCalled();
  });

  it("places device settings directly after browser settings", async () => {
    await openSettings();
    const sections = renderer!.root
      .findAll((node) => node.type === "section")
      .map((node) => node.props.id)
      .filter(Boolean);
    expect(sections.indexOf("devices")).toBeGreaterThan(sections.indexOf("browser"));
  });
});

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
