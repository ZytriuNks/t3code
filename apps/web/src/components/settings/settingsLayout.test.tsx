import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE:
    "This setting is saved on a server, and the hosted app is not anchored to one. Change it from the desktop app or from the server's own address.",
  usePrimarySettingsAvailable: () => true,
}));
vi.mock("./useScopedSettings", () => ({
  useClearScopedSettings: () => () => undefined,
  useClearProjectOverrides: () => () => undefined,
}));

const scopeState = vi.hoisted(() => ({
  value: null as unknown,
}));

vi.mock("./SettingsScopeContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingsScopeContext")>()),
  useOptionalSettingsScope: () => scopeState.value,
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { readonly children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    readonly render?: React.ReactNode;
    readonly children?: React.ReactNode;
  }) => (
    <>
      {render}
      {children}
    </>
  ),
  TooltipPopup: ({ children }: { readonly children?: React.ReactNode }) => <span>{children}</span>,
}));

// The indicator's popover is a portal; rendering its summary inline keeps the
// copy the row computes observable from the markup. The real module still
// supplies the English copy defaults the row falls back to.
vi.mock("./SettingInheritance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./SettingInheritance")>()),
  SettingInheritance: ({ summary }: { readonly summary: string }) => (
    <span data-setting-inheritance-summary={summary} />
  ),
}));

import {
  scrollToSettingsTarget,
  SettingResetButton,
  SettingsRow,
  SettingsRowCopyProvider,
  SettingsSearchTargetProvider,
  SettingsUnavailableGroup,
  type SettingsRowCopy,
} from "./settingsLayout";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");

const ZH_COPY: SettingsRowCopy = {
  resetToInheritedTooltip: "重置为继承值",
  resetToDefaultTooltip: "重置为默认值",
  resetToInheritedLabel: (label) => `将${label}重置为继承值`,
  resetToDefaultLabel: (label) => `将${label}重置为默认值`,
  overrideFallbackLabel: "覆盖项",
  reconnectSelectedEnvironment: "请重新连接所选环境后再更改此设置。",
  selectEnvironment: "环境级设置。请选择环境后再更改。",
  mixedAcrossEnvironments: "所选环境之间不一致",
  overriddenForProject: "已为此项目覆盖",
  inheritedFrom: (source) => `继承自 ${source}`,
  setOnEnvironment: "已在环境上设置",
  builtInDefault: "内置默认值",
  layerProject: "项目",
  layerEnvironment: "环境",
  layerDefault: "默认",
  inherits: "继承",
  on: "开",
  off: "关",
  dayCount: (count) => `${count} 天`,
  lastSelected: "上次选择",
  never: "从不",
  automatic: "自动",
  textGenerationModel: "文本生成模型",
  notSet: "未设置",
  empty: "空",
  itemCount: (count) => `${count} 项`,
  custom: "自定义",
  envModeLocal: "当前检出",
  envModeWorktree: "新工作树",
  overriddenBy: "被以下项目覆盖",
  resetOverride: (count) => (count === 1 ? "重置" : "全部重置"),
  projectOverrideSummary: (summary, count) => `${summary} · ${count} 个项目覆盖`,
  showSourceLabel: (summary) => `${summary}。查看此值的来源`,
};

const environment = {
  environmentId,
  label: "Laptop",
  connection: { phase: "connected" },
  serverConfig: null,
};

function connectedScope() {
  return {
    scope: { kind: "environment", environmentIds: [environmentId] },
    search: {},
    target: null,
    targets: [{ environmentId, label: "Laptop", projectId: null }],
    environments: [environment],
    connectedEnvironments: [environment],
    groups: [],
    selectScope: () => undefined,
  };
}

afterEach(() => {
  scopeState.value = null;
  vi.unstubAllGlobals();
});

describe("unavailable settings", () => {
  it("groups disabled controls under one reason", () => {
    const markup = renderToStaticMarkup(
      <SettingsUnavailableGroup message="Only available in the desktop app.">
        <SettingsRow title="Window capture" description="Capture a window." />
      </SettingsUnavailableGroup>,
    );

    expect(markup).toContain("Only available in the desktop app.");
    expect(markup).toContain("border-border/60");
    expect(markup).toContain("[&amp;_h3]:opacity-64");
  });
});

describe("settings search targets", () => {
  it("does not persist destination styling in the rendered row", () => {
    const markup = renderToStaticMarkup(
      <SettingsSearchTargetProvider targetId="word-wrap">
        <SettingsRow id="word-wrap" title="Word wrap" description="Wrap long lines." />
        <SettingsRow id="time-format" title="Time format" description="Choose a clock." />
      </SettingsSearchTargetProvider>,
    );

    expect(markup).toContain('id="word-wrap" tabindex="-1"');
    expect(markup).not.toContain("data-settings-search-target");
    expect(markup).not.toContain("settings-search-target-pulse");
  });

  it("scrolls directly to a section header and restarts the destination pulse", () => {
    const sectionScrollIntoView = vi.fn();
    const headerScrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const addEventListener = vi.fn();
    const target = {
      tagName: "SECTION",
      firstElementChild: { scrollIntoView: headerScrollIntoView },
      scrollIntoView: sectionScrollIntoView,
      focus,
      classList: { remove, add },
      addEventListener,
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: false })),
    });

    expect(scrollToSettingsTarget("providers")).toBe(true);
    expect(headerScrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    expect(sectionScrollIntoView).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(addEventListener).toHaveBeenCalledWith("blur", expect.any(Function), { once: true });
  });

  it("does not animate the destination when reduced motion is requested", () => {
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    const remove = vi.fn();
    const add = vi.fn();
    const target = {
      tagName: "DIV",
      firstElementChild: null,
      scrollIntoView,
      focus,
      classList: { remove, add },
      offsetWidth: 100,
    } as unknown as HTMLElement;
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => target),
    });
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({ matches: true })),
    });

    expect(scrollToSettingsTarget("word-wrap")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(remove).toHaveBeenCalledWith("settings-search-target-pulse");
    expect(add).not.toHaveBeenCalled();
  });

  it("leaves not-yet-mounted destinations to their mount lifecycle", () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => null),
    });

    expect(scrollToSettingsTarget("archive")).toBe(false);
  });
});

describe("settings row copy", () => {
  it("keeps the reset affordance in English when no copy provider is mounted", () => {
    const markup = renderToStaticMarkup(
      <SettingResetButton label="default automatic pull" onClick={() => undefined} />,
    );

    expect(markup).toContain('aria-label="Reset default automatic pull to default"');
  });

  it("labels the reset affordance and its tooltip from the mounted copy", () => {
    const markup = renderToStaticMarkup(
      <SettingsRowCopyProvider copy={ZH_COPY}>
        <SettingResetButton label="default automatic pull" onClick={() => undefined} />
      </SettingsRowCopyProvider>,
    );

    expect(markup).toContain('aria-label="将default automatic pull重置为默认值"');
    expect(markup).toContain("重置为默认值");
  });

  it("keeps an explicitly passed tooltip ahead of the mounted copy", () => {
    const markup = renderToStaticMarkup(
      <SettingsRowCopyProvider copy={ZH_COPY}>
        <SettingResetButton
          label="default automatic pull"
          tooltip="Reset automatic pull to off"
          onClick={() => undefined}
        />
      </SettingsRowCopyProvider>,
    );

    expect(markup).toContain('aria-label="将default automatic pull重置为默认值"');
    expect(markup).toContain("Reset automatic pull to off");
    expect(markup).not.toContain("<span>重置为默认值</span>");
  });

  it("summarizes a mixed selection with the mounted copy", () => {
    scopeState.value = connectedScope();
    const markup = renderToStaticMarkup(
      <SettingsRowCopyProvider copy={ZH_COPY}>
        <SettingsRow
          serverScoped
          settingKeys={["defaultAutoPull"]}
          title="Automatically pull"
          mixed
        />
      </SettingsRowCopyProvider>,
    );

    expect(markup).toContain("所选环境之间不一致");
  });

  it("summarizes a project override with the mounted copy", () => {
    const target = {
      environmentId,
      label: "Laptop",
      projectId,
      settings: { defaultAutoPull: false },
      sources: { defaultAutoPull: "project" as const },
    };
    scopeState.value = {
      ...connectedScope(),
      scope: { kind: "project", projectId, environmentIds: [environmentId] },
      target,
      targets: [target],
    };
    const markup = renderToStaticMarkup(
      <SettingsRowCopyProvider copy={ZH_COPY}>
        <SettingsRow serverScoped settingKeys={["defaultAutoPull"]} title="Automatically pull" />
      </SettingsRowCopyProvider>,
    );

    expect(markup).toContain("已为此项目覆盖");
    expect(markup).toContain('aria-label="将Automatically pull重置为继承值"');
    expect(markup).toContain("重置为继承值");
  });

  it("names the overridden row from the mounted copy when its title is a node", () => {
    const target = {
      environmentId,
      label: "Laptop",
      projectId,
      settings: { defaultAutoPull: false },
      sources: { defaultAutoPull: "project" as const },
    };
    scopeState.value = {
      ...connectedScope(),
      scope: { kind: "project", projectId, environmentIds: [environmentId] },
      target,
      targets: [target],
    };
    const markup = renderToStaticMarkup(
      <SettingsRowCopyProvider copy={ZH_COPY}>
        <SettingsRow
          serverScoped
          settingKeys={["defaultAutoPull"]}
          title={<span>Automatically pull</span>}
        />
      </SettingsRowCopyProvider>,
    );

    expect(markup).toContain('aria-label="将覆盖项重置为继承值"');
    expect(markup).not.toContain("将override重置为继承值");
  });
});
