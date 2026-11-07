import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
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
import * as EffectWorker from "./EffectWorker.ts";

const R = ThreadId.make("task6:R");
const F = ThreadId.make("task6:F");
const commandId = CommandId.make("task6:archive");
const lifecycle = { commandId, rootThreadId: R, revision: 1 };
const layerTest = EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.effect.each([
  "provider-turn.start",
  "provider-turn.restart",
  "provider-runtime.continue",
] as const)(
  "Pi claim %s rejects an uncommitted gate and rolls back its lease and attempt",
  (type) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const providerId = ProviderThreadId.make("provider:claim-gate");
      const runId = RunId.make("run:claim-gate");
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id, provider_session_id,
       status, first_run_ordinal, last_run_ordinal, updated_at, payload_json)
      VALUES (${providerId}, ${R}, NULL, 'pi', 'pi', 'pi', NULL, 'not_loaded', NULL, NULL, '2026-11-06',
        '{"nativeSessionOrigin":{"version":1,"state":"unstarted"}}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES (${runId}, ${R}, 1, 'pi', 'pi', ${providerId}, 'queued', '2026-11-06', NULL, '{}')`;
      yield* outbox.enqueue([
        {
          id: "gated-start",
          commandId,
          threadId: R,
          request:
            type === "provider-runtime.continue"
              ? { type, sourceRunId: runId }
              : type === "provider-turn.restart"
                ? {
                    type,
                    runId,
                    providerSessionId: ProviderSessionId.make("session:source"),
                    providerThreadId: providerId,
                    providerTurnId: ProviderTurnId.make("turn:source"),
                    interruptedAttemptId: RunAttemptId.make("attempt:source"),
                  }
                : { type, runId },
        },
      ]);
      const rejected = yield* Effect.result(outbox.claimNext({ workerId: "gate-worker" }));
      assert.equal(rejected._tag, "Failure");
      if (rejected._tag === "Failure") assert.equal(rejected.failure._tag, "EffectOutboxError");
      const pending = Option.getOrThrow(yield* outbox.get("gated-start"));
      assert.equal(pending.status, "pending");
      assert.equal(pending.attemptCount, 0);
      assert.isNull(pending.leaseOwner);
      const rollback = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE orchestration_v2_projection_provider_threads SET first_run_ordinal = 1,
        payload_json = json_set(payload_json, '$.nativeSessionOrigin.state', 'may_exist') WHERE provider_thread_id = ${providerId}`;
            yield* outbox.claimNext({ workerId: "gate-worker" });
            return yield* Effect.fail("injected gate transaction rollback");
          }),
        )
        .pipe(Effect.result);
      assert.equal(rollback._tag, "Failure");
      assert.equal(Option.getOrThrow(yield* outbox.get("gated-start")).attemptCount, 0);
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET first_run_ordinal = 1,
      payload_json = json_set(payload_json, '$.nativeSessionOrigin.state', 'may_exist') WHERE provider_thread_id = ${providerId}`;
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId: "gate-worker" })).id,
        "gated-start",
      );
      yield* outbox.cancelUnsettled({
        threadId: R,
        effectTypes: [type],
        reason: "fixture deletion",
      });
      yield* TestClock.adjust("8 days");
      assert.equal(yield* outbox.pruneSettled, 1);
      assert.isTrue(Option.isNone(yield* outbox.get("gated-start")));
      const rows = yield* sql<{
        readonly state: string;
      }>`SELECT json_extract(payload_json, '$.nativeSessionOrigin.state') AS state
      FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${providerId}`;
      assert.equal(rows[0]?.state, "may_exist");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  {
    type: "resolved",
    canonicalRoot: "/isolated/sessions",
    canonicalFile: "/isolated/sessions/test.jsonl",
  },
  { type: "unresolved", reason: "legacy_missing_locator" },
] as const)(
  "Pi delete $type round-trips, remains cleanup, and recovers after process loss",
  (nativeStorage) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const request = {
        type: "provider-thread.delete" as const,
        driver: "pi" as const,
        providerInstanceId: ProviderInstanceId.make("pi-original"),
        providerThreadId: ProviderThreadId.make("pi-thread"),
        threadIds: [R],
        nativeId: nativeStorage.type === "resolved" ? "native-id" : null,
        nativeStorage,
        lifecycle: { ...lifecycle, sourceToken: "persisted-source" },
      };
      yield* outbox.enqueue([{ id: "pi-delete", commandId, threadId: R, request }]);
      assert.deepEqual(Option.getOrThrow(yield* outbox.get("pi-delete")).request, request);
      assert.lengthOf(yield* outbox.listLifecycleCleanup([R]), 1);
      yield* outbox.claimNext({ workerId: "old" });
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
      const recovered = Option.getOrThrow(yield* outbox.get("pi-delete"));
      assert.equal(recovered.status, "pending");
      assert.equal(recovered.attemptCount, 1);
      assert.deepEqual(recovered.request, request);
      yield* outbox.claimNext({ workerId: "new" });
      yield* outbox.fail({ effectId: "pi-delete", workerId: "new", error: "blocked" });
      yield* TestClock.adjust("8 days");
      assert.equal(yield* outbox.pruneSettled, 0);
      assert.equal((yield* outbox.listLifecycleCleanup([R]))[0]?.status, "failed");
    }).pipe(Effect.provide(layerTest)),
);

const legacyReceipt = Effect.fn("test.legacyArchiveReceipt")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO orchestration_command_receipts
    (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
    VALUES ('task6:legacy', 'thread', ${R}, 'thread.archive', ${now}, 0, 'accepted', NULL)`;
});

it.effect("retains native delete completion proof beside cancelled lifecycle work", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const request = {
      type: "provider-thread.delete" as const,
      driver: "pi" as const,
      providerInstanceId: ProviderInstanceId.make("pi-original"),
      providerThreadId: ProviderThreadId.make("pi-thread"),
      threadIds: [R],
      nativeId: "native-id",
      nativeStorage: {
        type: "resolved" as const,
        canonicalRoot: "/isolated/sessions",
        canonicalFile: "/isolated/sessions/test.jsonl",
      },
      lifecycle: { ...lifecycle, sourceToken: "persisted-source" },
    };
    yield* outbox.enqueue([{ id: "cancelled-delete", commandId, threadId: R, request }]);
    yield* outbox.cancelUnsettled({
      threadId: R,
      effectTypes: ["provider-thread.delete"],
      reason: "replacement cleanup",
    });
    yield* outbox.enqueue([
      { id: "completed-delete", commandId, threadId: R, request },
      { id: "ordinary", commandId, threadId: R, request: { type: "terminal.cleanup" } },
    ]);
    for (const id of ["completed-delete", "ordinary"]) {
      assert.equal(Option.getOrThrow(yield* outbox.claimNext({ workerId: "worker" })).id, id);
      yield* outbox.succeed({ effectId: id, workerId: "worker" });
    }
    yield* TestClock.adjust("8 days");

    assert.equal(yield* outbox.pruneSettled, 1);
    assert.equal(Option.getOrThrow(yield* outbox.get("cancelled-delete")).status, "cancelled");
    assert.equal(Option.getOrThrow(yield* outbox.get("completed-delete")).status, "succeeded");
    assert.isTrue(Option.isNone(yield* outbox.get("ordinary")));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("start claims without a provider binding retain the legacy fake behavior", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    yield* outbox.enqueue([
      {
        id: "unbound-start",
        commandId,
        threadId: R,
        request: { type: "provider-turn.start", runId: RunId.make("run:unbound-fake") },
      },
    ]);
    assert.equal(
      Option.getOrThrow(yield* outbox.claimNext({ workerId: "unbound-worker" })).id,
      "unbound-start",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "none",
  "exact",
  "other-file",
  "other-native",
  "other-source",
  "other-revision",
  "other-target",
] as const)(
  "prunes unneeded and redundant Pi success proofs while retaining an exact dependency (%s)",
  (dependency) =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const request = {
        type: "provider-thread.delete" as const,
        driver: "pi" as const,
        providerInstanceId: ProviderInstanceId.make("pi-original"),
        providerThreadId: ProviderThreadId.make("pi-thread"),
        threadIds: [R],
        nativeId: null,
        nativeStorage: {
          type: "resolved" as const,
          canonicalRoot: "/isolated/sessions",
          canonicalFile: "/isolated/sessions/test.jsonl",
        },
        lifecycle: { ...lifecycle, sourceToken: "persisted-source" },
      };
      if (dependency !== "none") {
        yield* outbox.enqueue([{ id: "cancelled-proof", commandId, threadId: R, request }]);
        yield* outbox.cancelUnsettled({
          threadId: R,
          effectTypes: ["provider-thread.delete"],
          reason: "replacement",
        });
      }
      for (let index = 0; index < 3; index++) {
        const replacementCommand = CommandId.make(`replacement:${index}`);
        const id = `success-proof:${index}`;
        yield* outbox.enqueue([
          {
            id,
            commandId: replacementCommand,
            threadId: R,
            request: {
              ...request,
              threadIds: dependency === "other-target" ? [F] : [R],
              nativeId: dependency === "other-native" ? "other-native" : null,
              nativeStorage: {
                ...request.nativeStorage,
                canonicalFile:
                  dependency === "other-file"
                    ? "/isolated/sessions/other.jsonl"
                    : request.nativeStorage.canonicalFile,
              },
              lifecycle: {
                ...request.lifecycle,
                commandId: replacementCommand,
                revision: dependency === "other-revision" ? 2 : 1,
                sourceToken: dependency === "other-source" ? "other-source" : "persisted-source",
              },
            },
          },
        ]);
        assert.equal(
          Option.getOrThrow(yield* outbox.claimNext({ workerId: "proof-worker" })).id,
          id,
        );
        yield* outbox.succeed({ effectId: id, workerId: "proof-worker" });
      }
      yield* TestClock.adjust("8 days");
      assert.equal(yield* outbox.pruneSettled, dependency === "exact" ? 2 : 3);
      for (let index = 0; index < 3; index++) {
        assert.equal(
          Option.isSome(yield* outbox.get(`success-proof:${index}`)),
          dependency === "exact" && index === 0,
        );
      }
      if (dependency !== "none")
        assert.equal(Option.getOrThrow(yield* outbox.get("cancelled-proof")).status, "cancelled");
      yield* TestClock.adjust("365 days");
      assert.equal(yield* outbox.pruneSettled, 0);
      if (dependency === "exact")
        assert.isTrue(Option.isSome(yield* outbox.get("success-proof:0")));
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle cleanup query is thread scoped and distinguishes model-switch detach from legacy archive",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* legacyReceipt();
      yield* outbox.enqueue([
        { id: "marked", commandId, threadId: R, request: { type: "terminal.cleanup", lifecycle } },
        {
          id: "legacy",
          commandId: CommandId.make("task6:legacy"),
          threadId: R,
          request: { type: "preview.cleanup" },
        },
        {
          id: "ordinary",
          commandId: CommandId.make("task6:switch"),
          threadId: R,
          request: {
            type: "provider-session.detach",
            providerSessionId: ProviderSessionId.make("shared"),
          },
        },
        {
          id: "outside",
          commandId,
          threadId: F,
          request: { type: "scheduled-tasks.suspend", lifecycle },
        },
      ]);
      assert.deepEqual(
        (yield* outbox.listLifecycleCleanup([R])).map((effect) => effect.id).sort(),
        ["legacy", "marked"],
      );
      assert.deepEqual(yield* outbox.listLifecycleCleanup([]), []);
      for (let count = 0; count < 4; count++) yield* outbox.claimNext({ workerId: "task6:worker" });
      assert.isTrue(
        (yield* outbox.listLifecycleCleanup([R])).some((effect) => effect.status === "running"),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("attachment retirement query returns exact lifecycle receipt provenance", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const providerSessionId = ProviderSessionId.make("retirement-provenance");
    yield* outbox.enqueue([
      {
        id: "retirement-provenance",
        commandId,
        threadId: R,
        request: {
          type: "provider-session.detach",
          providerSessionId,
          retirementRevision: 3,
          retirementSourceToken: "retirement-source",
          lifecycle,
        },
      },
    ]);
    assert.deepEqual(yield* outbox.attachmentRetirements(R), [
      {
        effectId: "retirement-provenance",
        commandId,
        threadId: R,
        status: "pending",
        providerSessionId,
        retirementRevision: 3,
        retirementSourceToken: "retirement-source",
        lifecycleCommandId: commandId,
        lifecycleRootThreadId: R,
      },
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle prune preserves exact and legacy detach receipts plus cancelled cleanup barriers",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* legacyReceipt();
      const detach = {
        type: "provider-session.detach" as const,
        providerSessionId: ProviderSessionId.make("shared"),
      };
      yield* outbox.enqueue([
        {
          id: "exact",
          commandId,
          threadId: R,
          request: { ...detach, retirementRevision: 0, retirementSourceToken: "fixture-source" },
        },
        { id: "lifecycle", commandId, threadId: R, request: { ...detach, lifecycle } },
        {
          id: "legacy-detach",
          commandId: CommandId.make("task6:legacy"),
          threadId: R,
          request: detach,
        },
        { id: "ordinary", commandId: CommandId.make("task6:switch"), threadId: R, request: detach },
        {
          id: "cancelled",
          commandId,
          threadId: R,
          request: { type: "terminal.cleanup", lifecycle },
        },
        {
          id: "legacy-cancelled",
          commandId: CommandId.make("task6:legacy"),
          threadId: R,
          request: { type: "preview.cleanup" },
        },
      ]);
      yield* outbox.cancelUnsettled({
        threadId: R,
        effectTypes: ["terminal.cleanup", "preview.cleanup"],
        reason: "fixture cancellation",
      });
      for (let count = 0; count < 4; count++) {
        const claimed = yield* outbox.claimNext({
          workerId: "task6:worker",
        });
        assert.isTrue(Option.isSome(claimed));
        if (Option.isSome(claimed))
          yield* outbox.succeed({ effectId: claimed.value.id, workerId: "task6:worker" });
      }
      yield* TestClock.adjust("8 days");
      assert.equal(yield* outbox.pruneSettled, 1);
      for (const id of ["exact", "lifecycle", "legacy-detach", "cancelled", "legacy-cancelled"])
        assert.isTrue(Option.isSome(yield* outbox.get(id)));
      assert.isTrue(Option.isNone(yield* outbox.get("ordinary")));
      assert.lengthOf(yield* outbox.listLifecycleCleanup([R]), 2);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lifecycle suspend survives worker process loss with its marker and lease diagnostics",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.enqueue([
        {
          id: "suspend",
          commandId,
          threadId: R,
          request: { type: "scheduled-tasks.suspend", lifecycle },
        },
      ]);
      const claim = yield* outbox.claimNext({
        workerId: "task6:old-process",
      });
      assert.isTrue(Option.isSome(claim));
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
      const recovered = (yield* outbox.listLifecycleCleanup([R]))[0]!;
      assert.equal(recovered.status, "pending");
      assert.isNull(recovered.leaseOwner);
      assert.equal(recovered.attemptCount, 1);
      assert.deepPropertyVal(recovered.request, "lifecycle", lifecycle);
      const replay = yield* outbox.claimNext({
        workerId: "task6:new-process",
      });
      assert.isTrue(Option.isSome(replay));
      yield* outbox.succeed({ effectId: "suspend", workerId: "task6:new-process" });
      assert.deepEqual(yield* outbox.listLifecycleCleanup([R]), []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "legacy lifecycle detach uses confirmed cleanup on replay while ordinary model switches remain ordinary",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* legacyReceipt();
      const request = {
        type: "provider-session.detach" as const,
        providerSessionId: ProviderSessionId.make("shared"),
      };
      yield* outbox.enqueue([
        { id: "legacy", commandId: CommandId.make("task6:legacy"), threadId: R, request },
        { id: "ordinary", commandId: CommandId.make("task6:switch"), threadId: R, request },
      ]);
      const calls: Array<string> = [];
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        assert.equal(yield* worker.drain(), 2);
      }).pipe(
        Effect.provide(
          EffectWorker.layerWithOptions({ workerId: "task6:legacy-replay", maxAttempts: 1 }).pipe(
            Layer.provide(
              Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
                execute: (effect, options) =>
                  Effect.sync(() => {
                    if (effect.id === "legacy") assert.isTrue(options?.lifecycleCleanup);
                    else assert.isUndefined(options?.lifecycleCleanup);
                    calls.push(effect.id);
                  }),
              }),
            ),
          ),
        ),
      );
      assert.deepEqual(calls, ["legacy", "ordinary"]);
      assert.deepEqual(yield* outbox.listLifecycleCleanup([R]), []);
    }).pipe(Effect.provide(layerTest)),
);
