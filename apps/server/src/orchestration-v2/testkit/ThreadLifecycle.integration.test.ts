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
  type NativeSessionStorage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderSession,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NativeSessionStorageResolver from "@t3tools/provider-core/server/NativeSessionStorage";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { PiAdapterV2Driver } from "@t3tools/provider-pi/server";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

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
const decodePiRpcRecord = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodePiRpcRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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
const makeProvider = (additionalInstances: ReadonlyArray<ProviderInstance> = []) => {
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
  const instances = [instance, ...additionalInstances];
  return {
    closed,
    unloaded,
    resumed,
    forked,
    started,
    instance,
    registry: Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (id) =>
        Effect.succeed(instances.find((candidate) => candidate.instanceId === id)),
      listInstances: Effect.succeed(instances),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  };
};

const makePiProviderInstance = (input: {
  readonly base: ProviderInstance;
  readonly nativeStorage: NativeSessionStorage;
  readonly removeNativeFile: (filePath: string) => Effect.Effect<void>;
  readonly pauseDetach: Ref.Ref<boolean>;
  readonly detachEntered: Deferred.Deferred<void>;
  readonly detachRelease: Deferred.Deferred<void>;
  readonly resumed: Array<ThreadId>;
  readonly deleted: Array<ProviderThreadId>;
  readonly unloaded: Array<ProviderThreadId>;
}) => {
  const piInstanceId = ProviderInstanceId.make("task8-pi");
  const piDriver = ProviderDriverKind.make("pi");
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    sessions: {
      ...CodexProviderCapabilitiesV2.sessions,
      supportsMultipleProviderThreadsPerSession: false,
    },
  };
  const makeNativeThread = (
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
  ): OrchestrationV2ProviderThread => ({
    id: ProviderThreadId.make("task8:pi-native-thread"),
    driver: piDriver,
    providerInstanceId: piInstanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver: piDriver, nativeId: "task8:pi-native-session", strength: "strong" },
    nativeStorage: input.nativeStorage,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    ...input.base.orchestrationAdapter,
    instanceId: piInstanceId,
    driver: piDriver,
    getCapabilities: () => Effect.succeed(capabilities),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const openedAt = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: piDriver,
          providerInstanceId: piInstanceId,
          status: "ready",
          cwd: process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities,
          createdAt: openedAt,
          updatedAt: openedAt,
          lastError: null,
        };
        return {
          instanceId: piInstanceId,
          driver: piDriver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          supportsConfirmedThreadRetirement: true,
          backgroundTasksEndWithProcess: true,
          ensureThread: (request) =>
            Effect.succeed(makeNativeThread(request.threadId, sessionInput.providerSessionId)),
          resumeThread: (request) => {
            if (
              input.nativeStorage.type !== "resolved" ||
              input.nativeStorage.canonicalFile === undefined
            )
              return Effect.die("Pi fixture session file was not available to resume.");
            return Effect.sync(() => {
              if (request.providerThread.appThreadId !== null)
                input.resumed.push(request.providerThread.appThreadId);
              return request.providerThread;
            });
          },
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          unloadThread: ({ providerThread }) =>
            Effect.gen(function* () {
              input.unloaded.push(providerThread.id);
              if (yield* Ref.get(input.pauseDetach)) {
                yield* Deferred.succeed(input.detachEntered, undefined);
                yield* Deferred.await(input.detachRelease);
              }
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused Pi fixture snapshot"),
          rollbackThread: () => Effect.die("unused Pi fixture rollback"),
          forkThread: () => Effect.die("unused Pi fixture fork"),
        };
      }),
    deleteNativeThread: ({ providerThread }) =>
      Effect.gen(function* () {
        input.deleted.push(providerThread.id);
        const providerStorage = providerThread.nativeStorage;
        if (providerStorage?.type !== "resolved" || providerStorage.canonicalFile === undefined)
          return yield* Effect.die("Pi fixture deletion received no canonical file.");
        yield* input.removeNativeFile(providerStorage.canonicalFile);
      }),
  };
  return {
    instance: {
      ...input.base,
      instanceId: piInstanceId,
      driverKind: piDriver,
      continuationIdentity: { driverKind: piDriver, continuationKey: "task8:fake-pi" },
      displayName: "Task8 fake Pi provider",
      orchestrationAdapter: adapter,
    } satisfies ProviderInstance,
    makeNativeThread,
  };
};

const makeRealPiProviderInstance = Effect.fn("test.makeRealPiProviderInstance")(function* (input: {
  readonly base: ProviderInstance;
  readonly sessionFile: string;
  readonly pauseClose: Ref.Ref<boolean>;
  readonly closeEntered: Deferred.Deferred<void>;
  readonly closeRelease: Deferred.Deferred<void>;
  readonly closeCompleted: Deferred.Deferred<void>;
  readonly onPrompt?: () => Effect.Effect<void>;
}) {
  const requests: Array<Record<string, unknown>> = [];
  const deleteCalls: Array<ProviderAdapter.ProviderAdapterV2DeleteNativeThreadInput> = [];
  let piExit: Deferred.Deferred<ChildProcessSpawner.ExitCode> | null = null;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (ChildProcess.isStandardCommand(command) && command.command === "taskkill") {
        if (yield* Ref.get(input.pauseClose)) {
          yield* Deferred.succeed(input.closeEntered, undefined);
          yield* Deferred.await(input.closeRelease);
        }
        if (piExit !== null) yield* Deferred.succeed(piExit, ChildProcessSpawner.ExitCode(0));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_998),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      piExit = exited;
      let buffer = "";
      return ChildProcessSpawner.makeHandle({
        // The transport probes the pid before issuing the Windows tree
        // termination command; use this test process as a live sentinel.
        pid: ChildProcessSpawner.ProcessId(process.pid),
        exitCode: Deferred.await(exited),
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            buffer += new TextDecoder().decode(chunk);
            while (buffer.includes("\n")) {
              const newline = buffer.indexOf("\n");
              const record = decodePiRpcRecord(buffer.slice(0, newline));
              buffer = buffer.slice(newline + 1);
              requests.push(record);
              const type = record["type"];
              if (
                ![
                  "get_state",
                  "get_available_models",
                  "get_commands",
                  "switch_session",
                  "get_entries",
                  "get_messages",
                  "get_session_stats",
                  "prompt",
                  "set_session_name",
                ].includes(String(type))
              )
                return yield* Effect.die(`Unexpected Pi RPC command: ${String(type)}`);
              const data =
                type === "get_state"
                  ? {
                      sessionFile: input.sessionFile,
                      isStreaming: false,
                      model: { provider: "test", id: "model" },
                      thinkingLevel: "off",
                    }
                  : type === "get_available_models"
                    ? { models: [] }
                    : type === "get_entries"
                      ? { entries: [], leafId: null }
                      : type === "get_messages"
                        ? { messages: [] }
                        : type === "get_commands"
                          ? { commands: [] }
                          : type === "get_session_stats"
                            ? {}
                            : { cancelled: false };
              yield* Queue.offer(
                stdout,
                new TextEncoder().encode(
                  `${encodePiRpcRecord({ type: "response", id: record["id"], command: type, success: true, data })}\n`,
                ),
              );
              if (type === "prompt") {
                if (input.onPrompt !== undefined) yield* input.onPrompt();
                yield* Queue.offerAll(
                  stdout,
                  [
                    { type: "agent_start" },
                    {
                      type: "message_end",
                      message: {
                        role: "assistant",
                        content: [{ type: "text", text: "Lifecycle fixture completed" }],
                        stopReason: "stop",
                      },
                    },
                    { type: "agent_settled" },
                  ].map((event) => new TextEncoder().encode(`${encodePiRpcRecord(event)}\n`)),
                );
              }
            }
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const instanceId = ProviderInstanceId.make("task8-pi");
  const adapter = yield* PiAdapterV2Driver.create({
    instanceId,
    enabled: true,
    displayName: undefined,
    environment: [],
    config: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HostProcess.Platform, "win32"),
        TestProviderHost.layer(),
        McpProviderSessions.layer,
        IdAllocator.layer,
      ),
    ),
  );
  const realDeleteNativeThread = adapter.deleteNativeThread;
  const observedAdapter = {
    ...adapter,
    openSession: (openInput: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Deferred.succeed(input.closeCompleted, undefined));
        return yield* adapter.openSession(openInput);
      }),
    ...(realDeleteNativeThread === undefined
      ? {}
      : {
          deleteNativeThread: (
            deleteInput: ProviderAdapter.ProviderAdapterV2DeleteNativeThreadInput,
          ) =>
            Effect.gen(function* () {
              deleteCalls.push(deleteInput);
              yield* realDeleteNativeThread(deleteInput);
            }),
        }),
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
  return {
    requests,
    deleteCalls,
    childExited: Effect.suspend(() =>
      piExit === null ? Effect.succeed(false) : Deferred.isDone(piExit),
    ),
    instance: {
      ...input.base,
      instanceId,
      driverKind: ProviderDriverKind.make("pi"),
      orchestrationAdapter: observedAdapter,
    } satisfies ProviderInstance,
  };
});

const makeRuntime = <E, R>(
  database: Layer.Layer<SqlClient.SqlClient, E, R>,
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
    Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
    Layer.provide(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused link"),
      }),
    ),
  );

const create = Effect.fn("task8.create")(function* (
  threadId: ThreadId,
  selectedModel = modelSelection,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${threadId}:create`),
    threadId,
    projectId,
    title: threadId,
    modelSelection: selectedModel,
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

it.effect.each([
  { name: "lazy direct delete", lazy: true, detach: false, resume: false },
  { name: "existing client detach", lazy: false, detach: true, resume: false },
  { name: "lazy client detach", lazy: true, detach: true, resume: false },
  { name: "existing resume direct delete", lazy: false, detach: false, resume: true },
  {
    name: "lazy concurrent client close",
    lazy: true,
    detach: false,
    resume: false,
    concurrentClose: true,
  },
])("deletes the real Pi session through lifecycle cleanup: $name", (scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(now));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-fix06-" });
      const sessionFile = path.join(root, "session.jsonl");
      const siblingFile = path.join(root, "sibling.jsonl");
      const contents = "private Pi lifecycle transcript";
      yield* fs.writeFileString(siblingFile, "unrelated session");
      if (!scenario.lazy) yield* fs.writeFileString(sessionFile, contents);
      assert.isTrue(path.isAbsolute(sessionFile));
      assert.isTrue(yield* fs.exists(path.dirname(sessionFile)));
      assert.equal(yield* fs.exists(sessionFile), !scenario.lazy);
      const threadId = ThreadId.make(`fix06:${scenario.name}`);
      const piInstanceId = ProviderInstanceId.make("task8-pi");
      const piDriver = ProviderDriverKind.make("pi");
      const selection = { instanceId: piInstanceId, model: "default" };
      const closeEntered = yield* Deferred.make<void>();
      const closeRelease = yield* Deferred.make<void>();
      const closeCompleted = yield* Deferred.make<void>();
      const prompted = yield* Deferred.make<void>();
      const pauseClose = yield* Ref.make(false);
      const baseProvider = makeProvider();
      const pi = yield* makeRealPiProviderInstance({
        base: baseProvider.instance,
        sessionFile,
        pauseClose,
        closeEntered,
        closeRelease,
        closeCompleted,
        onPrompt: () =>
          Effect.gen(function* () {
            assert.equal(yield* fs.exists(sessionFile), !scenario.lazy);
            if (scenario.lazy) yield* fs.writeFileString(sessionFile, contents);
            yield* Deferred.succeed(prompted, undefined);
          }).pipe(Effect.orDie),
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const events = yield* EventStore.EventStoreV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const bindings = yield* NativeSessionBindings.NativeSessionBindings;
        const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        yield* projects.apply({
          sequence: 0,
          eventId: EventId.make(`${threadId}:project`),
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
            title: "Pi lifecycle fixture",
            workspaceRoot: root,
            defaultModelSelection: null,
            scripts: [],
            createdAt: DateTime.formatIso(now),
            updatedAt: DateTime.formatIso(now),
          },
        });
        yield* create(threadId, selection);
        const source = yield* orchestrator.resolveLifecycleSource(threadId);
        const startCommandId = CommandId.make(`${threadId}:message`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: startCommandId,
          threadId,
          messageId: MessageId.make(`${threadId}:message`),
          text: "Create the private session transcript",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const plannedProjection = yield* store.getThreadRecords(threadId, [
          "providerThreads",
          "runs",
        ]);
        assert.lengthOf(plannedProjection.providerThreads, 1);
        assert.lengthOf(plannedProjection.runs, 1);
        const planned = plannedProjection.providerThreads[0]!;
        const run = plannedProjection.runs[0]!;
        const providerThreadId = planned.id;
        assert.isNotNull(planned.providerSessionId);
        const providerSessionId = planned.providerSessionId!;
        assert.equal(planned.firstRunOrdinal, run.ordinal);
        assert.equal(planned.lastRunOrdinal, run.ordinal);
        assert.isNull(planned.nativeThreadRef);
        assert.deepEqual(planned.nativeBindingOrigin, {
          version: 1,
          kind: "server_placeholder",
        });
        const plannedEvents = yield* events.readByCommandId({ commandId: startCommandId }).pipe(
          Stream.filter((stored) => stored.event.type === "provider-thread.updated"),
          Stream.runCollect,
        );
        assert.isNotEmpty(plannedEvents);
        for (const stored of plannedEvents) {
          assert.nestedPropertyVal(stored, "event.payload.id", providerThreadId);
          assert.deepNestedPropertyVal(stored, "event.nativeBindingSource", {
            version: 1,
            kind: "pre_native_pending",
          });
        }
        assert.isEmpty(yield* bindings.listForThreads([threadId]));
        assert.isFalse(yield* sessions.isLive(providerSessionId));
        assert.isEmpty(pi.requests);
        assert.equal(yield* fs.exists(sessionFile), !scenario.lazy);
        const terminal = yield* orchestrator
          .streamStoredEventsFrom({
            threadId,
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === run.id &&
                ["waiting", "completed", "failed"].includes(stored.event.payload.status),
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
        assert.isAbove(yield* worker.drain(), 0);
        yield* Deferred.await(prompted);
        const terminalEvents = yield* Fiber.join(terminal);
        assert.lengthOf(terminalEvents, 1);
        assert.notNestedPropertyVal(terminalEvents[0]!, "event.payload.status", "failed");
        yield* worker.drain();
        const completed = yield* store.getThreadRecords(threadId, [
          "providerThreads",
          "providerTurns",
          "runs",
        ]);
        assert.equal(completed.runs[0]!.status, "completed");
        assert.lengthOf(completed.providerTurns, 1);
        assert.equal(completed.providerTurns[0]!.status, "completed");
        const native = completed.providerThreads[0]!;
        assert.equal(native.id, providerThreadId);
        assert.equal(native.nativeThreadRef?.nativeId, sessionFile);
        const nativeEvents = yield* events
          .read({ threadId, eventType: "provider-thread.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-thread.updated" &&
                stored.event.payload.nativeThreadRef !== null,
            ),
            Stream.runCollect,
          );
        assert.isNotEmpty(nativeEvents);
        for (const stored of nativeEvents) {
          assert.notNestedProperty(stored, "event.nativeBindingSource");
          assert.nestedPropertyVal(stored, "event.payload.nativeThreadRef.nativeId", sessionFile);
        }
        const runtime = Option.getOrThrow(yield* sessions.get(providerSessionId));
        if (scenario.resume) {
          const resumed = yield* runtime.resumeThread({ threadId, providerThread: native });
          assert.equal(resumed.id, providerThreadId);
          assert.equal(resumed.nativeThreadRef?.nativeId, sessionFile);
          assert.isTrue(
            pi.requests.some(
              (request) =>
                request["type"] === "switch_session" && request["sessionPath"] === sessionFile,
            ),
          );
        }
        assert.lengthOf(
          pi.requests.filter((request) => request["type"] === "prompt"),
          1,
        );
        assert.equal(yield* fs.readFileString(sessionFile), contents);
        assert.isTrue(yield* sessions.isLive(providerSessionId), "live before cleanup");
        assert.isFalse(yield* pi.childExited);
        assert.isFalse(yield* Deferred.isDone(closeCompleted));
        const persistedBindings = yield* bindings.listForThreads([threadId]);
        assert.lengthOf(persistedBindings, 1);
        for (const binding of persistedBindings) {
          assert.equal(binding.nativeId, sessionFile);
          assert.equal(binding.providerThreadId, providerThreadId);
          assert.equal(binding.providerInstanceId, piInstanceId);
          assert.deepEqual(binding.storage, native.nativeStorage);
        }
        if (scenario.detach) {
          const commandId = CommandId.make(`${threadId}:client-detach`);
          yield* orchestrator.dispatch({
            type: "provider-session.detach",
            commandId,
            threadId,
            providerSessionId,
            reason: "client-requested",
          });
          assert.isAbove(yield* worker.drain(), 0);
          const effects = yield* outbox.listByCommandId(commandId);
          assert.lengthOf(effects, 1);
          assert.equal(effects[0]!.status, "succeeded", effects[0]!.lastError ?? undefined);
          assert.nestedPropertyVal(effects[0]!, "request.detail", "client-requested");
          yield* Deferred.await(closeCompleted);
          assert.isTrue(yield* pi.childExited);
          assert.isFalse(yield* sessions.isLive(providerSessionId));
          assert.isTrue(yield* fs.exists(sessionFile));
        }
        assert.isTrue(
          (yield* store.getProviderAttachmentSources(threadId)).some(
            (attachment) =>
              attachment.providerSessionId === providerSessionId &&
              attachment.lifecycleRevision === source.lifecycleRevision &&
              attachment.sourceToken === source.sourceToken,
          ),
        );
        const commandId = CommandId.make(`${threadId}:delete`);
        yield* orchestrator.dispatch({ type: "thread.delete", commandId, threadId });
        const deletion = Option.getOrThrow(yield* records.get(threadId));
        assert.deepEqual(deletion.sessions, persistedBindings);
        assert.equal(deletion.commandId, commandId);
        assert.equal(deletion.scope, "t3_only");
        assert.isNotNull((yield* store.getThread(threadId)).deletedAt);
        assert.equal(
          yield* bindings.checkImport({
            driver: piDriver,
            providerInstanceId: piInstanceId,
            nativeId: sessionFile,
            storage: native.nativeStorage!,
          }),
          "deleted",
        );
        const effects = yield* outbox.listByCommandId(commandId);
        const retirement = effects.find(
          (effect) => effect.request.type === "provider-session.detach",
        );
        assert.isDefined(retirement);
        assert.nestedPropertyVal(
          retirement!,
          "request.retirementRevision",
          source.lifecycleRevision,
        );
        assert.nestedPropertyVal(retirement!, "request.retirementSourceToken", source.sourceToken);
        const nativeDelete = effects.find(
          (effect) =>
            effect.request.type === "provider-thread.delete" &&
            effect.request.nativeId === sessionFile,
        );
        assert.isDefined(nativeDelete);
        assert.deepEqual(
          nativeDelete!.request.type === "provider-thread.delete"
            ? nativeDelete!.request.nativeStorage
            : null,
          native.nativeStorage,
        );
        if ("concurrentClose" in scenario) {
          const readReached = yield* Deferred.make<void>();
          const readRelease = yield* Deferred.make<void>();
          const originalRead = store.getThreadRecords;
          let armed = true;
          const pausedRead: typeof originalRead = (targetId, fields, filter) =>
            Effect.gen(function* () {
              if (
                armed &&
                targetId === threadId &&
                fields.some((field) => field === "providerTurns") &&
                fields.some((field) => field === "runs")
              ) {
                armed = false;
                yield* Deferred.succeed(readReached, undefined);
                yield* Deferred.await(readRelease);
              }
              return yield* originalRead(targetId, fields, filter);
            });
          const blocked = yield* Effect.gen(function* () {
            yield* Ref.set(pauseClose, true);
            Object.defineProperty(store, "getThreadRecords", { value: pausedRead });
            const draining = yield* worker.drain().pipe(Effect.forkScoped);
            yield* Deferred.await(readReached);
            const ordinaryClose = yield* sessions
              .detach({ threadId, providerSessionId, detail: "client-requested" })
              .pipe(Effect.forkScoped);
            yield* Deferred.await(closeEntered);
            assert.isFalse(yield* sessions.isLive(providerSessionId));
            yield* Deferred.succeed(readRelease, undefined);
            assert.isAbove(yield* Fiber.join(draining), 0);
            const retirementEffect = Option.getOrThrow(yield* outbox.get(retirement!.id));
            const deleteEffect = Option.getOrThrow(yield* outbox.get(nativeDelete!.id));
            return {
              ordinaryClose,
              retirementEffect,
              deleteEffect,
              state: {
                fileExists: yield* fs.exists(sessionFile),
                childExited: yield* pi.childExited,
                closeCompleted: yield* Deferred.isDone(closeCompleted),
                retirement: retirementEffect.status,
                nativeDelete: deleteEffect.status,
                attempts: [retirementEffect.attemptCount, deleteEffect.attemptCount],
                succeededReceipt: (yield* outbox.attachmentRetirements(threadId)).some(
                  (receipt) =>
                    receipt.effectId === retirement!.id && receipt.status === "succeeded",
                ),
                deleteCalls: pi.deleteCalls.length,
              },
            };
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                Object.defineProperty(store, "getThreadRecords", { value: originalRead });
                yield* Deferred.succeed(readRelease, undefined);
                yield* Ref.set(pauseClose, false);
                yield* Deferred.succeed(closeRelease, undefined);
              }),
            ),
          );
          yield* Fiber.join(blocked.ordinaryClose);
          yield* Deferred.await(closeCompleted);
          assert.isTrue(yield* pi.childExited);
          assert.deepEqual(blocked.state, {
            fileExists: true,
            childExited: false,
            closeCompleted: false,
            retirement: "pending",
            nativeDelete: "pending",
            attempts: [1, 0],
            succeededReceipt: false,
            deleteCalls: 0,
          });
          yield* TestClock.setTime(
            Math.max(
              DateTime.toEpochMillis(DateTime.makeUnsafe(blocked.retirementEffect.availableAt)),
              DateTime.toEpochMillis(DateTime.makeUnsafe(blocked.deleteEffect.availableAt)),
            ),
          );
        }
        assert.isAbove(yield* worker.drain(), 0);
        const completedRetirement = Option.getOrThrow(yield* outbox.get(retirement!.id));
        const completedDelete = Option.getOrThrow(yield* outbox.get(nativeDelete!.id));
        if (completedRetirement.status !== "succeeded" || completedDelete.status !== "succeeded") {
          assert.isTrue(yield* fs.exists(sessionFile));
          assert.isEmpty(pi.deleteCalls);
        }
        assert.equal(
          completedRetirement.status,
          "succeeded",
          completedRetirement.lastError ?? undefined,
        );
        assert.equal(completedDelete.status, "succeeded", completedDelete.lastError ?? undefined);
        assert.equal(completedRetirement.attemptCount, "concurrentClose" in scenario ? 2 : 1);
        assert.equal(completedDelete.attemptCount, 1);
        yield* Deferred.await(closeCompleted);
        assert.isTrue(yield* pi.childExited);
        assert.isFalse(yield* fs.exists(sessionFile));
        assert.equal(yield* fs.readFileString(siblingFile), "unrelated session");
        assert.lengthOf(pi.deleteCalls, 1);
        assert.deepEqual(pi.deleteCalls[0]!.providerThread.nativeStorage, native.nativeStorage);
        assert.isTrue(
          (yield* outbox.attachmentRetirements(threadId)).some(
            (receipt) =>
              receipt.status === "succeeded" &&
              receipt.effectId === retirement!.id &&
              receipt.providerSessionId === providerSessionId &&
              receipt.retirementRevision === source.lifecycleRevision &&
              receipt.retirementSourceToken === source.sourceToken &&
              receipt.lifecycleCommandId === commandId &&
              receipt.lifecycleRootThreadId === threadId,
          ),
        );
        assert.equal(
          yield* bindings.checkImport({
            driver: piDriver,
            providerInstanceId: piInstanceId,
            nativeId: sessionFile,
            storage: native.nativeStorage!,
          }),
          "deleted",
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(makeRuntime(SqlitePersistence.layerMemory, makeProvider([pi.instance]))),
        ),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "fix06-pi-lifecycle-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  ),
);

it.effect(
  "re-retires a child Pi session after parent archive before delete drains and recovers its outbox effect",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(now));
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-lifecycle-" });
        const sessionFile = path.join(root, "session.jsonl");
        const siblingFile = path.join(root, "sibling.jsonl");
        yield* fs.writeFileString(sessionFile, "isolated Pi transcript");
        yield* fs.writeFileString(siblingFile, "keep this session");
        const parentThreadId = ThreadId.make("task8:pi-parent");
        const threadId = ThreadId.make("task8:pi-thread");
        const piInstanceId = ProviderInstanceId.make("task8-pi");
        const piDriver = ProviderDriverKind.make("pi");
        const piModelSelection = { instanceId: piInstanceId, model: "default" };
        const providerSessionId = ProviderSessionId.make("task8:pi-session");
        const detachEntered = yield* Deferred.make<void>();
        const detachRelease = yield* Deferred.make<void>();
        const closeCompleted = yield* Deferred.make<void>();
        const pauseDetach = yield* Ref.make(false);
        const baseProvider = makeProvider();
        const pi = yield* makeRealPiProviderInstance({
          base: baseProvider.instance,
          sessionFile,
          pauseClose: pauseDetach,
          closeEntered: detachEntered,
          closeRelease: detachRelease,
          closeCompleted,
        });
        const provider = makeProvider([pi.instance]);
        const runtime = makeRuntime(SqlitePersistence.layerMemory, provider);

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
          const bindings = yield* NativeSessionBindings.NativeSessionBindings;
          const sql = yield* SqlClient.SqlClient;
          const projects = yield* ProjectStore.ProjectStoreV2;
          const exhaustRetries = (label: string) =>
            Effect.gen(function* () {
              for (const attempt of [2, 3, 4, 5]) {
                yield* TestClock.adjust(Duration.seconds(30));
                assert.isAbove(yield* worker.drain(), 0, `${label} attempt ${attempt}`);
              }
            });
          yield* projects.apply({
            sequence: 0,
            eventId: EventId.make("task8:pi-project"),
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
              title: "Pi lifecycle fixture",
              workspaceRoot: config.cwd,
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          });
          yield* create(parentThreadId, piModelSelection);
          yield* create(threadId, piModelSelection);
          yield* sink.write({
            events: [
              {
                id: EventId.make("task8:pi-thread-lineage"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...(yield* store.getThread(threadId)),
                  lineage: {
                    parentThreadId,
                    relationshipToParent: "subagent",
                    rootThreadId: parentThreadId,
                  },
                },
              },
            ],
          });
          const plannedProviderThread: OrchestrationV2ProviderThread = {
            id: ProviderThreadId.make("task8:pi-native-thread"),
            driver: piDriver,
            providerInstanceId: piInstanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver: piDriver, nativeId: sessionFile, strength: "strong" },
            nativeStorage: yield* NativeSessionStorageResolver.make.pipe(
              Effect.flatMap((storage) =>
                storage.resolve({ driver: piDriver, nativeId: sessionFile, sessionFile }),
              ),
            ),
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          };
          yield* sink.write({
            lifecycleGuard: yield* orchestrator.resolveLifecycleSource(threadId),
            events: [
              {
                id: EventId.make("task8:pi-start-gate"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: plannedProviderThread,
              },
            ],
          });
          const firstRuntime = yield* sessions.open({
            threadId,
            providerThreadId: plannedProviderThread.id,
            providerSessionId,
            modelSelection: piModelSelection,
            runtimePolicy,
          });
          const nativeThread = yield* firstRuntime.ensureThread({
            threadId,
            existingProviderThread: plannedProviderThread,
            modelSelection: piModelSelection,
            runtimePolicy,
          });
          assert.isUndefined(firstRuntime.unloadThread);
          yield* sink.write({
            lifecycleGuard: yield* orchestrator.resolveLifecycleSource(threadId),
            events: [
              {
                id: EventId.make("task8:pi-native-thread"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: nativeThread,
              },
            ],
          });
          yield* firstRuntime.resumeThread({ threadId, providerThread: nativeThread });
          assert.equal(nativeThread.nativeThreadRef?.nativeId, sessionFile);

          yield* Ref.set(pauseDetach, true);
          const archiveCommandId = CommandId.make("task8:pi-archive");
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: archiveCommandId,
            threadId: parentThreadId,
          });
          const archiveEffects = yield* outbox.listByCommandId(archiveCommandId);
          const archiveDetach = archiveEffects.find(
            (effect) =>
              effect.threadId === threadId && effect.request.type === "provider-session.detach",
          );
          assert.isDefined(archiveDetach);
          assert.nestedPropertyVal(
            archiveDetach!.request,
            "lifecycle.rootThreadId",
            parentThreadId,
          );
          assert.isEmpty(
            archiveEffects.filter((effect) => effect.request.type === "provider-thread.delete"),
          );
          assert.isTrue(yield* fs.exists(sessionFile));
          const archiveDraining = yield* worker.drain().pipe(Effect.forkScoped);
          yield* Deferred.await(detachEntered);
          yield* TestClock.adjust("30 seconds");
          assert.isAbove(yield* Fiber.join(archiveDraining), 0);
          yield* exhaustRetries("archive detach");
          const completedArchiveDetach = Option.getOrThrow(yield* outbox.get(archiveDetach!.id));
          assert.equal(
            completedArchiveDetach.status,
            "failed",
            completedArchiveDetach.lastError ?? undefined,
          );
          assert.isFalse(yield* sessions.isLive(providerSessionId));
          assert.isTrue(yield* fs.exists(sessionFile));
          assert.isEmpty(pi.deleteCalls);
          assert.isFalse(yield* Deferred.isDone(closeCompleted));

          // Direct lifecycle commands reject subagent targets. Promotion makes the later
          // child-root operations legal while preserving the parent-root retirement receipt.
          yield* sink.write({
            events: [
              {
                id: EventId.make("task8:pi-thread-promoted"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: now,
                payload: {
                  ...(yield* store.getThread(threadId)),
                  lineage: {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: threadId,
                  },
                },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("task8:pi-unarchive"),
            threadId,
          });
          assert.isFalse(yield* sessions.isLive(providerSessionId));
          assert.isTrue(yield* fs.exists(sessionFile));

          const deleteCommandId = CommandId.make("task8:pi-delete-before-close");
          const deletedCommand = yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: deleteCommandId,
            threadId,
          });
          assert.isTrue(
            deletedCommand.storedEvents.some(
              (row) => row.event.type === "thread.deleted" && row.event.threadId === threadId,
            ),
          );
          const effects = yield* outbox.listByCommandId(deleteCommandId);
          const replacementDetach = effects.find(
            (effect) =>
              effect.request.type === "provider-session.detach" &&
              effect.request.providerSessionId === providerSessionId,
          );
          assert.isDefined(replacementDetach);
          assert.nestedPropertyVal(replacementDetach!.request, "lifecycle.rootThreadId", threadId);
          const detachIndex = effects.findIndex(
            (effect) => effect.request.type === "provider-session.detach",
          );
          const deleteIndex = effects.findIndex(
            (effect) => effect.request.type === "provider-thread.delete",
          );
          assert.isAtLeast(detachIndex, 0);
          assert.isAtLeast(deleteIndex, 0);
          assert.isBelow(detachIndex, deleteIndex);
          const deleteEffect = effects[deleteIndex]!;
          if (deleteEffect.request.type !== "provider-thread.delete")
            return yield* Effect.die("The Pi deletion effect was not queued.");
          assert.equal(deleteEffect.request.type, "provider-thread.delete");
          const deletedLifecycleSource = yield* orchestrator.resolveLifecycleSource(threadId);
          assert.equal(
            deleteEffect.request.lifecycle.revision,
            deletedLifecycleSource.lifecycleRevision,
          );
          assert.equal(
            deleteEffect.request.lifecycle.sourceToken,
            deletedLifecycleSource.sourceToken,
          );

          assert.isAbove(yield* worker.drain(), 0);
          yield* exhaustRetries("delete before close");
          const failedReplacement = Option.getOrThrow(yield* outbox.get(replacementDetach!.id));
          assert.equal(
            failedReplacement.status,
            "failed",
            failedReplacement.lastError ?? undefined,
          );
          const failedDelete = Option.getOrThrow(yield* outbox.get(deleteEffect.id));
          assert.equal(failedDelete.status, "pending", failedDelete.lastError ?? undefined);
          assert.isTrue(yield* fs.exists(sessionFile));
          assert.isEmpty(pi.deleteCalls);
          assert.isFalse(yield* Deferred.isDone(closeCompleted));

          yield* Deferred.succeed(detachRelease, undefined);
          yield* Deferred.await(closeCompleted);

          const retryDeleteCommandId = CommandId.make("task8:pi-delete-after-close");
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: retryDeleteCommandId,
            threadId,
          });
          const retryEffects = yield* outbox.listByCommandId(retryDeleteCommandId);
          const completedReplacement = retryEffects.find(
            (effect) =>
              effect.request.type === "provider-session.detach" &&
              effect.request.providerSessionId === providerSessionId,
          );
          const retryDeleteEffect = retryEffects.find(
            (effect) => effect.request.type === "provider-thread.delete",
          );
          assert.isDefined(completedReplacement);
          assert.isDefined(retryDeleteEffect);
          assert.notEqual(completedReplacement!.id, replacementDetach!.id);
          assert.notEqual(retryDeleteEffect!.id, deleteEffect.id);
          assert.isAbove(yield* worker.drain(), 0);

          const completedRetirement = Option.getOrThrow(
            yield* outbox.get(completedReplacement!.id),
          );
          assert.equal(
            completedRetirement.status,
            "succeeded",
            completedRetirement.lastError ?? undefined,
          );
          const completedDelete = Option.getOrThrow(yield* outbox.get(retryDeleteEffect!.id));
          assert.equal(completedDelete.status, "succeeded", JSON.stringify(completedDelete));
          assert.equal(Option.getOrThrow(yield* outbox.get(archiveDetach!.id)).status, "failed");
          assert.equal(
            Option.getOrThrow(yield* outbox.get(replacementDetach!.id)).status,
            "failed",
          );
          assert.isFalse(yield* sessions.isLive(providerSessionId));
          assert.isFalse(yield* fs.exists(sessionFile));
          assert.lengthOf(pi.deleteCalls, 1);
          assert.equal(yield* fs.readFileString(siblingFile), "keep this session");
          const deletion = Option.getOrThrow(yield* records.get(threadId));
          assert.equal(deletion.scope, "t3_only");
          assert.lengthOf(deletion.sessions, 1);
          assert.equal(deletion.sessions[0]?.driver, piDriver);
          assert.equal(deletion.sessions[0]?.storage.type, "resolved");
          assert.deepEqual(
            yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_thread_deletion_sessions
              WHERE thread_id = ${threadId}
            `,
            [{ count: 1 }],
          );
          assert.equal(
            yield* bindings.checkImport({
              driver: piDriver,
              providerInstanceId: piInstanceId,
              nativeId: nativeThread.nativeThreadRef!.nativeId,
              storage: nativeThread.nativeStorage!,
            }),
            "deleted",
          );
          assert.isNotNull((yield* store.getThread(threadId)).deletedAt);

          yield* outbox.enqueue([
            {
              id: "task8:pi-delete-recovered",
              commandId: retryDeleteCommandId,
              threadId,
              request: retryDeleteEffect!.request,
            },
          ]);
          const crashedClaim = yield* outbox.claimNext({
            workerId: "task8:pi-worker-lost",
          });
          assert.isTrue(Option.isSome(crashedClaim));
          if (Option.isSome(crashedClaim))
            assert.equal(crashedClaim.value.request.type, "provider-thread.delete");
          assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, {
            requeued: 1,
            cancelled: 0,
          });

          const restartedCount = yield* worker.drain();
          assert.equal(restartedCount, 1);
          assert.isFalse(yield* fs.exists(sessionFile));
          assert.equal(yield* fs.readFileString(siblingFile), "keep this session");
          assert.isTrue(Option.isSome(yield* records.get(threadId)));
        }).pipe(
          Effect.ensuring(Deferred.succeed(detachRelease, undefined)),
          Effect.provide(Layer.fresh(runtime)),
        );
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "task8-pi-lifecycle-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
);

it.effect(
  "keeps a shared Pi file after failed cleanup and retries through a new T3 delete command",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.toEpochMillis(now));
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-shared-delete-" });
        const sessionFile = path.join(root, "shared-session.jsonl");
        const sessionContents = "shared Pi transcript remains byte-for-byte intact";
        yield* fs.writeFileString(sessionFile, sessionContents);
        const nativeStorage: NativeSessionStorage = {
          type: "resolved",
          canonicalRoot: yield* fs.realPath(root),
          canonicalFile: yield* fs.realPath(sessionFile),
        };
        const threadId = ThreadId.make("task8:pi-shared-delete-thread");
        const outsideOwnerId = ThreadId.make("task8:pi-shared-delete-owner");
        const piInstanceId = ProviderInstanceId.make("task8-pi");
        const piDriver = ProviderDriverKind.make("pi");
        const piModelSelection = { instanceId: piInstanceId, model: "pi-fixture" };
        const providerSessionId = ProviderSessionId.make("task8:pi-shared-session");
        const outsideSessionId = ProviderSessionId.make("task8:pi-shared-owner-session");
        const detachEntered = yield* Deferred.make<void>();
        const detachRelease = yield* Deferred.make<void>();
        const pauseDetach = yield* Ref.make(false);
        const resumed: Array<ThreadId> = [];
        const deleted: Array<ProviderThreadId> = [];
        const unloaded: Array<ProviderThreadId> = [];
        const baseProvider = makeProvider();
        const pi = makePiProviderInstance({
          base: baseProvider.instance,
          nativeStorage,
          removeNativeFile: (filePath) =>
            fs.remove(filePath, { force: true }).pipe(Effect.asVoid, Effect.orDie),
          pauseDetach,
          detachEntered,
          detachRelease,
          resumed,
          deleted,
          unloaded,
        });
        const provider = makeProvider([pi.instance]);
        const runtime = makeRuntime(SqlitePersistence.layerMemory, provider);

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const resources = yield* ThreadLifecycleResources.ThreadLifecycleResources;
          const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
          const bindings = yield* NativeSessionBindings.NativeSessionBindings;
          const sql = yield* SqlClient.SqlClient;
          const projects = yield* ProjectStore.ProjectStoreV2;
          yield* projects.apply({
            sequence: 0,
            eventId: EventId.make("task8:pi-shared-project"),
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
              title: "Shared Pi deletion fixture",
              workspaceRoot: config.cwd,
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          });
          yield* create(threadId, piModelSelection);
          yield* create(outsideOwnerId, piModelSelection);
          const providerThread = pi.makeNativeThread(threadId, providerSessionId);
          const outsideProviderThread: OrchestrationV2ProviderThread = {
            ...pi.makeNativeThread(outsideOwnerId, outsideSessionId),
            id: ProviderThreadId.make("task8:pi-shared-owner-native-thread"),
          };
          yield* sink.write({
            lifecycleGuard: yield* orchestrator.resolveLifecycleSource(threadId),
            events: [
              {
                id: EventId.make("task8:pi-shared-native-thread"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: providerThread,
              },
            ],
          });
          const runtimeSession = yield* sessions.open({
            threadId,
            providerThreadId: providerThread.id,
            providerSessionId,
            modelSelection: piModelSelection,
            runtimePolicy,
          });
          yield* runtimeSession.resumeThread({ threadId, providerThread });
          yield* sink.write({
            lifecycleGuard: yield* orchestrator.resolveLifecycleSource(outsideOwnerId),
            events: [
              {
                id: EventId.make("task8:pi-shared-owner-native-thread"),
                type: "provider-thread.updated",
                threadId: outsideOwnerId,
                occurredAt: now,
                payload: outsideProviderThread,
              },
            ],
          });
          assert.isTrue(yield* fs.exists(sessionFile));
          assert.deepEqual(yield* fs.readFileString(sessionFile), sessionContents);
          assert.deepEqual(
            yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_native_session_bindings
              WHERE thread_id = ${outsideOwnerId} AND canonical_file = ${nativeStorage.canonicalFile}
            `,
            [{ count: 1 }],
          );
          assert.deepEqual(
            yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_threads
              WHERE thread_id = ${outsideOwnerId}
                AND json_extract(payload_json, '$.nativeStorage.canonicalFile') = ${nativeStorage.canonicalFile}
            `,
            [{ count: 1 }],
          );

          const firstDeleteCommandId = CommandId.make("task8:pi-shared-delete-first");
          const firstDeleteCommand = yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: firstDeleteCommandId,
            threadId,
          });
          assert.isTrue(
            firstDeleteCommand.storedEvents.some(
              (row) => row.event.type === "thread.deleted" && row.event.threadId === threadId,
            ),
          );
          const firstEffects = yield* outbox.listByCommandId(firstDeleteCommandId);
          const firstDeleteEffect = firstEffects.find(
            (effect) => effect.request.type === "provider-thread.delete",
          );
          assert.isDefined(firstDeleteEffect);
          assert.isAbove(yield* worker.drain(), 0);
          for (const attempt of [2, 3, 4, 5]) {
            yield* TestClock.adjust(Duration.seconds(30));
            assert.isAbove(yield* worker.drain(), 0, `delete attempt ${attempt}`);
          }
          const failedDelete = Option.getOrThrow(yield* outbox.get(firstDeleteEffect!.id));
          assert.equal(failedDelete.status, "failed", failedDelete.lastError ?? undefined);
          assert.equal(failedDelete.attemptCount, 5);
          assert.include(failedDelete.lastError ?? "", "reference");
          assert.deepEqual(yield* resources.getCleanupStatus(firstDeleteCommandId), {
            pendingCount: 0,
            failedCount: 1,
          });
          assert.isFalse(yield* sessions.isLive(providerSessionId));
          assert.isEmpty(deleted);
          assert.isTrue(yield* fs.exists(sessionFile));
          assert.deepEqual(yield* fs.readFileString(sessionFile), sessionContents);
          assert.isNotNull((yield* store.getThread(threadId)).deletedAt);
          assert.isTrue(Option.isSome(yield* records.get(threadId)));
          assert.equal(
            yield* bindings.checkImport({
              driver: piDriver,
              providerInstanceId: piInstanceId,
              nativeId: "task8:pi-native-session",
              storage: nativeStorage,
            }),
            "deleted",
          );
          assert.deepEqual(
            yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_thread_deletion_sessions
              WHERE thread_id = ${threadId}
            `,
            [{ count: 1 }],
          );

          // The shared reference is a temporary test dependency; clear only its active fixture rows.
          yield* sql`DELETE FROM orchestration_v2_native_session_bindings
            WHERE thread_id = ${outsideOwnerId}`;
          yield* sql`DELETE FROM orchestration_v2_projection_provider_threads
            WHERE thread_id = ${outsideOwnerId}`;

          const sourcesBeforeReclaim = yield* store.getProviderAttachmentSources(threadId);
          const receiptsBeforeReclaim = yield* outbox.attachmentRetirements(threadId);
          const bindingsBeforeReclaim = yield* bindings.listForThreads([threadId]);
          assert.isNotEmpty(sourcesBeforeReclaim);
          assert.isNotEmpty(receiptsBeforeReclaim);
          const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
          const reclamation = yield* maintenance.reclaimDeletedThreadData;
          assert.equal(reclamation.reclaimedThreadCount, 0);
          assert.deepEqual(reclamation.skippedThreads, [
            { threadId, blockerCodes: ["lifecycle_cleanup"] },
          ]);
          assert.deepEqual(
            yield* store.getProviderAttachmentSources(threadId),
            sourcesBeforeReclaim,
          );
          assert.deepEqual(yield* outbox.attachmentRetirements(threadId), receiptsBeforeReclaim);
          assert.deepEqual(yield* bindings.listForThreads([threadId]), bindingsBeforeReclaim);

          const retryCommandId = CommandId.make("task8:pi-shared-delete-retry");
          const retryCommand = yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: retryCommandId,
            threadId,
          });
          assert.isTrue(
            retryCommand.storedEvents.some(
              (row) => row.event.type === "thread.deleted" && row.event.threadId === threadId,
            ),
          );
          const retryEffects = yield* outbox.listByCommandId(retryCommandId);
          const retryDeleteEffect = retryEffects.find(
            (effect) => effect.request.type === "provider-thread.delete",
          );
          assert.isDefined(retryDeleteEffect);
          assert.notEqual(retryDeleteEffect!.id, firstDeleteEffect!.id);
          assert.isAbove(yield* worker.drain(), 0);
          const completedRetry = Option.getOrThrow(yield* outbox.get(retryDeleteEffect!.id));
          assert.equal(completedRetry.status, "succeeded", completedRetry.lastError ?? undefined);
          assert.deepEqual(deleted, [providerThread.id]);
          assert.isFalse(yield* fs.exists(sessionFile));
          assert.deepEqual(yield* resources.getCleanupStatus(retryCommandId), {
            pendingCount: 0,
            failedCount: 0,
          });
          assert.isNotNull((yield* store.getThread(threadId)).deletedAt);
          assert.isTrue(Option.isSome(yield* records.get(threadId)));
          assert.equal(
            yield* bindings.checkImport({
              driver: piDriver,
              providerInstanceId: piInstanceId,
              nativeId: "task8:pi-native-session",
              storage: nativeStorage,
            }),
            "deleted",
          );
          assert.deepEqual(
            yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM orchestration_v2_thread_deletion_sessions
              WHERE thread_id = ${threadId}
            `,
            [{ count: 1 }],
          );

          const absentDeleteCommandId = CommandId.make("task8:pi-shared-delete-absent");
          yield* orchestrator.dispatch({
            type: "thread.delete",
            commandId: absentDeleteCommandId,
            threadId,
          });
          const absentEffects = yield* outbox.listByCommandId(absentDeleteCommandId);
          const absentDeleteEffect = absentEffects.find(
            (effect) => effect.request.type === "provider-thread.delete",
          );
          assert.isDefined(absentDeleteEffect);
          assert.notEqual(absentDeleteEffect!.id, retryDeleteEffect!.id);
          assert.isAbove(yield* worker.drain(), 0);
          const completedAbsentDelete = Option.getOrThrow(
            yield* outbox.get(absentDeleteEffect!.id),
          );
          assert.equal(
            completedAbsentDelete.status,
            "succeeded",
            completedAbsentDelete.lastError ?? undefined,
          );
          assert.deepEqual(deleted, [providerThread.id, providerThread.id]);
          assert.isFalse(yield* fs.exists(sessionFile));
          assert.deepEqual(yield* resources.getCleanupStatus(absentDeleteCommandId), {
            pendingCount: 0,
            failedCount: 0,
          });
          assert.isNotNull((yield* store.getThread(threadId)).deletedAt);
          assert.isTrue(Option.isSome(yield* records.get(threadId)));
        }).pipe(Effect.provide(Layer.fresh(runtime)));
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "task8-pi-shared-delete-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    ),
);

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
