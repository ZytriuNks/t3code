import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));

vi.mock("../../i18n/I18nProvider", async () => {
  const { translate } = await import("../../i18n/messages");
  return {
    useI18n: () => ({
      language: state.language,
      t: (
        key: import("../../i18n/messages").MessageKey,
        values?: import("../../i18n/messages").MessageValues,
      ) => translate(state.language, key, values),
    }),
  };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "environment" },
    target: null,
    targets: [],
    connectedEnvironments: [{ environmentId: "primary" }],
  }),
}));
vi.mock("./useScopedSettings", async () => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  return {
    useScopedSettings: () => ({ ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "full-access" }),
    useScopedSettingsMixed: () => false,
    useScopedSettingSource: () => null,
    useUpdateScopedSettings: () => vi.fn(),
  };
});
vi.mock("./settingsSearch", () => ({
  searchableSetting: (id: string) => ({ id, title: id }),
}));
vi.mock("./settingsLayout", () => ({
  SETTINGS_PICKER_TRIGGER_CLASSNAME: "",
  SettingResetButton: () => null,
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ control }: { control?: ReactNode }) => <div>{control}</div>,
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("../ui/switch", () => ({ Switch: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <button>{children}</button>,
  SelectValue: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

import { ProjectDefaultsSettings } from "./ProjectDefaultsSettings";

function renderedText(renderer: ReactTestRenderer): string[] {
  const values: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") values.push(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object" && "children" in node) {
      visit((node as { children: unknown }).children);
    }
  };
  visit(renderer.toJSON());
  return values;
}

describe("Default permissions localization", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    state.language = "en";
    vi.unstubAllGlobals();
  });

  it("translates the permission mode options when the app language changes", async () => {
    await act(() => {
      renderer = create(<ProjectDefaultsSettings category="general" />);
    });
    expect(renderedText(renderer!)).toEqual(
      expect.arrayContaining([
        "Full access",
        "Supervised",
        "Ask before commands and file changes.",
      ]),
    );

    state.language = "zh-CN";
    await act(() => renderer!.update(<ProjectDefaultsSettings category="general" />));

    const chinese = renderedText(renderer!);
    expect(chinese).toEqual(
      expect.arrayContaining(["完全访问", "监督模式", "执行命令和更改文件前先询问。"]),
    );
    expect(chinese).not.toContain("Full access");
  });
});
