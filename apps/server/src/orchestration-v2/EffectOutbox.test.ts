import { assert, it } from "@effect/vitest";
import { CommandId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
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

const legacyReceipt = Effect.fn("test.legacyArchiveReceipt")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`INSERT INTO orchestration_command_receipts
    (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
    VALUES ('task6:legacy', 'thread', ${R}, 'thread.archive', ${now}, 0, 'accepted', NULL)`;
});

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
      for (let count = 0; count < 4; count++)
        yield* outbox.claimNext({ workerId: "task6:worker", leaseDurationMs: 1000 });
      assert.isTrue(
        (yield* outbox.listLifecycleCleanup([R])).some((effect) => effect.status === "running"),
      );
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
          leaseDurationMs: 1000,
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
        leaseDurationMs: 1000,
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
        leaseDurationMs: 1000,
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
