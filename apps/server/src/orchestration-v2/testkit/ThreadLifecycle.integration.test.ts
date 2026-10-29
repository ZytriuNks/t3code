import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as PreviewManager from "../../preview/Manager.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as NativeSessionBindings from "../NativeSessionBindings.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderRuntimeRecovery from "../ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ResourceCleanup from "../ResourceCleanupService.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import * as ThreadDeletionRecords from "../ThreadDeletionRecords.ts";
import * as ThreadLifecycleResources from "../ThreadLifecycleResources.ts";
import * as ThreadOwnership from "../ThreadOwnership.ts";

const [R, A, B, F, AF] = ["R", "A", "B", "F", "AF"].map((id) => ThreadId.make(`task8:${id}`)) as [
  ThreadId,
  ThreadId,
  ThreadId,
  ThreadId,
  ThreadId,
];
const S = ThreadId.make("task8:shared-survivor");
const projectId = ProjectId.make("task8:project");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const now = DateTime.makeUnsafe("2026-10-28T00:00:00.000Z");
const sharedSessionId = ProviderSessionId.make("task8:shared");
const runtimePolicy = {
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
} as const;

const nativeThread = (
  threadId: ThreadId,
  sessionId: ProviderSessionId,
): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(`${threadId}:native`),
  driver,
  providerInstanceId: instanceId,
  providerSessionId: sessionId,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: `${threadId}:native`, strength: "strong" },
  nativeStorage: { type: "resolved", canonicalRoot: "/task8/native-fixture" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
});

// External services are fakes; commands, ownership, commits, recovery and worker are real.
const makeProvider = () => {
  const closed: Array<ProviderSessionId> = [];
  const unloaded: Array<ThreadId> = [];
  const resumed: Array<ThreadId> = [];
  const forked: Array<ThreadId> = [];
  const started: Array<ThreadId> = [];
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed.push(input.providerSessionId);
          }),
        );
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/task8",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          supportsConfirmedThreadRetirement: true,
          backgroundTasksEndWithProcess: true,
          events: Stream.fromQueue(queue),
          ensureThread: (request) =>
            Effect.succeed(nativeThread(request.threadId, input.providerSessionId)),
          resumeThread: (request) =>
            Effect.sync(() => {
              resumed.push(request.providerThread.appThreadId!);
              return request.providerThread;
            }),
          startTurn: (request) =>
            Effect.gen(function* () {
              started.push(request.threadId);
              const providerTurnId = ProviderTurnId.make(`${request.runId}:turn`);
              yield* Queue.offerAll(queue, [
                {
                  type: "provider_turn.updated",
                  driver,
                  threadId: request.threadId,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: request.providerThread.id,
                    nodeId: request.rootNodeId,
                    runAttemptId: request.attemptId,
                    nativeTurnRef: null,
                    ordinal: request.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: request.providerThread.id,
                  providerTurnId,
                  runOrdinal: request.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.die("integration never steers provider work"),
          interruptTurn: () => Effect.void,
          unloadThread: (request) =>
            Effect.sync(() => {
              unloaded.push(request.providerThread.appThreadId!);
            }),
          respondToRuntimeRequest: () => Effect.die("cancelled approvals must not reach provider"),
          readThreadSnapshot: () => Effect.die("unused native snapshot"),
          rollbackThread: () => Effect.die("unused native rollback"),
          forkThread: (request) =>
            Effect.sync(() => {
              forked.push(request.targetThreadId);
              return nativeThread(request.targetThreadId, input.providerSessionId);
            }),
          injectHistory: () => Effect.succeed(true),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  const instance: ProviderInstance = {
    instanceId,
    driverKind: driver,
    continuationIdentity: { driverKind: driver, continuationKey: "task8:fake" },
    displayName: "Task8 fake provider",
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
    orchestrationAdapter: adapter,
    textGeneration: {} as ProviderInstance["textGeneration"],
  };
  return {
    closed,
    unloaded,
    resumed,
    forked,
    started,
    registry: Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  };
};

const makeRuntime = (
  database: ReturnType<typeof SqlitePersistence.layerFromPath>,
  provider: ReturnType<typeof makeProvider>,
) =>
  Layer.mergeAll(
    RuntimeLayer.layer,
    RuntimeLayer.layerEventSink,
    ProjectStore.layer,
    ProjectionStore.layer,
    EffectOutbox.layer,
    EventStore.layer,
    NativeSessionBindings.layer,
    ThreadDeletionRecords.layer,
  ).pipe(
    Layer.provide(McpSessionRegistryTestkit.layer),
    Layer.provide(McpProviderSessions.layer),
    Layer.provideMerge(database),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(provider.registry),
    Layer.provide(
      Layer.mock(CheckpointStore.CheckpointStore)({ isGitRepository: () => Effect.succeed(false) }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void }),
    ),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
    ),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused link"),
      }),
    ),
  );

const create = Effect.fn("task8.create")(function* (threadId: ThreadId) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${threadId}:create`),
    threadId,
    projectId,
    title: threadId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

const dispatch = Effect.fn("task8.message")(function* (threadId: ThreadId, suffix: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`${threadId}:${suffix}`),
    threadId,
    messageId: MessageId.make(`${threadId}:${suffix}`),
    text: suffix,
    attachments:
      suffix === "history"
        ? [
            {
              type: "file",
              id: "task8-shared",
              name: "fixture.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 13,
            },
          ]
        : [],
    dispatchMode: { type: suffix === "first-continuation" ? "start_immediately" : "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
});

it.effect(
  "replays archive, restore and delete of R/A/B through SQLite without reviving work or crossing forks",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      const attachmentFile = path.join(config.attachmentsDir, "task8-shared.bin");
      yield* fs.writeFileString(attachmentFile, "fixture bytes");
      const database = SqlitePersistence.layerFromPath(config.dbPath);
      const provider = makeProvider();
      const cleanupEntered = yield* Deferred.make<void>();
      const cleanupRelease = yield* Deferred.make<void>();
      const cleaned: Array<string> = [];
      const cleanup = ResourceCleanup.layer.pipe(
        Layer.provide(database),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              deleteForThread: (id) =>
                Effect.sync(() => {
                  cleaned.push(`delete:${id}`);
                  return 1;
                }),
              disableForThread: (id) =>
                Effect.sync(() => {
                  cleaned.push(`suspend:${id}`);
                  return 1;
                }),
            }),
            Layer.mock(TerminalManager.TerminalManager)({
              close: ({ threadId }) =>
                Deferred.succeed(cleanupEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanupRelease)),
                  Effect.andThen(
                    Effect.sync(() => {
                      cleaned.push(`terminal:${threadId}`);
                    }),
                  ),
                ),
            }),
            Layer.mock(PreviewManager.PreviewManager)({
              close: ({ threadId }) =>
                Effect.sync(() => {
                  cleaned.push(`preview:${threadId}`);
                }),
            }),
          ),
        ),
      );
      const runtime = Layer.merge(
        makeRuntime(database, provider).pipe(Layer.provide(cleanup)),
        cleanup,
      );
      const saved = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const resources = yield* ThreadLifecycleResources.ThreadLifecycleResources;
        const ownership = yield* ThreadOwnership.ThreadOwnership;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
        const events = yield* EventStore.EventStoreV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        yield* projects.apply({
          sequence: 0,
          eventId: EventId.make("task8:project"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Task8",
            workspaceRoot: config.cwd,
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        });
        for (const id of [R, A, B, S]) yield* create(id);
        for (const [id, parent] of [
          [A, R],
          [B, A],
        ] as const) {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${id}:lineage`),
                type: "thread.metadata-updated",
                threadId: id,
                occurredAt: now,
                payload: {
                  ...(yield* store.getThread(id)),
                  lineage: {
                    parentThreadId: parent,
                    relationshipToParent: "subagent",
                    rootThreadId: R,
                  },
                },
              },
            ],
          });
        }
        for (const id of [R, A, B]) {
          yield* dispatch(id, "history");
          const projection = yield* store.getThreadRecords(id, ["runs", "nodes", "turnItems"]);
          const run = projection.runs[0]!;
          yield* sink.write({
            lifecycleGuard: yield* orchestrator.resolveLifecycleSource(id),
            events: [
              {
                id: EventId.make(`${id}:history-native`),
                type: "provider-thread.updated",
                threadId: id,
                occurredAt: now,
                payload: nativeThread(id, sharedSessionId),
              },
            ],
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${id}:stable`),
                type: "run.updated",
                threadId: id,
                occurredAt: now,
                payload: {
                  ...run,
                  providerThreadId: nativeThread(id, sharedSessionId).id,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
              ...projection.nodes.map((node) => ({
                id: EventId.make(`${node.id}:stable`),
                type: "node.updated" as const,
                threadId: id,
                occurredAt: now,
                payload: { ...node, status: "completed" as const, completedAt: now },
              })),
              ...projection.turnItems.map((item) => ({
                id: EventId.make(`${item.id}:stable`),
                type: "turn-item.updated" as const,
                threadId: id,
                occurredAt: now,
                payload: { ...item, status: "completed" as const, completedAt: now },
              })),
            ],
          });
        }
        for (const [threadId, childThreadId] of [
          [R, A],
          [A, B],
        ] as const) {
          const run = (yield* store.getThreadRecords(threadId, ["runs"])).runs[0]!;
          const taskId = NodeId.make(`${threadId}:historical-child`);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`${threadId}:child`),
                type: "subagent.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: taskId,
                  threadId,
                  runId: run.id,
                  parentNodeId: run.rootNodeId!,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver,
                  providerInstanceId: instanceId,
                  providerThreadId: null,
                  childThreadId,
                  nativeTaskRef: null,
                  prompt: "Delegate",
                  title: null,
                  model: null,
                  completionDelivery: { state: "claimed", observedByRunId: null },
                  status: "completed",
                  result: "retained child result",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make(`${threadId}:child-card`),
                type: "turn-item.updated",
                threadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`${threadId}:child-card`),
                  type: "subagent",
                  threadId,
                  runId: run.id,
                  nodeId: taskId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2000001,
                  status: "completed",
                  title: "Historical child",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  subagentId: taskId,
                  origin: "app_owned",
                  driver,
                  providerInstanceId: instanceId,
                  childThreadId,
                  prompt: "Delegate",
                  result: "retained child result",
                },
              },
            ],
          });
        }
        for (const [sourceThreadId, targetThreadId] of [
          [R, F],
          [A, AF],
        ] as const)
          yield* orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(`${targetThreadId}:fork`),
            sourceThreadId,
            targetThreadId,
            sourcePoint: {
              type: "run",
              runId: (yield* store.getThreadRecords(sourceThreadId, ["runs"])).runs[0]!.id,
            },
            title: targetThreadId,
            createdBy: "user",
            creationSource: "web",
          });
        const forkHistory = (yield* orchestrator.getThreadProjection(F)).visibleTurnItems;
        assert.isTrue(
          forkHistory.some((row) => row.item.type === "subagent" && row.item.childThreadId === A),
        );
        assert.isEmpty((yield* orchestrator.getThreadProjection(F)).subagents);
        const oldSource = yield* orchestrator.resolveLifecycleSource(R);
        const shared = sharedSessionId;
        const oldRuntime = yield* sessions.open({
          threadId: R,
          providerSessionId: shared,
          modelSelection,
          runtimePolicy,
        });
        for (const threadId of [A, B, S])
          yield* sessions.open({
            threadId,
            providerSessionId: shared,
            modelSelection,
            runtimePolicy,
          });
        for (const id of [R, A, B, S]) {
          yield* sink.write({
            lifecycleGuard: yield* orchestrator.resolveLifecycleSource(id),
            events: [
              {
                id: EventId.make(`${id}:native`),
                type: "provider-thread.updated",
                threadId: id,
                occurredAt: now,
                payload: nativeThread(id, shared),
              },
            ],
          });
        }
        for (const id of [R, A, B]) {
          yield* dispatch(id, "old-queue");
          const projection = yield* store.getThreadRecords(id, ["runs", "nodes"]);
          const run = projection.runs.at(-1)!;
          const node = projection.nodes.find((row) => row.id === run.rootNodeId)!;
          const runless = NodeId.make(`${id}:runless`);
          const updates: Array<OrchestrationV2DomainEvent> = [
            {
              id: EventId.make(`${id}:active`),
              type: "run.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                ...run,
                status: id === R ? "running" : "queued",
                delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
              },
            },
            {
              id: EventId.make(`${id}:runless`),
              type: "node.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                ...node,
                id: runless,
                rootNodeId: runless,
                runId: null,
                status: "running",
              },
            },
            {
              id: EventId.make(`${id}:approval`),
              type: "runtime-request.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make(`${id}:approval`),
                nodeId: runless,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "command",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ];
          yield* sink.write({ events: updates });
        }
        const oldRun = (yield* store.getThreadRecords(R, ["runs"])).runs.at(-1)!;
        const oldCursor = yield* events.latestSequence();
        const archiveId = CommandId.make("task8:archive");
        const archived = yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: archiveId,
          threadId: R,
        });
        assert.deepEqual(
          archived.storedEvents
            .filter((row) => row.event.type === "thread.archived")
            .map((row) => row.event.threadId),
          [R, A, B],
        );
        for (const id of [R, A, B]) {
          assert.isNotNull((yield* store.getThread(id)).archivedAt);
          assert.isTrue(Option.isNone(yield* records.get(id)));
        }
        assert.deepEqual(
          (yield* ownership.resolveScope({ rootThreadId: R, operation: "unarchive" })).members.map(
            (row) => row.id,
          ),
          [R, A, B],
        );
        assert.isTrue(
          (yield* store.getShellSnapshot({ location: "archive" })).archivedThreads.some(
            (row) => row.id === B,
          ),
        );
        yield* orchestrator.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make("task8:unarchive"),
          threadId: R,
        });
        for (const id of [R, A, B]) {
          const projection = yield* orchestrator.getThreadProjection(id);
          assert.isNull(projection.thread.archivedAt);
          assert.isFalse(
            projection.runs.some((row) =>
              ["running", "queued", "starting", "preparing", "waiting"].includes(row.status),
            ),
          );
          assert.isFalse(projection.runtimeRequests.some((row) => row.status === "pending"));
          assert.isFalse(
            projection.nodes.some((row) => row.runId === null && row.status === "running"),
          );
          assert.equal((yield* resources.assertCanCreate(id).pipe(Effect.flip)).reason, "cleanup");
        }
        assert.isEmpty(cleaned);
        const draining = yield* worker.drain().pipe(Effect.forkChild);
        yield* Deferred.await(cleanupEntered);
        assert.equal((yield* resources.assertCanCreate(R).pipe(Effect.flip)).reason, "cleanup");
        yield* Deferred.succeed(cleanupRelease, undefined);
        assert.isAbove(yield* Fiber.join(draining), 0);
        assert.deepEqual(yield* resources.getCleanupStatus(archiveId), {
          pendingCount: 0,
          failedCount: 0,
        });
        for (const id of [R, A, B]) yield* resources.withCreateCommit(id, Effect.void);
        assert.sameMembers(
          cleaned.filter((entry) => entry.startsWith("suspend:")),
          [R, A, B].map((id) => `suspend:${id}`),
        );
        assert.isFalse(provider.closed.includes(shared));
        assert.isFalse(provider.unloaded.includes(S));
        yield* oldRuntime.resumeThread({ threadId: S, providerThread: nativeThread(S, shared) });
        assert.equal(provider.resumed.at(-1), S);
        assert.equal(
          (yield* oldRuntime
            .resumeThread({ threadId: R, providerThread: nativeThread(R, shared) })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        const freshSource = yield* orchestrator.resolveLifecycleSource(R);
        const freshSession = IdAllocator.derive.providerSession({
          providerInstanceId: instanceId,
          incarnation: { threadId: R, sourceToken: freshSource.sourceToken },
        });
        yield* sessions.open({
          threadId: R,
          providerSessionId: freshSession,
          modelSelection,
          runtimePolicy,
        });
        yield* dispatch(R, "fresh-queue");
        const freshBefore = yield* orchestrator.getThreadProjection(R);
        assert.notEqual(freshSource.sourceToken, oldSource.sourceToken);
        assert.deepEqual(
          yield* sink.write({
            lifecycleGuard: oldSource,
            events: [
              {
                id: EventId.make("task8:late-metadata"),
                type: "thread.metadata-updated",
                threadId: R,
                occurredAt: now,
                payload: { ...freshBefore.thread, title: "stale callback" },
              },
            ],
          }),
          [],
        );
        const lateCommand = CommandId.make("task8:late-completion");
        assert.deepEqual(
          yield* sink.writeWithEffects({
            lifecycleGuard: oldSource,
            commandId: lateCommand,
            updateDelegatedCompletionOnly: true,
            events: [
              {
                id: EventId.make("task8:late-completion"),
                type: "run.updated",
                threadId: R,
                occurredAt: now,
                payload: {
                  ...oldRun,
                  delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
                },
              },
            ],
            effects: [
              {
                id: "task8:late-queue",
                commandId: lateCommand,
                threadId: R,
                request: { type: "provider-turn.start", runId: oldRun.id },
              },
            ],
          }),
          [],
        );
        assert.deepEqual(yield* outbox.listByCommandId(lateCommand), []);
        const detach = (yield* outbox.listByCommandId(archiveId)).find(
          (row) => row.threadId === R && row.request.type === "provider-session.detach",
        )!;
        if (detach.request.type === "provider-session.detach")
          yield* sessions.detach({
            threadId: R,
            providerSessionId: detach.request.providerSessionId,
            retirementRevision: detach.request.retirementRevision!,
            retirementSourceToken: detach.request.retirementSourceToken!,
            lifecycle: detach.request.lifecycle!,
          });
        assert.isTrue(yield* sessions.isLive(freshSession));
        assert.deepEqual(yield* orchestrator.getThreadProjection(R), freshBefore);
        const deleteId = CommandId.make("task8:delete");
        yield* orchestrator.dispatch({ type: "thread.delete", commandId: deleteId, threadId: R });
        for (const id of [R, A, B]) {
          const deletion = Option.getOrThrow(yield* records.get(id));
          assert.equal(deletion.operationRootThreadId, R);
          assert.equal(deletion.scope, "t3_only");
        }
        for (const id of [F, AF]) {
          assert.isNull((yield* store.getThread(id)).deletedAt);
          assert.isTrue(Option.isNone(yield* records.get(id)));
        }
        const effects = yield* outbox.listByCommandId(deleteId);
        assert.equal(new Set(effects.map((row) => row.id)).size, effects.length);
        assert.isTrue(effects.every((row) => [R, A, B].includes(row.threadId)));
        assert.isAbove(yield* worker.drain(), 0);
        assert.sameMembers(
          cleaned.filter((entry) => entry.startsWith("delete:")),
          [R, A, B].map((id) => `delete:${id}`),
        );
        assert.isTrue(yield* sessions.isLive(shared));
        assert.isFalse(provider.unloaded.includes(S));
        assert.deepEqual(yield* resources.getCleanupStatus(deleteId), {
          pendingCount: 0,
          failedCount: 0,
        });
        assert.deepEqual(
          (yield* orchestrator.getThreadProjection(F)).visibleTurnItems,
          forkHistory,
        );
        assert.equal(yield* fs.readFileString(attachmentFile), "fixture bytes");
        yield* (yield* ResourceCleanup.ResourceCleanupService).cleanupAttachments(
          ["task8-shared"],
          R,
        );
        assert.equal(yield* fs.readFileString(attachmentFile), "fixture bytes");
        const firstPage = yield* store.getTimelinePage(F, { view: "activity", limit: 1 });
        const nextPage = yield* store.getTimelinePage(F, {
          view: "activity",
          limit: 100,
          afterPosition: 0,
        });
        assert.deepEqual([...firstPage.items, ...nextPage.items], forkHistory);
        assert.equal(
          (yield* orchestrator
            .dispatch({
              type: "thread.fork",
              commandId: CommandId.make("task8:forbidden-fork"),
              sourceThreadId: R,
              targetThreadId: ThreadId.make("task8:forbidden"),
              sourcePoint: { type: "latest_stable" },
              title: "Forbidden",
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.isEmpty(provider.started);
        const continuationCursor = yield* events.latestSequence();
        for (const threadId of [F, AF]) {
          yield* dispatch(threadId, "first-continuation");
        }
        yield* worker.drain();
        for (const threadId of [F, AF])
          yield* sink
            .stream({ afterSequence: continuationCursor, threadId, eventType: "run.updated" })
            .pipe(
              Stream.filter(
                (row) =>
                  row.event.type === "run.updated" &&
                  ["waiting", "completed"].includes(row.event.payload.status),
              ),
              Stream.runHead,
            );
        yield* worker.drain();
        assert.sameMembers(provider.started, [F, AF]);
        assert.sameMembers(provider.forked, [F, AF]);
        for (const threadId of [F, AF]) {
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(projection.runs.at(-1)?.status, "completed");
          assert.isEmpty(projection.subagents);
          assert.equal(projection.contextTransfers[0]?.status, "consumed");
        }
        return {
          oldCursor,
          forkHistory: (yield* store.getThreadProjection(F)).visibleTurnItems,
          deleteId,
        };
      }).pipe(Effect.provide(Layer.fresh(runtime)));

      // Close and reopen the actual SQLite file, then replay through the public maintenance API.
      yield* Effect.gen(function* () {
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const events = yield* EventStore.EventStoreV2;
        const bindings = yield* NativeSessionBindings.NativeSessionBindings;
        const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
        assert.isTrue((yield* maintenance.rebuild).valid);
        yield* recovery.recover;
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        const replay = yield* events
          .read({ afterSequence: saved.oldCursor })
          .pipe(Stream.runCollect);
        assert.deepEqual(
          replay
            .filter((row) => row.event.type === "thread.deleted")
            .map((row) => row.event.threadId),
          [R, A, B],
        );
        for (const id of [R, A, B]) {
          const projection = yield* store.getThreadProjection(id);
          assert.isNotNull(projection.thread.deletedAt);
          assert.isFalse(
            projection.runs.some((run) =>
              ["running", "queued", "starting", "preparing", "waiting"].includes(run.status),
            ),
          );
          assert.isFalse(
            projection.runtimeRequests.some((request) => request.status === "pending"),
          );
          assert.equal(Option.getOrThrow(yield* records.get(id)).commandId, saved.deleteId);
          assert.equal(
            yield* bindings.checkImport({
              driver,
              providerInstanceId: ProviderInstanceId.make("alias"),
              nativeId: `${id}:native`,
              storage: { type: "resolved", canonicalRoot: "/task8/native-fixture" },
            }),
            "deleted",
          );
        }
        assert.deepEqual((yield* store.getThreadProjection(F)).visibleTurnItems, saved.forkHistory);
        assert.isTrue((yield* maintenance.verify).valid);
        assert.deepEqual(
          yield* sink.write({
            lifecycleGuard: { threadId: R, lifecycleRevision: 0 },
            events: [
              {
                id: EventId.make("task8:restart-late"),
                type: "thread.metadata-updated",
                threadId: R,
                occurredAt: now,
                payload: { ...(yield* store.getThread(R)), deletedAt: null },
              },
            ],
          }),
          [],
        );
      }).pipe(Effect.provide(Layer.fresh(runtime)));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "task8-lifecycle-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
