import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
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
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => Symbol("providers"),
    providerAuthState: () => Symbol("auth-state"),
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("./ProviderAuthenticationSection", () => ({ ProviderAuthenticationSection: () => null }));
vi.mock("../ui/wizard", () => ({
  WizardPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      <div>{description}</div>
      {control}
    </section>
  ),
}));

import { ProviderWizardAuthenticationStep } from "./ProviderWizardAuthenticationStep";

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

describe("provider wizard sign-in step language switching", () => {
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

  it("translates the discovery row and the footer action", async () => {
    const render = () => (
      <ProviderWizardAuthenticationStep
        environmentId={EnvironmentId.make("environment")}
        environmentLabel="Laptop"
        instanceId={ProviderInstanceId.make("acpRegistry_kilo")}
        onFinish={() => undefined}
      />
    );
    await act(() => {
      renderer = create(render());
    });
    expect(renderedText(renderer!)).toContain("Skip for now");

    state.language = "zh-CN";
    await act(() => renderer!.update(render()));

    const chinese = renderedText(renderer!);
    expect(chinese).toContain("账户");
    expect(chinese).toContain("正在查找登录方式…");
    expect(chinese).toContain("暂时跳过");
  });
});
