import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";

const R = ThreadId.make("R");
const A = ThreadId.make("A");
const B = ThreadId.make("B");
const F = ThreadId.make("F");
const FC = ThreadId.make("FC");
const AF = ThreadId.make("AF");
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

const seed = Effect.fn("test.seedOwnership")(function* (
  threads: ReadonlyArray<OrchestrationV2AppThread>,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  for (const payload of threads) {
    yield* store.apply({
      id: EventId.make(`created:${payload.id}`),
      type: "thread.created",
      threadId: payload.id,
      occurredAt: now,
      payload,
    });
  }
});

const layerSql = ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
describe.each([
  ["SQLite", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)("ThreadOwnership %s", (_name, storeLayer) => {
  const layerTest = ThreadOwnership.layer.pipe(Layer.provideMerge(storeLayer));
  it.effect("resolves only direct subagent ownership, crossing deleted nodes for delete", () =>
    Effect.gen(function* () {
      yield* seed([
        thread(FC, F, "subagent"),
        thread(AF, A, "fork"),
        thread(B, A, "subagent", { archivedAt: now }),
        thread(F, R, "fork"),
        thread(A, R, "subagent", { deletedAt: now }),
        thread(R),
      ]);
      const owners = yield* ThreadOwnership.ThreadOwnership;
      assert.deepEqual(
        (yield* owners.resolveScope({ rootThreadId: R, operation: "delete" })).members.map(
          (member) => member.id,
        ),
        [R, A, B],
      );
      assert.equal(yield* owners.resolveRoot(B), R);
      assert.equal(yield* owners.resolveRoot(FC), F);
      assert.equal(yield* owners.resolveRoot(AF), AF);
      assert.deepEqual(
        (yield* owners.resolveScope({ rootThreadId: F, operation: "archive" })).members.map(
          (member) => member.id,
        ),
        [F, FC],
      );
      for (const operation of ["archive", "unarchive"] as const) {
        const scope = yield* owners.resolveScope({ rootThreadId: R, operation });
        assert.equal(scope.rootThreadId, R);
        assert.deepEqual(
          scope.members.map((member) => member.id),
          [R],
        );
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("orders each level by ID with parents before children", () =>
    Effect.gen(function* () {
      const C = ThreadId.make("C");
      const D = ThreadId.make("D");
      yield* seed([
        thread(D, A, "subagent"),
        thread(C, R, "subagent"),
        thread(B, C, "subagent"),
        thread(A, R, "subagent"),
        thread(R),
      ]);
      const owners = yield* ThreadOwnership.ThreadOwnership;
      assert.deepEqual(
        (yield* owners.resolveScope({ rootThreadId: R, operation: "delete" })).members.map(
          (member) => member.id,
        ),
        [R, A, C, B, D],
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects a subagent target before running a caller's mutation", () =>
    Effect.gen(function* () {
      yield* seed([thread(R), thread(A, R, "subagent")]);
      const owners = yield* ThreadOwnership.ThreadOwnership;
      const committed = yield* Ref.make(false);
      for (const operation of ["delete", "archive", "unarchive"] as const) {
        const error = yield* owners
          .resolveScope({ rootThreadId: A, operation })
          .pipe(Effect.andThen(Ref.set(committed, true)), Effect.flip);
        assert.instanceOf(error, ThreadOwnership.ThreadOwnershipError);
        assert.include(error, { threadId: A, reason: "subagent_target" });
      }
      assert.isFalse(yield* Ref.get(committed));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["cross_project", "cycle", "missing_parent"] as const)(
    "reports %s without silently truncating ownership paths",
    (reason) =>
      Effect.gen(function* () {
        yield* seed(
          reason === "cross_project"
            ? [thread(R), thread(A, R, "subagent", { projectId: ProjectId.make("other") })]
            : reason === "cycle"
              ? [thread(R, A, "subagent"), thread(A, R, "subagent")]
              : [thread(A, R, "subagent")],
        );
        const owners = yield* ThreadOwnership.ThreadOwnership;
        const error = yield* owners.resolveRoot(A).pipe(Effect.flip);
        assert.instanceOf(error, ThreadOwnership.ThreadOwnershipError);
        assert.equal(error.reason, reason);
        if (reason === "cross_project") {
          const scopeError = yield* owners
            .resolveScope({ rootThreadId: R, operation: "delete" })
            .pipe(Effect.flip);
          assert.include(scopeError, { threadId: A, reason });
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stops at forks even when their source is missing or in another project", () =>
    Effect.gen(function* () {
      yield* seed([thread(F, R, "fork"), thread(FC, F, "subagent")]);
      const owners = yield* ThreadOwnership.ThreadOwnership;
      assert.equal(yield* owners.resolveRoot(FC), F);
      yield* seed([thread(R, A, "subagent", { projectId: ProjectId.make("other") })]);
      assert.equal(yield* owners.resolveRoot(FC), F);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "treats a subagent with no parent as missing_parent and skips deleted roots for archive",
    () =>
      Effect.gen(function* () {
        yield* seed([thread(A, null, "subagent"), thread(R, null, null, { deletedAt: now })]);
        const owners = yield* ThreadOwnership.ThreadOwnership;
        assert.include(yield* owners.resolveRoot(A).pipe(Effect.flip), {
          threadId: A,
          reason: "missing_parent",
        });
        for (const operation of ["archive", "unarchive"] as const) {
          assert.deepEqual(
            (yield* owners.resolveScope({ rootThreadId: R, operation })).members,
            [],
          );
        }
        const store = yield* ProjectionStore.ProjectionStoreV2;
        assert.instanceOf(
          yield* store.getOwnershipPath(ThreadId.make("absent")).pipe(Effect.flip),
          ProjectionStore.ProjectionStoreThreadNotFoundError,
        );
      }).pipe(Effect.provide(layerTest)),
  );
});

const layerLocks = ThreadOwnership.layer.pipe(
  Layer.provide(ProjectionStore.layerMemory),
  Layer.provideMerge(ThreadCommandExecutor.layer),
);

it.effect(
  "serializes the same root, lets another root and the existing thread lock enter, and releases on interruption",
  () =>
    Effect.gen(function* () {
      const owners = yield* ThreadOwnership.ThreadOwnership;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const other = yield* Deferred.make<void>();
      const holder = yield* owners
        .withRoots([R], Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const waiter = yield* owners
        .withRoots([R], Deferred.succeed(waiting, undefined))
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(yield* Deferred.isDone(waiting));
      const independent = yield* owners
        .withRoots([F], Deferred.succeed(other, undefined))
        .pipe(Effect.forkChild);
      yield* Deferred.await(other);
      yield* executor.withLock(R, Effect.void);
      assert.isFalse(yield* Deferred.isDone(waiting));
      yield* Fiber.interrupt(holder);
      yield* Deferred.await(waiting);
      yield* Fiber.joinAll([waiter, independent]);
    }).pipe(Effect.provide(layerLocks)),
);

it.effect("deduplicates roots and takes overlapping root sets in canonical order", () =>
  Effect.gen(function* () {
    const owners = yield* ThreadOwnership.ThreadOwnership;
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const holder = yield* owners
      .withRoots(
        [R, A, R],
        Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(held);
    const waiter = yield* owners
      .withRoots([A, R], Deferred.succeed(entered, undefined))
      .pipe(Effect.forkChild({ startImmediately: true }));
    assert.isFalse(yield* Deferred.isDone(entered));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.joinAll([holder, waiter]);
    assert.equal(yield* owners.withRoots([], Effect.succeed(42)), 42);
    assert.equal(
      yield* owners.withRoots([R], Effect.fail("expected")).pipe(Effect.flip),
      "expected",
    );
    yield* owners.withRoots([R], Effect.void);
  }).pipe(Effect.provide(layerLocks)),
);

it.effect(
  "waits for the lowest root first and releases partially acquired roots on interruption",
  () =>
    Effect.gen(function* () {
      const owners = yield* ThreadOwnership.ThreadOwnership;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const holder = yield* owners
        .withRoots(
          [A],
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const waiting = yield* owners
        .withRoots([R, A, R], Deferred.succeed(entered, undefined))
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(yield* Deferred.isDone(entered));
      // R is still available because the waiter acquires A first.
      yield* owners.withRoots([R], Effect.void);
      yield* Fiber.interrupt(waiting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);

      const highHeld = yield* Deferred.make<void>();
      const highHolder = yield* owners
        .withRoots([R], Deferred.succeed(highHeld, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(highHeld);
      const partial = yield* owners
        .withRoots([A, R], Deferred.succeed(entered, undefined))
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(yield* Deferred.isDone(entered));
      yield* Fiber.interrupt(partial);
      // The interrupted waiter must release A even while R is held elsewhere.
      yield* owners.withRoots([A], Effect.void);
      yield* Fiber.interrupt(highHolder);
      yield* owners.withRoots([R, A], Effect.void);
    }).pipe(Effect.provide(layerLocks)),
);
