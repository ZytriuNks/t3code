import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
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
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: () => "auth-state",
    startProviderAuth: "start",
    respondProviderAuth: "respond",
    completeProviderAuth: "complete",
    cancelProviderAuth: "cancel",
    logoutProviderAuth: "logout",
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ title, description }: { title: ReactNode; description: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      <div>{description}</div>
    </section>
  ),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "button",
  SelectValue: "span",
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => <>{render}</>,
}));

import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("acpRegistry"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

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

describe("provider authentication language switching", () => {
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

  it("updates the live sign-in discovery status when the app language changes", async () => {
    const render = () => (
      <ProviderAuthenticationSection
        environmentId={EnvironmentId.make("environment")}
        environmentLabel="Laptop"
        instanceId={provider.instanceId}
        provider={provider}
        readOnly={false}
      />
    );
    await act(() => {
      renderer = create(render());
    });
    expect(renderedText(renderer!)).toContain("Discovering sign-in methods…");

    state.language = "zh-CN";
    await act(() => renderer!.update(render()));

    expect(renderedText(renderer!)).toContain("正在查找登录方式…");
  });
});
