import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { Atom } from "effect/reactivity";
import "~/index.css";
import { render } from "../../../test/render";
import { serverEnvironment } from "../../state/server";

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
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => ({
    environmentId: "primary",
    label: "Laptop",
    serverConfig: null,
    displayUrl: null,
    connection: { phase: "connected" },
  }),
  usePrimaryEnvironmentId: () => "primary",
  useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
}));
vi.mock("../../environments/primary", async (original) => ({
  ...(await original<typeof import("../../environments/primary")>()),
  usePrimarySessionState: () => ({
    data: {
      authenticated: true,
      permissions: [
        "access:read",
        "orchestration:read",
        "settings:write",
        "providers:manage",
        "filesystem:read",
        "filesystem:write",
      ],
      auth: { policy: "remote-reachable" },
    },
  }),
}));
vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom ? { type: "snapshot", payload: { pairingLinks: [], clientSessions: [] } } : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../ServerUpdateAction", () => ({
  OutdatedServerUpdateAction: () => null,
  ServerUpdateAction: () => null,
  ServerUpdateProgress: () => null,
  ServerUpdatesAction: () => null,
}));
vi.mock("../clerk/RemoveT3ConnectEnvironmentDialog", () => ({
  RemoveT3ConnectEnvironmentDialog: () => null,
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("./LoadBalancingSettings", () => ({ LoadBalancingSettings: () => null }));
vi.mock("./GitHubRoutingSettings", () => ({ GitHubRoutingSettings: () => null }));
vi.mock("./LocalEnvironmentSetting", () => ({ LocalEnvironmentSetting: () => null }));
vi.mock("./SessionPermissions", () => ({ SessionPermissions: () => null }));
import { ConnectionsSettings } from "./ConnectionsSettings";

describe("Connections settings language switching", () => {
  it("updates the connection page and open pairing dialog when the language changes", async () => {
    state.language = "en";
    using _updates = vi
      .spyOn(serverEnvironment, "updateStateAtom")
      .mockReturnValue(Atom.make({ status: "idle" }));
    await using screen = await render(<ConnectionsSettings />);
    await expect.element(screen.getByText("Version", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Environments", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Add environment", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Authorized clients 0 clients", exact: true }).click();
    await expect
      .element(screen.getByText("No pairing links or client sessions.", { exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Create link", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Create pairing link", exact: true }))
      .toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(<ConnectionsSettings />);
    await expect
      .element(page.getByRole("heading", { name: "创建配对链接", exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "客户端标签（可选）" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "只读", exact: true })).toBeVisible();
    for (const permission of ["查看环境", "更改环境设置", "管理提供商", "读取文件", "写入文件"]) {
      await expect.element(page.getByText(permission, { exact: true })).toBeVisible();
    }
    await userEvent.keyboard("{Escape}");
    for (const text of ["版本", "网络访问"]) {
      await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
    }
    await expect.element(screen.getByRole("heading", { name: "环境", exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "添加环境", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "已授权客户端 0 客户端", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText("没有配对链接或客户端会话。", { exact: true }))
      .toBeVisible();
    expect(screen.container.textContent).not.toContain("Authorized clients");
  });
});
