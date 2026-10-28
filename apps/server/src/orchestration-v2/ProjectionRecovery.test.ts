import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";
import * as ThreadLifecycleGuard from "./ThreadLifecycleGuard.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
import * as NativeSessionBindings from "./NativeSessionBindings.ts";
import * as ThreadDeletionRecords from "./ThreadDeletionRecords.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";

const layerLifecycleStores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  NativeSessionBindings.layer,
  ThreadDeletionRecords.layer,
);
const layerLifecycleTest = ProjectionMaintenance.layer.pipe(
  Layer.provideMerge(layerLifecycleStores),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect(
  "rebuilds historical native bindings and idempotently restores independent deletion records",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const bindings = yield* NativeSessionBindings.NativeSessionBindings;
      const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* createThread("lifecycle", { lifecycleRevision: 7 });
      const thread = yield* projections.getThread(threadId);
      const at = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z");
      yield* events.append({
        events: [
          {
            id: EventId.make("lifecycle:create"),
            type: "thread.created",
            threadId,
            occurredAt: at,
            payload: thread,
          },
        ],
      });
      for (const [driverName, canonicalRoot] of [
        ["claude", "C:/claude"],
        ["codex", "C:/codex"],
        ["codex", "C:/other-codex"],
      ] as const) {
        const event = {
          id: EventId.make(`lifecycle:${canonicalRoot}`),
          type: "provider-thread.updated" as const,
          threadId,
          occurredAt: at,
          payload: {
            id: ProviderThreadId.make(`lifecycle:${driverName}`),
            driver: ProviderDriverKind.make(driverName),
            providerInstanceId: ProviderInstanceId.make(driverName),
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: ProviderDriverKind.make(driverName),
              nativeId: `${driverName}-session`,
              strength: "strong" as const,
            },
            nativeConversationHeadRef: null,
            nativeStorage: { type: "resolved" as const, canonicalRoot },
            status: "idle" as const,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
          },
        };
        yield* events.append({ events: [event] });
        yield* projections.apply(event);
      }
      const sessions = yield* bindings.listForThreads([threadId]);
      assert.equal(sessions.length, 3);
      assert.equal((yield* projections.getThreadShell(threadId))?.lifecycleRevision, 7);
      for (const type of ["thread.archived", "thread.unarchived"] as const) {
        yield* projections.apply({
          id: EventId.make(type),
          type,
          threadId,
          occurredAt: at,
          payload: thread,
        });
        assert.isTrue(Option.isNone(yield* deletions.get(threadId)));
      }
      const record = {
        threadId,
        projectId: thread.projectId,
        parentThreadId: null,
        operationRootThreadId: threadId,
        deletedAt: DateTime.formatIso(at),
        commandId: CommandId.make("lifecycle:delete"),
        scope: "t3_only" as const,
        sessions,
      };
      const deletionEvent = {
        id: EventId.make("lifecycle:delete"),
        type: "thread.deleted" as const,
        threadId,
        occurredAt: at,
        payload: { ...thread, deletedAt: at },
        deletionRecord: record,
      };
      yield* events.append({ events: [deletionEvent] });
      yield* projections.apply(deletionEvent);
      // A record whose source event is unavailable must survive projection rebuild too.
      const independent = { ...record, threadId: ThreadId.make("independent"), sessions: [] };
      yield* deletions.apply(independent);
      yield* sql`DELETE FROM orchestration_v2_thread_deletions WHERE thread_id = ${threadId}`;
      yield* sql`DELETE FROM orchestration_v2_native_session_bindings`;
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* bindings.listForThreads([threadId]), sessions);
      assert.deepEqual(Option.getOrThrow(yield* deletions.get(threadId)), record);
      assert.deepEqual(Option.getOrThrow(yield* deletions.get(independent.threadId)), independent);
      assert.equal((yield* projections.getThread(threadId)).lifecycleRevision, 7);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(Option.getOrThrow(yield* deletions.get(threadId)), record);
    }).pipe(Effect.provide(layerLifecycleTest)),
);

it.effect("rolls back deletion records together with a failed thread projection update", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* createThread("lifecycle-rollback");
    const thread = yield* projections.getThread(threadId);
    yield* sql`CREATE TRIGGER reject_lifecycle_update BEFORE UPDATE ON orchestration_v2_projection_threads BEGIN SELECT RAISE(ABORT, 'test projection failure'); END`;
    const deletedAt = thread.updatedAt;
    const error = yield* Effect.flip(
      projections.apply({
        id: EventId.make("lifecycle:rollback"),
        type: "thread.deleted",
        threadId,
        occurredAt: deletedAt,
        payload: { ...thread, deletedAt },
        deletionRecord: {
          threadId,
          projectId: thread.projectId,
          parentThreadId: null,
          operationRootThreadId: threadId,
          deletedAt: DateTime.formatIso(deletedAt),
          commandId: CommandId.make("lifecycle:rollback"),
          scope: "t3_only",
          sessions: [],
        },
      }),
    );
    assert.equal(error._tag, "ProjectionStoreApplyEventError");
    assert.isTrue(Option.isNone(yield* deletions.get(threadId)));
    assert.isNull((yield* projections.getThread(threadId)).deletedAt);
  }).pipe(Effect.provide(layerLifecycleTest)),
);

const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerRecoveryTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provide(ThreadLifecycleGuard.layer),
  Layer.provide(ThreadOwnership.layer),
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:recovery:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:recovery"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const ordinal = overrides.ordinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* projections.apply({
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    },
  });
  return runId;
});

it.effect.each(["startup", "shutdown"] as const)(
  "%s cancels queued buffered wakes and holds durable messages",
  (trigger) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const bufferedThreads = [] as ThreadId[];
      const durableThreads = [] as ThreadId[];
      for (const kind of ["buffered", "user", "notification", "delegated"] as const) {
        const threadId = yield* createThread(`wake:${trigger}:${kind}`);
        const buffered = kind === "buffered";
        (buffered ? bufferedThreads : durableThreads).push(threadId);
        const messageId = MessageId.make(`message:${threadId}`);
        const runId = yield* createRun(threadId, "queued", {
          userMessageId: messageId,
          startedAt: null,
          queuePosition: 1,
        });
        yield* createRun(threadId, "completed", { ordinal: 2 });
        yield* projections.apply({
          id: EventId.make(`message:${threadId}`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "Queued work",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: kind === "user" ? "user" : "agent",
            creationSource: buffered ? "provider" : "server",
            ...(kind === "user" || kind === "delegated"
              ? {}
              : {
                  notification: {
                    source: { kind: "background_task" as const },
                    outcome: "updated" as const,
                    summary: "Background activity updated",
                  },
                }),
            ...(kind === "delegated"
              ? { delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [] } }
              : {}),
          },
        });
      }
      assert.deepEqual(
        new Set(yield* projections.getRecoveryThreadIds("runtime")),
        new Set([...bufferedThreads, ...durableThreads]),
      );
      const summary = yield* recovery.reconcile(trigger);
      assert.equal(summary.terminalizedRuns, 1);
      for (const threadId of bufferedThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "cancelled");
        assert.isNotNull(projection.runs[0]?.completedAt);
        assert.isNull(projection.runs[0]?.queuePosition);
        assert.equal(projection.runs[1]?.status, "completed");
      }
      for (const threadId of durableThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "queued");
        assert.isTrue(projection.runs[0]?.queueHeld);
      }
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("stops a session its thread detached, which kept its live status", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("detached-session");
    const providerSessionId = ProviderSessionId.make("session:recovery:detached");
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:attached"),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:detached"),
      type: "provider-session.detached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: { providerSessionId, detachedAt: now, reason: "Thread settled." },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);

    const summary = yield* recovery.reconcile("startup");

    assert.equal(summary.stoppedSessions, 1);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(rows, [{ status: "stopped" }]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("selects unfinished recovery work without reading settled thread histories", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (let index = 0; index < 600; index += 1) {
      yield* createRun(yield* createThread(`settled-${index}`), "completed");
    }
    const queued = yield* createThread("queued");
    const archived = yield* createThread("archived", { archivedAt: now });
    const deleted = yield* createThread("deleted", { deletedAt: now });
    const blocked = yield* createThread("blocked");
    yield* createRun(queued, "completed");
    for (const threadId of [queued, archived, deleted, blocked]) {
      yield* createRun(threadId, "queued", threadId === queued ? { ordinal: 2 } : {});
    }
    yield* createRun(blocked, "waiting", { ordinal: 2 });
    const background = yield* createThread("background");
    yield* createRun(background, "completed");
    yield* projections.apply({
      id: EventId.make("event:recovery:background"),
      type: "turn-item.updated",
      threadId: background,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:recovery:background"),
        threadId: background,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "dynamic_tool",
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        toolName: "background",
        input: null,
        output: null,
      },
    });
    const outboxOnly = yield* createThread("outbox-only");
    yield* outbox.enqueue([
      {
        id: "effect:recovery:outbox-only",
        commandId: CommandId.make("command:recovery:outbox-only"),
        threadId: outboxOnly,
        request: { type: "provider-turn.start", runId: RunId.make("run:outbox-only") },
      },
    ]);
    const requestOnly = yield* createThread("request-only");
    yield* projections.apply({
      id: EventId.make("event:recovery:request-only"),
      type: "runtime-request.updated",
      threadId: requestOnly,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:recovery:pending"),
        nodeId: NodeId.make("node:recovery:request"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Process stopped" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const delivery = yield* createThread("delivery", { archivedAt: now });
    yield* createRun(delivery, "completed", {
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: MessageId.make("message:delivery"), taskIds: [] },
      },
    });

    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${ThreadId.make("thread:recovery:settled-599")}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${queued} AND ordinal = 1
    `;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("queued-runs"), [queued]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([queued, archived, blocked, background, outboxOnly, requestOnly]),
    );
    assert.deepEqual(yield* projections.getRecoveryThreadIds("delegated-completions"), [delivery]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const recoveryState = yield* projections.getRuntimeRecoveryProjection(queued);
    assert.deepEqual(
      recoveryState.runs.map((run) => run.id),
      [RunId.make(`run:${queued}:2`)],
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), [
      queued,
      ThreadId.make("thread:recovery:settled-599"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recovers terminal subagent results until their cross-thread transfer exists", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const parent = yield* createThread("subagent-parent");
    const children: Array<ThreadId> = [];
    for (const name of ["terminal", "archived", "deleted", "running", "held", "queued"]) {
      const child = yield* createThread(`subagent-${name}`, {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
        forkedFrom: { type: "node", nodeId: NodeId.make(`node:${name}`) },
        archivedAt: name === "archived" ? now : null,
        deletedAt: name === "deleted" ? now : null,
      });
      yield* createRun(child, name === "running" ? "running" : "completed");
      if (name === "held" || name === "queued") {
        yield* createRun(child, "queued", {
          ordinal: 2,
          startedAt: null,
          ...(name === "held" ? { queueHeld: true } : {}),
        });
      }
      children.push(child);
    }
    const terminalChildren = new Set([children[0]!, children[1]!, children[4]!]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      terminalChildren,
    );

    const completed = children[0]!;
    const transferId = ContextTransferId.make("transfer:recovery:subagent-result");
    yield* projections.apply({
      id: EventId.make("event:recovery:subagent-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: transferId,
        type: "subagent_result",
        sourceThreadId: completed,
        targetThreadId: parent,
        sourcePoint: { threadId: completed },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    const archivedChild = children[1];
    assert.isDefined(archivedChild);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      new Set([archivedChild, children[4]!]),
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_context_transfers SET payload_json = '{}'
      WHERE context_transfer_id = ${transferId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([parent, completed]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "memory", layer: ProjectionStore.layerMemory },
])("recovers only recorded follow-up results with $name projections", ({ layer }) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const parent = yield* createThread("followup-parent");
    const child = yield* createThread("followup-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      forkedFrom: { type: "node", nodeId: NodeId.make("node:original") },
    });
    const originalRunId = yield* createRun(child, "completed");
    yield* projections.apply({
      id: EventId.make("event:original-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: ContextTransferId.make("transfer:original-result"),
        type: "subagent_result",
        sourceThreadId: child,
        targetThreadId: parent,
        sourcePoint: { threadId: child, runId: originalRunId },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    yield* createRun(child, "completed", { ordinal: 2 });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const taskId = NodeId.make("node:followup");
    yield* createRun(child, "completed", { ordinal: 3, delegatedTaskId: taskId });
    yield* createRun(child, "running", { ordinal: 4 });
    const task = {
      id: taskId,
      threadId: parent,
      runId: null,
      parentNodeId: NodeId.make("node:parent"),
      origin: "app_owned" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: child,
      nativeTaskRef: null,
      prompt: "Check the follow-up.",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* projections.apply({
      id: EventId.make("event:followup-task"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: task,
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), [child]);
    yield* projections.apply({
      id: EventId.make("event:followup-settled"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: { ...task, status: "completed", result: "Follow-up result.", completedAt: now },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("includes shared sessions and provider-owned background rosters in recovery", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const first = yield* createThread("shared-first");
    const second = yield* createThread("shared-second", { archivedAt: now });
    const providerSessionId = ProviderSessionId.make("session:recovery:shared");
    for (const threadId of [first, second]) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:session`),
        type: "provider-session.attached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const roster = yield* createThread("roster");
    yield* projections.apply({
      id: EventId.make("event:recovery:roster"),
      type: "provider-thread.updated",
      threadId: roster,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:recovery:roster"),
        appThreadId: roster,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "background", description: "Still running", kind: "command" },
        ],
      },
    });
    const prepared = yield* createThread("prepared-continuation");
    const preparedSessionId = ProviderSessionId.make("session:recovery:prepared");
    const preparedProviderThreadId = ProviderThreadId.make("provider-thread:recovery:prepared");
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-session"),
      type: "provider-session.attached",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedSessionId,
        driver,
        providerInstanceId,
        status: "stopped",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-thread"),
      type: "provider-thread.updated",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedProviderThreadId,
        appThreadId: prepared,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: preparedSessionId,
        nativeThreadRef: { driver, nativeId: "native:prepared", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    });
    const preparedRunId = yield* createRun(prepared, "starting", {
      providerThreadId: preparedProviderThreadId,
      restartContinuationOfRunId: RunId.make("run:recovery:source"),
    });
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([first, second, roster, prepared]),
    );
    const preparedState = yield* projections.getRuntimeRecoveryProjection(prepared);
    assert.deepEqual(
      preparedState.providerSessions.map((session) => session.id),
      [preparedSessionId],
    );
    assert.equal(restartContinuationRun(preparedState, yield* DateTime.now)?.id, preparedRunId);
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_provider_sessions SET payload_json = '{}'
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([first, second]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads the run that owns a background roster, not a queued or resumed one", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const withRoster = Effect.fn(function* (threadId: ThreadId) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:roster`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${threadId}`),
          appThreadId: threadId,
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          pendingBackgroundTasks: [
            { taskId: "background", description: "Still running", kind: "command" },
          ],
        },
      });
    });
    const runIds = (threadId: ThreadId) =>
      projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.map((state) => state.runs.map((run) => run.id)));
    const settled = yield* createThread("roster-before-queue");
    const settledRun = yield* createRun(settled, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${settled}`),
    });
    const queuedRun = yield* createRun(settled, "queued", { ordinal: 2, completedAt: null });
    yield* withRoster(settled);
    assert.deepEqual(yield* runIds(settled), [settledRun, queuedRun]);
    const resumed = yield* createThread("roster-after-resume");
    const resumedRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    });
    const continuationRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      ordinal: 2,
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    });
    yield* withRoster(resumed);
    assert.deepEqual(yield* runIds(resumed), [resumedRun, continuationRun]);
    const quiet = yield* createThread("no-roster-before-queue");
    yield* createRun(quiet, "completed");
    const quietQueued = yield* createRun(quiet, "queued", { ordinal: 2, completedAt: null });
    assert.deepEqual(yield* runIds(quiet), [quietQueued]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes the run whose subagent lost its shell, past a wake cut before it started", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("subagent-shell");
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:session`),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const settledRun = yield* createRun(threadId, "completed", { providerThreadId });
    yield* createRun(threadId, "starting", {
      ordinal: 2,
      providerThreadId,
      startedAt: null,
      completedAt: null,
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:roster`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "shell", description: "sleep 150", kind: "command", parentTaskId: "agent" },
        ],
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${settledRun}` }]);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      { kind: "subagent", label: "sleep 150 (subagent agent)", id: "agent" },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("wakes a settled run whose native subagent ran on its own provider thread", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("native-subagent");
    const parentProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const childProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}:child`);
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    const subagentId = NodeId.make(`node:${threadId}:subagent`);
    // An older thread on the same Codex session is recovered first and stops it.
    const sibling = yield* createThread("a-shared-session");
    yield* createRun(sibling, "completed");
    for (const boundThreadId of [sibling, threadId]) {
      yield* projections.apply({
        id: EventId.make(`event:${boundThreadId}:session`),
        type: "provider-session.attached",
        threadId: boundThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const settledRun = yield* createRun(threadId, "completed", {
      providerThreadId: parentProviderThreadId,
    });
    for (const [id, nativeId] of [
      [parentProviderThreadId, "native-thread"],
      [childProviderThreadId, "agent-thread"],
    ] as const) {
      yield* projections.apply({
        id: EventId.make(`event:${id}`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id,
          appThreadId:
            id === parentProviderThreadId ? threadId : ThreadId.make(`${threadId}:child`),
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId,
          nativeThreadRef: { driver, nativeId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: id === parentProviderThreadId ? 1 : null,
          lastRunOrdinal: id === parentProviderThreadId ? 1 : null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    const subagent = {
      threadId,
      runId: settledRun,
      origin: "provider_native",
      driver,
      providerInstanceId,
      childThreadId: null,
      prompt: "audit src",
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    } as const;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: subagentId,
        parentNodeId: NodeId.make(`node:${threadId}:root`),
        createdBy: "agent",
        providerThreadId: childProviderThreadId,
        nativeTaskRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        title: null,
        model: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent-item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: TurnItemId.make(`item:${threadId}:subagent`),
        nodeId: subagentId,
        providerThreadId: childProviderThreadId,
        providerTurnId: null,
        nativeItemRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        parentItemId: null,
        ordinal: 1,
        type: "subagent",
        title: "audit",
        subagentId,
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${settledRun}` }]);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      {
        kind: "subagent",
        label: "audit (id agent-thread)",
        id: TurnItemId.make(`item:${threadId}:subagent`),
      },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("marks fork descendants unreadable when their source is missing or corrupt", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const source = yield* createThread("source");
    const sourceRun = yield* createRun(source, "completed");
    const fork = yield* createThread("fork", {
      forkedFrom: { type: "run", threadId: source, runId: sourceRun },
    });
    const descendant = yield* createThread("descendant", {
      forkedFrom: { type: "run", threadId: fork, runId: RunId.make("run:fork") },
    });
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{}'
      WHERE run_id = ${sourceRun}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([source, fork, descendant]),
    );
    yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${source}`;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([fork, descendant]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "070 canonical recovery survives V2 rebuild and old cursors without guessing unknown history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const at = "2026-10-28T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('task8:legacy-project', 'Legacy', '/task8/legacy', '[]', ${at}, ${at})`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('task8:legacy', 'task8:legacy-project', 'Legacy', '{"instanceId":"codex","model":"test"}', 'full-access', 'default', ${at}, ${at})`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('task8:canonical', 'task8:legacy', 'task8:turn', 'assistant', 'recoverable canonical token', 0, ${at}, ${at}),
        ('task8:unknown', 'task8:legacy', 'task8:unknown-turn', 'assistant', 'unprovable history token', 0, ${at}, ${at})`;
      yield* sql`INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES ('task8:legacy-event', 'thread', 'task8:legacy', 1, 'thread.message-sent', ${at}, 'provider',
        '{"threadId":"task8:legacy","turnId":"task8:turn","messageId":"task8:canonical","role":"assistant"}', '{}', 1)`;
      const threadId = yield* createThread("task8-replay");
      const thread = yield* store.getThread(threadId);
      yield* events.append({
        events: [
          {
            id: EventId.make("task8:replay-created"),
            type: "thread.created",
            threadId,
            occurredAt: DateTime.makeUnsafe(at),
            payload: thread,
          },
        ],
      });
      const cursor = yield* events.latestSequence();
      const metadataEvent = {
        id: EventId.make("task8:replay-metadata"),
        type: "thread.metadata-updated" as const,
        threadId,
        occurredAt: DateTime.makeUnsafe(at),
        payload: { ...thread, title: "Recovered title" },
      };
      yield* events.append({ events: [metadataEvent] });
      yield* store.apply(metadataEvent);
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 70`;
      assert.deepEqual(
        (yield* runMigrations()).map(([id]) => id),
        [70],
      );
      const before = yield* search.search({ query: "recoverable canonical token" });
      assert.deepEqual(
        before.matches.map((row) => row.threadId),
        ["task8:legacy"],
      );
      assert.deepEqual((yield* search.search({ query: "unprovable history token" })).matches, []);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* search.search({ query: "recoverable canonical token" }), before);
      assert.equal((yield* store.getThread(threadId)).title, "Recovered title");
      assert.deepEqual(
        (yield* events.read({ afterSequence: cursor }).pipe(Stream.runCollect)).map(
          (row) => row.event.id,
        ),
        [metadataEvent.id],
      );
      yield* sql`DELETE FROM legacy_canonical_assistant_messages`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 70`;
      yield* runMigrations();
      assert.deepEqual(yield* search.search({ query: "recoverable canonical token" }), before);
      // Search must keep using the recovered index when event storage is unavailable.
      yield* sql`DROP TABLE orchestration_events`;
      assert.deepEqual(yield* search.search({ query: "recoverable canonical token" }), before);
      assert.deepEqual((yield* search.search({ query: "unprovable history token" })).matches, []);
    }).pipe(Effect.provide(ThreadSearch.layer.pipe(Layer.provideMerge(layerLifecycleTest)))),
);
