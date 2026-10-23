import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("@tanstack/react-router", () => ({ useLocation: () => "" }));
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
// Base UI floating primitives need a DOM; render their triggers and content inline instead.
vi.mock("../ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  const Trigger = ({ render, children }: { render?: React.ReactElement; children?: ReactNode }) =>
    render ? (
      cloneElement(render, {}, children ?? (render.props as { children?: ReactNode }).children)
    ) : (
      <>{children}</>
    );
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Tooltip: Pass, TooltipTrigger: Trigger, TooltipPopup: Pass };
});
vi.mock("../ui/popover", async () => {
  const { cloneElement } = await import("react");
  const Trigger = ({ render, children }: { render?: React.ReactElement; children?: ReactNode }) =>
    render ? cloneElement(render, {}, children) : <>{children}</>;
  const Pass = () => null;
  return {
    Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
    PopoverTrigger: Trigger,
    PopoverContent: Pass,
  };
});
vi.mock("../ui/menu", () => {
  const Pass = () => null;
  return { Menu: Pass, MenuItem: Pass, MenuPopup: Pass, MenuTrigger: Pass };
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

function textContents(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => textContents(child, out));
  else if (node && typeof node === "object" && "children" in node)
    textContents((node as { children: unknown }).children, out);
  return out;
}

function ariaLabels(root: ReactTestInstance): string[] {
  return root
    .findAll((instance) => typeof instance.props["aria-label"] === "string")
    .map((instance) => instance.props["aria-label"] as string);
}

function panel() {
  return (
    <I18nProvider>
      <KeybindingsSettingsPanel />
    </I18nProvider>
  );
}

describe("Keybindings panel localization", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    localeState.language = "zh-CN";
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    vi.stubGlobal("navigator", { platform: "Win32", languages: ["en"], language: "en" });
    act(() => {
      renderer = create(panel());
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("renders the panel, its actions, and command labels in Simplified Chinese", () => {
    const text = textContents(renderer!.toJSON());
    expect(text).toContain("快捷键");
    expect(text).toContain("添加快捷键");
    expect(text).toContain("侧栏: 切换");
    expect(text).toContain("预览: 聚焦地址栏");
    const labels = ariaLabels(renderer!.root);
    expect(labels).toContain("搜索快捷键");
    expect(labels).toContain("打开 keybindings.json");
  });

  it("filters rows by their localized command label", () => {
    const search = renderer!.root.find(
      (instance) => instance.type === "input" && instance.props["aria-label"] === "搜索快捷键",
    );
    act(() => {
      (search.props.onChange as (event: unknown) => void)({ currentTarget: { value: "侧栏" } });
    });
    const text = textContents(renderer!.toJSON());
    expect(text).toContain("侧栏: 切换");
    expect(text).not.toContain("预览: 聚焦地址栏");
  });

  it("follows a language change without remounting and keeps upstream English labels", () => {
    act(() => {
      localeState.language = "en";
      renderer!.update(panel());
    });
    const text = textContents(renderer!.toJSON());
    expect(text).toContain("Keybindings");
    expect(text).toContain("Add keybinding");
    expect(text).toContain("Sidebar: Toggle");
    expect(text).toContain("Preview: Focus URL");
    expect(ariaLabels(renderer!.root)).toContain("Search keybindings");
  });
});
