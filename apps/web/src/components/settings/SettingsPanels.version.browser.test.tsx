import { RegistryContext } from "@effect/atom-react";
import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));
vi.mock("../../i18n/I18nProvider", async (original) => {
  const { translate } = await import("../../i18n/messages");
  return {
    ...(await original<typeof import("../../i18n/I18nProvider")>()),
    useI18n: () => ({
      language: state.language,
      t: (key: import("../../i18n/messages").MessageKey) => translate(state.language, key),
    }),
  };
});

vi.mock("../../branding", async (original) => ({
  ...(await original<typeof import("../../branding")>()),
  APP_VERSION: "0.0.45",
}));
vi.mock("../../env", async (original) => ({
  ...(await original<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => DEFAULT_UNIFIED_SETTINGS,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./useScopedModelAvailability", () => ({ useScopedModelDisabledReason: () => () => null }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
    target: null,
    targets: [],
  }),
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ id, title }: { id?: string; title?: ReactNode }) =>
    id === "app-version" ? <section>{title}</section> : <h3>{title}</h3>,
  SettingsSection: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SettingsPageContainer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SettingsRowCopyProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SettingResetButton: () => null,
  useSettingsSearchTarget: () => null,
  useSettingsSearchTargetId: () => null,
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./NotificationSettings", () => ({ NotificationSettings: () => null }));
vi.mock("./CliCommandSettingsRow", () => ({ CliCommandSettingsRow: () => null }));
vi.mock("./MobileAppSettingsRow", () => ({ MobileAppSettingsRow: () => null }));
vi.mock("./BackgroundActivitySettings", () => ({ BackgroundActivitySettingsRow: () => null }));
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { GeneralSettingsPanel } from "./SettingsPanels";

const installedState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.1.0-fork-7",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function setup(getUpdateState?: () => Promise<DesktopUpdateState>) {
  state.language = "en";
  const registry = AtomRegistry.make();
  let listener: ((state: DesktopUpdateState) => void) | undefined;
  const bridge = getUpdateState
    ? ({
        getUpdateState,
        onUpdateState: (next: (state: DesktopUpdateState) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
      } satisfies Pick<DesktopBridge, "getUpdateState" | "onUpdateState">)
    : undefined;
  const global = stubGlobal("desktopBridge", bridge);
  return {
    view: () => (
      <RegistryContext.Provider value={registry}>
        <GeneralSettingsPanel />
      </RegistryContext.Provider>
    ),
    emit: (state: DesktopUpdateState) => {
      expect(listener).toBeTypeOf("function");
      listener!(state);
    },
    [Symbol.dispose]() {
      registry.dispose();
      global[Symbol.dispose]();
    },
  };
}

describe("settings app version", () => {
  it("switches general setting titles to Chinese without remounting", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view());
    await expect.element(screen.getByRole("heading", { name: "Project grouping" })).toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(fixture.view());
    for (const name of ["项目分组", "项目排序", "主动面板", "发送快捷键", "开源许可证"]) {
      await expect.element(screen.getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await expect
      .element(screen.getByRole("heading", { name: "Project grouping" }))
      .not.toBeInTheDocument();
  });
  it("shows the running desktop version instead of the web bundle or downloaded update", async () => {
    using fixture = setup(async () => ({
      ...installedState,
      status: "downloaded",
      availableVersion: "0.1.0-fork-8",
      downloadedVersion: "0.1.0-fork-8",
    }));
    await using screen = await render(fixture.view());
    await expect.element(screen.getByText("0.1.0-fork-7", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("0.1.0-fork-8", { exact: true })).not.toBeInTheDocument();
  });
  it("updates the visible version from desktop events without remounting", async () => {
    const getUpdateState = vi.fn(async () => ({
      ...installedState,
      currentVersion: "0.1.0-fork-6",
    }));
    using fixture = setup(getUpdateState);
    await using screen = await render(fixture.view());
    await expect.element(screen.getByText("0.1.0-fork-6", { exact: true })).toBeVisible();
    await act(() => fixture.emit(installedState));
    await expect.element(screen.getByText("0.1.0-fork-7", { exact: true })).toBeVisible();
    expect(getUpdateState).toHaveBeenCalledOnce();
  });
  it("uses the web bundle version without a desktop bridge", async () => {
    using fixture = setup();
    await using screen = await render(fixture.view());
    await expect.element(screen.getByText("0.0.45", { exact: true })).toBeVisible();
  });
  it("replaces the fallback after the initial desktop state arrives", async () => {
    let resolveInitial!: (state: DesktopUpdateState) => void;
    const initial = new Promise<DesktopUpdateState>((resolve) => {
      resolveInitial = resolve;
    });
    using fixture = setup(() => initial);
    await using screen = await render(fixture.view());
    await expect.element(screen.getByText("0.0.45", { exact: true })).toBeVisible();
    await act(() => resolveInitial(installedState));
    await expect.element(screen.getByText("0.1.0-fork-7", { exact: true })).toBeVisible();
  });
});
