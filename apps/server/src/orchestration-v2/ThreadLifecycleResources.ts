import { CommandId, ThreadId, ThreadLifecycleResourceBlockedError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export class ThreadLifecycleResourceError extends Schema.TaggedError<ThreadLifecycleResourceError>()(
  "ThreadLifecycleResourceError",
  {
    operation: Schema.Literals(["attachments", "cleanup-status"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread lifecycle resource ${this.operation} failed.`;
  }
}

export class ThreadLifecycleResources extends Context.Service<
  ThreadLifecycleResources,
  {
    readonly assertCanCreate: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadLifecycleResourceBlockedError>;
    /** Only the short publication/commit belongs here; prepare long I/O before acquiring the root. */
    readonly withCreateCommit: <A, E, R>(
      threadId: ThreadId,
      commit: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ThreadLifecycleResourceBlockedError, R>;
    readonly safeAttachmentIds: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<string>, ThreadLifecycleResourceError>;
    readonly getCleanupStatus: (
      commandId: CommandId,
    ) => Effect.Effect<
      { readonly pendingCount: number; readonly failedCount: number },
      ThreadLifecycleResourceError
    >;
  }
>()("t3/orchestration-v2/ThreadLifecycleResources") {}

const make = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const ownership = yield* ThreadOwnership.ThreadOwnership;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const sql = yield* SqlClient.SqlClient;

  const assertCanCreate = Effect.fn("ThreadLifecycleResources.assertCanCreate")(
    function* (threadId: ThreadId) {
      yield* ownership
        .resolveRoot(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadLifecycleResourceBlockedError({ threadId, reason: "ownership", cause }),
          ),
        );
      const path = yield* store
        .getOwnershipPath(threadId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadLifecycleResourceBlockedError({ threadId, reason: "ownership", cause }),
          ),
        );
      const ids = path.map((member) => member.id);
      const deleted =
        yield* sql`SELECT thread_id FROM orchestration_v2_thread_deletions WHERE ${sql.in("thread_id", ids)}`;
      if (
        deleted.length > 0 ||
        path.some((member) => member.archivedAt !== null || member.deletedAt !== null)
      )
        return yield* new ThreadLifecycleResourceBlockedError({ threadId, reason: "inactive" });
      const cleanup = yield* outbox.listLifecycleCleanup(ids);
      if (cleanup[0] !== undefined)
        return yield* new ThreadLifecycleResourceBlockedError({
          threadId,
          reason: "cleanup",
          effectId: cleanup[0].id,
        });
    },
    (effect, threadId) =>
      Effect.mapError(effect, (cause) =>
        cause._tag === "ThreadLifecycleResourceBlockedError"
          ? cause
          : new ThreadLifecycleResourceBlockedError({ threadId, reason: "unavailable", cause }),
      ),
  );

  const withCreateCommit = Effect.fn("ThreadLifecycleResources.withCreateCommit")(function* <
    A,
    E,
    R,
  >(threadId: ThreadId, commit: Effect.Effect<A, E, R>) {
    const root = yield* ownership
      .resolveRoot(threadId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadLifecycleResourceBlockedError({ threadId, reason: "ownership", cause }),
        ),
      );
    return yield* ownership.withRoots(
      [root],
      assertCanCreate(threadId).pipe(Effect.andThen(commit)),
    );
  });

  const safeAttachmentIds = Effect.fn("ThreadLifecycleResources.safeAttachmentIds")(
    function* (threadIds: ReadonlyArray<ThreadId>) {
      if (threadIds.length === 0) return [];
      const candidates = [
        ...new Set((yield* Effect.forEach(threadIds, store.getThreadAttachmentIds)).flat()),
      ];
      if (candidates.length === 0) return [];
      // A source edge protects its entire history, including lazy fork hydration and pending transfers.
      const dependencies = yield* sql<{
        readonly source_id: string | null;
        readonly known: number;
      }>`
        WITH RECURSIVE edges(source_id, target_id) AS (
          SELECT json_extract(payload_json, '$.forkedFrom.sourceThreadId'), thread_id
          FROM orchestration_v2_projection_threads WHERE json_type(payload_json, '$.forkedFrom') = 'object'
          UNION
          SELECT json_extract(payload_json, '$.lineage.parentThreadId'), thread_id
          FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'fork'
          UNION
          SELECT source_thread_id, target_thread_id FROM orchestration_v2_projection_context_transfers
        ), readers(thread_id) AS (
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL AND NOT ${sql.in("thread_id", threadIds)}
          UNION
          SELECT target_thread_id FROM orchestration_v2_projection_context_transfers
          WHERE status = 'pending' AND NOT ${sql.in("target_thread_id", threadIds)}
          UNION
          SELECT edges.source_id FROM readers JOIN edges ON edges.target_id = readers.thread_id
        )
        SELECT DISTINCT edges.source_id, source.thread_id IS NOT NULL AS known
        FROM readers JOIN edges ON edges.target_id = readers.thread_id
        LEFT JOIN orchestration_v2_projection_threads source ON source.thread_id = edges.source_id
      `;
      // Unknown provenance is not proof that the candidate has no surviving reader.
      if (dependencies.some((edge) => edge.source_id === null || edge.known === 0)) return [];
      const protectedSources = new Set(dependencies.map((edge) => edge.source_id!));
      const retained = new Set<string>();
      for (const source of threadIds.filter((id) => protectedSources.has(id)))
        for (const id of yield* store.getThreadAttachmentIds(ThreadId.make(source)))
          retained.add(id);
      // A deleted intermediate source still exposes both messages and tool output to its surviving readers.
      const protectedIds = [...protectedSources];
      const encodedCandidates = encodeIds(candidates);
      const referenced = yield* sql<{ readonly id: string }>`
        SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
        FROM orchestration_v2_projection_messages message
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = message.thread_id,
          json_each(message.payload_json, '$.attachments') attachment
        WHERE (thread.deleted_at IS NULL OR ${sql.in("thread.thread_id", protectedIds)})
          AND NOT ${sql.in("thread.thread_id", threadIds)}
          AND EXISTS (SELECT 1 FROM json_each(${encodedCandidates}) candidate
            WHERE candidate.value = json_extract(attachment.value, '$.id'))
        UNION
        SELECT candidate.value AS id FROM orchestration_v2_projection_turn_items item
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = item.thread_id,
          json_each(${encodedCandidates}) candidate
        WHERE (thread.deleted_at IS NULL OR ${sql.in("thread.thread_id", protectedIds)})
          AND NOT ${sql.in("thread.thread_id", threadIds)}
          AND item.type = 'dynamic_tool' AND instr(item.payload_json, candidate.value) > 0
      `;
      for (const reference of referenced) retained.add(reference.id);
      return candidates.filter((id) => !retained.has(id));
    },
    Effect.mapError(
      (cause) => new ThreadLifecycleResourceError({ operation: "attachments", cause }),
    ),
  );

  const getCleanupStatus = Effect.fn("ThreadLifecycleResources.getCleanupStatus")(
    function* (commandId: CommandId) {
      const effects = yield* outbox.listByCommandId(commandId);
      return {
        pendingCount: effects.filter(
          (effect) => effect.status === "pending" || effect.status === "running",
        ).length,
        failedCount: effects.filter(
          (effect) => effect.status === "failed" || effect.status === "cancelled",
        ).length,
      };
    },
    Effect.mapError(
      (cause) => new ThreadLifecycleResourceError({ operation: "cleanup-status", cause }),
    ),
  );
  return ThreadLifecycleResources.of({
    assertCanCreate,
    withCreateCommit,
    safeAttachmentIds,
    getCleanupStatus,
  });
});

export const layer = Layer.effect(ThreadLifecycleResources, make).pipe(
  Layer.provide(ThreadOwnership.layer),
  Layer.provide(Layer.merge(ProjectionStore.layer, EffectOutbox.layer)),
);
