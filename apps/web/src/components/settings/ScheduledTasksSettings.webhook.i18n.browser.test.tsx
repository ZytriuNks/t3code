import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { AsyncResult } from "effect/reactivity";
import { render } from "../../../test/render";
import { I18nProvider } from "../../i18n/I18nProvider";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import "~/index.css";

const state = vi.hoisted(() => ({
  language: "en" as "en" | "zh-CN",
  tasks: [] as ScheduledTask[],
  multipleEnvironments: false,
  listResults: [] as unknown[],
  environment: {
    environmentId: "fixture-env",
    label: "Fixture environment",
    connection: { phase: "connected" },
    serverConfig: { environment: { platform: { machine: "server" } } },
    displayUrl: null,
  },
}));
vi.mock("../../hooks/useSettings", async (original) => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  return {
    ...(await original<typeof import("../../hooks/useSettings")>()),
    useClientSettings: <T,>(selector: (settings: typeof state) => T) => selector(state),
    useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
  };
});
vi.mock("./SettingsScopeContext", async (original) => ({
  ...(await original<typeof import("./SettingsScopeContext")>()),
  useSettingsScope: () => ({
    scope: { kind: "environment", environmentIds: [state.environment.environmentId] },
    environments: state.multipleEnvironments
      ? [
          state.environment,
          {
            ...state.environment,
            environmentId: "offline-env",
            label: "Offline environment",
            connection: { phase: "offline" },
            serverConfig: null,
          },
        ]
      : [state.environment],
    connectedEnvironments: [state.environment],
    environment: state.environment,
    targets: [],
    target: null,
  }),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: { fixture?: string }) =>
    atom?.fixture === "task-list" ? state.listResults : atom?.fixture === "providers" ? [] : true,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: [state.environment] }),
  usePrimaryEnvironment: () => state.environment,
  usePrimaryEnvironmentId: () => state.environment.environmentId,
  useEnvironment: () => state.environment,
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:12345",
}));
vi.mock("../../state/server", async (original) => {
  const actual = await original<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      scheduledTasksLive: () => ({ fixture: "tasks" }),
      providersValueAtom: () => ({ fixture: "providers" }),
      scheduledTaskWebhookDeliveries: () => ({ fixture: "deliveries" }),
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-10-25T02:00" }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/environmentAtomList", () => ({
  environmentAtomList: () => () => ({ fixture: "task-list" }),
  environmentIdsKey: () => "fixture-environments",
}));
vi.mock("../../cloud/primaryCloudLinkState", () => ({
  usePrimaryCloudLinkState: () => ({ target: null, data: null }),
}));
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: (atom: { fixture?: string } | null) => ({
    data: atom?.fixture === "tasks" ? { tasks: state.tasks } : { deliveries: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

function setup() {
  state.language = "en";
  state.multipleEnvironments = false;
  state.listResults = [AsyncResult.initial()];
  state.tasks = [
    {
      id: ScheduledTaskId.make("fixture-webhook"),
      title: "Fixture webhook",
      prompt: "Handle {{body}}",
      schedule: { type: "webhook", signature: null },
      enabled: true,
      projectId: ProjectId.make("fixture-project"),
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdBy: "user",
      creationSource: "web",
      createdAt: "2026-10-25T01:00:00.000Z",
      updatedAt: "2026-10-25T01:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    },
  ];
  return () => (
    <I18nProvider>
      <ScheduledTasksSettings />
    </I18nProvider>
  );
}

describe("scheduled webhook localization", () => {
  it("switches pending and disconnected environment summaries together", async () => {
    const view = setup();
    state.multipleEnvironments = true;
    await using screen = await render(view());
    await expect
      .element(screen.getByText("Not connected: Offline environment (Offline)"))
      .toBeVisible();
    await expect
      .element(screen.getByText("Loading scheduled tasks on Fixture environment"))
      .toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(view());
    await expect.element(screen.getByText("未连接： Offline environment (离线)")).toBeVisible();
    await expect
      .element(screen.getByText("正在加载以下环境的计划任务： Fixture environment"))
      .toBeVisible();
  });

  it("switches the endpoint reachability note inside an open webhook editor", async () => {
    const view = setup();
    state.tasks = state.tasks.map((task) => ({
      ...task,
      webhook: { url: null, path: "/fixture-hook", hasSecret: false },
    }));
    await using screen = await render(view());
    await screen.getByRole("button", { name: /Fixture webhook/ }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect
      .element(dialog.getByRole("textbox", { name: "Webhook URL", exact: true }))
      .toHaveValue("http://127.0.0.1:12345/fixture-hook");
    await expect
      .element(
        dialog.getByText(
          "Only this computer can call this address. Link T3 Connect for a public URL.",
        ),
      )
      .toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(view());
    await expect
      .element(dialog.getByRole("textbox", { name: "Webhook 地址", exact: true }))
      .toHaveValue("http://127.0.0.1:12345/fixture-hook");
    await expect
      .element(dialog.getByText("只有本机能调用此地址。连接 T3 Connect 可获取公开地址。"))
      .toBeVisible();
  });

  it("localizes selected weekdays, past run times and run outcomes when switching languages", async () => {
    const view = setup();
    state.tasks = state.tasks.map((task) => ({
      ...task,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 3] },
      nextRunAt: "2026-10-25T01:55:00.000Z",
      lastRunStatus: "succeeded",
    }));
    await using screen = await render(view());
    await expect.element(screen.getByText("Sun, Wed at 09:00 · Next run 5m ago")).toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(view());
    await expect.element(screen.getByText("周日, 周三 09:00 · 下次运行 5 分钟前")).toBeVisible();
    await expect.element(screen.getByText("已成功", { exact: true })).toBeVisible();
  });

  it("switches the task status, open deliveries dialog and its empty state together", async () => {
    const view = setup();
    await using screen = await render(view());
    await expect.element(screen.getByText("On webhook · Listening", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: /Fixture webhook/ }).click();
    await page.getByRole("menuitem", { name: "Deliveries", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Deliveries · Fixture webhook" }))
      .toBeVisible();
    state.language = "zh-CN";
    await screen.rerender(view());
    const dialog = page.getByRole("dialog");
    await expect
      .element(dialog.getByRole("heading", { name: "投递记录 · Fixture webhook" }))
      .toBeVisible();
    await expect.element(dialog.getByText("尚未收到请求。", { exact: true })).toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "完成", exact: true }).click();
    await expect
      .element(screen.getByText("收到 Webhook 时 · 正在监听", { exact: true }))
      .toBeVisible();
  });
});
