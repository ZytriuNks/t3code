import { EnvironmentId, type AcpRegistrySearchAgent } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ language: "en" as "en" | "zh-CN" }));

vi.mock("../../i18n/I18nProvider", async (original) => {
  const { translate } = await import("../../i18n/messages");
  return {
    ...(await original<typeof import("../../i18n/I18nProvider")>()),
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
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({
    data: { agents: [] as AcpRegistrySearchAgent[] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

vi.mock("./CodexSetupSection", () => ({ AddManagedCodexAccountDialog: () => null }));

import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";

describe("add provider dialog language switching", () => {
  it("translates the wizard and its ACP Registry search step", async () => {
    state.language = "en";
    const dialog = () => (
      <AddProviderInstanceDialog
        open
        environmentId={EnvironmentId.make("environment")}
        environmentLabel="Laptop"
        onOpenChange={() => undefined}
      />
    );
    await using screen = await render(dialog());
    await expect
      .element(page.getByRole("heading", { name: "Add provider", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Configure manually", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("No compatible agents found", { exact: true }))
      .toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(dialog());
    await expect
      .element(page.getByRole("heading", { name: "添加提供商", exact: true }))
      .toBeVisible();
    for (const text of [
      "在 Laptop 上设置提供商。",
      "手动配置",
      "或从 ACP 注册表中选择",
      "选择代理",
      "手动输入",
      "未找到兼容的代理",
    ]) {
      await expect.element(page.getByText(text, { exact: true })).toBeVisible();
    }
    await expect
      .element(page.getByText("Configure manually", { exact: true }))
      .not.toBeInTheDocument();
  });
});
