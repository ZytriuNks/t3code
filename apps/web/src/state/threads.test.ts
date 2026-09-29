import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/state/threads";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createRunningThreadKeepAliveAtom } from "./threads";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");

function shell(
  id: string,
  status: OrchestrationV2ThreadShell["status"],
  overrides: Partial<
    Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "pendingBackgroundTasks">
  > = {},
) {
  return {
    id: ThreadId.make(id),
    status,
    ...overrides,
  } satisfies Pick<
    OrchestrationV2ThreadShell,
    "id" | "status" | "activityRunStatus" | "pendingBackgroundTasks"
  >;
}

function detail(
  id: string,
  status: OrchestrationV2RunStatus,
  overrides: Partial<EnvironmentThreadState> = {},
) {
  const threadId = ThreadId.make(id);
  const now = DateTime.makeUnsafe("2026-09-24T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
  const projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: id,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: RunId.make(`${id}-run`),
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`${id}-message`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  };
  return AsyncResult.success<EnvironmentThreadState>({
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    status: "live",
    data: Option.some(projection),
    ...overrides,
  });
}

function makeHarness() {
  // Registry cleanup runs only on `flush`, like the real deferred task.
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const environmentIds = Atom.make<ReadonlyArray<EnvironmentId>>([LOCAL, REMOTE]).pipe(
    Atom.keepAlive,
  );
  const threads = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<ReturnType<typeof shell>>>([]).pipe(Atom.keepAlive),
  );
  // Stand-ins for the thread state atoms. Each one lives only while mounted,
  // as the real stream does.
  const keys = new Set<string>();
  const states = Atom.family((_key: string) =>
    Atom.make<AsyncResult.AsyncResult<EnvironmentThreadState>>(
      AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE),
    ),
  );
  const stateAtom = (environmentId: EnvironmentId, threadId: string) => {
    const key = `${environmentId}:${threadId}`;
    keys.add(key);
    return states(key);
  };
  const keepAlive = createRunningThreadKeepAliveAtom({
    environmentIdsAtom: environmentIds,
    threadsAtom: threads,
    stateAtom,
  });
  registry.mount(keepAlive);
  return {
    registry,
    environmentIds,
    threads,
    stateAtom,
    keepAlive,
    openStreams: () => {
      flush();
      return [...keys].filter((key) => registry.getNodes().has(states(key))).toSorted();
    },
  };
}

describe("createRunningThreadKeepAliveAtom", () => {
  it("keeps running threads open across shell updates and thread view visits", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("a", "running"),
      shell("b", "completed"),
      shell("c", "idle"),
    ]);
    h.registry.set(h.threads(REMOTE), [shell("d", "starting")]);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);

    // A thread view that comes and goes shares the kept stream.
    const live = detail("a", "running");
    h.registry.set(h.stateAtom(LOCAL, "a"), live);
    h.registry.mount(h.stateAtom(LOCAL, "a"))();

    // A shell update that starts or stops nothing does not rebuild the set.
    const kept = h.registry.get(h.keepAlive);
    h.registry.set(h.threads(LOCAL), [shell("a", "running"), shell("b", "completed")]);
    expect(h.registry.get(h.keepAlive)).toBe(kept);
    expect(h.openStreams()).toEqual(["local:a", "remote:d"]);
    expect(h.registry.get(h.stateAtom(LOCAL, "a"))).toBe(live);
  });

  it("holds a stopped thread until its own stream is live and shows the stop", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("a", "running"),
      shell("b", "running"),
      shell("c", "running"),
    ]);
    // "b" has not loaded yet. "c" hit a stream error.
    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "running"));
    h.registry.set(
      h.stateAtom(LOCAL, "c"),
      detail("c", "running", { status: "cached", error: Option.some("Could not sync.") }),
    );

    // The shell reports the stops first. A failed stream cannot deliver its
    // stop, so only it is released now.
    h.registry.set(h.threads(LOCAL), [
      shell("a", "completed"),
      shell("b", "completed"),
      shell("c", "completed"),
    ]);
    expect(h.openStreams()).toEqual(["local:a", "local:b"]);

    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "completed"));
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "completed", { status: "synchronizing" }));
    expect(h.openStreams()).toEqual(["local:b"]);
    h.registry.set(h.stateAtom(LOCAL, "b"), detail("b", "completed"));
    expect(h.openStreams()).toEqual([]);
  });

  it.each(["preparing", "starting", "running"] as const)(
    "keeps a %s V2 run open after the shell settles",
    (status) => {
      const h = makeHarness();
      h.registry.set(h.threads(LOCAL), [shell("a", "running")]);
      h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", status));

      h.registry.set(h.threads(LOCAL), [shell("a", "completed")]);
      expect(h.openStreams()).toEqual(["local:a"]);

      h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "completed"));
      expect(h.openStreams()).toEqual([]);
    },
  );

  it.each(["preparing", "starting", "running"] as const)(
    "opens the detail stream for a %s V2 shell",
    (status) => {
      const h = makeHarness();
      h.registry.set(h.threads(LOCAL), [shell("a", status)]);
      expect(h.openStreams()).toEqual(["local:a"]);
    },
  );

  it("keeps the activity run open when the latest run is queued", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("a", "queued", { activityRunStatus: "running" }),
      shell("b", "queued"),
    ]);
    expect(h.openStreams()).toEqual(["local:a"]);

    h.registry.set(h.stateAtom(LOCAL, "a"), detail("a", "completed"));
    h.registry.set(h.threads(LOCAL), [shell("a", "queued", { activityRunStatus: null })]);
    expect(h.openStreams()).toEqual([]);
  });

  it("does not open settled background work as an active shell run", () => {
    const h = makeHarness();
    h.registry.set(h.threads(LOCAL), [
      shell("a", "running", {
        activityRunStatus: "running",
        pendingBackgroundTasks: [{ taskId: "background-task", description: "Background work" }],
      }),
    ]);
    expect(h.openStreams()).toEqual([]);
  });

  it("follows environments that connect and go away", () => {
    const h = makeHarness();
    h.registry.set(h.environmentIds, [LOCAL]);
    h.registry.set(h.threads(REMOTE), [shell("d", "running")]);
    expect(h.openStreams()).toEqual([]);

    h.registry.set(h.environmentIds, [LOCAL, REMOTE]);
    expect(h.openStreams()).toEqual(["remote:d"]);

    // Removal drops every mount, including one still waiting for its stop.
    h.registry.set(h.stateAtom(REMOTE, "d"), detail("d", "running"));
    h.registry.set(h.threads(REMOTE), [shell("d", "completed")]);
    expect(h.openStreams()).toEqual(["remote:d"]);
    h.registry.set(h.environmentIds, [LOCAL]);
    expect(h.openStreams()).toEqual([]);
  });
});
