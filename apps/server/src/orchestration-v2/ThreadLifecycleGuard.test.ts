import { assert, it } from "@effect/vitest";
import {
  EventId,
  CommandId,
  MessageId,
  RunId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderDriverKind,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  RunAttemptId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ThreadDeletionRecords from "./ThreadDeletionRecords.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventStore from "./EventStore.ts";
import * as EventSink from "./EventSink.ts";
import * as ThreadLifecycleGuard from "./ThreadLifecycleGuard.ts";

const R = ThreadId.make("R");
const A = ThreadId.make("A");
const B = ThreadId.make("B");
const F = ThreadId.make("F");
const projectId = ProjectId.make("project:ownership");
const now = DateTime.makeUnsafe("2026-10-26T00:00:00Z");
const instanceId = ProviderInstanceId.make("codex");

function thread(
  id: ThreadId,
  parentThreadId: ThreadId | null = null,
  relationshipToParent: "subagent" | "fork" | null = null,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    id,
    projectId,
    title: id,
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId, relationshipToParent, rootThreadId: R },
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
}

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
  Layer.provide(database),
);
const layerTest = Layer.mergeAll(
  stores,
  database,
  ThreadDeletionRecords.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ThreadLifecycleGuard.layer.pipe(Layer.provide(database)),
  EventSink.layer.pipe(Layer.provide(Layer.merge(stores, database))),
);
const seed = Effect.fn("test.seedLifecycle")(function* (payload: OrchestrationV2AppThread) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`created:${payload.id}`),
    type: "thread.created",
    threadId: payload.id,
    occurredAt: now,
    payload,
  });
});
it.effect(
  "lifecycle rechecks both roots of a secondary branch write in its commit transaction",
  () =>
    Effect.gen(function* () {
      yield* seed(thread(R));
      yield* seed(thread(F));
      const guards = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const source = yield* guards.resolveLifecycleSource(R);
      const target = yield* guards.resolveLifecycleSource(F);
      const captured = { ...target, prerequisites: [source] };
      const commit = Effect.fn("test.commitSecondaryBranch")(function* (phase: string) {
        return yield* sink.commitCommand({
          lifecycleGuard: captured,
          commandId: CommandId.make(`secondary:${phase}`),
          threadId: F,
          commandType: "thread.metadata.update",
          acceptedAt: now,
          events: [
            {
              id: EventId.make(`secondary:${phase}`),
              type: "thread.metadata-updated",
              threadId: F,
              occurredAt: now,
              payload: thread(F, null, null, { branch: phase }),
            },
          ],
          effects: [],
        });
      });
      assert.isTrue((yield* commit("fresh")).committed);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const late = yield* Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(commit("late").pipe(Effect.result)),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* seed(thread(R, null, null, { lifecycleRevision: 1, archivedAt: now }));
      yield* seed(thread(R, null, null, { lifecycleRevision: 2 }));
      assert.equal(yield* guards.check({ guard: target, purpose: "activity" }), "accept");
      yield* Deferred.succeed(release, undefined);
      const rejected = yield* Fiber.join(late);
      assert.isTrue(Result.isFailure(rejected));
      if (Result.isFailure(rejected)) assert.equal(rejected.failure._tag, "EventSinkWriteError");
      assert.isEmpty(
        yield* sink
          .readByCommandId({ commandId: CommandId.make("secondary:late") })
          .pipe(Stream.runCollect),
      );
      assert.equal((yield* store.getThreadShell(F))?.branch, "fresh");
    }).pipe(Effect.provide(layerTest)),
);
it.effect("lifecycle fails closed for an attempt without its run identity", () =>
  Effect.gen(function* () {
    yield* seed(thread(R));
    const guard = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
    assert.equal(
      yield* guard.check({
        guard: {
          threadId: R,
          lifecycleRevision: 0,
          attemptId: RunAttemptId.make("unknown-attempt"),
        },
        purpose: "activity",
      }),
      "stale",
    );
  }).pipe(Effect.provide(layerTest)),
);
it.effect(
  "lifecycle rejects old revisions after archive and immediate restore using small metadata",
  () =>
    Effect.gen(function* () {
      const guard = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
      yield* seed(thread(R));
      assert.equal(
        yield* guard.check({ guard: { threadId: R, lifecycleRevision: 0 }, purpose: "activity" }),
        "accept",
      );
      yield* seed(thread(R, null, null, { lifecycleRevision: 2 }));
      assert.equal(
        yield* guard.check({ guard: { threadId: R, lifecycleRevision: 0 }, purpose: "activity" }),
        "stale",
      );
      assert.equal(
        yield* guard.check({ guard: yield* guard.resolveLifecycleSource(R), purpose: "activity" }),
        "accept",
      );
    }).pipe(Effect.provide(layerTest)),
);
it.effect("lifecycle validates the complete subagent chain but forks remain independent", () =>
  Effect.gen(function* () {
    const guard = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
    yield* seed(thread(R, null, null, { archivedAt: now }));
    yield* seed(thread(A, R, "subagent"));
    yield* seed(thread(B, A, "subagent"));
    yield* seed(thread(F, R, "fork"));
    assert.equal(
      yield* guard.check({ guard: { threadId: B, lifecycleRevision: 0 }, purpose: "activity" }),
      "stale",
    );
    assert.equal(
      yield* guard.check({ guard: { threadId: F, lifecycleRevision: 0 }, purpose: "activity" }),
      "accept",
    );
    yield* seed(thread(R));
    yield* seed(thread(A, R, "subagent", { projectId: ProjectId.make("other") }));
    assert.equal(
      yield* guard.check({ guard: { threadId: B, lifecycleRevision: 0 }, purpose: "activity" }),
      "stale",
    );
    yield* seed(thread(A, B, "subagent"));
    assert.equal(
      yield* guard.check({ guard: { threadId: B, lifecycleRevision: 0 }, purpose: "activity" }),
      "stale",
    );
    yield* seed(thread(A, ThreadId.make("missing"), "subagent"));
    assert.equal(
      yield* guard.check({ guard: { threadId: B, lifecycleRevision: 0 }, purpose: "activity" }),
      "stale",
    );
  }).pipe(Effect.provide(layerTest)),
);
it.effect("lifecycle metadata updates cannot erase a newer lifecycle snapshot", () =>
  Effect.gen(function* () {
    yield* seed(thread(R, null, null, { lifecycleRevision: 2 }));
    const sink = yield* EventSink.EventSinkV2;
    const guards = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
    yield* sink.write({
      lifecycleGuard: yield* guards.resolveLifecycleSource(R),
      events: [
        {
          id: EventId.make("late-metadata"),
          threadId: R,
          occurredAt: now,
          type: "thread.metadata-updated",
          payload: thread(R, null, null, { branch: "generated" }),
        },
      ],
    });
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const result = yield* store.getThreadShell(R);
    assert.equal(result?.lifecycleRevision, 2);
    assert.equal(result?.branch, "generated");
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle persists complete owner provenance across guard restart and fork isolation",
  () =>
    Effect.gen(function* () {
      const guards = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
      yield* seed(thread(R));
      yield* seed(thread(A, R, "subagent"));
      yield* seed(thread(F, R, "fork"));
      const old = yield* guards.resolveLifecycleSource(A);
      const fork = yield* guards.resolveLifecycleSource(F);
      assert.match(old.sourceToken, /^[0-9a-f]{64}$/);
      yield* seed(thread(R, null, null, { lifecycleRevision: 2 }));
      const fresh = yield* guards.resolveLifecycleSource(A);
      assert.equal(fresh.lifecycleRevision, 0);
      assert.notEqual(old.sourceToken, fresh.sourceToken);
      assert.deepEqual(yield* guards.resolveLifecycleSource(F), fork);
      const check = Effect.gen(function* () {
        const restarted = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
        for (const [guard, expected] of [
          [old, "stale"],
          [fresh, "accept"],
          [{ threadId: A, lifecycleRevision: 0 }, "stale"],
          [fork, "accept"],
        ] as const)
          assert.equal(yield* restarted.check({ guard, purpose: "activity" }), expected);
      });
      yield* check.pipe(Effect.provide(Layer.fresh(ThreadLifecycleGuard.layer)));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle checks persisted queued run, attempt and exact provider session identities",
  () =>
    Effect.gen(function* () {
      const guards = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const sink = yield* EventSink.EventSinkV2;
      yield* seed(thread(R));
      yield* seed(thread(A, R, "subagent"));
      const old = yield* guards.resolveLifecycleSource(A);
      const runId = RunId.make("run:identity"),
        attemptId = RunAttemptId.make("attempt:identity"),
        ptId = ProviderThreadId.make("pt:identity");
      const sessionId = ProviderSessionId.make("session:identity");
      const run: OrchestrationV2Run = {
        id: runId,
        threadId: A,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: thread(A).modelSelection,
        providerThreadId: ptId,
        userMessageId: MessageId.make("message:identity"),
        rootNodeId: null,
        activeAttemptId: attemptId,
        lifecycleRevision: old.lifecycleRevision,
        lifecycleSourceToken: old.sourceToken,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* store.apply({
        id: EventId.make("run:identity"),
        type: "run.created",
        threadId: A,
        occurredAt: now,
        payload: run,
      });
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
      (attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json)
      VALUES (${attemptId},${A},${runId},1,'node:identity',${instanceId},${ptId},'queued','{}')`;
      const provider: OrchestrationV2ProviderThread = {
        id: ptId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        appThreadId: A,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeStorage: { type: "unresolved", reason: "legacy_missing_locator" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: null,
        nativeMetadata: null,
        goal: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* store.apply({
        id: EventId.make("pt:identity"),
        type: "provider-thread.updated",
        threadId: A,
        occurredAt: now,
        payload: provider,
      });
      const guard = {
        ...ThreadLifecycleGuard.guardForRun(run),
        attemptId,
        providerSessionId: sessionId,
      };
      const verifyWrites = Effect.fn("test.lifecycleCommitBranches")(function* (
        phase: "fresh" | "stale",
      ) {
        const events = [
          {
            id: EventId.make(`commit:${phase}`),
            type: "thread.metadata-updated" as const,
            threadId: A,
            occurredAt: now,
            payload: { ...thread(A, R, "subagent"), title: phase },
          },
        ];
        const expected = (yield* store.getThreadRecords(A, ["providerThreads"]))
          .providerThreads[0]!;
        const counts = [
          (yield* sink.write({ lifecycleGuard: guard, events })).length,
          (yield* sink.writeWithEffects({
            lifecycleGuard: guard,
            events: events.map((event) => ({ ...event, id: EventId.make(`effects:${phase}`) })),
            effects: [],
          })).length,
          (yield* sink.writeIfRunCurrent({
            lifecycleGuard: guard,
            threadId: A,
            runId,
            activeAttemptId: attemptId,
            expectedStatus: "queued",
            events: events.map((event) => ({ ...event, id: EventId.make(`run:${phase}`) })),
            effects: [],
          })).storedEvents.length,
          (yield* sink.writeIfProviderThreadOwner({
            lifecycleGuard: guard,
            providerThreadId: ptId,
            runId,
            activeAttemptId: attemptId,
            expectedLastRunOrdinal: 1,
            events: events.map((event) => ({ ...event, id: EventId.make(`owner:${phase}`) })),
          })).storedEvents.length,
          (yield* sink.writeIfProviderThreadUnchanged({
            lifecycleGuard: guard,
            expected,
            events: events.map((event) => ({ ...event, id: EventId.make(`unchanged:${phase}`) })),
          })).storedEvents.length,
        ];
        assert.deepEqual(counts, Array(5).fill(phase === "fresh" ? 1 : 0));
      });
      yield* verifyWrites("fresh");
      assert.equal(yield* guards.check({ guard, purpose: "activity" }), "accept");
      for (const invalid of [
        { ...guard, runId: RunId.make("missing") },
        { ...guard, attemptId: RunAttemptId.make("missing") },
        { ...guard, providerSessionId: ProviderSessionId.make("other") },
      ])
        assert.equal(yield* guards.check({ guard: invalid, purpose: "activity" }), "stale");
      yield* seed(thread(R, null, null, { lifecycleRevision: 2 }));
      assert.equal(yield* guards.check({ guard, purpose: "activity" }), "stale");
      yield* verifyWrites("stale");
      const fresh = yield* guards.resolveLifecycleSource(A);
      // A receiver cannot refresh a persisted old run merely by supplying the current token.
      assert.equal(
        yield* guards.check({ guard: { ...guard, ...fresh }, purpose: "activity" }),
        "stale",
      );
      for (const token of [undefined, fresh.sourceToken]) {
        yield* store.apply({
          id: EventId.make(`run:updated:${String(token)}`),
          type: "run.updated",
          threadId: A,
          occurredAt: now,
          payload: { ...run, lifecycleSourceToken: token },
        });
        assert.equal(
          yield* guards.check({
            guard: { ...guard, ...fresh, sourceToken: token },
            purpose: "activity",
          }),
          token === undefined ? "stale" : "accept",
        );
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle deletion records reject recreation while internal creation retry remains valid",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const guards = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
      const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      yield* seed(thread(R));
      const old = yield* guards.resolveLifecycleSource(R);
      yield* records.apply({
        threadId: R,
        projectId,
        parentThreadId: null,
        operationRootThreadId: R,
        deletedAt: DateTime.formatIso(now),
        commandId: CommandId.make("deleted"),
        scope: "t3_only",
        sessions: [],
      });
      assert.equal(yield* guards.check({ guard: old, purpose: "activity" }), "stale");
      const create = (id: ThreadId) =>
        sink.write({
          events: [
            {
              id: EventId.make(`retry:${id}`),
              type: "thread.created",
              threadId: id,
              occurredAt: now,
              payload: thread(id),
            },
          ],
        });
      assert.equal((yield* create(R)).length, 0);
      assert.equal((yield* create(B)).length, 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle terminal cleanup preserves current metadata and refuses live writes or new effects",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const guards = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* seed(thread(R));
      const old = yield* guards.resolveLifecycleSource(R);
      const session = {
        id: ProviderSessionId.make("cleanup:session"),
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        status: "ready" as const,
        capabilities: CodexProviderCapabilitiesV2,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        model: "fixture-model",
        cwd: "/current",
        createdAt: now,
        startedAt: now,
        updatedAt: now,
        lastError: null,
      };
      const event = {
        id: EventId.make("cleanup:session"),
        type: "provider-session.updated" as const,
        threadId: R,
        occurredAt: now,
        payload: session,
      };
      yield* sink.write({ events: [{ ...event, type: "provider-session.attached" }] });
      const provider: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("cleanup:pt"),
        driver: session.driver,
        providerInstanceId: instanceId,
        providerSessionId: session.id,
        appThreadId: R,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      yield* store.apply({
        id: EventId.make("cleanup:pt"),
        type: "provider-thread.updated",
        threadId: R,
        occurredAt: now,
        payload: provider,
      });
      yield* seed(thread(R, null, null, { lifecycleRevision: 2 }));
      assert.equal(
        (yield* sink.write({
          lifecycleGuard: old,
          lifecyclePurpose: "terminal_cleanup",
          events: [
            {
              ...event,
              id: EventId.make("cleanup:stopped"),
              payload: { ...session, status: "stopped", cwd: "/obsolete" },
            },
          ],
        })).length,
        1,
      );
      assert.equal(
        (yield* store.getThreadRecords(R, ["providerSessions"])).providerSessions[0]?.cwd,
        "/current",
      );
      assert.equal(
        (yield* sink.write({
          lifecycleGuard: old,
          lifecyclePurpose: "terminal_cleanup",
          events: [{ ...event, id: EventId.make("cleanup:live") }],
        })).length,
        0,
      );
      const commandId = CommandId.make("cleanup:wakeup");
      assert.equal(
        (yield* sink.writeWithEffects({
          lifecycleGuard: old,
          lifecyclePurpose: "terminal_cleanup",
          events: [],
          effects: [
            {
              id: "cleanup:wakeup",
              commandId,
              threadId: R,
              request: { type: "provider-runtime.continue", sourceRunId: RunId.make("old") },
            },
          ],
        })).length,
        0,
      );
      assert.equal((yield* outbox.listByCommandId(commandId)).length, 0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle retirement receipts survive service reconstruction, process loss and pruning",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const session = ProviderSessionId.make("retirement:restart");
      const commandId = CommandId.make("retirement:restart");
      yield* outbox.enqueue([
        {
          id: "retirement:restart",
          commandId,
          threadId: R,
          request: {
            type: "provider-session.detach",
            providerSessionId: session,
            retirementRevision: 0,
            retirementSourceToken: "captured-token",
          },
        },
      ]);
      assert.equal((yield* outbox.attachmentRetirements(R))[0]?.status, "pending");
      yield* outbox.claimNext({ workerId: "lost-worker", leaseDurationMs: 1000 });
      const restarted = yield* EffectOutbox.EffectOutboxV2.pipe(
        Effect.provide(Layer.fresh(EffectOutbox.layer)),
      );
      assert.equal((yield* restarted.attachmentRetirements(R))[0]?.status, "running");
      yield* restarted.reconcileAfterProcessLoss;
      assert.equal((yield* restarted.attachmentRetirements(R))[0]?.status, "pending");
      yield* restarted.claimNext({ workerId: "new-worker", leaseDurationMs: 1000 });
      yield* restarted.fail({
        effectId: "retirement:restart",
        workerId: "new-worker",
        error: "Exact attachment unavailable.",
      });
      assert.equal((yield* outbox.attachmentRetirements(R))[0]?.status, "failed");
      const old = DateTime.formatIso(
        DateTime.subtractDuration(yield* DateTime.now, Duration.days(30)),
      );
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status='succeeded',completed_at=${old} WHERE effect_id='retirement:restart'`;
      yield* restarted.pruneSettled;
      assert.deepEqual(
        (yield* outbox.attachmentRetirements(R)).map((receipt) => ({
          status: receipt.status,
          token: receipt.retirementSourceToken,
        })),
        [{ status: "succeeded", token: "captured-token" }],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("lifecycle child result writes retain their child source while targeting the owner", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const guard = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* seed(thread(R));
    yield* seed(thread(A, R, "subagent"));
    yield* seed(thread(B));
    const source = yield* guard.resolveLifecycleSource(A);
    const event = {
      id: EventId.make("child:result"),
      type: "thread.metadata-updated" as const,
      threadId: R,
      occurredAt: now,
      payload: { ...thread(R), title: "child result" },
    };
    assert.lengthOf(yield* sink.write({ lifecycleGuard: source, events: [event] }), 1);
    assert.equal((yield* store.getThread(R)).title, "child result");
    assert.isEmpty(
      yield* sink.write({
        lifecycleGuard: source,
        events: [
          { ...event, id: EventId.make("child:other-root"), threadId: B, payload: thread(B) },
        ],
      }),
    );
    yield* seed(thread(R, null, null, { lifecycleRevision: 2 }));
    assert.isEmpty(
      yield* sink.write({
        lifecycleGuard: source,
        events: [{ ...event, id: EventId.make("child:old-result") }],
      }),
    );
    assert.equal((yield* store.getThread(R)).title, "R");
  }).pipe(Effect.provide(layerTest)),
);
