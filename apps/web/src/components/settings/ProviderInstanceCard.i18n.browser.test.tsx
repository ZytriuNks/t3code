import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

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

describe("provider instance editor language switching", () => {
  it("translates the card, its runtime form, and its models list together", async () => {
    state.language = "en";
    const ui = () => (
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
    await using screen = await render(ui());
    await expect.element(screen.getByText("Display name", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Authenticated as", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Binary path", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Add variable", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Add custom model", { exact: true })).toBeVisible();

    state.language = "zh-CN";
    await screen.rerender(ui());

    // Card shell.
    await expect.element(screen.getByText("显示名称", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("已通过身份验证，账户：", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("运行时", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("环境", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("添加变量", { exact: true })).toBeVisible();
    // ProviderSettingsForm field labels from the Codex schema.
    await expect.element(screen.getByText("二进制文件路径", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("CODEX_HOME 路径", { exact: true })).toBeVisible();
    // ProviderModelsSection.
    await expect.element(screen.getByText("添加自定义模型", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("1 个模型", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByText("Add custom model", { exact: true }))
      .not.toBeInTheDocument();
  });
});
