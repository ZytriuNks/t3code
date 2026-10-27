import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ArchivedThreadsPanel } from "./ArchivedThreadsPanel";
import "~/index.css";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const state = vi.hoisted(() => ({
  threads: [] as OrchestrationV2ThreadShell[],
  unarchive: vi.fn(),
  delete: vi.fn(),
  refresh: vi.fn(),
  refreshed: null as ReturnType<typeof deferred> | null,
}));
const environmentId = EnvironmentId.make("archive");
const projectId = ProjectId.make("project");
const now = DateTime.makeUnsafe("2026-10-26T00:00:00Z");
vi.mock("../../i18n/I18nProvider", async () => {
  const { translate } = await import("../../i18n/messages");
  return {
    useI18n: () => ({
      t: (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) =>
        translate("en", key, values),
    }),
  };
});
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "all", environmentIds: [environmentId] },
    groups: [],
    environments: [{ environmentId, label: "Archive machine", displayUrl: null }],
  }),
  useOptionalSettingsScope: () => null,
}));
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({
    snapshots: [
      {
        environmentId,
        snapshot: {
          projects: [{ id: projectId, title: "Project", workspaceRoot: "/work/project" }],
          threads: state.threads,
        },
      },
    ],
    error: null,
    isLoading: false,
    refresh: state.refresh,
  }),
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    unarchiveThread: state.unarchive,
    confirmAndDeleteThread: state.delete,
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettingsAvailable: () => true,
  PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE: "Settings unavailable",
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => environmentId,
  usePrimaryEnvironment: () => null,
  useEnvironments: () => ({ environments: [] }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: () => new Set([environmentId]),
}));
vi.mock("./useScopedSettings", () => ({
  useClearScopedSettings: () => vi.fn(),
  useClearProjectOverrides: () => vi.fn(),
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../RelativeTime", () => ({ RelativeTime: () => null }));

function thread(
  id: string,
  relationshipToParent: "fork" | "subagent" | null,
): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make(id),
    projectId,
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("root"),
      parentThreadId: relationshipToParent ? ThreadId.make("root") : null,
      relationshipToParent,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: now,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}
function setup() {
  state.threads = [thread("root", null), thread("child", "subagent"), thread("fork", "fork")];
  state.unarchive.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.delete.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.refreshed = deferred();
  state.refresh.mockReset().mockImplementation(() => state.refreshed!.resolve());
}

it("counts independent archive rows, retains forks and unarchives only the selected root", async () => {
  setup();
  await using screen = await render(<ArchivedThreadsPanel />);
  await expect.element(screen.getByText("root", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("child", { exact: true })).not.toBeInTheDocument();
  const controls = screen.getByRole("button", { name: "Unarchive", exact: true });
  expect(controls.elements()).toHaveLength(2);
  await controls.nth(0).click();
  await state.refreshed!.promise;
  expect(state.unarchive).toHaveBeenCalledExactlyOnceWith({ environmentId, threadId: "root" });
  expect(state.threads).toHaveLength(3);
  expect(state.delete).not.toHaveBeenCalled();
});

it("shows the empty state when the archive contains only subagents and restores a fork row", async () => {
  setup();
  state.threads = [thread("child", "subagent")];
  await using screen = await render(<ArchivedThreadsPanel />);
  await expect.element(screen.getByText("No archived threads", { exact: true })).toBeVisible();
  expect(screen.getByRole("button", { name: "Unarchive", exact: true }).elements()).toHaveLength(0);
  state.threads = [...state.threads, thread("fork", "fork")];
  await screen.rerender(<ArchivedThreadsPanel />);
  await expect.element(screen.getByText("fork", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("No archived threads", { exact: true }))
    .not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Unarchive", exact: true }).elements()).toHaveLength(1);
  expect(state.unarchive).not.toHaveBeenCalled();
});
