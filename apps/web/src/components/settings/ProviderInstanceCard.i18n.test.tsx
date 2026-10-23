import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
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

// Base UI floating primitives need a DOM; these tests only read rendered copy.
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => (
    <>
      {render}
      {children}
    </>
  ),
}));
vi.mock("./ProviderAccentColorPicker", () => ({ ProviderAccentColorPicker: () => null }));
vi.mock("./RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));

import { providerClients } from "./providerDriverMeta";
import { ProviderInstanceCard } from "./ProviderInstanceCard";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const models: ServerProviderModel[] = [
  { slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null },
];
const liveProvider: ServerProvider = {
  instanceId,
  driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "developer@example.com" },
  checkedAt: "2026-08-27T12:00:00.000Z",
  models,
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

describe("provider instance editor language switching", () => {
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

  it("translates the card, its runtime form, and its models list together", async () => {
    const render = () => (
      <ProviderInstanceCard
        instanceId={instanceId}
        instance={{ driver }}
        driverOption={providerClients.get(driver)}
        liveProvider={liveProvider}
        mode="editor"
        onUpdate={() => undefined}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={() => undefined}
        onFavoriteModelsChange={() => undefined}
        onToggleFavorite={() => undefined}
        onModelOrderChange={() => undefined}
      />
    );
    await act(() => {
      renderer = create(render());
    });
    const english = renderedText(renderer!);
    expect(english).toContain("Display name");
    expect(english).toContain("Authenticated as");
    expect(english).toContain("Binary path");
    expect(english).toContain("Add variable");
    expect(english).toContain("Add custom model");

    state.language = "zh-CN";
    await act(() => renderer!.update(render()));

    const chinese = renderedText(renderer!);
    // Card shell.
    expect(chinese).toContain("显示名称");
    expect(chinese).toContain("已通过身份验证，账户：");
    expect(chinese).toContain("运行时");
    expect(chinese).toContain("环境");
    expect(chinese).toContain("添加变量");
    // ProviderSettingsForm field labels from the Codex schema.
    expect(chinese).toContain("二进制文件路径");
    expect(chinese).toContain("CODEX_HOME 路径");
    // ProviderModelsSection.
    expect(chinese).toContain("添加自定义模型");
    expect(chinese).toContain("1 个模型");
    expect(chinese).not.toContain("Add custom model");
  });
});
