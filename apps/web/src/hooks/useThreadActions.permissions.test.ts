import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  CommandId,
  type OrchestrationV2DispatchCommandResult,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useThreadDeleteConfirmation } from "./useThreadDeleteConfirmation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  threads: [] as {
    environmentId: EnvironmentId;
    id: ThreadId;
    projectId: ProjectId;
    title: string;
    worktreePath: string | null;
    session: { status: "ready" | "stopped" } | null;
    latestTurn: null;
  }[],
  requests: [] as { action: string; environmentId: string; input: { threadId?: string } }[],
  localEffects: [] as string[],
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  toasts: [] as string[],
  afterRequest: undefined as ((action: string) => void) | undefined,
  sessionLookupFails: false,
  dispatchResult: { sequence: 1 } as OrchestrationV2DispatchCommandResult,
}));

vi.mock("../i18n/I18nProvider", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [] }, navigate: async () => {} }),
}));
vi.mock("../state/session", () => ({
  environmentSession: { sessionStateAtom: "session" },
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand:
    (action: string) =>
    async (request: { environmentId: string; input: { threadId?: string } }) => {
      state.requests.push({ action, ...request });
      const scope =
        action === "removeWorktree" ? AuthSourceControlWriteScope : AuthOrchestrationOperateScope;
      if (!state.scopes.get(request.environmentId)?.has(scope)) {
        return AsyncResult.failure(Cause.fail(new Error("Server denied the request")));
      }
      state.afterRequest?.(action);
      return AsyncResult.success(state.dispatchResult);
    },
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async (environmentId: string) =>
    state.sessionLookupFails
      ? AsyncResult.failure(Cause.fail(new Error("Session lookup failed")))
      : AsyncResult.success({
          authenticated: true,
          scopes: [...(state.scopes.get(environmentId) ?? [])],
          auth: { serverUpdateScope: "environment:maintain" },
        }),
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "pin",
      "unpin",
      "reorderPin",
      "snooze",
      "unsnooze",
      "stopSession",
    ].map((action) => [action, action]),
  ),
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { removeWorktree: "removeWorktree", refreshStatus: "refreshStatus" },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsPinReorder: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readThreadShell: (ref: ScopedThreadRef) =>
    state.threads.find(
      (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
    ) ?? null,
  readThreadShells: () => state.threads,
  readEnvironmentThreadRefs: (environmentId: EnvironmentId) =>
    state.threads
      .filter((thread) => thread.environmentId === environmentId)
      .map((thread) => ({ environmentId, threadId: thread.id })),
  readProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("@dnd-kit/sortable", () => ({ defaultAnimateLayoutChanges: () => true }));
vi.mock("../components/Sidebar.logic", () => ({
  getFallbackThreadIdAfterDelete: () => null,
  pinOrderKeyBetween: () => "a",
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      clearDraftThread: () => state.localEffects.push("clear-draft"),
      clearProjectDraftThreadById: () => state.localEffects.push("clear-project-draft"),
    }),
}));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      clearTerminalUiState: () => state.localEffects.push("clear-terminal-ui"),
    }),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: (select: (store: unknown) => unknown) =>
    select({
      markThreadVisited: () => state.localEffects.push("mark-visited"),
    }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: () => state.localEffects.push("refresh-archive"),
}));
vi.mock("../lib/composerDraftUploads", () => ({
  releaseComposerDraftUploads: () => state.localEffects.push("release-uploads"),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteRef: () => null,
  buildThreadRouteParams: (ref: ScopedThreadRef) => ref,
}));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: {
    add: (toast: { title?: string }) => {
      if (toast.title) state.toasts.push(toast.title);
    },
  },
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: unknown) => unknown) =>
    select({
      sidebarThreadSortOrder: "createdAt",
      confirmThreadDelete: true,
      confirmThreadUnpin: true,
    }),
}));

import { useThreadActions } from "./useThreadActions";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const target = { environmentId: secondary, threadId: ThreadId.make("thread") };
type ThreadActions = ReturnType<typeof useThreadActions>;
const operations = [
  {
    name: "archive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.archiveThread(ref),
  },
  {
    name: "unarchive",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unarchiveThread(ref),
  },
  {
    name: "settle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.settleThread(ref),
  },
  {
    name: "unsettle",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsettleThread(ref),
  },
  {
    name: "snooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) =>
      actions.snoozeThread(ref, "2099-01-01T00:00:00Z"),
  },
  {
    name: "unsnooze",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unsnoozeThread(ref),
  },
  { name: "pin", run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.pinThread(ref) },
  {
    name: "unpin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.unpinThread(ref),
  },
  {
    name: "reorderPin",
    run: (actions: ThreadActions, ref: ScopedThreadRef) => actions.reorderPinnedThread(ref, "b"),
  },
] as const;

beforeEach(() => {
  state.scopes = new Map([
    [primary, new Set([AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.threads = [
    {
      environmentId: secondary,
      id: target.threadId,
      projectId: ProjectId.make("project"),
      title: "Thread",
      worktreePath: null,
      session: null,
      latestTurn: null,
    },
  ];
  state.requests = [];
  state.localEffects = [];
  state.confirm.mockReset().mockResolvedValue(true);
  state.toasts = [];
  state.afterRequest = undefined;
  state.sessionLookupFails = false;
  state.dispatchResult = { sequence: 1 };
});

describe("thread action permissions", () => {
  it("reports real cleanup failure and sends only the selected root command", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    using _configs = vi
      .spyOn(appAtomRegistry, "get")
      .mockReturnValue(
        new Map([[secondary, { environment: { capabilities: { threadLifecycleCascade: true } } }]]),
      );
    state.dispatchResult = {
      sequence: 17,
      lifecycle: {
        commandId: CommandId.make("archive"),
        rootThreadId: target.threadId,
        affectedThreadIds: [target.threadId, ThreadId.make("child")],
        cleanup: { pendingCount: 2, failedCount: 1 },
      },
    };
    expect((await useThreadActions().archiveThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      { action: "archive", environmentId: secondary, input: { threadId: target.threadId } },
    ]);
    expect(state.toasts).toContain("thread.lifecycle.archived");
    _configs.mockReturnValue(new Map());
    state.toasts = [];
    await useThreadActions().unarchiveThread(target);
    expect(state.toasts).toContain("thread.lifecycle.saved");
    expect(state.toasts).not.toContain("thread.lifecycle.unarchived");
  });

  it.each(operations)("$name requires the target environment's grant", async ({ run }) => {
    const result = await run(useThreadActions(), target);
    expect(result._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(state.localEffects).toEqual([]);
  });

  it.each(operations)("$name rechecks a retained callback after revocation", async ({ run }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    const actions = useThreadActions();
    state.scopes.get(secondary)!.clear();
    await run(actions, target);
    expect(state.requests).toEqual([]);
  });

  it.each(operations)(
    "$name works after the target gains only task permission",
    async ({ name, run }) => {
      const actions = useThreadActions();
      state.scopes.get(primary)!.clear();
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      expect((await run(actions, target))._tag).toBe("Success");
      expect(state.requests).toEqual([
        expect.objectContaining({ action: name, environmentId: secondary }),
      ]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s blocks a forbidden confirmation",
    async (action) => {
      await useThreadActions()[action](target);
      expect(state.confirm).not.toHaveBeenCalled();
      expect(state.requests).toEqual([]);
    },
  );

  it.each(["confirmAndDeleteThread", "confirmAndUnpinThread"] as const)(
    "%s rechecks after the confirmation",
    async (action) => {
      state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
      const confirmation = deferred<boolean>();
      state.confirm.mockReturnValue(confirmation.promise);
      const result = useThreadActions()[action](target);
      expect(state.confirm).toHaveBeenCalledOnce();
      state.scopes.get(secondary)!.clear();
      confirmation.resolve(true);
      await result;
      expect(state.requests).toEqual([]);
      expect(state.localEffects).toEqual([]);
    },
  );

  it("deletes an archived thread only with its own environment's grant", async () => {
    state.threads = [];
    const actions = useThreadActions();
    await actions.deleteThread(target);
    expect(state.requests).toEqual([]);
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    expect((await actions.deleteThread(target))._tag).toBe("Success");
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "delete", environmentId: secondary }),
    ]);
  });

  it("stops before delete and local cleanup when permission is revoked during session stop", async () => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.session = { status: "ready" };
    state.afterRequest = () => state.scopes.get(secondary)!.clear();
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Failure");
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession"]);
    expect(state.localEffects).toEqual([]);
  });

  it.each([
    { reason: "without source-control permission", sessionLookupFails: false },
    { reason: "when the permission lookup fails", sessionLookupFails: true },
  ])("deletes a worktree thread and keeps its worktree $reason", async ({ sessionLookupFails }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.sessionLookupFails = sessionLookupFails;
    expect((await useThreadActions().deleteThread(target))._tag).toBe("Success");
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
    expect(state.localEffects).toContain("clear-terminal-ui");
  });

  it("does not request worktree removal after its grant is revoked during delete", async () => {
    state.scopes
      .get(secondary)!
      .add(AuthOrchestrationOperateScope)
      .add(AuthSourceControlWriteScope);
    state.threads[0]!.worktreePath = "/worktrees/thread";
    state.afterRequest = () => state.scopes.get(secondary)!.delete(AuthSourceControlWriteScope);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await useThreadActions().deleteThread(target);
      expect(result._tag).toBe("Success");
      expect(state.requests.map((request) => request.action)).toEqual(["stopSession", "delete"]);
      expect(state.toasts).toContain("Failed to delete worktree");
      expect(state.localEffects).toContain("clear-terminal-ui");
    } finally {
      consoleError.mockRestore();
    }
  });
});

it.each([
  { capability: undefined, metadata: false },
  { capability: undefined, metadata: true },
  { capability: true, metadata: false },
  { capability: true, metadata: true },
])(
  "keeps delete confirmation and feedback honest for $capability / metadata $metadata",
  async ({ capability, metadata }) => {
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    using _configs = vi
      .spyOn(appAtomRegistry, "get")
      .mockReturnValue(
        new Map([
          [secondary, { environment: { capabilities: { threadLifecycleCascade: capability } } }],
        ]),
      );
    if (metadata)
      state.dispatchResult = {
        sequence: 18,
        lifecycle: {
          commandId: CommandId.make("delete"),
          rootThreadId: target.threadId,
          affectedThreadIds: [target.threadId, ThreadId.make("child")],
          cleanup: { pendingCount: 0, failedCount: 0 },
        },
      };
    const result = await useThreadActions().confirmAndDeleteThread(target);
    expect(result._tag).toBe("Success");
    expect(state.confirm.mock.calls[0]![0]).toContain(
      capability === true
        ? "thread.lifecycle.deleteConfirm"
        : "thread.lifecycle.deleteConfirmLegacy",
    );
    expect(state.requests).toEqual([
      { action: "stopSession", environmentId: secondary, input: { threadId: target.threadId } },
      { action: "delete", environmentId: secondary, input: { threadId: target.threadId } },
    ]);
    expect(state.toasts.includes("thread.lifecycle.deleted")).toBe(capability === true && metadata);
  },
);

it("cancels confirmed delete without sending a lifecycle command", async () => {
  state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
  state.confirm.mockResolvedValue(false);
  await useThreadActions().confirmAndDeleteThread(target);
  expect(state.requests).toEqual([]);
  expect(state.toasts).toEqual([]);
});

it.each([
  { capability: undefined, metadata: false },
  { capability: undefined, metadata: true },
  { capability: true, metadata: false },
  { capability: true, metadata: true },
])(
  "confirms a bulk selection once and reports each root result for $capability / metadata $metadata",
  async ({ capability, metadata }) => {
    const { deleteSelectedThreadEntries } = await vi.importActual<
      typeof import("../components/Sidebar.logic")
    >("../components/Sidebar.logic");
    state.scopes.get(secondary)!.add(AuthOrchestrationOperateScope);
    state.threads.push({ ...state.threads[0]!, environmentId: primary });
    const targets = [target, { ...target, environmentId: primary }];
    using _configs = vi
      .spyOn(appAtomRegistry, "get")
      .mockReturnValue(
        new Map(
          targets.map(({ environmentId }) => [
            environmentId,
            { environment: { capabilities: { threadLifecycleCascade: capability } } },
          ]),
        ),
      );
    const confirmed = await useThreadDeleteConfirmation()(targets);
    expect(confirmed).toMatchObject({ _tag: "Success", value: true });
    const actions = useThreadActions();
    const result = await deleteSelectedThreadEntries({
      entries: targets.map((threadRef) => ({ threadRef, threadKey: scopedThreadKey(threadRef) })),
      delete: ({ threadRef }, deletedThreadKeys) => {
        state.dispatchResult = metadata
          ? {
              sequence: 20,
              lifecycle: {
                commandId: CommandId.make(`delete:${threadRef.environmentId}`),
                rootThreadId: threadRef.threadId,
                affectedThreadIds: [threadRef.threadId, ThreadId.make("child")],
                cleanup: { pendingCount: 0, failedCount: 0 },
              },
            }
          : { sequence: 20 };
        return actions.deleteThread(threadRef, { deletedThreadKeys });
      },
    });
    expect(result.firstFailure).toBeNull();
    expect([...result.deletedThreadKeys]).toEqual(targets.map(scopedThreadKey));
    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.confirm.mock.calls[0]![0].split("\n")[1]).toBe(
      capability === true
        ? "thread.lifecycle.deleteConfirmMany"
        : "thread.lifecycle.deleteConfirmManyLegacy",
    );
    expect(state.requests.filter(({ action }) => action === "delete")).toEqual(
      targets.map(({ environmentId, threadId }) => ({
        action: "delete",
        environmentId,
        input: { threadId },
      })),
    );
    expect(state.requests.every(({ input }) => input.threadId === target.threadId)).toBe(true);
    expect(state.toasts.filter((title) => title === "thread.lifecycle.deleted")).toHaveLength(
      capability === true && metadata ? 2 : 0,
    );
  },
);
