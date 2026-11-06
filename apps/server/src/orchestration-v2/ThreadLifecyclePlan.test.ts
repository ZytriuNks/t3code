import { assert, it } from "@effect/vitest";
import {
  CommandId,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import { applyToProjection, emptyProjection } from "./ProjectionStore.ts";
import * as NativeSessionBindings from "./NativeSessionBindings.ts";
import * as ThreadDataReclamation from "./ThreadDataReclamation.ts";
import * as ThreadDeletionRecords from "./ThreadDeletionRecords.ts";
import * as ThreadLifecyclePlan from "./ThreadLifecyclePlan.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";

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
