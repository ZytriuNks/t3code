import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) => {
    const settings = { ...DEFAULT_CLIENT_SETTINGS, language: "zh-CN" as const };
    return selector ? selector(settings) : settings;
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
  }),
}));
vi.mock("./ProjectDefaultsSettings", () => ({ ProjectDefaultsSettings: () => null }));
vi.mock("./SourceControlWritingSettings", () => ({
  SourceControlWritingSettingsSection: () => null,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingsSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  PolicyTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingResetButton: () => null,
  SettingsSearchTarget: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSettingsSearchTargetId: () => "source-control",
}));

import { SourceControlSettingsPanel } from "./SourceControlSettings";
import { I18nProvider } from "../../i18n/I18nProvider";

function textContents(renderer: ReactTestRenderer): string[] {
  const result: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      result.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === "object" && "children" in node) {
      visit((node as { children: unknown }).children);
    }
  };
  visit(renderer.toJSON());
  return result;
}

describe("SourceControlSettings Chinese rendering", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    act(() => {
      renderer = create(
        <I18nProvider>
          <SourceControlSettingsPanel />
        </I18nProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("renders the server environment empty state in Simplified Chinese", () => {
    const text = textContents(renderer!);
    expect(text).toContain("服务器环境");
    expect(text).toContain("连接一个环境以检查其版本控制工具和托管集成。");
  });
});
