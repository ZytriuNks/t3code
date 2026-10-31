import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const THREAD_DATA_RECLAMATION_BATCH_SIZE = 50;

export type ThreadDataReclamationBlockerCode =
  | "lifecycle_cleanup"
  | "active_work"
  | "surviving_fork"
  | "pending_transfer"
  | "shared_provider_session"
  | "shared_native_session"
  | "shared_attachment"
  | "unknown_dependency";

const blockerOrder: ReadonlyArray<ThreadDataReclamationBlockerCode> = [
  "lifecycle_cleanup",
  "active_work",
  "surviving_fork",
  "pending_transfer",
  "shared_provider_session",
  "shared_native_session",
  "shared_attachment",
  "unknown_dependency",
];

export interface ThreadDataReclamationSummary {
  readonly reclaimedThreadCount: number;
  readonly skippedThreads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly blockerCodes: ReadonlyArray<ThreadDataReclamationBlockerCode>;
  }>;
  readonly deletedEventCount: number;
  readonly deletedReceiptCount: number;
  readonly deletedProjectionRowCount: number;
  readonly deletedTurnItemPositionCount: number;
  readonly deletedOutboxCount: number;
}

export interface ThreadDataReclamationInput {
  readonly eventThroughSequence: number;
  readonly receiptThroughRowId: number;
}

export class ThreadDataReclamationError extends Schema.TaggedError<ThreadDataReclamationError>()(
  "ThreadDataReclamationError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to inspect deleted thread reclamation candidates.";
  }
}

export class ThreadDataReclamation extends Context.Service<
  ThreadDataReclamation,
  {
    readonly reclaim: (
      input: ThreadDataReclamationInput,
    ) => Effect.Effect<ThreadDataReclamationSummary, ThreadDataReclamationError>;
  }
>()("t3/orchestration-v2/ThreadDataReclamation") {}

interface CandidateRow {
  readonly thread_id: string;
  readonly project_id: string;
  readonly shell_project_id: string;
  readonly parent_thread_id: string | null;
  readonly operation_root_thread_id: string;
  readonly lineage_parent_thread_id: string | null;
  readonly relationship_to_parent: string | null;
  readonly forked_from_type: string | null;
  readonly forked_from_thread_id: string | null;
}

interface ThreadReferenceRow {
  readonly thread_id: string;
  readonly deleted_at: string | null;
  readonly parent_thread_id: string | null;
  readonly relationship_to_parent: string | null;
  readonly forked_from_type: string | null;
  readonly forked_from_thread_id: string | null;
}

interface ContextTransferRow {
  readonly source_thread_id: string;
  readonly target_thread_id: string;
  readonly source_exists: number;
  readonly target_exists: number;
}

interface SubagentOwnershipRow {
  readonly parent_thread_id: string;
  readonly child_thread_id: string;
}

interface Closure {
  readonly threadIds: ReadonlyArray<string>;
}

const chunksOf = <A>(values: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const reclaim = Effect.fn("ThreadDataReclamation.reclaim")(
    function* (input: ThreadDataReclamationInput) {
      const candidates: Array<CandidateRow> = [];
      let lastThreadId = "";
      while (true) {
        const page = yield* sql<CandidateRow>`
          SELECT
            deletion.thread_id,
            deletion.project_id,
            shell.project_id AS shell_project_id,
            deletion.parent_thread_id,
            deletion.operation_root_thread_id,
            json_extract(shell.payload_json, '$.lineage.parentThreadId') AS lineage_parent_thread_id,
            json_extract(shell.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
            json_extract(shell.payload_json, '$.forkedFrom.type') AS forked_from_type,
            json_extract(shell.payload_json, '$.forkedFrom.threadId') AS forked_from_thread_id
          FROM orchestration_v2_thread_deletions AS deletion
          INNER JOIN orchestration_v2_projection_threads AS shell
            ON shell.thread_id = deletion.thread_id
          WHERE deletion.scope = 't3_only'
            AND shell.deleted_at IS NOT NULL
            AND deletion.thread_id > ${lastThreadId}
            AND EXISTS (
              SELECT 1
              FROM orchestration_events AS deleted_event
              WHERE deleted_event.aggregate_kind = 'thread'
                AND deleted_event.stream_id = deletion.thread_id
                AND deleted_event.event_type = 'thread.deleted'
                AND deleted_event.command_id = deletion.command_id
                AND deleted_event.application_event_version = 2
                AND deleted_event.sequence <= ${input.eventThroughSequence}
            )
            AND EXISTS (
              SELECT 1
              FROM orchestration_command_receipts AS delete_receipt
              WHERE delete_receipt.command_id = deletion.command_id
                AND delete_receipt.aggregate_kind = 'thread'
                AND delete_receipt.aggregate_id = deletion.operation_root_thread_id
                AND delete_receipt.command_type = 'thread.delete'
                AND delete_receipt.status = 'accepted'
                AND delete_receipt.rowid <= ${input.receiptThroughRowId}
            )
          ORDER BY deletion.thread_id ASC
          LIMIT ${THREAD_DATA_RECLAMATION_BATCH_SIZE}
        `;
        candidates.push(...page);
        if (page.length < THREAD_DATA_RECLAMATION_BATCH_SIZE) break;
        lastThreadId = page.at(-1)!.thread_id;
      }

      const blockersByThreadId = new Map<string, Set<ThreadDataReclamationBlockerCode>>();
      const addBlocker = (threadId: string, blocker: ThreadDataReclamationBlockerCode) => {
        let blockers = blockersByThreadId.get(threadId);
        if (blockers === undefined) {
          blockers = new Set();
          blockersByThreadId.set(threadId, blockers);
        }
        blockers.add(blocker);
      };
      const candidateById = new Map(candidates.map((candidate) => [candidate.thread_id, candidate]));
      const directSubagentPairs = new Set<string>();
      for (const candidateIdChunk of chunksOf(
        candidates.map((candidate) => candidate.thread_id),
        THREAD_DATA_RECLAMATION_BATCH_SIZE,
      )) {
        const ownershipRows = yield* sql<SubagentOwnershipRow>`
          SELECT thread_id AS parent_thread_id, child_thread_id
          FROM orchestration_v2_projection_subagents
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND child_thread_id IS NOT NULL
          ORDER BY thread_id ASC, child_thread_id ASC, subagent_id ASC
        `;
        for (const ownership of ownershipRows) {
          const child = candidateById.get(ownership.child_thread_id);
          if (child === undefined) {
            addBlocker(ownership.parent_thread_id, "unknown_dependency");
            continue;
          }
          const matchesLineage =
            child.relationship_to_parent === "subagent" &&
            child.parent_thread_id === ownership.parent_thread_id &&
            child.lineage_parent_thread_id === ownership.parent_thread_id &&
            child.operation_root_thread_id ===
              candidateById.get(ownership.parent_thread_id)?.operation_root_thread_id &&
            child.project_id === candidateById.get(ownership.parent_thread_id)?.project_id;
          if (matchesLineage) {
            directSubagentPairs.add(JSON.stringify([ownership.parent_thread_id, ownership.child_thread_id]));
          } else {
            addBlocker(ownership.parent_thread_id, "unknown_dependency");
            addBlocker(ownership.child_thread_id, "unknown_dependency");
          }
        }
      }
      const childrenByParentId = new Map<string, Array<CandidateRow>>();

      for (const candidate of candidates) {
        const parentThreadId = candidate.parent_thread_id;
        const relationship = candidate.relationship_to_parent;
        if (
          candidate.project_id !== candidate.shell_project_id ||
          parentThreadId !== candidate.lineage_parent_thread_id
        ) {
          addBlocker(candidate.thread_id, "unknown_dependency");
          if (parentThreadId !== null && candidateById.has(parentThreadId)) {
            addBlocker(parentThreadId, "unknown_dependency");
          }
        }

        if (
          relationship !== "subagent" &&
          candidate.operation_root_thread_id !== candidate.thread_id
        ) {
          addBlocker(candidate.thread_id, "unknown_dependency");
        }

        if (relationship === "subagent") {
          const parent = parentThreadId === null ? undefined : candidateById.get(parentThreadId);
          if (
            parentThreadId === null ||
            parentThreadId !== candidate.lineage_parent_thread_id ||
            parent === undefined ||
            parent.operation_root_thread_id !== candidate.operation_root_thread_id ||
            parent.project_id !== candidate.project_id ||
            !directSubagentPairs.has(JSON.stringify([parentThreadId, candidate.thread_id]))
          ) {
            addBlocker(candidate.thread_id, "unknown_dependency");
            if (parent !== undefined) addBlocker(parent.thread_id, "unknown_dependency");
          } else {
            const children = childrenByParentId.get(parentThreadId) ?? [];
            children.push(candidate);
            childrenByParentId.set(parentThreadId, children);
          }
        } else if (relationship === "fork") {
          if (
            parentThreadId === null ||
            parentThreadId !== candidate.lineage_parent_thread_id ||
            candidate.forked_from_type !== "run" ||
            candidate.forked_from_thread_id !== parentThreadId
          ) {
            addBlocker(candidate.thread_id, "unknown_dependency");
            if (parentThreadId !== null && candidateById.has(parentThreadId)) {
              addBlocker(parentThreadId, "unknown_dependency");
            }
          }
        } else if (parentThreadId !== null || candidate.forked_from_thread_id !== null) {
          addBlocker(candidate.thread_id, "unknown_dependency");
          if (parentThreadId !== null && candidateById.has(parentThreadId)) {
            addBlocker(parentThreadId, "unknown_dependency");
          }
        }
      }

      for (const children of childrenByParentId.values()) {
        children.sort((left, right) => left.thread_id.localeCompare(right.thread_id));
      }
      const childThreadIds = new Set(
        [...childrenByParentId.values()].flatMap((children) =>
          children.map((child) => child.thread_id),
        ),
      );
      const visitedThreadIds = new Set<string>();
      const closures: Array<Closure> = [];
      const closureRootByThreadId = new Map<string, string>();
      const roots = candidates.filter((candidate) => !childThreadIds.has(candidate.thread_id));
      for (const root of roots) {
        if (visitedThreadIds.has(root.thread_id)) continue;
        const threadIds: Array<string> = [];
        const pending = [root.thread_id];
        while (pending.length > 0) {
          const current = pending.shift()!;
          if (visitedThreadIds.has(current)) continue;
          visitedThreadIds.add(current);
          threadIds.push(current);
          for (const child of childrenByParentId.get(current) ?? []) pending.push(child.thread_id);
        }
        threadIds.sort((left, right) => left.localeCompare(right));
        closures.push({ threadIds });
        for (const threadId of threadIds) closureRootByThreadId.set(threadId, root.thread_id);
      }
      for (const candidate of candidates) {
        if (visitedThreadIds.has(candidate.thread_id)) continue;
        addBlocker(candidate.thread_id, "unknown_dependency");
        visitedThreadIds.add(candidate.thread_id);
        closures.push({ threadIds: [candidate.thread_id] });
        closureRootByThreadId.set(candidate.thread_id, candidate.thread_id);
      }

      const candidateIds = candidates.map((candidate) => candidate.thread_id);
      for (const candidateIdChunk of chunksOf(candidateIds, THREAD_DATA_RECLAMATION_BATCH_SIZE)) {
        const activeRows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_runs
          WHERE ${sql.in("thread_id", candidateIdChunk)}
            AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          UNION
          SELECT thread_id FROM orchestration_v2_projection_run_attempts
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND status IN ('pending', 'running')
          UNION
          SELECT thread_id FROM orchestration_v2_projection_nodes
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND status IN ('pending', 'running', 'waiting')
          UNION
          SELECT thread_id FROM orchestration_v2_projection_provider_turns
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND status IN ('pending', 'running')
          UNION
          SELECT thread_id FROM orchestration_v2_projection_runtime_requests
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND status = 'pending'
          UNION
          SELECT thread_id FROM orchestration_v2_projection_turn_items
          WHERE ${sql.in("thread_id", candidateIdChunk)}
            AND type IN ('command_execution', 'dynamic_tool', 'subagent')
            AND status IN ('pending', 'running', 'waiting')
          UNION
          SELECT thread_id FROM orchestration_v2_projection_subagents
          WHERE ${sql.in("thread_id", candidateIdChunk)}
            AND status IN ('pending', 'running', 'waiting')
        `;
        for (const row of activeRows) addBlocker(row.thread_id, "active_work");

        const cleanupRows = yield* sql<{ readonly thread_id: string }>`
          SELECT DISTINCT cleanup.thread_id
          FROM orchestration_v2_effect_outbox AS cleanup
          WHERE ${sql.in("cleanup.thread_id", candidateIdChunk)}
            AND cleanup.status IN ('pending', 'running', 'failed')
            AND cleanup.effect_type IN (
              'provider-session.detach', 'terminal.cleanup', 'preview.cleanup',
              'scheduled-tasks.cleanup', 'scheduled-tasks.suspend', 'attachment.cleanup'
            )
            AND (
              json_type(cleanup.payload_json, '$.lifecycle') = 'object'
              OR EXISTS (
                SELECT 1
                FROM orchestration_command_receipts AS cleanup_receipt
                WHERE cleanup_receipt.command_id = cleanup.command_id
                  AND cleanup_receipt.status = 'accepted'
                  AND cleanup_receipt.command_type IN ('thread.archive', 'thread.delete', 'project.delete')
                  AND cleanup_receipt.rowid <= ${input.receiptThroughRowId}
              )
            )
        `;
        for (const row of cleanupRows) addBlocker(row.thread_id, "lifecycle_cleanup");

        const transferRows = yield* sql<ContextTransferRow>`
          SELECT
            transfer.source_thread_id,
            transfer.target_thread_id,
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_threads AS source
              WHERE source.thread_id = transfer.source_thread_id
            ) AS source_exists,
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_threads AS target
              WHERE target.thread_id = transfer.target_thread_id
            ) AS target_exists
          FROM orchestration_v2_projection_context_transfers AS transfer
          WHERE (
            ${sql.in("transfer.source_thread_id", candidateIdChunk)}
            OR ${sql.in("transfer.target_thread_id", candidateIdChunk)}
          )
            AND transfer.status IN ('pending', 'running')
          ORDER BY transfer.context_transfer_id ASC
        `;
        for (const row of transferRows) {
          if (candidateById.has(row.source_thread_id)) {
            addBlocker(row.source_thread_id, "pending_transfer");
          }
          if (candidateById.has(row.target_thread_id)) {
            addBlocker(row.target_thread_id, "pending_transfer");
          }
          if (row.source_exists === 0) addBlocker(row.target_thread_id, "unknown_dependency");
          if (row.target_exists === 0) addBlocker(row.source_thread_id, "unknown_dependency");
        }

        const referenceRows = yield* sql<ThreadReferenceRow>`
          SELECT
            child.thread_id,
            child.deleted_at,
            json_extract(child.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
            json_extract(child.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
            json_extract(child.payload_json, '$.forkedFrom.type') AS forked_from_type,
            json_extract(child.payload_json, '$.forkedFrom.threadId') AS forked_from_thread_id
          FROM orchestration_v2_projection_threads AS child
          WHERE (
            json_extract(child.payload_json, '$.lineage.parentThreadId') IN ${sql.in(candidateIdChunk)}
            OR json_extract(child.payload_json, '$.forkedFrom.threadId') IN ${sql.in(candidateIdChunk)}
          )
          ORDER BY child.thread_id ASC
        `;
        for (const reference of referenceRows) {
          const referencedIds = new Set(
            [reference.parent_thread_id, reference.forked_from_thread_id].filter(
              (threadId): threadId is string =>
                threadId !== null && candidateById.has(threadId) && candidateIdChunk.includes(threadId),
            ),
          );
          for (const sourceThreadId of referencedIds) {
            const knownFork =
              reference.relationship_to_parent === "fork" &&
              reference.parent_thread_id === sourceThreadId &&
              reference.forked_from_type === "run" &&
              reference.forked_from_thread_id === sourceThreadId;
            if (knownFork) {
              if (reference.deleted_at === null) addBlocker(sourceThreadId, "surviving_fork");
              continue;
            }

            const knownSubagent =
              reference.relationship_to_parent === "subagent" &&
              reference.parent_thread_id === sourceThreadId;
            const sameClosure =
              knownSubagent &&
              closureRootByThreadId.get(reference.thread_id) ===
                closureRootByThreadId.get(sourceThreadId);
            if (sameClosure) continue;
            addBlocker(sourceThreadId, "unknown_dependency");
            if (candidateById.has(reference.thread_id)) {
              addBlocker(reference.thread_id, "unknown_dependency");
            }
          }
        }

        const sharedProviderRows = yield* sql<{ readonly thread_id: string }>`
          WITH session_owners AS (
            SELECT provider_session_id, thread_id
            FROM orchestration_v2_projection_provider_session_bindings
            UNION
            SELECT provider_session_id, thread_id
            FROM orchestration_v2_projection_provider_sessions
            WHERE thread_id IS NOT NULL
            UNION
            SELECT provider_session_id, thread_id
            FROM orchestration_v2_projection_provider_threads
            WHERE provider_session_id IS NOT NULL AND thread_id IS NOT NULL
          )
          SELECT DISTINCT candidate.thread_id
          FROM session_owners AS candidate
          INNER JOIN session_owners AS shared
            ON shared.provider_session_id = candidate.provider_session_id
            AND shared.thread_id <> candidate.thread_id
          INNER JOIN orchestration_v2_projection_threads AS live_thread
            ON live_thread.thread_id = shared.thread_id
            AND live_thread.deleted_at IS NULL
          WHERE ${sql.in("candidate.thread_id", candidateIdChunk)}
          ORDER BY candidate.thread_id ASC
        `;
        for (const row of sharedProviderRows) {
          addBlocker(row.thread_id, "shared_provider_session");
        }

        const unknownNativeRows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id
          FROM orchestration_v2_native_session_bindings
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND native_id IS NULL
          UNION
          SELECT thread_id
          FROM orchestration_v2_thread_deletion_sessions
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND native_id IS NULL
        `;
        for (const row of unknownNativeRows) addBlocker(row.thread_id, "unknown_dependency");

        const sharedNativeRows = yield* sql<{ readonly thread_id: string }>`
          WITH candidate_identities AS (
            SELECT thread_id, driver, native_id, storage_type, canonical_root, canonical_file
            FROM orchestration_v2_native_session_bindings
            WHERE ${sql.in("thread_id", candidateIdChunk)}
            UNION
            SELECT thread_id, driver, native_id, storage_type, canonical_root, canonical_file
            FROM orchestration_v2_thread_deletion_sessions
            WHERE ${sql.in("thread_id", candidateIdChunk)}
          )
          SELECT DISTINCT candidate.thread_id
          FROM candidate_identities AS candidate
          INNER JOIN orchestration_v2_native_session_bindings AS shared
            ON shared.driver = candidate.driver
            AND shared.native_id = candidate.native_id
            AND (
              candidate.storage_type <> 'resolved'
              OR shared.storage_type <> 'resolved'
              OR (
                shared.canonical_root = candidate.canonical_root
                AND shared.canonical_file = candidate.canonical_file
              )
            )
            AND shared.thread_id <> candidate.thread_id
          INNER JOIN orchestration_v2_projection_threads AS live_thread
            ON live_thread.thread_id = shared.thread_id
            AND live_thread.deleted_at IS NULL
          ORDER BY candidate.thread_id ASC
        `;
        for (const row of sharedNativeRows) addBlocker(row.thread_id, "shared_native_session");

        const sharedAttachmentRows = yield* sql<{ readonly thread_id: string }>`
          WITH message_attachments AS (
            SELECT
              message.thread_id,
              json_extract(attachment.value, '$.id') AS attachment_id
            FROM orchestration_v2_projection_messages AS message,
              json_each(message.payload_json, '$.attachments') AS attachment
            WHERE json_extract(attachment.value, '$.id') IS NOT NULL
          )
          SELECT DISTINCT candidate.thread_id
          FROM message_attachments AS candidate
          INNER JOIN message_attachments AS shared
            ON shared.attachment_id = candidate.attachment_id
            AND shared.thread_id <> candidate.thread_id
          INNER JOIN orchestration_v2_projection_threads AS live_thread
            ON live_thread.thread_id = shared.thread_id
            AND live_thread.deleted_at IS NULL
          WHERE ${sql.in("candidate.thread_id", candidateIdChunk)}
          ORDER BY candidate.thread_id ASC
        `;
        for (const row of sharedAttachmentRows) addBlocker(row.thread_id, "shared_attachment");
      }

      let reclaimedThreadCount = 0;
      const skippedThreads: Array<ThreadDataReclamationSummary["skippedThreads"][number]> = [];
      for (const closure of closures) {
        const closureBlockers = new Set<ThreadDataReclamationBlockerCode>();
        for (const threadId of closure.threadIds) {
          for (const blocker of blockersByThreadId.get(threadId) ?? []) closureBlockers.add(blocker);
        }
        if (closureBlockers.size === 0) {
          reclaimedThreadCount += closure.threadIds.length;
          continue;
        }
        const blockerCodes = blockerOrder.filter((blocker) => closureBlockers.has(blocker));
        for (const threadId of closure.threadIds) {
          skippedThreads.push({ threadId: ThreadId.make(threadId), blockerCodes });
        }
      }
      skippedThreads.sort((left, right) => left.threadId.localeCompare(right.threadId));

      return {
        reclaimedThreadCount,
        skippedThreads,
        deletedEventCount: 0,
        deletedReceiptCount: 0,
        deletedProjectionRowCount: 0,
        deletedTurnItemPositionCount: 0,
        deletedOutboxCount: 0,
      } satisfies ThreadDataReclamationSummary;
    },
    (effect) =>
      Effect.mapError(
        effect,
        (cause) => new ThreadDataReclamationError({ operation: "reclaim", cause }),
      ),
  );

  return ThreadDataReclamation.of({ reclaim });
});

export const layer: Layer.Layer<ThreadDataReclamation, never, SqlClient.SqlClient> = Layer.effect(
  ThreadDataReclamation,
  make,
);
