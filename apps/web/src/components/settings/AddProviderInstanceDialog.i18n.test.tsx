import { EnvironmentId, type AcpRegistrySearchAgent } from "@t3tools/contracts";
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
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  useEnvironmentSettings: () => ({ providerInstances: {} }),
  usePersistEnvironmentProviderInstanceMutation: () => vi.fn(),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      searchAcpRegistry: () => Symbol("search"),
    },
  };
});
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { agents: [] as AcpRegistrySearchAgent[] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
// Base UI dialog and floating primitives need a DOM; these tests only read copy.
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/wizard", () => ({
  WizardPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardHeader: ({
    title,
    description,
    children,
  }: {
    title: ReactNode;
    description: ReactNode;
    children: ReactNode;
  }) => (
    <header>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </header>
  ),
  WizardPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  WizardSteps: ({ steps }: { steps: readonly string[] }) => (
    <ol>
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  ),
}));
vi.mock("../ui/radio-group", () => ({
  RadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@base-ui/react/radio", () => ({
  Radio: {
    Root: ({ children }: { children: ReactNode }) => <label>{children}</label>,
    Indicator: () => null,
  },
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
}));
vi.mock("./ProviderAccentColorPicker", () => ({ ProviderAccentColorPicker: () => null }));
vi.mock("./CodexSetupSection", () => ({ AddManagedCodexAccountDialog: () => null }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

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

describe("add provider dialog language switching", () => {
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

  it("translates the wizard and its ACP Registry search step", async () => {
    const render = () => (
      <AddProviderInstanceDialog
        open
        environmentId={EnvironmentId.make("environment")}
        environmentLabel="Laptop"
        onOpenChange={() => undefined}
      />
    );
    await act(() => {
      renderer = create(render());
    });
    const english = renderedText(renderer!);
    expect(english).toContain("Add provider");
    expect(english).toContain("Configure manually");
    expect(english).toContain("No compatible agents found");

    state.language = "zh-CN";
    await act(() => renderer!.update(render()));

    const chinese = renderedText(renderer!);
    // Dialog shell and wizard steps.
    expect(chinese).toContain("添加提供商");
    expect(chinese).toContain("在 Laptop 上设置提供商。");
    expect(chinese).toContain("提供商");
    expect(chinese).toContain("手动配置");
    expect(chinese).toContain("或从 ACP 注册表中选择");
    // AcpRegistrySearchStep.
    expect(chinese).toContain("选择代理");
    expect(chinese).toContain("手动输入");
    expect(chinese).toContain("未找到兼容的代理");
    expect(chinese).not.toContain("Configure manually");
  });
});
