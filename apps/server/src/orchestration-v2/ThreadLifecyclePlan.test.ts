import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type NativeSessionBinding,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProjectionStore from "./ProjectionStore.ts";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";
import * as NativeSessionBindings from "./NativeSessionBindings.ts";
import * as ThreadDataReclamation from "./ThreadDataReclamation.ts";
import * as ThreadDeletionRecords from "./ThreadDeletionRecords.ts";
import * as ThreadLifecyclePlan from "./ThreadLifecyclePlan.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";

const planThreadLifecycle = ThreadLifecyclePlan.planThreadLifecycle;

const threadId = ThreadId.make("thread:delete-plan");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:delete-plan");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const createdAt = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z");
const deletedAt = DateTime.makeUnsafe("2026-09-04T00:00:00.000Z");
const command = {
  type: "thread.delete" as const,
  commandId: CommandId.make("command:delete-plan"),
  threadId,
};

function makeProjection(): OrchestrationV2ThreadProjection {
  const base = emptyProjection({
    id: EventId.make("event:delete-plan-created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: {
      id: threadId,
      createdBy: "user",
      creationSource: "web",
      projectId: ProjectId.make("project:delete-plan"),
      title: "Delete the thread",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature",
      worktreePath: "/workspace/feature",
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  const runs: Array<OrchestrationV2Run> = (
    ["preparing", "queued", "starting", "running", "waiting", "completed"] as const
  ).map((status, index) => ({
    id: RunId.make(`run:delete-plan:${status}`),
    threadId,
    ordinal: index + 1,
    providerInstanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`message:delete-plan:${status}`),
    rootNodeId: NodeId.make(`node:delete-plan:${status}`),
    activeAttemptId: RunAttemptId.make(`attempt:delete-plan:${status}`),
    status,
    queuePosition: status === "queued" ? 1 : null,
    requestedAt: createdAt,
    startedAt: createdAt,
    completedAt: status === "completed" ? createdAt : null,
    checkpointId: null,
    contextHandoffId: null,
  }));
  return {
    ...base,
    runs,
    attempts: runs.map((run) => ({
      id: run.activeAttemptId!,
      runId: run.id,
      attemptOrdinal: 1,
      rootNodeId: run.rootNodeId!,
      providerInstanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: run.status === "completed" ? "completed" : "running",
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    nodes: runs.map((run) => ({
      id: run.rootNodeId!,
      threadId,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: run.rootNodeId!,
      kind: "root_turn",
      status: run.status === "completed" ? "completed" : "waiting",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: createdAt,
      completedAt: run.completedAt,
    })),
    runtimeRequests: ["pending", "resolved"].map((status) => ({
      id: RuntimeRequestId.make(`request:delete-plan:${status}`),
      nodeId: runs[3]!.rootNodeId!,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: status === "pending" ? "pending" : "resolved",
      responseCapability: { type: "message" },
      createdAt,
      resolvedAt: status === "resolved" ? createdAt : null,
    })),
  };
}

const piInstanceId = ProviderInstanceId.make("pi-saved");
const piStorage = {
  type: "resolved",
  canonicalRoot: "/isolated-pi/sessions",
  canonicalFile: "/isolated-pi/sessions/session.jsonl",
} as const;

function makePiThread(
  overrides: Partial<OrchestrationV2ProviderThread> = {},
): OrchestrationV2ProviderThread {
  return {
    id: ProviderThreadId.make("pi-provider-thread"),
    driver: ProviderDriverKind.make("pi"),
    providerInstanceId: piInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: ProviderDriverKind.make("pi"),
      nativeId: "pi-native-session",
      strength: "strong",
    },
    nativeStorage: piStorage,
    nativeConversationHeadRef: null,
    status: "closed",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function makeBinding(overrides: Partial<NativeSessionBinding> = {}): NativeSessionBinding {
  return {
    threadId,
    providerThreadId: ProviderThreadId.make("pi-historical-thread"),
    providerInstanceId: piInstanceId,
    driver: ProviderDriverKind.make("pi"),
    nativeId: "pi-historical-session",
    storage: piStorage,
    boundAt: DateTime.formatIso(createdAt),
    ...overrides,
  };
}

const readReclaimableRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.forEach(
    [
      "orchestration_v2_projection_runs",
      "orchestration_v2_projection_run_attempts",
      "orchestration_v2_projection_nodes",
      "orchestration_v2_projection_subagents",
      "orchestration_v2_projection_runtime_requests",
      "orchestration_v2_projection_provider_threads",
      "orchestration_v2_projection_provider_turns",
      "orchestration_v2_projection_provider_sessions",
      "orchestration_v2_projection_provider_session_bindings",
      "orchestration_v2_native_session_bindings",
      "orchestration_v2_projection_turn_items",
      "orchestration_v2_turn_item_positions",
      "orchestration_v2_projection_messages",
      "orchestration_v2_projection_context_handoffs",
      "orchestration_v2_projection_context_transfers",
      "orchestration_v2_projection_checkpoints",
      "orchestration_v2_projection_checkpoint_scopes",
      "orchestration_v2_projection_plans",
    ],
    (table) =>
      Effect.map(sql.unsafe(`SELECT * FROM ${table} ORDER BY rowid`), (rows) => ({ table, rows })),
  );
});

it.effect("plans a root-scoped Pi deletion from saved identity after switching models", () =>
  Effect.gen(function* () {
    const member = makeProjection();
    const piThread = makePiThread();
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [{ ...member, providerThreads: [piThread] }],
      bindings: [],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deletes = plan.effects.filter(
      (effect) => effect.request.type === "provider-thread.delete",
    );
    assert.lengthOf(deletes, 1);
    assert.equal(deletes[0]!.threadId, threadId);
    assert.equal(deletes[0]!.commandId, command.commandId);
    assert.include(deletes[0]!.id, `${command.commandId}:${threadId}:provider-thread.delete:`);
    assert.deepEqual(deletes[0]!.request, {
      type: "provider-thread.delete",
      driver: "pi",
      providerInstanceId: piInstanceId,
      providerThreadId: piThread.id,
      threadIds: [threadId],
      nativeId: "pi-native-session",
      nativeStorage: piStorage,
      lifecycle: {
        commandId: command.commandId,
        rootThreadId: threadId,
        revision: 1,
        sourceToken: "c987e085db672112c54ad2f29b90eace007b7b83c720888fda3225ab8811104e",
      },
    });
    assert.equal(plan.effects.at(-1)?.request.type, "provider-thread.delete");
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(["archive", "unarchive"] as const)(
  "%s never plans native Pi deletion",
  (operation) =>
    Effect.gen(function* () {
      const member = makeProjection();
      const piThread = makePiThread();
      const plan = yield* planThreadLifecycle({
        command: { ...command, type: `thread.${operation}` },
        operationRootThreadId: threadId,
        members: [
          {
            ...member,
            thread: { ...member.thread, archivedAt: operation === "unarchive" ? createdAt : null },
            providerThreads: [piThread],
          },
        ],
        bindings: [makeBinding()],
        attachmentIdsByThread: new Map(),
        now: deletedAt,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
      });
      assert.deepEqual(
        plan.effects.map((effect) => effect.request.type),
        operation === "archive"
          ? ["scheduled-tasks.suspend", "terminal.cleanup", "preview.cleanup"]
          : [],
      );
      assert.isFalse(plan.events.some((event) => event.type === "provider-thread.updated"));
      assert.deepEqual(piThread.nativeStorage, piStorage);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(["codex", "claude"])("does not delete native %s threads", (driverKind) =>
  Effect.gen(function* () {
    const member = makeProjection();
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [
        {
          ...member,
          providerThreads: [makePiThread({ driver: ProviderDriverKind.make(driverKind) })],
        },
      ],
      bindings: [makeBinding({ driver: ProviderDriverKind.make(driverKind) })],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    assert.isFalse(plan.effects.some((effect) => effect.request.type === "provider-thread.delete"));
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each([piInstanceId, ProviderInstanceId.make("pi-other-instance")])(
  "deduplicates one canonical file across members and saved instance %s",
  (secondInstanceId) =>
    Effect.gen(function* () {
      const childId = ThreadId.make("pi-child");
      const base = makeProjection();
      const members = [
        {
          ...base,
          thread: { ...base.thread, lifecycleRevision: 4 },
          providerThreads: [makePiThread()],
        },
        {
          ...base,
          thread: {
            ...base.thread,
            id: childId,
            lifecycleRevision: 10,
            lineage: {
              parentThreadId: threadId,
              relationshipToParent: "subagent" as const,
              rootThreadId: threadId,
            },
          },
          providerThreads: [
            makePiThread({
              id: ProviderThreadId.make("pi-child-provider-thread"),
              appThreadId: childId,
              providerInstanceId: secondInstanceId,
            }),
          ],
        },
      ];
      const bindings = members.map((member) =>
        makeBinding({
          threadId: member.thread.id,
          providerThreadId: member.providerThreads[0]!.id,
          providerInstanceId: member.providerThreads[0]!.providerInstanceId,
          nativeId: "pi-native-session",
        }),
      );
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const input = {
        command,
        operationRootThreadId: threadId,
        members,
        bindings,
        attachmentIdsByThread: new Map(),
        now: deletedAt,
        idAllocator,
      };
      const plan = yield* planThreadLifecycle(input);
      const reordered = yield* planThreadLifecycle({
        ...input,
        members: members.toReversed(),
        bindings: bindings.toReversed(),
      });
      const deletes = plan.effects.filter(
        (effect) => effect.request.type === "provider-thread.delete",
      );
      assert.lengthOf(deletes, 1);
      assert.deepEqual(
        deletes,
        reordered.effects.filter((effect) => effect.request.type === "provider-thread.delete"),
      );
      const effect = deletes[0]!;
      assert.equal(effect.threadId, threadId);
      if (effect.request.type !== "provider-thread.delete")
        return assert.fail("Missing Pi deletion");
      assert.sameMembers([...effect.request.threadIds], [threadId, childId]);
      assert.equal(effect.request.lifecycle.revision, 5);
      assert.equal(
        effect.request.lifecycle.sourceToken,
        "2827917a4728c056bdbe8edf4957c8459b323fa9de5ea78e88d26170ae06d5b8",
      );
      assert.equal(new Set(plan.effects.map((item) => item.id)).size, plan.effects.length);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("prefers saved binding provenance over a changed provider thread instance", () =>
  Effect.gen(function* () {
    const binding = makeBinding({ providerThreadId: ProviderThreadId.make("pi-provider-thread") });
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [
        {
          ...makeProjection(),
          providerThreads: [
            makePiThread({ providerInstanceId: ProviderInstanceId.make("pi-changed-instance") }),
          ],
        },
      ],
      bindings: [binding],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deletes = plan.effects.filter(
      (effect) => effect.request.type === "provider-thread.delete",
    );
    assert.lengthOf(deletes, 1);
    assert.deepPropertyVal(deletes[0]!.request, "providerInstanceId", piInstanceId);
    assert.deepPropertyVal(deletes[0]!.request, "nativeId", binding.nativeId);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("plans historical native bindings even without provider thread projections", () =>
  Effect.gen(function* () {
    const first = makeBinding();
    const second = makeBinding({
      storage: { ...piStorage, canonicalFile: "/isolated-pi/sessions/second.jsonl" },
    });
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [makeProjection()],
      bindings: [first, first, second, makeBinding({ threadId: ThreadId.make("foreign") })],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deletes = plan.effects.filter(
      (effect) => effect.request.type === "provider-thread.delete",
    );
    assert.lengthOf(deletes, 2);
    assert.equal(new Set(deletes.map((effect) => effect.id)).size, 2);
    assert.sameDeepMembers(
      deletes.map((effect) => {
        if (effect.request.type !== "provider-thread.delete")
          return assert.fail("Missing Pi deletion");
        assert.equal(effect.request.providerInstanceId, piInstanceId);
        assert.equal(effect.request.providerThreadId, first.providerThreadId);
        assert.deepEqual(effect.request.threadIds, [threadId]);
        return effect.request.nativeStorage;
      }),
      [first.storage, second.storage],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each([
  { type: "unresolved", reason: "unavailable" },
  { type: "unresolved", reason: "legacy_missing_locator" },
  undefined,
] as const)("preserves unresolved Pi identity as a blocked deletion intent (%j)", (storage) =>
  Effect.gen(function* () {
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [
        { ...makeProjection(), providerThreads: [makePiThread({ nativeStorage: storage })] },
      ],
      bindings: [],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deletes = plan.effects.filter(
      (effect) => effect.request.type === "provider-thread.delete",
    );
    assert.lengthOf(deletes, 1);
    assert.deepPropertyVal(deletes[0]!.request, "nativeId", "pi-native-session");
    assert.deepPropertyVal(
      deletes[0]!.request,
      "nativeStorage",
      storage ?? { type: "unresolved", reason: "legacy_missing_locator" },
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each([
  null,
  { driver: ProviderDriverKind.make("pi"), nativeId: null, strength: "strong" as const },
])("does not plan deletion without any native identity (%j)", (nativeThreadRef) =>
  Effect.gen(function* () {
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [
        {
          ...makeProjection(),
          providerThreads: [
            makePiThread({
              nativeThreadRef,
              nativeStorage: { type: "unresolved", reason: "legacy_missing_locator" },
            }),
          ],
        },
      ],
      bindings: [
        makeBinding({
          nativeId: null,
          storage: { type: "unresolved", reason: "legacy_missing_locator" },
        }),
      ],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    assert.isFalse(plan.effects.some((effect) => effect.request.type === "provider-thread.delete"));
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("retains canonical-file identity when Pi has no native session id", () =>
  Effect.gen(function* () {
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [
        { ...makeProjection(), providerThreads: [makePiThread({ nativeThreadRef: null })] },
      ],
      bindings: [],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    const deletes = plan.effects.filter(
      (effect) => effect.request.type === "provider-thread.delete",
    );
    assert.lengthOf(deletes, 1);
    assert.deepPropertyVal(deletes[0]!.request, "nativeId", null);
    assert.deepPropertyVal(deletes[0]!.request, "nativeStorage", piStorage);
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect("ignores borrowed provider threads and inconsistent native drivers", () =>
  Effect.gen(function* () {
    const plan = yield* planThreadLifecycle({
      command,
      operationRootThreadId: threadId,
      members: [
        {
          ...makeProjection(),
          providerThreads: [
            makePiThread({ appThreadId: null }),
            makePiThread({ appThreadId: ThreadId.make("foreign") }),
            makePiThread({
              nativeThreadRef: { driver, nativeId: "foreign-driver-native", strength: "strong" },
            }),
          ],
        },
      ],
      bindings: [makeBinding({ threadId: ThreadId.make("foreign") })],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
    });
    assert.isFalse(plan.effects.some((effect) => effect.request.type === "provider-thread.delete"));
    assert.deepEqual(
      plan.events.find((event) => event.type === "thread.deleted")?.deletionRecord?.sessions,
      [],
    );
  }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(["first-delete", "pr37-binding", "pr37-projection"] as const)(
  "keeps closed legacy Pi identity through cleanup, reclamation and import protection (%s)",
  (history) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(deletedAt));
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const member = makeProjection();
      yield* store.apply({
        id: EventId.make("pi-service-created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: member.thread,
      });
      if (history !== "first-delete") {
        yield* records.apply({
          threadId,
          projectId: member.thread.projectId,
          parentThreadId: null,
          operationRootThreadId: threadId,
          deletedAt: DateTime.formatIso(deletedAt),
          commandId: command.commandId,
          scope: "t3_only",
          sessions: [],
        });
      }
      yield* store.apply({
        id: EventId.make("pi-service-provider-thread"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: createdAt,
        payload: makePiThread({
          providerSessionId: ProviderSessionId.make("pi-historical-session"),
        }),
      });
      const sql = yield* SqlClient.SqlClient;
      if (history !== "pr37-binding")
        yield* sql`DELETE FROM orchestration_v2_native_session_bindings`;
      const planner = yield* ThreadLifecyclePlan.ThreadLifecyclePlanner;
      const plan = yield* planner.plan(command);
      assert.deepEqual(
        plan.effects.map((effect) => effect.request.type),
        [
          "scheduled-tasks.cleanup",
          "terminal.cleanup",
          "preview.cleanup",
          "provider-session.detach",
          "provider-thread.delete",
        ],
      );
      const deletion = plan.effects.at(-1)!;
      assert.equal(deletion.threadId, threadId);
      assert.deepPropertyVal(deletion.request, "threadIds", [threadId]);
      assert.nestedPropertyVal(deletion.request, "lifecycle.revision", 1);
      const deleted = plan.events.find((event) => event.type === "thread.deleted")!;
      const expectedSession = makeBinding({
        providerThreadId: makePiThread().id,
        nativeId: "pi-native-session",
      });
      assert.deepEqual(deleted.deletionRecord?.sessions, [expectedSession]);
      for (const event of plan.events) yield* store.apply(event);
      assert.deepEqual(Option.getOrThrow(yield* records.get(threadId)).sessions, [expectedSession]);
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${deleted.id}, 'thread', ${threadId}, 1, 'thread.deleted', ${DateTime.formatIso(deletedAt)},
          ${command.commandId}, 'server', '{}', '{}', 2
        )
      `;
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
          status, error, command_type
        ) VALUES (
          ${command.commandId}, 'thread', ${threadId}, ${DateTime.formatIso(deletedAt)},
          0, 'accepted', NULL, 'thread.delete'
        )
      `;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const effects =
        history === "first-delete"
          ? plan.effects
          : plan.effects.filter((effect) => effect.request.type !== "provider-thread.delete");
      yield* outbox.enqueue(effects);
      assert.equal(
        (yield* outbox.listByCommandId(command.commandId)).filter(
          (effect) => effect.request.type === "provider-thread.delete",
        ).length,
        history === "first-delete" ? 1 : 0,
      );
      for (const _effect of effects) {
        const claimed = Option.getOrThrow(yield* outbox.claimNext({ workerId: "i2-worker" }));
        assert.isTrue(yield* outbox.succeed({ effectId: claimed.id, workerId: "i2-worker" }));
      }
      const reclamation = yield* ThreadDataReclamation.ThreadDataReclamation;
      const summary = yield* reclamation.reclaim({
        eventThroughSequence: Number.MAX_SAFE_INTEGER,
        receiptThroughRowId: Number.MAX_SAFE_INTEGER,
      });
      assert.equal(summary.reclaimedThreadCount, 1);
      assert.deepEqual(summary.skippedThreads, []);
      assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads`);
      assert.lengthOf(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`, 1);
      assert.equal(
        yield* (yield* NativeSessionBindings.NativeSessionBindings).checkImport(expectedSession),
        "deleted",
      );
    }).pipe(
      Effect.provide(
        ThreadLifecyclePlan.layer.pipe(
          Layer.provideMerge(ThreadOwnership.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              ProjectionStore.layer,
              IdAllocator.layer,
              EffectOutbox.layer,
              ThreadDeletionRecords.layer,
              ThreadDataReclamation.layer,
              NativeSessionBindings.layer,
            ),
          ),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
);

it.effect.each([
  "missing-storage",
  "unresolved-storage",
  "unclaimed-start",
  "archive-before-delete",
  "archive-after-compaction",
  "pre-start-failure",
  "pre-start-failure-then-archive",
  "pre-start-failure-after-rebuild",
  "pre-start-failure-with-queued-run",
  "rerouted-before-start",
  "rerouted-with-queued-run",
  "rerouted-after-compaction",
  "rerouted-target-restart",
  "rerouted-target-running",
  "rerouted-target-switch",
  "rerouted-target-instance-switch",
  "rerouted-returned-to-pi",
  "rerouted-after-pi-start",
  "failure-without-provider-origin",
  "failure-with-corrupt-origin-version",
  "failure-with-corrupt-origin-state",
  "failure-with-corrupt-origin-shape",
  "failure-after-starting-history",
  "failure-after-attempt-start-history",
  "started-attempt",
  "claimed-after-plan",
  "existing-binding",
  "previous-tombstone",
  "late-unresolved-identity",
  "late-resolved-identity",
  "identity-before-reclaim-transaction",
  "explicit-origin-without-execution-history",
  "non-pi-origin",
] as const)(
  "certifies only never-started queued Pi placeholders through deletion (%s)",
  (scenario) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(deletedAt));
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const allocator = yield* IdAllocator.IdAllocatorV2;
      const member = makeProjection();
      const runId = allocator.derive.run({ threadId, ordinal: 2 });
      const attemptId = allocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const nodeId = allocator.derive.rootNode({ runId });
      const pending = makePiThread({
        id: allocator.derive.providerThread({
          driver: ProviderDriverKind.make("pi"),
          nativeThreadId: `pending:${runId}`,
        }),
        status: "not_loaded",
        driver: scenario === "non-pi-origin" ? driver : ProviderDriverKind.make("pi"),
        nativeSessionOrigin: { version: 1, state: "unstarted" },
        nativeThreadRef: null,
        nativeStorage:
          scenario === "missing-storage"
            ? undefined
            : { type: "unresolved", reason: "unavailable" },
      });
      const run: OrchestrationV2Run = {
        ...member.runs[1]!,
        id: runId,
        providerInstanceId: piInstanceId,
        modelSelection: { instanceId: piInstanceId, model: "test" },
        providerThreadId: pending.id,
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        startedAt: null,
      };
      const attempt = {
        ...member.attempts[1]!,
        id: attemptId,
        runId,
        rootNodeId: nodeId,
        providerInstanceId: piInstanceId,
        providerThreadId: pending.id,
        status: scenario === "started-attempt" ? ("running" as const) : ("pending" as const),
        startedAt: scenario === "started-attempt" ? createdAt : null,
      };
      const node = {
        ...member.nodes[1]!,
        id: nodeId,
        rootNodeId: nodeId,
        runId,
        providerThreadId: pending.id,
        status: "pending" as const,
        startedAt: null,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("placeholder-created"),
            type: "thread.created",
            threadId,
            occurredAt: createdAt,
            payload: member.thread,
          },
          {
            id: EventId.make("placeholder-provider"),
            type: "provider-thread.updated",
            threadId,
            occurredAt: createdAt,
            payload: pending,
          },
          {
            id: EventId.make("placeholder-run"),
            type: "run.created",
            threadId,
            occurredAt: createdAt,
            payload: run,
          },
          {
            id: EventId.make("placeholder-attempt"),
            type: "run-attempt.created",
            threadId,
            occurredAt: createdAt,
            payload: attempt,
          },
          {
            id: EventId.make("placeholder-node"),
            type: "node.updated",
            threadId,
            occurredAt: createdAt,
            payload: node,
          },
        ],
      });
      if (scenario.startsWith("pre-start-failure") || scenario.startsWith("failure-")) {
        if (scenario === "failure-after-starting-history") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("placeholder-crossed-starting"),
                type: "run.updated",
                threadId,
                occurredAt: createdAt,
                payload: { ...run, status: "starting", queuePosition: null },
              },
            ],
          });
        }
        if (scenario === "failure-after-attempt-start-history") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("placeholder-attempt-started"),
                type: "run-attempt.updated",
                threadId,
                occurredAt: createdAt,
                payload: { ...attempt, status: "running", startedAt: createdAt },
              },
            ],
          });
        }
        // Match failQueuedRunStart: one system write fails the initial attempt, root and queued run.
        yield* sink.write({
          events: [
            {
              id: EventId.make("placeholder-failed-attempt"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: deletedAt,
              payload: { ...attempt, status: "failed", completedAt: deletedAt },
            },
            {
              id: EventId.make("placeholder-failed-root"),
              type: "node.updated",
              threadId,
              occurredAt: deletedAt,
              payload: { ...node, status: "failed", completedAt: deletedAt },
            },
            {
              id: EventId.make("placeholder-failure-item"),
              type: "turn-item.updated",
              threadId,
              occurredAt: deletedAt,
              payload: {
                id: allocator.derive.turnItemFromProviderItem({
                  driver: pending.driver,
                  nativeItemId: `queued-start-failure:${runId}`,
                }),
                threadId,
                runId,
                nodeId,
                providerThreadId: pending.id,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "failed",
                title: "Queued provider could not start",
                startedAt: deletedAt,
                completedAt: deletedAt,
                updatedAt: deletedAt,
                type: "error",
                failure: makeProviderFailure({
                  cause: "checkpoint preparation failed",
                  code: "queued_start_failed",
                  class: "unknown",
                }),
              },
            },
            {
              id: EventId.make("placeholder-failed-run"),
              type: "run.updated",
              threadId,
              occurredAt: deletedAt,
              payload: { ...run, status: "failed", queuePosition: null, completedAt: deletedAt },
            },
          ],
        });
        if (scenario === "failure-without-provider-origin") {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE orchestration_v2_projection_provider_threads
            SET payload_json = json_remove(payload_json, '$.nativeSessionOrigin') WHERE provider_thread_id = ${pending.id}`;
          yield* sql`UPDATE orchestration_events SET payload_json = json_remove(payload_json, '$.nativeSessionOrigin')
            WHERE event_type = 'provider-thread.updated' AND json_extract(payload_json, '$.id') = ${pending.id}`;
        }
        if (
          scenario === "failure-after-starting-history" ||
          scenario === "failure-after-attempt-start-history"
        ) {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(
            (yield* store.getThreadRecords(threadId, ["providerThreads"])).providerThreads[0]!
              .nativeSessionOrigin,
            { version: 1, state: "may_exist" },
          );
          yield* sql`DELETE FROM orchestration_events WHERE event_type IN ('run.created', 'run.updated', 'run-attempt.created', 'run-attempt.updated', 'node.updated')`;
        }
        if (scenario === "pre-start-failure-with-queued-run") {
          const secondRunId = allocator.derive.run({ threadId, ordinal: 3 });
          const secondAttemptId = allocator.derive.runAttempt({
            runId: secondRunId,
            attemptOrdinal: 1,
          });
          const secondNodeId = allocator.derive.rootNode({ runId: secondRunId });
          yield* sink.write({
            events: [
              {
                id: EventId.make("placeholder-second-run"),
                type: "run.created",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...run,
                  id: secondRunId,
                  ordinal: 3,
                  rootNodeId: secondNodeId,
                  activeAttemptId: secondAttemptId,
                },
              },
              {
                id: EventId.make("placeholder-second-attempt"),
                type: "run-attempt.created",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...attempt,
                  id: secondAttemptId,
                  runId: secondRunId,
                  rootNodeId: secondNodeId,
                },
              },
              {
                id: EventId.make("placeholder-second-node"),
                type: "node.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...node,
                  id: secondNodeId,
                  rootNodeId: secondNodeId,
                  runId: secondRunId,
                },
              },
            ],
          });
        }
        if (scenario === "pre-start-failure-after-rebuild") {
          yield* Effect.gen(function* () {
            const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
            yield* maintenance.compactEventStore();
            assert.isTrue((yield* maintenance.rebuild).valid);
          }).pipe(Effect.provide(ProjectionMaintenance.layer));
        }
      }
      if (scenario.startsWith("rerouted-")) {
        if (scenario === "rerouted-with-queued-run") {
          const secondRunId = allocator.derive.run({ threadId, ordinal: 3 });
          const secondAttemptId = allocator.derive.runAttempt({
            runId: secondRunId,
            attemptOrdinal: 1,
          });
          const secondNodeId = allocator.derive.rootNode({ runId: secondRunId });
          yield* sink.write({
            events: [
              {
                id: EventId.make("rerouted-remaining-run"),
                type: "run.created",
                threadId,
                occurredAt: createdAt,
                payload: {
                  ...run,
                  id: secondRunId,
                  ordinal: 3,
                  rootNodeId: secondNodeId,
                  activeAttemptId: secondAttemptId,
                },
              },
              {
                id: EventId.make("rerouted-remaining-attempt"),
                type: "run-attempt.created",
                threadId,
                occurredAt: createdAt,
                payload: {
                  ...attempt,
                  id: secondAttemptId,
                  runId: secondRunId,
                  rootNodeId: secondNodeId,
                },
              },
              {
                id: EventId.make("rerouted-remaining-root"),
                type: "node.updated",
                threadId,
                occurredAt: createdAt,
                payload: {
                  ...node,
                  id: secondNodeId,
                  rootNodeId: secondNodeId,
                  runId: secondRunId,
                },
              },
            ],
          });
        }
        if (scenario === "rerouted-after-pi-start") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("placeholder-prior-gate"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: createdAt,
                payload: {
                  ...pending,
                  firstRunOrdinal: 2,
                  lastRunOrdinal: 2,
                  providerSessionId: ProviderSessionId.make("prior-pi-session"),
                },
              },
            ],
          });
        }
        // A monitor wake can move to the current conversation before its original placeholder starts.
        const targetStatus =
          scenario === "rerouted-target-running"
            ? ("running" as const)
            : scenario === "rerouted-target-switch" ||
                scenario === "rerouted-target-instance-switch"
              ? ("waiting" as const)
              : ("completed" as const);
        const targetCompletedAt = targetStatus === "completed" ? deletedAt : null;
        yield* sink.write({
          events: [
            {
              id: EventId.make("placeholder-rerouted-target"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: deletedAt,
              payload: {
                ...pending,
                id: providerThreadId,
                driver,
                providerInstanceId,
                nativeThreadRef: { driver, nativeId: "codex-target", strength: "strong" },
                nativeStorage: { type: "resolved", canonicalRoot: "/codex-target" },
                firstRunOrdinal: 2,
                lastRunOrdinal: 2,
                status: targetStatus === "completed" ? "closed" : "active",
              },
            },
            {
              id: EventId.make("placeholder-rerouted-attempt"),
              type: "run-attempt.updated",
              threadId,
              occurredAt: deletedAt,
              payload: {
                ...attempt,
                providerThreadId,
                providerInstanceId,
                status: targetStatus === "completed" ? "completed" : "running",
                startedAt: createdAt,
                completedAt: targetCompletedAt,
              },
            },
            {
              id: EventId.make("placeholder-rerouted-root"),
              type: "node.updated",
              threadId,
              occurredAt: deletedAt,
              payload: {
                ...node,
                providerThreadId,
                status: targetStatus,
                startedAt: createdAt,
                completedAt: targetCompletedAt,
              },
            },
            {
              id: EventId.make("placeholder-rerouted-run"),
              type: "run.updated",
              threadId,
              occurredAt: deletedAt,
              payload: {
                ...run,
                providerThreadId,
                providerInstanceId,
                modelSelection,
                status: targetStatus,
                queuePosition: null,
                startedAt: createdAt,
                completedAt: targetCompletedAt,
              },
            },
          ],
        });
        if (scenario === "rerouted-target-restart") {
          const nextAttemptId = allocator.derive.runAttempt({ runId, attemptOrdinal: 2 });
          yield* sink.write({
            events: [
              {
                id: EventId.make("rerouted-target-attempt-2"),
                type: "run-attempt.created",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...attempt,
                  id: nextAttemptId,
                  attemptOrdinal: 2,
                  reason: "retry",
                  providerThreadId,
                  providerInstanceId,
                  status: "completed",
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
              {
                id: EventId.make("rerouted-target-retried-run"),
                type: "run.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...run,
                  providerThreadId,
                  providerInstanceId,
                  modelSelection,
                  activeAttemptId: nextAttemptId,
                  status: "completed",
                  queuePosition: null,
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
              {
                id: EventId.make("rerouted-target-tool"),
                type: "node.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...node,
                  id: NodeId.make("rerouted-target-tool"),
                  parentNodeId: node.id,
                  providerThreadId,
                  kind: "tool_call",
                  status: "completed",
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
            ],
          });
        }
        if (
          scenario === "rerouted-target-switch" ||
          scenario === "rerouted-target-instance-switch"
        ) {
          const nextAttemptId = allocator.derive.runAttempt({ runId, attemptOrdinal: 2 });
          const nextNodeId = NodeId.make("rerouted-next-root");
          const nextProviderId =
            scenario === "rerouted-target-instance-switch"
              ? providerThreadId
              : ProviderThreadId.make("rerouted-next-provider");
          const nextInstanceId = ProviderInstanceId.make("codex-next-instance");
          yield* sink.write({
            events: [
              {
                id: EventId.make("rerouted-old-attempt"),
                type: "run-attempt.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...attempt,
                  providerThreadId,
                  providerInstanceId,
                  status: "superseded",
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
              {
                id: EventId.make("rerouted-old-root"),
                type: "node.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...node,
                  providerThreadId,
                  status: "interrupted",
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
              {
                id: EventId.make("rerouted-new-provider"),
                type: "provider-thread.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...pending,
                  id: nextProviderId,
                  driver,
                  providerInstanceId: nextInstanceId,
                  nativeThreadRef: { driver, nativeId: "next-native", strength: "strong" },
                  nativeStorage: { type: "resolved", canonicalRoot: "/codex-next" },
                  firstRunOrdinal: 2,
                  lastRunOrdinal: 2,
                  status: "closed",
                },
              },
              {
                id: EventId.make("rerouted-new-attempt"),
                type: "run-attempt.created",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...attempt,
                  id: nextAttemptId,
                  attemptOrdinal: 2,
                  reason: "steering_restart",
                  rootNodeId: nextNodeId,
                  providerThreadId: nextProviderId,
                  providerInstanceId: nextInstanceId,
                  status: "completed",
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
              {
                id: EventId.make("rerouted-new-root"),
                type: "node.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...node,
                  id: nextNodeId,
                  rootNodeId: nextNodeId,
                  providerThreadId: nextProviderId,
                  status: "completed",
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
              {
                id: EventId.make("rerouted-new-run"),
                type: "run.updated",
                threadId,
                occurredAt: deletedAt,
                payload: {
                  ...run,
                  providerThreadId: nextProviderId,
                  providerInstanceId: nextInstanceId,
                  modelSelection: { instanceId: nextInstanceId, model: "next" },
                  rootNodeId: nextNodeId,
                  activeAttemptId: nextAttemptId,
                  status: "completed",
                  queuePosition: null,
                  startedAt: createdAt,
                  completedAt: deletedAt,
                },
              },
            ],
          });
        }
        if (scenario === "rerouted-returned-to-pi") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("rerouted-returned-run"),
                type: "run.updated",
                threadId,
                occurredAt: deletedAt,
                payload: run,
              },
              {
                id: EventId.make("rerouted-returned-attempt"),
                type: "run-attempt.updated",
                threadId,
                occurredAt: deletedAt,
                payload: attempt,
              },
              {
                id: EventId.make("rerouted-returned-node"),
                type: "node.updated",
                threadId,
                occurredAt: deletedAt,
                payload: node,
              },
            ],
          });
        }
        if (scenario === "rerouted-after-compaction") {
          yield* Effect.gen(function* () {
            const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
            yield* maintenance.compactEventStore();
            assert.isTrue((yield* maintenance.rebuild).valid);
          }).pipe(Effect.provide(ProjectionMaintenance.layer));
        }
      }
      if (scenario === "existing-binding") {
        yield* (yield* NativeSessionBindings.NativeSessionBindings).applyProviderThread({
          id: EventId.make("placeholder-existing-binding"),
          type: "provider-thread.updated",
          threadId,
          occurredAt: createdAt,
          payload: { ...pending, status: "error" },
        });
      }
      if (scenario === "missing-storage") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_remove(payload_json, '$.nativeStorage') WHERE provider_thread_id = ${pending.id}`;
      }
      if (scenario === "previous-tombstone") {
        yield* records.apply({
          threadId,
          projectId: member.thread.projectId,
          parentThreadId: null,
          operationRootThreadId: threadId,
          deletedAt: DateTime.formatIso(deletedAt),
          commandId: command.commandId,
          scope: "t3_only",
          sessions: [],
        });
      }
      const planner = yield* ThreadLifecyclePlan.ThreadLifecyclePlanner;
      if (
        scenario === "archive-before-delete" ||
        scenario === "archive-after-compaction" ||
        scenario === "pre-start-failure-then-archive"
      ) {
        const archive = {
          ...command,
          commandId: CommandId.make("placeholder-archive"),
          type: "thread.archive" as const,
        };
        const archivePlan = yield* planner.plan(archive);
        yield* sink.commitCommand({
          ...archivePlan,
          commandId: archive.commandId,
          commandType: archive.type,
          threadId,
          acceptedAt: deletedAt,
        });
        for (const effect of archivePlan.effects) {
          const claimed = Option.getOrThrow(
            yield* outbox.claimNext({ workerId: "placeholder-archive" }),
          );
          assert.equal(claimed.request.type, effect.request.type);
          assert.isTrue(
            yield* outbox.succeed({ effectId: claimed.id, workerId: "placeholder-archive" }),
          );
        }
        if (scenario === "archive-after-compaction") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("placeholder-rename-after-archive"),
                type: "thread.metadata-updated",
                threadId,
                occurredAt: deletedAt,
                payload: { ...(yield* store.getThread(threadId)), title: "Archived placeholder" },
              },
            ],
          });
          yield* Effect.gen(function* () {
            yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).compactEventStore();
          }).pipe(Effect.provide(ProjectionMaintenance.layer));
          const sql = yield* SqlClient.SqlClient;
          assert.isEmpty(
            yield* sql`SELECT * FROM orchestration_events WHERE event_type = 'thread.archived'`,
          );
        }
      }
      const plan = yield* planner.plan(command);
      if (scenario.startsWith("failure-with-corrupt-origin-")) {
        const sql = yield* SqlClient.SqlClient;
        const corruptOrigin =
          scenario === "failure-with-corrupt-origin-version"
            ? { version: 2, state: "unstarted" }
            : scenario === "failure-with-corrupt-origin-state"
              ? { version: 1, state: "unknown" }
              : "unstarted";
        yield* sql`UPDATE orchestration_v2_projection_provider_threads
            SET payload_json = json_set(payload_json, '$.nativeSessionOrigin', json(${JSON.stringify(corruptOrigin)}))
            WHERE provider_thread_id = ${pending.id}`;
        yield* sql`UPDATE orchestration_events
            SET payload_json = json_set(payload_json, '$.nativeSessionOrigin', json(${JSON.stringify(corruptOrigin)}))
            WHERE event_type = 'provider-thread.updated' AND json_extract(payload_json, '$.id') = ${pending.id}`;
      }
      if (scenario === "explicit-origin-without-execution-history") {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM orchestration_events WHERE event_type IN ('run.created', 'run.updated', 'run-attempt.created', 'run-attempt.updated', 'node.updated')`;
      }
      const startId = "placeholder-start";
      if (scenario === "unclaimed-start" || scenario === "claimed-after-plan") {
        yield* outbox.enqueue([
          {
            id: startId,
            commandId: CommandId.make("placeholder-dispatch"),
            threadId,
            request: { type: "provider-turn.start", runId },
          },
        ]);
        if (scenario === "claimed-after-plan") {
          yield* sink.write({
            events: [
              {
                id: EventId.make("placeholder-gate-before-claim"),
                type: "run.updated",
                threadId,
                occurredAt: deletedAt,
                payload: { ...run, status: "starting", queuePosition: null },
              },
            ],
          });
          assert.equal(
            Option.getOrThrow(yield* outbox.claimNext({ workerId: "racing-start" })).id,
            startId,
          );
          assert.deepEqual(
            (yield* store.getThreadRecords(threadId, ["providerThreads"])).providerThreads[0]!
              .nativeSessionOrigin,
            { version: 1, state: "may_exist" },
          );
        }
      }
      const committed = yield* sink.commitCommand({
        ...plan,
        commandId: command.commandId,
        commandType: command.type,
        threadId,
        acceptedAt: deletedAt,
      });
      assert.isTrue(committed.committed);
      const first = Option.getOrThrow(yield* records.get(threadId));
      if (scenario === "rerouted-before-start") {
        assert.nestedPropertyVal(first, "noNativeSessionProofs.0.providerThreadId", pending.id);
      }
      if (scenario === "late-unresolved-identity" || scenario === "late-resolved-identity") {
        yield* sink.write({
          events: [
            {
              id: EventId.make("placeholder-late-identity"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: deletedAt,
              payload: {
                ...pending,
                status: "closed",
                providerSessionId: ProviderSessionId.make("late-session"),
                nativeThreadRef: {
                  driver: ProviderDriverKind.make("pi"),
                  nativeId: "late-native",
                  strength: "strong",
                },
                ...(scenario === "late-resolved-identity" ? { nativeStorage: piStorage } : {}),
              },
            },
          ],
        });
      }
      // The worker can no longer claim a start after the deletion transaction commits.
      for (const effect of plan.effects) {
        const claimed = Option.getOrThrow(
          yield* outbox.claimNext({ workerId: "placeholder-cleanup" }),
        );
        assert.equal(claimed.request.type, effect.request.type);
        assert.isTrue(
          yield* outbox.succeed({ effectId: claimed.id, workerId: "placeholder-cleanup" }),
        );
      }
      if (scenario === "unclaimed-start" || scenario === "claimed-after-plan") {
        const cancelled = Option.getOrThrow(yield* outbox.get(startId));
        assert.equal(cancelled.status, "cancelled");
        assert.equal(cancelled.attemptCount, scenario === "unclaimed-start" ? 0 : 1);
      }
      const allowed = [
        "explicit-origin-without-execution-history",
        "non-pi-origin",
        "missing-storage",
        "unresolved-storage",
        "unclaimed-start",
        "archive-before-delete",
        "archive-after-compaction",
        "pre-start-failure",
        "pre-start-failure-then-archive",
        "pre-start-failure-after-rebuild",
        "pre-start-failure-with-queued-run",
        "rerouted-before-start",
        "rerouted-with-queued-run",
        "rerouted-after-compaction",
        "rerouted-target-restart",
        "rerouted-target-running",
        "rerouted-target-switch",
        "rerouted-target-instance-switch",
        "rerouted-returned-to-pi",
      ].includes(scenario);
      const certified =
        (allowed && scenario !== "non-pi-origin") ||
        scenario.startsWith("late-") ||
        scenario === "identity-before-reclaim-transaction";
      const reclaim = (yield* ThreadDataReclamation.ThreadDataReclamation).reclaim;
      const bounds = {
        eventThroughSequence: Number.MAX_SAFE_INTEGER,
        receiptThroughRowId: Number.MAX_SAFE_INTEGER,
      };
      let summary: ThreadDataReclamation.ThreadDataReclamationSummary;
      if (scenario === "identity-before-reclaim-transaction") {
        const sql = yield* SqlClient.SqlClient;
        const bindings = yield* NativeSessionBindings.NativeSessionBindings;
        let injected = false;
        const withTransaction: typeof sql.withTransaction = (effect) =>
          Effect.gen(function* () {
            if (!injected) {
              injected = true;
              yield* bindings
                .applyProviderThread({
                  id: EventId.make("late-before-reclaim-transaction"),
                  type: "provider-thread.updated",
                  threadId,
                  occurredAt: deletedAt,
                  payload: { ...pending, status: "error" },
                })
                .pipe(Effect.orDie);
            }
            return yield* sql.withTransaction(effect);
          });
        const intercepted = new Proxy(sql, {
          get(target, key, receiver) {
            return key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver);
          },
        });
        summary = yield* Effect.gen(function* () {
          return yield* (yield* ThreadDataReclamation.ThreadDataReclamation).reclaim(bounds);
        }).pipe(
          Effect.provide(
            Layer.fresh(
              ThreadDataReclamation.layer.pipe(
                Layer.provide(Layer.succeed(SqlClient.SqlClient, intercepted)),
              ),
            ),
          ),
        );
        assert.isTrue(injected);
      } else summary = yield* reclaim(bounds);
      assert.equal(summary.reclaimedThreadCount, allowed ? 1 : 0);
      if (allowed) {
        assert.deepEqual(summary.skippedThreads, []);
        const sql = yield* SqlClient.SqlClient;
        assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads`);
        assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_runs`);
        for (const { table, rows } of yield* readReclaimableRows) assert.isEmpty(rows, table);
        const repeated = yield* reclaim(bounds);
        assert.deepEqual(repeated.skippedThreads, []);
        assert.equal(repeated.deletedProjectionRowCount, 0);
      } else {
        assert.deepInclude(summary.skippedThreads, {
          threadId,
          blockerCodes: ["unknown_dependency"],
        });
        assert.lengthOf((yield* store.getThreadRecords(threadId, ["runs"])).runs, 1);
      }
      if (certified) {
        assert.deepEqual(first.noNativeSessionProofs, [
          {
            providerThreadId: pending.id,
            providerInstanceId: piInstanceId,
            source: "queued_provider_origin",
            version: 1,
          },
        ]);
        const stored = committed.storedEvents.find((row) => row.event.type === "thread.deleted")!;
        assert.deepNestedPropertyVal(
          stored,
          "event.deletionRecord.noNativeSessionProofs",
          first.noNativeSessionProofs,
        );
      } else assert.notProperty(first, "noNativeSessionProofs");
      // A certified placeholder has no native file or id to import. Its T3 tombstone remains durable.
      assert.isTrue(Option.isSome(yield* records.get(threadId)));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(ThreadLifecyclePlan.layer, EventSink.layerFromStores).pipe(
          Layer.provideMerge(ThreadOwnership.layer),
          Layer.provideMerge(
            Layer.mergeAll(
              ProjectionStore.layer,
              EventStore.layer,
              IdAllocator.layer,
              EffectOutbox.layer,
              CommandReceiptStore.layer,
              ProjectStore.layer,
              TurnItemPositionStore.layer,
              ThreadDeletionRecords.layer,
              ThreadDataReclamation.layer,
              NativeSessionBindings.layer,
            ),
          ),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
);

const exactRetirementReceipt = {
  effectId: "prior-archive-retirement",
  commandId: "prior-archive",
  threadId,
  status: "succeeded",
  providerSessionId: ProviderSessionId.make("prior-session"),
  retirementRevision: 0,
  retirementSourceToken: "prior-source",
  lifecycleCommandId: "prior-archive",
  lifecycleRootThreadId: threadId,
} as const;

it.effect.each([
  { name: "reuses an exact succeeded archive receipt", receipt: exactRetirementReceipt, count: 0 },
  {
    name: "replans a pending receipt",
    receipt: { ...exactRetirementReceipt, status: "pending" },
    count: 1,
  },
  {
    name: "replans a failed receipt",
    receipt: { ...exactRetirementReceipt, status: "failed" },
    count: 1,
  },
  {
    name: "replans a receipt from another operation root",
    receipt: { ...exactRetirementReceipt, lifecycleRootThreadId: "other-root" },
    count: 1,
  },
  {
    name: "replans malformed command provenance",
    receipt: { ...exactRetirementReceipt, lifecycleCommandId: "other-command" },
    count: 1,
  },
] as const)("$name", ({ receipt, count }) => {
  const member = makeProjection();
  const layer = ThreadLifecyclePlan.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadOwnership.ThreadOwnership)({
          resolveScope: () =>
            Effect.succeed({
              rootThreadId: threadId,
              members: [
                {
                  id: threadId,
                  projectId: member.thread.projectId,
                  lineage: member.thread.lineage,
                  archivedAt: member.thread.archivedAt,
                  deletedAt: member.thread.deletedAt,
                },
              ],
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(member),
          getThreadAttachmentIds: () => Effect.succeed([]),
          getProviderAttachmentSources: () =>
            Effect.succeed([
              {
                providerSessionId: exactRetirementReceipt.providerSessionId,
                lifecycleRevision: 0,
                sourceToken: exactRetirementReceipt.retirementSourceToken,
              },
            ]),
        }),
        Layer.mock(EffectOutbox.EffectOutboxV2)({
          attachmentRetirements: () => Effect.succeed([receipt]),
        }),
        IdAllocator.layer,
        SqlitePersistence.layerMemory,
      ),
    ),
  );
  return Effect.gen(function* () {
    const planner = yield* ThreadLifecyclePlan.ThreadLifecyclePlanner;
    const plan = yield* planner.plan(command);
    const detaches = plan.effects.filter(
      (effect) => effect.request.type === "provider-session.detach",
    );
    assert.lengthOf(detaches, count);
    if (count === 1) {
      assert.equal(detaches[0]?.commandId, command.commandId);
      assert.nestedPropertyVal(detaches[0]!.request, "lifecycle.rootThreadId", threadId);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("a newer lifecycle plan cancels pending native Pi deletion at the root", () =>
  Effect.gen(function* () {
    const member = { ...makeProjection(), providerThreads: [makePiThread()] };
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const input = {
      command,
      operationRootThreadId: threadId,
      members: [member],
      bindings: [],
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator,
    };
    const original = yield* planThreadLifecycle(input);
    const deletion = original.effects.find(
      (effect) => effect.request.type === "provider-thread.delete",
    );
    assert.isDefined(deletion);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue([deletion!]);
    const newer = yield* planThreadLifecycle({
      ...input,
      command: { ...command, commandId: CommandId.make("newer-archive"), type: "thread.archive" },
    });
    const cancelled = yield* Effect.forEach(newer.cancelUnsettledEffectsByThread, (cancellation) =>
      outbox.cancelUnsettled(cancellation),
    );
    assert.deepEqual(cancelled.flat(), [deletion!.id]);
    assert.equal(Option.getOrThrow(yield* outbox.get(deletion!.id)).status, "cancelled");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
);

it.effect(
  "lifecycle archive suspends schedules and marks each cleanup without duplicating effects",
  () =>
    Effect.gen(function* () {
      const plan = yield* planThreadLifecycle({
        command: { ...command, type: "thread.archive" },
        operationRootThreadId: threadId,
        members: [makeProjection()],
        bindings: [],
        attachmentIdsByThread: new Map([[threadId, ["attachment:exclusive"]]]),
        now: deletedAt,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
      });
      assert.deepEqual(plan.effects.map((effect) => effect.request.type).sort(), [
        "preview.cleanup",
        "scheduled-tasks.suspend",
        "terminal.cleanup",
      ]);
      for (const effect of plan.effects)
        assert.deepPropertyVal(effect.request, "lifecycle", {
          commandId: command.commandId,
          rootThreadId: threadId,
          revision: 1,
        });
      assert.equal(new Set(plan.effects.map((effect) => effect.id)).size, plan.effects.length);
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each(["delete", "archive", "unarchive"] as const)(
  "plans %s for ordered R/A/B and invalidates live work only",
  (operation) =>
    Effect.gen(function* () {
      const ids = ["R", "A", "B"].map((id) => ThreadId.make(id));
      const members = ids.map((id) => {
        const base = makeProjection();
        return {
          ...base,
          thread: { ...base.thread, id, archivedAt: operation === "unarchive" ? createdAt : null },
          runs: base.runs.map((run) => ({ ...run, threadId: id })),
          nodes: [
            ...base.nodes.map((node) => ({ ...node, threadId: id })),
            {
              ...base.nodes[0]!,
              id: NodeId.make(`runless:${id}`),
              threadId: id,
              runId: null,
              status: "running" as const,
            },
          ],
          providerSessions: [
            {
              id: ProviderSessionId.make("shared-session"),
              driver,
              providerInstanceId,
              status: "running" as const,
              cwd: "/workspace",
              model: null,
              capabilities: CodexProviderCapabilitiesV2,
              createdAt,
              updatedAt: createdAt,
              lastError: null,
            },
          ],
        };
      });
      const plan = yield* planThreadLifecycle({
        command: { ...command, type: `thread.${operation}`, threadId: ids[0]! },
        operationRootThreadId: ids[0]!,
        members,
        bindings: [],
        attachmentIdsByThread: new Map(),
        now: deletedAt,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
      });
      const kind =
        operation === "delete"
          ? "thread.deleted"
          : operation === "archive"
            ? "thread.archived"
            : "thread.unarchived";
      assert.deepEqual(
        plan.events.filter((e) => e.type === kind).map((e) => e.threadId),
        ids,
      );
      assert.equal(new Set(plan.effects.map((e) => e.id)).size, plan.effects.length);
      assert.isFalse(plan.events.some((e) => e.threadId === ThreadId.make("F")));
      for (const member of members) {
        const events = plan.events.filter((e) => e.threadId === member.thread.id);
        const after = events.reduce(applyToProjection, member);
        assert.equal(after.thread.lifecycleRevision, 1);
        if (operation === "unarchive") {
          assert.deepEqual(after.runs, member.runs);
          assert.deepEqual(after.runtimeRequests, member.runtimeRequests);
          assert.deepEqual(plan.effects, []);
          assert.deepEqual(plan.cancelUnsettledEffectsByThread, []);
        } else {
          assert.equal(
            after.nodes.find((n) => n.id === NodeId.make(`runless:${member.thread.id}`))?.status,
            "cancelled",
          );
          assert.isTrue(
            after.runs.every((r) => r.status === "completed" || r.status === "cancelled"),
          );
          assert.deepEqual(after.runs.at(-1), member.runs.at(-1));
          assert.isTrue(after.runtimeRequests.every((r) => r.status !== "pending"));
          assert.isTrue(
            plan.effects
              .filter((e) => e.threadId === member.thread.id)
              .every((e) => e.id.includes(member.thread.id)),
          );
        }
      }
      assert.equal(
        plan.events.filter(
          (e) => e.type === "thread.deleted" && e.deletionRecord?.scope === "t3_only",
        ).length,
        operation === "delete" ? 3 : 0,
      );
      assert.equal(
        plan.effects.filter((e) => e.request.type === "provider-session.detach").length,
        operation === "unarchive" ? 0 : 3,
      );
      if (operation !== "unarchive")
        assert.deepEqual(
          plan.cancelUnsettledEffectsByThread.map((c) => c.effectTypes),
          ids.map(
            () =>
              [
                "provider-turn.start",
                "provider-turn.steer",
                "provider-turn.restart",
                "provider-runtime.continue",
                "runtime-request.respond",
                "provider-thread.rollback",
                "provider-thread.delete",
                "thread-title.generate",
              ] as const,
          ),
        );
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect(
  "disposes each open completion cohort and records only owned historical native bindings",
  () =>
    Effect.gen(function* () {
      const base = makeProjection();
      const run = base.runs.find((r) => r.status === "completed")!;
      const taskId = NodeId.make("task5:completion");
      const member = {
        ...base,
        runs: base.runs.map((r) =>
          r.id === run.id
            ? {
                ...r,
                delegatedCompletion: {
                  disposition: "open" as const,
                  nextGeneration: 4,
                  delivery: {
                    generation: 3,
                    messageId: base.runs[1]!.userMessageId,
                    taskIds: [taskId],
                  },
                },
              }
            : r,
        ),
        subagents: [
          {
            id: taskId,
            threadId,
            runId: run.id,
            parentNodeId: run.rootNodeId!,
            origin: "app_owned" as const,
            createdBy: "agent" as const,
            driver,
            providerInstanceId,
            providerThreadId: null,
            childThreadId: null,
            nativeTaskRef: null,
            prompt: "Inspect",
            title: null,
            model: null,
            completionDelivery: { state: "claimed" as const, observedByRunId: null },
            status: "completed" as const,
            result: "preserve-result",
            startedAt: createdAt,
            completedAt: createdAt,
            updatedAt: createdAt,
          },
        ],
      };
      const binding = {
        threadId,
        providerThreadId,
        providerInstanceId,
        driver,
        nativeId: "task5:native",
        storage: { type: "resolved" as const, canonicalRoot: "/task5/native" },
        boundAt: DateTime.formatIso(createdAt),
      };
      for (const operation of ["delete", "archive"] as const) {
        const plan = yield* planThreadLifecycle({
          command: { ...command, type: `thread.${operation}` },
          operationRootThreadId: threadId,
          members: [member],
          bindings: [binding, { ...binding, threadId: ThreadId.make("foreign") }],
          attachmentIdsByThread: new Map(),
          now: deletedAt,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
        });
        const after = plan.events.reduce(applyToProjection, member);
        const completed = after.runs.find((r) => r.id === run.id)!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.completedAt, createdAt);
        assert.deepEqual(completed.delegatedCompletion, {
          disposition: "disposed",
          nextGeneration: 4,
          delivery: null,
        });
        assert.equal(after.subagents[0]?.result, "preserve-result");
        assert.equal(after.subagents[0]?.completionDelivery?.state, "disposed");
        const deletion = plan.events.find((e) => e.type === "thread.deleted");
        assert.deepEqual(
          deletion?.deletionRecord?.sessions ?? [],
          operation === "delete" ? [binding] : [],
        );
      }
    }).pipe(Effect.provide(IdAllocator.layer)),
);

it.effect.each([
  "same-root-pending",
  "same-root-held",
  "same-root-original-queued-pi",
  "cross-batch-parent-reference",
  "cross-batch-parent-first",
  "cross-batch-parent-first-failure",
  "cross-batch-parent-first-late-binding",
  "cross-batch-parent-first-claimed-start",
  "cross-batch-parent-first-child-provider-restart",
  "cross-batch-parent-first-child-instance-resume",
  "cross-batch-parent-first-child-terminal-switch",
  "same-root-child-terminal-reuse",
  "cross-batch-parent-first-child-terminal-reuse",
  "cross-batch-parent-first-child-terminal-switch-reuse",
  "cross-batch-parent-first-child-terminal-reuse-compacted",
  "cross-batch-parent-first-child-terminal-reuse-without-run-history",
  "cross-batch-parent-first-child-terminal-reuse-without-attempt-history",
  "cross-batch-parent-first-child-terminal-reuse-without-provider-history",
  "cross-batch-parent-first-child-restart-without-run-history",
  "cross-batch-parent-first-child-resume-stale-display-instance",
  "cross-batch-parent-first-without-spawn",
  "cross-batch-parent-first-wrong-spawn-owner",
  "cross-batch-parent-first-wrong-spawn-target",
  "parent-owner-restart",
  "parent-owner-restart-compacted",
  "parent-owner-restart-wrong-root",
  "parent-owner-restart-without-old-attempt",
  "missing-provider-origin",
  "corrupt-provider-origin",
  "live-parent",
  "different-operation-root",
  "missing-task",
  "wrong-lineage",
  "wrong-original-task",
  "wrong-task-child",
  "wrong-task-owner",
  "stale-task-display-instance",
  "extra-execution-node",
  "started-root",
  "native-binding",
  "late-native-identity",
] as const)("A3 validates app-owned queued follow-up references (%s)", (scenario) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(deletedAt));
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const sql = yield* SqlClient.SqlClient;
    const base = makeProjection();
    const parentFirst = scenario.startsWith("cross-batch-parent-first");
    const parentId = ThreadId.make(parentFirst ? "thread:a3-000parent" : "thread:a3-parent");
    const childId = ThreadId.make(parentFirst ? "thread:a3-zchild" : "thread:a3-child");
    const originalTaskId = NodeId.make("task:a3-original");
    const followupTaskId = allocator.derive.delegatedTaskNode({
      commandId: CommandId.make("command:a3-followup"),
    });
    const owner = {
      ...base.runs[5]!,
      id: RunId.make("run:a3-parent-owner"),
      threadId: parentId,
      providerThreadId: ProviderThreadId.make("provider:a3-parent"),
      rootNodeId: NodeId.make("node:a3-parent-root"),
      activeAttemptId: RunAttemptId.make("attempt:a3-parent"),
      ...(scenario.startsWith("parent-owner-restart")
        ? { status: "running" as const, completedAt: null }
        : {}),
    };
    const originalRun = {
      ...base.runs[5]!,
      id: RunId.make("run:a3-child-original"),
      ordinal: 1,
      threadId: childId,
      providerThreadId: ProviderThreadId.make("provider:a3-child-codex"),
      rootNodeId: NodeId.make("node:a3-child-original"),
      activeAttemptId: RunAttemptId.make("attempt:a3-child-original"),
      ...(scenario === "same-root-original-queued-pi"
        ? {
            providerThreadId: allocator.derive.providerThread({
              driver: ProviderDriverKind.make("pi"),
              nativeThreadId: "pending:run:a3-child-original",
            }),
            providerInstanceId: piInstanceId,
            modelSelection: { instanceId: piInstanceId, model: "test" },
            status: "queued" as const,
            queuePosition: 1,
            startedAt: null,
            completedAt: null,
          }
        : {}),
    };
    const activeRun = {
      ...originalRun,
      id: RunId.make("run:a3-child-active"),
      ordinal: 2,
      status: "running" as const,
      rootNodeId: NodeId.make("node:a3-child-active"),
      activeAttemptId: RunAttemptId.make("attempt:a3-child-active"),
      delegatedTaskId: NodeId.make("task:a3-active"),
      completedAt: null,
      providerThreadId: ProviderThreadId.make("provider:a3-child-codex"),
      providerInstanceId,
      modelSelection,
      queuePosition: null,
      startedAt: createdAt,
    };
    const queuedId = allocator.derive.run({ threadId: childId, ordinal: 3 });
    const pending = makePiThread({
      id: allocator.derive.providerThread({
        driver: ProviderDriverKind.make("pi"),
        nativeThreadId: `pending:${scenario === "same-root-original-queued-pi" ? originalRun.id : queuedId}`,
      }),
      appThreadId: childId,
      nativeThreadRef: null,
      nativeStorage: { type: "unresolved", reason: "unavailable" },
      status: "not_loaded",
      nativeSessionOrigin: { version: 1, state: "unstarted" },
    });
    const queued: OrchestrationV2Run = {
      ...base.runs[1]!,
      id: queuedId,
      threadId: childId,
      ordinal: 3,
      providerThreadId: pending.id,
      providerInstanceId: piInstanceId,
      modelSelection: { instanceId: piInstanceId, model: "test" },
      rootNodeId: allocator.derive.rootNode({ runId: queuedId }),
      activeAttemptId: allocator.derive.runAttempt({ runId: queuedId, attemptOrdinal: 1 }),
      startedAt: null,
      ...(scenario === "same-root-held" ? { queueHeld: true } : {}),
    };
    const parent = {
      ...base.thread,
      id: parentId,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentId },
    };
    const child = {
      ...base.thread,
      id: childId,
      lineage: {
        parentThreadId: parentId,
        relationshipToParent:
          scenario === "wrong-lineage" ? ("fork" as const) : ("subagent" as const),
        rootThreadId: parentId,
      },
      forkedFrom: {
        type: "node" as const,
        nodeId:
          scenario === "wrong-original-task" ? NodeId.make("task:a3-missing") : originalTaskId,
      },
    };
    const fillers = scenario.startsWith("cross-batch")
      ? Array.from({ length: 49 }, (_, index) => ({
          ...base.thread,
          id: ThreadId.make(`thread:a3-filler:${String(index).padStart(3, "0")}`),
          forkedFrom: null,
          lineage: {
            parentThreadId: parentId,
            relationshipToParent: "fork" as const,
            rootThreadId: parentId,
            sideChat: true,
          },
        }))
      : [];
    const members = [parent, child, ...fillers];
    for (const thread of members) {
      yield* sink.write({
        events: [
          {
            id: EventId.make(`a3-created:${thread.id}`),
            type: "thread.created",
            threadId: thread.id,
            occurredAt: createdAt,
            payload: thread,
          },
        ],
      });
    }
    for (const run of [
      owner,
      {
        ...originalRun,
        providerThreadId: activeRun.providerThreadId,
        providerInstanceId,
        modelSelection,
      },
    ]) {
      yield* sink.write({
        events: [
          {
            id: EventId.make(`a3-codex-provider:${run.id}`),
            type: "provider-thread.updated",
            threadId: run.threadId,
            occurredAt: createdAt,
            payload: {
              ...pending,
              id: run.providerThreadId,
              appThreadId: run.threadId,
              driver,
              providerInstanceId,
              nativeThreadRef: { driver, nativeId: `native:${run.id}`, strength: "strong" },
              nativeStorage: { type: "resolved", canonicalRoot: `/codex/${run.id}` },
              status: "active",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
            },
          },
        ],
      });
    }
    yield* sink.write({
      events: [
        {
          id: EventId.make("a3-pending-provider"),
          type: "provider-thread.updated",
          threadId: childId,
          occurredAt: createdAt,
          payload: pending,
        },
      ],
    });
    for (const run of [owner, originalRun, activeRun, queued]) {
      const isQueued = run.status === "queued";
      yield* sink.write({
        events: [
          {
            id: EventId.make(`a3-run:${run.id}`),
            type: "run.created",
            threadId: run.threadId,
            occurredAt: createdAt,
            payload: run,
          },
          {
            id: EventId.make(`a3-attempt:${run.id}`),
            type: "run-attempt.created",
            threadId: run.threadId,
            occurredAt: createdAt,
            payload: {
              ...base.attempts[5]!,
              id: run.activeAttemptId!,
              runId: run.id,
              rootNodeId: run.rootNodeId!,
              providerInstanceId: run.providerInstanceId,
              providerThreadId: run.providerThreadId!,
              status: isQueued ? "pending" : run.status === "running" ? "running" : "completed",
              startedAt: run.startedAt,
              completedAt: run.completedAt,
            },
          },
          {
            id: EventId.make(`a3-root:${run.id}`),
            type: "node.updated",
            threadId: run.threadId,
            occurredAt: createdAt,
            payload: {
              ...base.nodes[5]!,
              id: run.rootNodeId!,
              rootNodeId: run.rootNodeId!,
              threadId: run.threadId,
              runId: run.id,
              providerThreadId: run.providerThreadId,
              status: isQueued ? "pending" : run.status === "running" ? "running" : "completed",
              startedAt: run.startedAt,
              completedAt: run.completedAt,
            },
          },
        ],
      });
    }
    assert.notProperty(originalRun, "delegatedTaskId");
    // 首次委派由 spawn transfer 关联；只有 follow-up 向 run 写入 delegatedTaskId。
    for (const run of [originalRun, activeRun, { ...queued, delegatedTaskId: followupTaskId }]) {
      const isQueued = run.status === "queued";
      const task = {
        id: run.id === originalRun.id ? originalTaskId : run.delegatedTaskId!,
        threadId: parentId,
        runId: owner.id,
        parentNodeId: owner.rootNodeId!,
        origin: "app_owned" as const,
        createdBy: "user" as const,
        driver: isQueued ? ProviderDriverKind.make("pi") : driver,
        providerInstanceId: run.providerInstanceId,
        providerThreadId: run.providerThreadId,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Follow up",
        title: "Child",
        model: run.modelSelection.model,
        completionDelivery: { state: "pending" as const, observedByRunId: null },
        status: isQueued
          ? scenario === "same-root-held"
            ? ("idle" as const)
            : ("pending" as const)
          : run.status === "running"
            ? ("running" as const)
            : ("completed" as const),
        result: run.id === originalRun.id ? "Original result" : null,
        startedAt: createdAt,
        completedAt: run.completedAt,
        updatedAt: createdAt,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make(`a3-delegated-run:${run.id}`),
            type: "run.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: run,
          },
          {
            id: EventId.make(`a3-task:${run.id}`),
            type: "subagent.updated",
            threadId: parentId,
            occurredAt: createdAt,
            payload: task,
          },
          {
            id: EventId.make(`a3-tracking-node:${run.id}`),
            type: "node.updated",
            threadId: parentId,
            occurredAt: createdAt,
            payload: {
              ...base.nodes[5]!,
              id: task.id,
              threadId: parentId,
              runId: owner.id,
              parentNodeId: owner.rootNodeId,
              rootNodeId: owner.rootNodeId!,
              kind: "subagent",
              countsForRun: false,
              providerThreadId: run.providerThreadId,
              status: task.status,
              startedAt: task.startedAt,
              completedAt: task.completedAt,
            },
          },
        ],
      });
    }
    for (const type of ["subagent_spawn", "subagent_result"] as const) {
      if (type === "subagent_spawn" && scenario.endsWith("without-spawn")) continue;
      const spawn = type === "subagent_spawn";
      yield* sink.write({
        events: [
          {
            id: EventId.make(`a3-transfer-event:${type}`),
            type: "context-transfer.created",
            threadId: spawn ? childId : parentId,
            occurredAt: createdAt,
            payload: {
              id: ContextTransferId.make(`a3-transfer:${type}`),
              type,
              sourceThreadId: spawn ? parentId : childId,
              targetThreadId: spawn ? childId : parentId,
              sourcePoint: {
                threadId: spawn ? parentId : childId,
                runId: spawn
                  ? scenario.endsWith("wrong-spawn-owner")
                    ? activeRun.id
                    : owner.id
                  : originalRun.id,
              },
              basePoint: null,
              sourceProviderInstanceId: providerInstanceId,
              targetProviderInstanceId: providerInstanceId,
              targetRunId: spawn
                ? scenario.endsWith("wrong-spawn-target")
                  ? owner.id
                  : originalRun.id
                : owner.id,
              status: "consumed",
              resolution: null,
              createdBy: "system",
              error: null,
              createdAt,
              updatedAt: createdAt,
              consumedAt: createdAt,
            },
          },
        ],
      });
    }
    if (scenario.includes("child-")) {
      const previous = yield* store.getThreadRecords(childId, [
        "attempts",
        "nodes",
        "providerThreads",
      ]);
      const initialAttempt = previous.attempts.find(
        (attempt) => attempt.id === activeRun.activeAttemptId,
      )!;
      const initialRoot = previous.nodes.find((node) => node.id === activeRun.rootNodeId)!;
      const initialProvider = previous.providerThreads.find(
        (provider) => provider.id === activeRun.providerThreadId,
      )!;
      const resume = scenario.includes("resume");
      const nextProviderId = resume
        ? initialProvider.id
        : ProviderThreadId.make("provider:a3-child-restarted");
      const nextInstanceId = ProviderInstanceId.make("codex-a3-restarted");
      const nextDriver = scenario.includes("terminal-switch")
        ? ProviderDriverKind.make("claude")
        : driver;
      const nextRoot = allocator.derive.rootNodeAttempt({ runId: activeRun.id, attemptOrdinal: 2 });
      const nextAttempt = allocator.derive.runAttempt({ runId: activeRun.id, attemptOrdinal: 2 });
      yield* sink.write({
        events: [
          {
            id: EventId.make("a3-child-initial-ended"),
            type: "run-attempt.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: { ...initialAttempt, status: "superseded", completedAt: createdAt },
          },
          {
            id: EventId.make("a3-child-root-ended"),
            type: "node.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: { ...initialRoot, status: "interrupted", completedAt: createdAt },
          },
          {
            id: EventId.make("a3-child-restart-provider"),
            type: "provider-thread.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: {
              ...initialProvider,
              id: nextProviderId,
              providerInstanceId: nextInstanceId,
              driver: nextDriver,
              nativeThreadRef: {
                driver: nextDriver,
                nativeId: "native:a3-restarted",
                strength: "strong",
              },
              status: "active",
            },
          },
          {
            id: EventId.make("a3-child-restarted"),
            type: "run.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: {
              ...activeRun,
              status: "starting",
              providerThreadId: nextProviderId,
              providerInstanceId: nextInstanceId,
              modelSelection: { ...activeRun.modelSelection, instanceId: nextInstanceId },
              rootNodeId: nextRoot,
              activeAttemptId: nextAttempt,
            },
          },
          {
            id: EventId.make("a3-child-attempt-next"),
            type: "run-attempt.created",
            threadId: childId,
            occurredAt: createdAt,
            payload: {
              ...initialAttempt,
              id: nextAttempt,
              rootNodeId: nextRoot,
              providerThreadId: nextProviderId,
              providerInstanceId: nextInstanceId,
              attemptOrdinal: 2,
              reason: "steering_restart",
              status: "pending",
              startedAt: null,
              completedAt: null,
            },
          },
          {
            id: EventId.make("a3-child-root-next"),
            type: "node.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: {
              ...initialRoot,
              id: nextRoot,
              rootNodeId: nextRoot,
              providerThreadId: nextProviderId,
              status: "pending",
              startedAt: null,
              completedAt: null,
            },
          },
        ],
      });
      if (scenario.includes("terminal")) {
        if (scenario.includes("reuse")) {
          const childSource = yield* store.getThreadRecords(childId, ["runs", "attempts", "nodes"]);
          const parentSource = yield* store.getThreadRecords(parentId, ["subagents", "nodes"]);
          const queuedTask = parentSource.subagents.find((task) => task.id === followupTaskId)!;
          const queuedNode = parentSource.nodes.find((node) => node.id === followupTaskId)!;
          assert.isTrue(
            (yield* sink.commitCommand({
              commandId: CommandId.make("a3-cancel-before-reuse"),
              commandType: "queued-run.cancel",
              threadId: childId,
              acceptedAt: createdAt,
              effects: [],
              events: [
                {
                  id: EventId.make("a3-cancelled-queued-run"),
                  type: "run.updated",
                  threadId: childId,
                  occurredAt: createdAt,
                  payload: {
                    ...childSource.runs.find((run) => run.id === queuedId)!,
                    status: "cancelled",
                    completedAt: createdAt,
                  },
                },
                {
                  id: EventId.make("a3-cancelled-queued-attempt"),
                  type: "run-attempt.updated",
                  threadId: childId,
                  occurredAt: createdAt,
                  payload: {
                    ...childSource.attempts.find(
                      (attempt) => attempt.id === queued.activeAttemptId,
                    )!,
                    status: "cancelled",
                    completedAt: createdAt,
                  },
                },
                {
                  id: EventId.make("a3-cancelled-queued-root"),
                  type: "node.updated",
                  threadId: childId,
                  occurredAt: createdAt,
                  payload: {
                    ...childSource.nodes.find((node) => node.id === queued.rootNodeId)!,
                    status: "cancelled",
                    completedAt: createdAt,
                  },
                },
                {
                  id: EventId.make("a3-cancelled-queued-task"),
                  type: "subagent.updated",
                  threadId: parentId,
                  occurredAt: createdAt,
                  payload: {
                    ...queuedTask,
                    status: "cancelled",
                    completedAt: createdAt,
                    updatedAt: createdAt,
                  },
                },
                {
                  id: EventId.make("a3-cancelled-queued-tracking"),
                  type: "node.updated",
                  threadId: parentId,
                  occurredAt: createdAt,
                  payload: { ...queuedNode, status: "cancelled", completedAt: createdAt },
                },
              ],
            })).committed,
          );
        }
        const current = yield* store.getThreadRecords(childId, ["runs", "attempts", "nodes"]);
        const task = (yield* store.getThreadRecords(parentId, ["subagents"])).subagents.find(
          (task) => task.id === activeRun.delegatedTaskId,
        )!;
        const tracking = (yield* store.getThreadRecords(parentId, ["nodes"])).nodes.find(
          (node) => node.id === task.id,
        )!;
        yield* sink.write({
          events: [
            {
              id: EventId.make("a3-switched-run-completed"),
              type: "run.updated",
              threadId: childId,
              occurredAt: createdAt,
              payload: {
                ...current.runs.find((run) => run.id === activeRun.id)!,
                status: "completed",
                completedAt: createdAt,
              },
            },
            {
              id: EventId.make("a3-switched-attempt-completed"),
              type: "run-attempt.updated",
              threadId: childId,
              occurredAt: createdAt,
              payload: {
                ...current.attempts.find((attempt) => attempt.id === nextAttempt)!,
                status: "completed",
                startedAt: createdAt,
                completedAt: createdAt,
              },
            },
            {
              id: EventId.make("a3-switched-root-completed"),
              type: "node.updated",
              threadId: childId,
              occurredAt: createdAt,
              payload: {
                ...current.nodes.find((node) => node.id === nextRoot)!,
                status: "completed",
                startedAt: createdAt,
                completedAt: createdAt,
              },
            },
            {
              id: EventId.make("a3-switched-task-completed"),
              type: "subagent.updated",
              threadId: parentId,
              occurredAt: createdAt,
              payload: {
                ...task,
                providerThreadId: nextProviderId,
                status: "completed",
                result: "Completed on another provider",
                completedAt: createdAt,
                updatedAt: createdAt,
              },
            },
            {
              id: EventId.make("a3-switched-tracking-completed"),
              type: "node.updated",
              threadId: parentId,
              occurredAt: createdAt,
              payload: {
                ...tracking,
                providerThreadId: nextProviderId,
                status: "completed",
                completedAt: createdAt,
              },
            },
            {
              id: EventId.make("a3-switched-result-transfer"),
              type: "context-transfer.created",
              threadId: parentId,
              occurredAt: createdAt,
              payload: {
                id: ContextTransferId.make("a3-transfer:switched-result"),
                type: "subagent_result",
                sourceThreadId: childId,
                targetThreadId: parentId,
                sourcePoint: { threadId: childId, runId: activeRun.id },
                basePoint: null,
                sourceProviderInstanceId: nextInstanceId,
                targetProviderInstanceId: owner.providerInstanceId,
                targetRunId: owner.id,
                status: "consumed",
                resolution: null,
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: createdAt,
              },
            },
          ],
        });
        if (scenario.includes("reuse")) {
          const currentProvider = (yield* store.getThreadRecords(childId, [
            "providerThreads",
          ])).providerThreads.find((provider) => provider.id === nextProviderId)!;
          const reusedInstanceId = ProviderInstanceId.make("codex-a3-reused");
          const reusedRunId = allocator.derive.run({ threadId: childId, ordinal: 4 });
          const reusedRoot = allocator.derive.rootNode({ runId: reusedRunId });
          const reusedAttempt = allocator.derive.runAttempt({
            runId: reusedRunId,
            attemptOrdinal: 1,
          });
          const reusedTaskId = NodeId.make("task:a3-reused");
          const reusedRun = {
            ...activeRun,
            id: reusedRunId,
            ordinal: 4,
            providerThreadId: nextProviderId,
            providerInstanceId: reusedInstanceId,
            modelSelection: { instanceId: reusedInstanceId, model: "test" },
            delegatedTaskId: reusedTaskId,
            rootNodeId: reusedRoot,
            activeAttemptId: reusedAttempt,
            status: "starting" as const,
          };
          yield* sink.write({
            events: [
              {
                id: EventId.make("a3-reused-provider"),
                type: "provider-thread.updated",
                threadId: childId,
                occurredAt: createdAt,
                payload: {
                  ...currentProvider,
                  providerInstanceId: reusedInstanceId,
                  providerSessionId: ProviderSessionId.make("session:a3-reused"),
                  status: "not_loaded",
                },
              },
              {
                id: EventId.make("a3-reused-run"),
                type: "run.created",
                threadId: childId,
                occurredAt: createdAt,
                payload: reusedRun,
              },
              {
                id: EventId.make("a3-reused-attempt"),
                type: "run-attempt.created",
                threadId: childId,
                occurredAt: createdAt,
                payload: {
                  ...initialAttempt,
                  id: reusedAttempt,
                  runId: reusedRunId,
                  rootNodeId: reusedRoot,
                  providerThreadId: nextProviderId,
                  providerInstanceId: reusedInstanceId,
                  status: "pending",
                  startedAt: null,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("a3-reused-root"),
                type: "node.updated",
                threadId: childId,
                occurredAt: createdAt,
                payload: {
                  ...initialRoot,
                  id: reusedRoot,
                  rootNodeId: reusedRoot,
                  runId: reusedRunId,
                  providerThreadId: nextProviderId,
                  status: "pending",
                  startedAt: null,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("a3-reused-task"),
                type: "subagent.updated",
                threadId: parentId,
                occurredAt: createdAt,
                payload: {
                  ...task,
                  id: reusedTaskId,
                  driver: nextDriver,
                  providerInstanceId: reusedInstanceId,
                  providerThreadId: nextProviderId,
                  status: "running",
                  result: null,
                  completedAt: null,
                },
              },
              {
                id: EventId.make("a3-reused-tracking"),
                type: "node.updated",
                threadId: parentId,
                occurredAt: createdAt,
                payload: {
                  ...tracking,
                  id: reusedTaskId,
                  providerThreadId: nextProviderId,
                  status: "running",
                  completedAt: null,
                },
              },
            ],
          });
          const terminal = (yield* store.getThreadRecords(childId, ["runs"])).runs.find(
            (run) => run.id === activeRun.id,
          )!;
          const completedTask = (yield* store.getThreadRecords(parentId, [
            "subagents",
          ])).subagents.find((candidate) => candidate.id === task.id)!;
          assert.equal(completedTask.providerInstanceId, providerInstanceId);
          assert.equal(terminal.providerInstanceId, nextInstanceId);
          assert.equal(
            (yield* store.getThreadRecords(childId, ["providerThreads"])).providerThreads.find(
              (provider) => provider.id === nextProviderId,
            )!.providerInstanceId,
            reusedInstanceId,
          );
          if (scenario.endsWith("compacted")) {
            yield* Effect.gen(function* () {
              const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
              yield* maintenance.compactEventStore();
              assert.isTrue((yield* maintenance.rebuild).valid);
            }).pipe(Effect.provide(ProjectionMaintenance.layer));
          } else if (scenario.endsWith("without-run-history")) {
            yield* sql`DELETE FROM orchestration_events WHERE stream_id = ${childId}
              AND event_type IN ('run.created', 'run.updated') AND json_extract(payload_json, '$.id') = ${activeRun.id}
              AND json_extract(payload_json, '$.providerThreadId') = ${nextProviderId}`;
          } else if (scenario.endsWith("without-attempt-history")) {
            yield* sql`DELETE FROM orchestration_events WHERE stream_id = ${childId}
              AND event_type = 'run-attempt.created' AND json_extract(payload_json, '$.id') = ${nextAttempt}`;
          } else if (scenario.endsWith("without-provider-history")) {
            yield* sql`DELETE FROM orchestration_events WHERE stream_id = ${childId}
              AND event_type = 'provider-thread.updated' AND json_extract(payload_json, '$.id') = ${nextProviderId}
              AND json_extract(payload_json, '$.providerInstanceId') = ${nextInstanceId}`;
          }
        }
      }
      if (scenario.endsWith("without-run-history") && !scenario.includes("reuse")) {
        yield* sql`DELETE FROM orchestration_events
          WHERE event_type IN ('run.created', 'run.updated') AND json_extract(payload_json, '$.id') = ${activeRun.id}
            AND json_extract(payload_json, '$.providerThreadId') = ${initialProvider.id}`;
      } else if (scenario.endsWith("stale-display-instance")) {
        yield* sql`UPDATE orchestration_v2_projection_subagents
          SET provider_instance_id = 'codex-a3-unrelated', payload_json = json_set(payload_json, '$.providerInstanceId', 'codex-a3-unrelated')
          WHERE subagent_id = ${activeRun.delegatedTaskId}`;
      }
    }
    if (scenario.startsWith("parent-owner-restart")) {
      const previous = yield* store.getThreadRecords(parentId, ["attempts", "nodes"]);
      const initialAttempt = previous.attempts.find(
        (attempt) => attempt.id === owner.activeAttemptId,
      )!;
      const initialRoot = previous.nodes.find((node) => node.id === owner.rootNodeId)!;
      const nextRoot = allocator.derive.rootNodeAttempt({ runId: owner.id, attemptOrdinal: 2 });
      const nextAttempt = allocator.derive.runAttempt({ runId: owner.id, attemptOrdinal: 2 });
      yield* sink.write({
        events: [
          {
            id: EventId.make("a3-parent-initial-ended"),
            type: "run-attempt.updated",
            threadId: parentId,
            occurredAt: createdAt,
            payload: { ...initialAttempt, status: "superseded", completedAt: createdAt },
          },
          {
            id: EventId.make("a3-parent-root-ended"),
            type: "node.updated",
            threadId: parentId,
            occurredAt: createdAt,
            payload: { ...initialRoot, status: "interrupted", completedAt: createdAt },
          },
          {
            id: EventId.make("a3-parent-restarted"),
            type: "run.updated",
            threadId: parentId,
            occurredAt: createdAt,
            payload: {
              ...owner,
              status: "starting",
              rootNodeId: nextRoot,
              activeAttemptId: nextAttempt,
              completedAt: null,
            },
          },
          {
            id: EventId.make("a3-parent-attempt-next"),
            type: "run-attempt.created",
            threadId: parentId,
            occurredAt: createdAt,
            payload: {
              ...initialAttempt,
              id: nextAttempt,
              rootNodeId: nextRoot,
              attemptOrdinal: 2,
              reason: "steering_restart",
              status: "pending",
              startedAt: null,
              completedAt: null,
            },
          },
          {
            id: EventId.make("a3-parent-root-next"),
            type: "node.updated",
            threadId: parentId,
            occurredAt: createdAt,
            payload: {
              ...initialRoot,
              id: nextRoot,
              rootNodeId: nextRoot,
              status: "pending",
              startedAt: null,
              completedAt: null,
            },
          },
        ],
      });
      if (scenario === "parent-owner-restart-wrong-root") {
        yield* sink.write({
          events: [
            {
              id: EventId.make("a3-parent-root-conflict"),
              type: "node.updated",
              threadId: parentId,
              occurredAt: createdAt,
              payload: {
                ...initialRoot,
                runId: RunId.make("run:a3-foreign"),
                status: "interrupted",
                completedAt: createdAt,
              },
            },
          ],
        });
      } else if (scenario === "parent-owner-restart-without-old-attempt") {
        yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE attempt_id = ${initialAttempt.id}`;
      } else if (scenario === "parent-owner-restart-compacted") {
        yield* Effect.gen(function* () {
          yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).compactEventStore();
        }).pipe(Effect.provide(ProjectionMaintenance.layer));
      }
    }
    if (scenario === "missing-task") {
      yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id = ${followupTaskId}`;
    }
    if (scenario.startsWith("wrong-task-") || scenario === "stale-task-display-instance") {
      const task = (yield* store.getThreadRecords(parentId, ["subagents"])).subagents.find(
        (row) => row.id === followupTaskId,
      )!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("a3-conflicting-task"),
            type: "subagent.updated",
            threadId: parentId,
            occurredAt: createdAt,
            payload: {
              ...task,
              ...(scenario === "wrong-task-child"
                ? { childThreadId: ThreadId.make("thread:a3-foreign") }
                : scenario === "wrong-task-owner"
                  ? { runId: activeRun.id }
                  : { providerInstanceId }),
            },
          },
        ],
      });
    }
    if (scenario === "extra-execution-node" || scenario === "started-root") {
      const root = (yield* store.getThreadRecords(childId, ["nodes"])).nodes.find(
        (row) => row.id === queued.rootNodeId,
      )!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("a3-executed-run"),
            type: "run.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: { ...queued, status: "starting", queuePosition: null, startedAt: createdAt },
          },
          {
            id: EventId.make("a3-executed-node"),
            type: "node.updated",
            threadId: childId,
            occurredAt: createdAt,
            payload: {
              ...root,
              id: scenario === "extra-execution-node" ? NodeId.make("node:a3-extra") : root.id,
              startedAt: createdAt,
            },
          },
        ],
      });
    }
    if (scenario === "native-binding") {
      yield* (yield* NativeSessionBindings.NativeSessionBindings).applyProviderThread({
        id: EventId.make("a3-binding"),
        type: "provider-thread.updated",
        threadId: childId,
        occurredAt: createdAt,
        payload: {
          ...pending,
          status: "not_loaded",
          firstRunOrdinal: 3,
          lastRunOrdinal: 3,
          providerSessionId: ProviderSessionId.make("session:a3-started"),
        },
      });
    }
    const separateDelete = scenario === "live-parent" || scenario === "different-operation-root";
    const deleteRoot = separateDelete ? childId : parentId;
    const deletionCommand = {
      type: "thread.delete" as const,
      commandId: CommandId.make("command:a3-delete"),
      threadId: deleteRoot,
    };
    const plan = yield* planThreadLifecycle({
      command: deletionCommand,
      operationRootThreadId: deleteRoot,
      members: yield* Effect.forEach(
        separateDelete ? [childId] : members.map((thread) => thread.id),
        (id) =>
          store.getThreadRecords(id, [
            "runs",
            "attempts",
            "nodes",
            "subagents",
            "runtimeRequests",
            "providerSessions",
            "providerThreads",
            "providerTurns",
            "turnItems",
          ]),
      ),
      bindings: yield* (yield* NativeSessionBindings.NativeSessionBindings).listForThreads([
        parentId,
        childId,
      ]),
      attachmentIdsByThread: new Map(),
      now: deletedAt,
      idAllocator: allocator,
    });
    assert.isNull((yield* store.getThread(childId)).deletedAt);
    assert.isNull((yield* store.getThread(parentId)).deletedAt);
    if (scenario === "missing-provider-origin" || scenario === "corrupt-provider-origin") {
      if (scenario === "missing-provider-origin") {
        yield* sql`UPDATE orchestration_v2_projection_provider_threads
          SET payload_json = json_remove(payload_json, '$.nativeSessionOrigin') WHERE provider_thread_id = ${pending.id}`;
      } else {
        yield* sql`UPDATE orchestration_v2_projection_provider_threads
          SET payload_json = json_set(payload_json, '$.nativeSessionOrigin.version', 2) WHERE provider_thread_id = ${pending.id}`;
      }
    }
    const committed = yield* sink.commitCommand({
      ...plan,
      commandId: deletionCommand.commandId,
      commandType: deletionCommand.type,
      threadId: deleteRoot,
      acceptedAt: deletedAt,
    });
    assert.isTrue(committed.committed);
    const cleanupEffects = [...plan.effects];
    if (scenario === "different-operation-root") {
      const parentCommand = {
        type: "thread.delete" as const,
        commandId: CommandId.make("command:a3-delete-parent"),
        threadId: parentId,
      };
      const parentPlan = yield* planThreadLifecycle({
        command: parentCommand,
        operationRootThreadId: parentId,
        members: [
          yield* store.getThreadRecords(parentId, [
            "runs",
            "attempts",
            "nodes",
            "subagents",
            "runtimeRequests",
            "providerSessions",
            "providerThreads",
            "providerTurns",
            "turnItems",
          ]),
        ],
        bindings: yield* (yield* NativeSessionBindings.NativeSessionBindings).listForThreads([
          parentId,
        ]),
        attachmentIdsByThread: new Map(),
        now: deletedAt,
        idAllocator: allocator,
      });
      assert.isTrue(
        (yield* sink.commitCommand({
          ...parentPlan,
          commandId: parentCommand.commandId,
          commandType: parentCommand.type,
          threadId: parentId,
          acceptedAt: deletedAt,
        })).committed,
      );
      cleanupEffects.push(...parentPlan.effects);
    }
    const first = Option.getOrThrow(yield* records.get(childId));
    const certified = ![
      "native-binding",
      "extra-execution-node",
      "started-root",
      "missing-provider-origin",
      "corrupt-provider-origin",
    ].includes(scenario);
    assert.equal(first.noNativeSessionProofs?.length ?? 0, certified ? 1 : 0);
    if (certified) {
      assert.deepEqual(first.noNativeSessionProofs, [
        {
          providerThreadId: pending.id,
          providerInstanceId: piInstanceId,
          source: "queued_provider_origin",
          version: 1,
        },
      ]);
      assert.deepNestedPropertyVal(
        committed.storedEvents.find(
          (row) => row.event.type === "thread.deleted" && row.event.threadId === childId,
        ),
        "event.deletionRecord.noNativeSessionProofs",
        first.noNativeSessionProofs,
      );
    }
    if (scenario === "late-native-identity") {
      yield* sink.write({
        events: [
          {
            id: EventId.make("a3-late-identity"),
            type: "provider-thread.updated",
            threadId: childId,
            occurredAt: deletedAt,
            payload: {
              ...pending,
              status: "closed",
              providerSessionId: ProviderSessionId.make("session:a3-late"),
              nativeThreadRef: {
                driver: ProviderDriverKind.make("pi"),
                nativeId: "a3-late-native",
                strength: "strong",
              },
            },
          },
        ],
      });
    }
    const cleanupIds = new Set(cleanupEffects.map((effect) => effect.id));
    for (const _effect of cleanupEffects) {
      const claimed = Option.getOrThrow(yield* outbox.claimNext({ workerId: "a3-cleanup" }));
      assert.isTrue(cleanupIds.delete(claimed.id));
      assert.isTrue(yield* outbox.succeed({ effectId: claimed.id, workerId: "a3-cleanup" }));
    }
    assert.isEmpty(cleanupIds);
    const bounds = {
      eventThroughSequence: Number.MAX_SAFE_INTEGER,
      receiptThroughRowId: Number.MAX_SAFE_INTEGER,
    };
    const reclaimer = yield* ThreadDataReclamation.ThreadDataReclamation;
    const beforeReclamation = yield* readReclaimableRows;
    if (scenario === "cross-batch-parent-first-failure") {
      yield* sql`
        CREATE TRIGGER reject_a3_child_batch BEFORE DELETE ON orchestration_v2_projection_runs
        WHEN OLD.thread_id = 'thread:a3-zchild'
        BEGIN SELECT RAISE(ABORT, 'injected A3 final-chunk failure'); END
      `;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(reclaimer.reclaim(bounds))));
      assert.deepEqual(yield* readReclaimableRows, beforeReclamation);
      yield* sql`DROP TRIGGER reject_a3_child_batch`;
    }
    const lateBarrier =
      scenario === "cross-batch-parent-first-late-binding" ||
      scenario === "cross-batch-parent-first-claimed-start";
    let injected = false;
    let expectedRetainedRows = beforeReclamation;
    let reclaimEffect = Effect.gen(function* () {
      return yield* (yield* ThreadDataReclamation.ThreadDataReclamation).reclaim(bounds);
    });
    if (lateBarrier) {
      const withTransaction: typeof sql.withTransaction = (effect) =>
        Effect.gen(function* () {
          if (!injected) {
            injected = true;
            assert.deepEqual(
              yield* readReclaimableRows.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              beforeReclamation,
            );
            const barrierAt = "2026-09-04T00:00:00.000Z";
            if (scenario === "cross-batch-parent-first-late-binding") {
              yield* sql`
                INSERT INTO orchestration_v2_native_session_bindings (
                  binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
                  native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
                ) VALUES ('a3:late-binding', ${childId}, ${pending.id}, ${piInstanceId}, 'pi',
                  NULL, 'unresolved', '', '', ${barrierAt}, '{}')
              `;
            } else {
              yield* sql`
                INSERT INTO orchestration_v2_effect_outbox (
                  effect_id, command_id, thread_id, effect_type, payload_json, status,
                  attempt_count, available_at, created_at, updated_at
                ) VALUES ('a3:claimed-start', 'a3:claimed-start-command', ${childId}, 'provider-turn.start',
                  ${JSON.stringify({ runId: queuedId })}, 'cancelled', 1, ${barrierAt}, ${barrierAt}, ${barrierAt})
              `;
            }
            expectedRetainedRows = yield* readReclaimableRows.pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            );
          }
          return yield* sql.withTransaction(effect);
        });
      const intercepted = new Proxy(sql, {
        get(target, key, receiver) {
          return key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver);
        },
      });
      reclaimEffect = reclaimEffect.pipe(
        Effect.provide(
          Layer.fresh(
            ThreadDataReclamation.layer.pipe(
              Layer.provide(Layer.succeed(SqlClient.SqlClient, intercepted)),
            ),
          ),
        ),
      );
    }
    const summary = yield* reclaimEffect;
    const allowed =
      [
        "same-root-pending",
        "same-root-held",
        "same-root-original-queued-pi",
        "cross-batch-parent-reference",
        "cross-batch-parent-first",
        "cross-batch-parent-first-failure",
        "cross-batch-parent-first-child-provider-restart",
        "cross-batch-parent-first-child-instance-resume",
        "cross-batch-parent-first-child-terminal-switch",
        "parent-owner-restart",
        "parent-owner-restart-compacted",
        "parent-owner-restart-without-old-attempt",
        "cross-batch-parent-first-child-restart-without-run-history",
        "cross-batch-parent-first-child-resume-stale-display-instance",
        "cross-batch-parent-first-without-spawn",
        "stale-task-display-instance",
      ].includes(scenario) || scenario.includes("reuse");
    assert.equal(summary.reclaimedThreadCount, allowed ? members.length : 0);
    if (allowed) {
      assert.isEmpty(summary.skippedThreads);
      assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_nodes`);
      assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_subagents`);
      assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_runs`);
      assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_provider_threads`);
      for (const { table, rows } of yield* readReclaimableRows) assert.isEmpty(rows, table);
      assert.equal(
        (yield* (yield* ThreadDataReclamation.ThreadDataReclamation).reclaim(bounds))
          .deletedProjectionRowCount,
        0,
      );
    } else {
      if (lateBarrier) {
        assert.isTrue(injected);
        assert.lengthOf(
          yield* sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id = ${childId}`,
          3,
        );
      }
      assert.deepEqual(yield* readReclaimableRows, expectedRetainedRows);
      assert.isTrue(summary.skippedThreads.some((row) => row.threadId === childId));
      assert.lengthOf(
        yield* sql`SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${pending.id}`,
        1,
      );
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(ThreadLifecyclePlan.layer, EventSink.layerFromStores).pipe(
        Layer.provideMerge(ThreadOwnership.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            ProjectionStore.layer,
            EventStore.layer,
            IdAllocator.layer,
            EffectOutbox.layer,
            CommandReceiptStore.layer,
            ProjectStore.layer,
            TurnItemPositionStore.layer,
            ThreadDeletionRecords.layer,
            ThreadDataReclamation.layer,
            NativeSessionBindings.layer,
          ),
        ),
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);
