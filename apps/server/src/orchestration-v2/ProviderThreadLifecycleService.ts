import { ProviderDriverKind, ProviderSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadLifecycleGuard from "./ThreadLifecycleGuard.ts";

export class ProviderThreadLifecycleError extends Schema.TaggedError<ProviderThreadLifecycleError>()(
  "ProviderThreadLifecycleError",
  {
    reason: Schema.Literals([
      "lifecycle",
      "identity",
      "provenance",
      "reference",
      "runtime",
      "adapter",
      "persistence",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider thread deletion failed (${this.reason}).`;
  }
}

// The outbox envelope contains a request union, so Extract on the envelope itself is never.
type ExtractRequest<Type extends EffectOutbox.OrchestrationEffectRequestV2["type"]> = Omit<
  EffectOutbox.OrchestrationEffectV2,
  "request"
> & {
  readonly request: Extract<EffectOutbox.OrchestrationEffectRequestV2, { type: Type }>;
};

export class ProviderThreadLifecycleService extends Context.Service<
  ProviderThreadLifecycleService,
  {
    readonly delete: (
      effect: ExtractRequest<"provider-thread.delete">,
    ) => Effect.Effect<void, ProviderThreadLifecycleError>;
  }
>()("t3/orchestration-v2/ProviderThreadLifecycleService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const guards = yield* ThreadLifecycleGuard.ThreadLifecycleGuard;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

  const deleteThread = Effect.fn("ProviderThreadLifecycleService.delete")(function* (
    effect: ExtractRequest<"provider-thread.delete">,
  ) {
    const request = effect.request;
    const lifecycle: EffectOutbox.LifecycleCleanup = request.lifecycle;
    const root = yield* projections
      .getThread(lifecycle.rootThreadId)
      .pipe(
        Effect.mapError(
          (cause) => new ProviderThreadLifecycleError({ reason: "lifecycle", cause }),
        ),
      );
    const guard = {
      threadId: lifecycle.rootThreadId,
      lifecycleRevision: lifecycle.revision,
      sourceToken: lifecycle.sourceToken,
    };
    const accepted = yield* guards
      .check({ guard, purpose: "terminal_cleanup" })
      .pipe(
        Effect.mapError(
          (cause) => new ProviderThreadLifecycleError({ reason: "lifecycle", cause }),
        ),
      );
    if (accepted === "stale" || (root.lifecycleRevision ?? 0) !== lifecycle.revision) return;
    // terminal_cleanup deliberately permits inactive owners; revision/token still fence this effect.
    if (lifecycle.sourceToken !== undefined) {
      const source = yield* guards
        .resolveLifecycleSource(root.id)
        .pipe(
          Effect.mapError(
            (cause) => new ProviderThreadLifecycleError({ reason: "lifecycle", cause }),
          ),
        );
      if (source.sourceToken !== lifecycle.sourceToken) return;
    }
    if (
      request.nativeStorage.type !== "resolved" ||
      !request.nativeStorage.canonicalFile ||
      (request.nativeId !== null && !request.nativeId.trim()) ||
      request.threadIds.length === 0
    ) {
      return yield* new ProviderThreadLifecycleError({ reason: "identity" });
    }
    const storage = request.nativeStorage;
    const targetIds = [...new Set(request.threadIds)];
    const targets = new Set<string>(targetIds);

    const associatedSessions = yield* Effect.gen(function* () {
      const closure = yield* sql<{
        readonly thread_id: string;
        readonly deleted_at: string | null;
        readonly tombstone: string | null;
      }>`
        WITH RECURSIVE members(thread_id) AS (
          SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${root.id}
          UNION
          SELECT child.thread_id FROM members
          JOIN orchestration_v2_projection_threads child
            ON json_extract(child.payload_json, '$.lineage.parentThreadId') = members.thread_id
          WHERE child.project_id = ${root.projectId}
            AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        )
        SELECT t.thread_id, t.deleted_at, d.thread_id AS tombstone FROM members
        JOIN orchestration_v2_projection_threads t ON t.thread_id = members.thread_id
        LEFT JOIN orchestration_v2_thread_deletions d ON d.thread_id = t.thread_id
      `;
      const deleted = new Set(
        closure
          .filter((row) => row.deleted_at !== null && row.tombstone !== null)
          .map((row) => row.thread_id),
      );
      if (!deleted.has(root.id) || targetIds.some((id) => !deleted.has(id)))
        return yield* new ProviderThreadLifecycleError({ reason: "lifecycle" });

      // Canonical files can be shared across instances; instance id is routing, not ownership proof.
      const references = yield* sql<{
        readonly thread_id: string | null;
        readonly provider_thread_id: string;
        readonly provider_instance_id: string | null;
        readonly driver: string | null;
        readonly native_id: string | null;
        readonly storage_type: string | null;
        readonly canonical_root: string | null;
        readonly canonical_file: string | null;
        readonly provider_session_id: string | null;
      }>`
        WITH RECURSIVE identities AS (
          SELECT thread_id, provider_thread_id, provider_instance_id, driver, native_id, storage_type,
            canonical_root, canonical_file, NULL AS provider_session_id
          FROM orchestration_v2_native_session_bindings WHERE driver = 'pi'
          UNION ALL
          SELECT thread_id, provider_thread_id, provider_instance_id, driver, native_id, storage_type,
            canonical_root, canonical_file, NULL
          FROM orchestration_v2_thread_deletion_sessions WHERE driver = 'pi'
          UNION ALL
          SELECT thread_id, provider_thread_id, provider_instance_id, driver,
            json_extract(payload_json, '$.nativeThreadRef.nativeId'),
            json_extract(payload_json, '$.nativeStorage.type'),
            json_extract(payload_json, '$.nativeStorage.canonicalRoot'),
            json_extract(payload_json, '$.nativeStorage.canonicalFile'), provider_session_id
          FROM orchestration_v2_projection_provider_threads WHERE driver = 'pi' OR driver IS NULL
        ), related_identities AS (
          SELECT * FROM identities WHERE provider_thread_id = ${request.providerThreadId}
            OR canonical_file = ${storage.canonicalFile}
          UNION
          SELECT candidate.* FROM identities candidate JOIN related_identities related
            ON candidate.provider_thread_id = related.provider_thread_id
              OR (candidate.canonical_file <> '' AND candidate.canonical_file = related.canonical_file)
              OR (candidate.native_id = related.native_id AND trim(candidate.native_id) <> '' AND (
                coalesce(candidate.storage_type, 'unresolved') <> 'resolved'
                OR coalesce(related.storage_type, 'unresolved') <> 'resolved'
                OR candidate.canonical_root = related.canonical_root
              ))
        )
        SELECT * FROM related_identities
      `;
      if (
        !references.some(
          (row) =>
            row.provider_thread_id === request.providerThreadId &&
            row.provider_instance_id === request.providerInstanceId &&
            row.driver === "pi" &&
            row.native_id === request.nativeId &&
            row.storage_type === "resolved" &&
            row.canonical_root === storage.canonicalRoot &&
            row.canonical_file === storage.canonicalFile &&
            row.thread_id !== null &&
            targets.has(row.thread_id),
        )
      )
        return yield* new ProviderThreadLifecycleError({ reason: "provenance" });
      if (
        references.some(
          (row) =>
            row.thread_id === null ||
            !targets.has(row.thread_id) ||
            row.provider_instance_id === null ||
            row.driver !== "pi" ||
            row.storage_type !== "resolved" ||
            !row.canonical_root ||
            !row.canonical_file,
        )
      )
        return yield* new ProviderThreadLifecycleError({ reason: "reference" });

      const providerIds = [...new Set(references.map((row) => row.provider_thread_id))];
      const instanceIds = [...new Set(references.map((row) => row.provider_instance_id!))];
      const unknownBindings = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_provider_session_bindings b
        WHERE ${sql.in("b.thread_id", targetIds)}
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_sessions s
            WHERE s.provider_session_id = b.provider_session_id AND s.driver IS NOT NULL
              AND s.provider_instance_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads p
            WHERE p.provider_session_id = b.provider_session_id AND p.driver IS NOT NULL
              AND p.provider_instance_id IS NOT NULL)
        LIMIT 1
      `;
      if (unknownBindings.length > 0)
        return yield* new ProviderThreadLifecycleError({ reason: "provenance" });
      const sessionRows = yield* sql<{
        readonly provider_session_id: string;
        readonly thread_id: string | null;
        readonly unknown_owner: number;
      }>`
        WITH associated(provider_session_id) AS (
          SELECT DISTINCT provider_session_id FROM orchestration_v2_projection_provider_threads
          WHERE ${sql.in("provider_thread_id", providerIds)} AND provider_session_id IS NOT NULL
          UNION
          SELECT s.provider_session_id FROM orchestration_v2_projection_provider_sessions s
          LEFT JOIN orchestration_v2_projection_provider_session_bindings b USING (provider_session_id)
          WHERE s.driver = 'pi' AND ${sql.in("s.provider_instance_id", instanceIds)}
            AND (${sql.in("s.thread_id", targetIds)} OR ${sql.in("b.thread_id", targetIds)})
        )
        SELECT a.provider_session_id, b.thread_id, 0 AS unknown_owner FROM associated a
        JOIN orchestration_v2_projection_provider_session_bindings b USING (provider_session_id)
        UNION
        SELECT a.provider_session_id, s.thread_id, 0 FROM associated a
        LEFT JOIN orchestration_v2_projection_provider_sessions s USING (provider_session_id)
        UNION
        SELECT p.provider_session_id, p.thread_id, p.thread_id IS NULL FROM orchestration_v2_projection_provider_threads p
        JOIN associated a USING (provider_session_id)
      `;
      if (
        sessionRows.some(
          (row) =>
            row.unknown_owner === 1 || (row.thread_id !== null && !targets.has(row.thread_id)),
        )
      )
        return yield* new ProviderThreadLifecycleError({ reason: "reference" });

      // The planner's single routing identity does not enumerate every alias of the canonical file.
      const nativeIds = [
        ...new Set(
          references.flatMap((row) =>
            row.native_id !== null && row.native_id.trim() !== "" ? [row.native_id] : [],
          ),
        ),
      ];
      const transfers = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_context_transfers
        WHERE status = 'pending' AND (
          ${sql.in("source_thread_id", targetIds)} OR ${sql.in("target_thread_id", targetIds)}
          OR json_extract(payload_json, '$.sourcePoint.threadId') IN ${sql.in(targetIds)}
          OR json_extract(payload_json, '$.basePoint.threadId') IN ${sql.in(targetIds)}
          OR (json_extract(payload_json, '$.sourcePoint.providerThreadRef.driver') = 'pi'
            AND json_extract(payload_json, '$.sourcePoint.providerThreadRef.nativeId') IN ${sql.in(nativeIds)})
          OR (json_extract(payload_json, '$.basePoint.providerThreadRef.driver') = 'pi'
            AND json_extract(payload_json, '$.basePoint.providerThreadRef.nativeId') IN ${sql.in(nativeIds)})
          OR (json_extract(payload_json, '$.resolution.providerThreadRef.driver') = 'pi'
            AND json_extract(payload_json, '$.resolution.providerThreadRef.nativeId') IN ${sql.in(nativeIds)})
        ) LIMIT 1
      `;
      if (transfers.length > 0)
        return yield* new ProviderThreadLifecycleError({ reason: "reference" });
      return [
        ...new Set(sessionRows.map((row) => ProviderSessionId.make(row.provider_session_id))),
      ];
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) =>
        cause._tag === "ProviderThreadLifecycleError"
          ? cause
          : new ProviderThreadLifecycleError({ reason: "persistence", cause }),
      ),
    );

    for (const id of associatedSessions) {
      if (yield* sessions.isLive(id))
        return yield* new ProviderThreadLifecycleError({ reason: "runtime" });
    }
    const adapter = yield* adapters
      .get(request.providerInstanceId)
      .pipe(
        Effect.mapError((cause) => new ProviderThreadLifecycleError({ reason: "adapter", cause })),
      );
    if (
      adapter.driver !== "pi" ||
      adapter.instanceId !== request.providerInstanceId ||
      !adapter.deleteNativeThread
    )
      return yield* new ProviderThreadLifecycleError({ reason: "adapter" });
    // The persisted identity is authoritative even when the current model or provider projection changed.
    const createdAt = DateTime.makeUnsafe(effect.createdAt);
    yield* adapter
      .deleteNativeThread({
        providerThread: {
          id: request.providerThreadId,
          driver: ProviderDriverKind.make("pi"),
          providerInstanceId: request.providerInstanceId,
          providerSessionId: null,
          appThreadId: targetIds[0]!,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: ProviderDriverKind.make("pi"),
            nativeId: request.nativeId,
            strength: "strong",
          },
          nativeStorage: storage,
          nativeConversationHeadRef: null,
          status: "closed",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt,
          updatedAt: createdAt,
        },
      })
      .pipe(
        Effect.mapError((cause) => new ProviderThreadLifecycleError({ reason: "adapter", cause })),
      );
  });
  return ProviderThreadLifecycleService.of({ delete: deleteThread });
});

export const layer = Layer.effect(ProviderThreadLifecycleService, make);
