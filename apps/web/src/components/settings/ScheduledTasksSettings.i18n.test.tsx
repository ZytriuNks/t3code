import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    upsertScheduledTask: { permissionAtom: () => Symbol("permission") },
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => true,
  useAtomCommand: () => vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "unavailable", message: "Hidden by the current selection", environmentIds: [] },
    environments: [],
    connectedEnvironments: [],
    environment: null,
    targets: [],
    target: null,
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <>{children}</>,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ title }: { title: ReactNode }) => <p>{title}</p>,
  SettingResetButton: () => null,
  PolicyTooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  useSettingsSearchTargetId: () => "scheduled-tasks",
  useRelativeTimeTick: () => undefined,
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
}));
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));

import { I18nProvider } from "../../i18n/I18nProvider";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

function textContents(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((child) => textContents(child, out));
  else if (node && typeof node === "object" && "children" in node)
    textContents((node as { children: unknown }).children, out);
  return out;
}

describe("Scheduled tasks panel localization", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("document", { documentElement: { lang: "en" } });
    act(() => {
      renderer = create(
        <I18nProvider>
          <ScheduledTasksSettings />
        </I18nProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("renders the panel, its create action, and the unavailable scope in Simplified Chinese", () => {
    const text = textContents(renderer!.toJSON());
    expect(text).toContain("计划任务");
    expect(text).toContain("新建任务");
    expect(text).toContain("选择不可用");
  });

  it("follows a language change without remounting", () => {
    act(() => {
      localeState.language = "en";
      renderer!.update(
        <I18nProvider>
          <ScheduledTasksSettings />
        </I18nProvider>,
      );
    });
    const text = textContents(renderer!.toJSON());
    expect(text).toContain("Scheduled tasks");
    expect(text).toContain("New task");
  });
});
