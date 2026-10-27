import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type TerminalEvent,
} from "@t3tools/contracts";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Resources from "./ThreadLifecycleResources.ts";

const R = ThreadId.make("task6:R");
const F = ThreadId.make("task6:F");
const commandId = CommandId.make("task6:archive");
const now = DateTime.makeUnsafe("2026-10-26T00:00:00Z");
const provider = ProviderInstanceId.make("codex");
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(Resources.layer, ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provide(database),
);

const seed = Effect.fn("test.seedResourceThread")(function* (
  id: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const thread: OrchestrationV2AppThread = {
    id,
    projectId: ProjectId.make("task6:project"),
    title: id,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: provider,
    modelSelection: { instanceId: provider, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`seed:${id}`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: thread,
  });
  return thread;
});

const enqueue = Effect.fn("test.enqueueLifecycleCleanup")(function* () {
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  yield* outbox.enqueue([
    {
      id: "task6:terminal-cleanup",
      commandId,
      threadId: R,
      request: { type: "terminal.cleanup", lifecycle: { commandId, rootThreadId: R, revision: 1 } },
    },
  ]);
});

const attach = Effect.fn("test.seedResourceAttachment")(function* (
  threadId: ThreadId,
  id = "task6-exclusive",
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`message:${threadId}:${id}`),
    type: "message.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: MessageId.make(`message:${threadId}:${id}`),
      threadId,
      runId: null,
      nodeId: null,
      streaming: false,
      role: "user",
      text: "attachment",
      attachments: [
        {
          type: "file",
          id,
          name: "fixture.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 1,
        },
      ],
      createdAt: now,
      updatedAt: now,
      createdBy: "user",
      creationSource: "web",
    },
  });
});

it.effect(
  "lifecycle cleanup blocks restored creation until the durable worker drain succeeds",
  () =>
    Effect.gen(function* () {
      yield* seed(R, { lifecycleRevision: 2 });
      yield* enqueue();
      const resources = yield* Resources.ThreadLifecycleResources;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const workerLayer = EffectWorker.layerWithOptions({ workerId: "task6:worker" }).pipe(
        Layer.provide(
          Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
            execute: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          }),
        ),
      );
      assert.deepEqual(yield* resources.getCleanupStatus(commandId), {
        pendingCount: 1,
        failedCount: 0,
      });
      assert.equal((yield* resources.assertCanCreate(R).pipe(Effect.result))._tag, "Failure");
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const running = yield* worker.drain().pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.equal((yield* resources.assertCanCreate(R).pipe(Effect.result))._tag, "Failure");
        yield* Deferred.succeed(release, undefined);
        assert.equal(yield* Fiber.join(running), 1);
        yield* resources.withCreateCommit(R, Effect.void);
        assert.deepEqual(yield* resources.getCleanupStatus(commandId), {
          pendingCount: 0,
          failedCount: 0,
        });
      }).pipe(Effect.provide(workerLayer));
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["failed", "cancelled"] as const)(
  "lifecycle %s cleanup remains observable and blocks restoration",
  (status) =>
    Effect.gen(function* () {
      yield* seed(R, { lifecycleRevision: 2 });
      yield* enqueue();
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      if (status === "cancelled")
        yield* outbox.cancelUnsettled({
          threadId: R,
          effectTypes: ["terminal.cleanup"],
          reason: "fixture cancellation",
        });
      else {
        yield* outbox.claimNext({ workerId: "task6:failed", leaseDurationMs: 1000 });
        yield* outbox.fail({
          effectId: "task6:terminal-cleanup",
          workerId: "task6:failed",
          error: "Cleanup failed.",
        });
      }
      const resources = yield* Resources.ThreadLifecycleResources;
      const result = yield* resources.assertCanCreate(R).pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure.effectId, "task6:terminal-cleanup");
      assert.deepEqual(yield* resources.getCleanupStatus(commandId), {
        pendingCount: 0,
        failedCount: 1,
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle creation checks archived owners without treating independent forks as owned children",
  () =>
    Effect.gen(function* () {
      yield* seed(R, { archivedAt: now });
      yield* seed(F, {
        lineage: { parentThreadId: R, relationshipToParent: "fork", rootThreadId: R },
      });
      const child = ThreadId.make("task6:child");
      yield* seed(child, {
        lineage: { parentThreadId: R, relationshipToParent: "subagent", rootThreadId: R },
      });
      const resources = yield* Resources.ThreadLifecycleResources;
      assert.equal((yield* resources.assertCanCreate(child).pipe(Effect.result))._tag, "Failure");
      yield* resources.assertCanCreate(F);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["exclusive", "message", "fork", "unknown"] as const)(
  "lifecycle attachment cleanup preserves %s references conservatively",
  (reference) =>
    Effect.gen(function* () {
      yield* seed(R);
      if (reference !== "exclusive")
        yield* seed(
          F,
          reference === "fork" || reference === "unknown"
            ? {
                lineage: {
                  parentThreadId: reference === "unknown" ? ThreadId.make("task6:missing") : R,
                  relationshipToParent: "fork",
                  rootThreadId: R,
                },
              }
            : {},
        );
      for (const id of reference === "message" ? [R, F] : [R]) yield* attach(id);
      const resources = yield* Resources.ThreadLifecycleResources;
      assert.deepEqual(
        yield* resources.safeAttachmentIds([R]),
        reference === "exclusive" ? ["task6-exclusive"] : [],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle cleanup retains pending transfer attachments even before a target shell exists",
  () =>
    Effect.gen(function* () {
      yield* seed(R, { deletedAt: now });
      yield* attach(R);
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* store.apply({
        id: EventId.make("task6:pending-transfer"),
        type: "context-transfer.created",
        threadId: R,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make("task6:pending"),
          type: "fork",
          sourceThreadId: R,
          targetThreadId: F,
          sourcePoint: { runId: RunId.make("task6:source-run"), threadId: R },
          basePoint: null,
          sourceProviderInstanceId: provider,
          targetProviderInstanceId: null,
          targetRunId: null,
          status: "pending",
          resolution: null,
          createdBy: "user",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: null,
        },
      });
      assert.deepEqual(
        yield* (yield* Resources.ThreadLifecycleResources).safeAttachmentIds([R]),
        [],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["message", "dynamic-tool"] as const)(
  "lifecycle retains %s references in a deleted history source still read by a surviving fork",
  (reference) =>
    Effect.gen(function* () {
      yield* seed(R, { deletedAt: now });
      yield* attach(R);
      yield* seed(F, { deletedAt: now });
      yield* seed(ThreadId.make("task6:history-reader"), {
        lineage: { parentThreadId: F, relationshipToParent: "fork", rootThreadId: F },
      });
      if (reference === "message") yield* attach(F);
      else
        yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
          id: EventId.make("task6:shared-tool-output"),
          type: "turn-item.updated",
          threadId: F,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("task6:shared-tool-output"),
            threadId: F,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "dynamic_tool",
            toolName: "fixture",
            input: {},
            output: { attachmentId: "task6-exclusive" },
          },
        });
      assert.deepEqual(
        yield* (yield* Resources.ThreadLifecycleResources).safeAttachmentIds([R]),
        [],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["exclusive", "fork", "transfer"] as const)(
  "lifecycle actual attachment cleanup deletes only %s files with no surviving reader",
  (reference) =>
    Effect.gen(function* () {
      yield* seed(R, { deletedAt: now });
      yield* attach(R);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const file = path.join(config.attachmentsDir, "task6-exclusive.bin");
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(file, "fixture bytes");
      // The executor must recheck a dependency that appeared after the effect was planned.
      if (reference === "fork")
        yield* seed(F, {
          lineage: { parentThreadId: R, relationshipToParent: "fork", rootThreadId: R },
        });
      if (reference === "transfer") {
        yield* seed(F);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        yield* store.apply({
          id: EventId.make("task6:late-transfer"),
          type: "context-transfer.created",
          threadId: R,
          occurredAt: now,
          payload: {
            id: ContextTransferId.make("task6:late-transfer"),
            type: "merge_back",
            sourceThreadId: R,
            targetThreadId: F,
            sourcePoint: { runId: RunId.make("task6:source-run"), threadId: R },
            basePoint: null,
            sourceProviderInstanceId: provider,
            targetProviderInstanceId: null,
            targetRunId: null,
            status: "pending",
            resolution: null,
            createdBy: "user",
            error: null,
            createdAt: now,
            updatedAt: now,
            consumedAt: null,
          },
        });
      }
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      yield* cleanup.cleanupAttachments(["task6-exclusive"], R);
      assert.equal(yield* fileSystem.exists(file), reference !== "exclusive");
      yield* cleanup.cleanupAttachments(["task6-exclusive"], R);
      assert.equal(yield* fileSystem.exists(file), reference !== "exclusive");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layerTest,
          ResourceCleanupService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(TerminalManager.TerminalManager)({}),
                Layer.mock(PreviewManager.PreviewManager)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          ),
        ).pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "task-6-attachments-" }),
          ),
          Layer.provide(database),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "lifecycle preview opens only after cleanup succeeds and archived owners cannot publish a tab",
  () =>
    Effect.gen(function* () {
      yield* seed(R, { lifecycleRevision: 2 });
      yield* enqueue();
      const manager = yield* PreviewManager.PreviewManager;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      assert.equal((yield* manager.open({ threadId: R }).pipe(Effect.result))._tag, "Failure");
      assert.lengthOf((yield* manager.list({ threadId: R })).sessions, 0);
      yield* outbox.claimNext({ workerId: "task6:preview", leaseDurationMs: 1000 });
      yield* outbox.succeed({ effectId: "task6:terminal-cleanup", workerId: "task6:preview" });
      yield* manager.open({ threadId: R });
      assert.lengthOf((yield* manager.list({ threadId: R })).sessions, 1);
      yield* seed(R, { archivedAt: now, lifecycleRevision: 3 });
      assert.equal((yield* manager.open({ threadId: R }).pipe(Effect.result))._tag, "Failure");
      assert.lengthOf((yield* manager.list({ threadId: R })).sessions, 1);
    }).pipe(
      Effect.provide(
        PreviewManager.layer.pipe(Layer.provideMerge(layerTest), Layer.provide(NodeServices.layer)),
      ),
    ),
);

it.effect(
  "lifecycle terminal rechecks delayed spawn before publication and allows creation after drain",
  () =>
    Effect.gen(function* () {
      yield* seed(R);
      const resources = yield* Resources.ThreadLifecycleResources;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "task-6-terminal-" });
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const events: Array<TerminalEvent> = [];
      const killed: Array<number> = [];
      const firstKilled = yield* Deferred.make<void>();
      let spawnCount = 0;
      const manager = yield* TerminalManager.makeWithOptions({
        logsDir: baseDir,
        shellResolver: () => "fixture-shell",
        subprocessInspector: () =>
          Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
        ptyAdapter: {
          spawn: () =>
            Effect.gen(function* () {
              const pid = 900000 + ++spawnCount;
              let exit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
              const fake: PtyAdapter.PtyProcess = {
                pid,
                write: () => {},
                resize: () => {},
                kill: () => {
                  killed.push(pid);
                  exit?.({ exitCode: 0, signal: null });
                  if (pid === 900001) Deferred.doneUnsafe(firstKilled, Effect.void);
                },
                onData: () => () => {},
                onExit: (callback) => {
                  exit = callback;
                  return () => {
                    exit = undefined;
                  };
                },
              };
              if (spawnCount === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return fake;
            }),
        },
      });
      yield* manager.subscribe((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      const opening = yield* manager
        .open({ threadId: R, terminalId: "task6-terminal", cwd: baseDir })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* seed(R, { lifecycleRevision: 1, archivedAt: now });
      yield* enqueue();
      yield* seed(R, { lifecycleRevision: 2 });
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(opening))._tag, "Failure");
      assert.isFalse(events.some((event) => event.type === "started"));
      yield* Deferred.await(firstKilled);
      assert.include(killed, 900001);
      assert.equal(
        (yield* manager
          .restart({ threadId: R, terminalId: "task6-terminal", cwd: baseDir, cols: 80, rows: 24 })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.claimNext({ workerId: "task6:terminal", leaseDurationMs: 1000 });
      yield* outbox.succeed({ effectId: "task6:terminal-cleanup", workerId: "task6:terminal" });
      yield* resources.assertCanCreate(R);
      const snapshot = yield* manager.open({
        threadId: R,
        terminalId: "task6-terminal",
        cwd: baseDir,
      });
      assert.equal(snapshot.status, "running");
      assert.equal(spawnCount, 2);
      yield* manager.close({ threadId: R, deleteHistory: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerTest, ProcessRunner.layer).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

it.effect(
  "lifecycle cleanup bounded retry survives reconcile and only success releases the barrier",
  () =>
    Effect.gen(function* () {
      yield* seed(R, { lifecycleRevision: 2 });
      yield* enqueue();
      const resources = yield* Resources.ThreadLifecycleResources;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      let executions = 0;
      const workerLayer = EffectWorker.layerWithOptions({
        workerId: "task6:retry",
        maxAttempts: 2,
      }).pipe(
        Layer.provide(
          Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
            execute: () =>
              Effect.suspend(() =>
                ++executions === 1
                  ? Effect.fail(
                      new EffectWorker.OrchestrationEffectExecutionError({
                        effectId: "task6:terminal-cleanup",
                        effectType: "terminal.cleanup",
                        cause: "Temporary fixture failure.",
                      }),
                    )
                  : Effect.void,
              ),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.runOnce;
        assert.equal((yield* resources.assertCanCreate(R).pipe(Effect.result))._tag, "Failure");
        yield* outbox.reconcileAfterProcessLoss;
        yield* TestClock.adjust("100 millis");
        assert.equal(yield* worker.drain(), 1);
        assert.equal(executions, 2);
        yield* resources.assertCanCreate(R);
      }).pipe(Effect.provide(workerLayer));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle exhausted cleanup stays failed after process recovery and ordinary prune",
  () =>
    Effect.gen(function* () {
      yield* seed(R, { lifecycleRevision: 2 });
      yield* enqueue();
      const resources = yield* Resources.ThreadLifecycleResources;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        assert.equal(yield* worker.drain(), 1);
      }).pipe(
        Effect.provide(
          EffectWorker.layerWithOptions({ workerId: "task6:exhausted", maxAttempts: 1 }).pipe(
            Layer.provide(
              Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
                execute: () =>
                  Effect.fail(
                    new EffectWorker.OrchestrationEffectExecutionError({
                      effectId: "task6:terminal-cleanup",
                      effectType: "terminal.cleanup",
                      cause: "Fixture cleanup failure.",
                    }),
                  ),
              }),
            ),
          ),
        ),
      );
      yield* outbox.reconcileAfterProcessLoss;
      yield* TestClock.adjust("8 days");
      assert.equal(yield* outbox.pruneSettled, 0);
      assert.deepEqual(yield* resources.getCleanupStatus(commandId), {
        pendingCount: 0,
        failedCount: 1,
      });
      assert.equal((yield* resources.assertCanCreate(R).pipe(Effect.result))._tag, "Failure");
    }).pipe(Effect.provide(layerTest)),
);
