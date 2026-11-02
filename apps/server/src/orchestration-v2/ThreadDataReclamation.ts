import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const THREAD_DATA_RECLAMATION_BATCH_SIZE = 50;

const encodeStringPair = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const encodeStringArray = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

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
    return "Failed to reclaim deleted thread data.";
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

interface InternalContextTransferRow {
  readonly context_transfer_id: string;
  readonly source_thread_id: string;
  readonly target_thread_id: string;
}

interface InternalContextHandoffRow {
  readonly context_handoff_id: string;
  readonly thread_id: string;
}

interface ReclaimableMessageRow {
  readonly message_id: string;
  readonly thread_id: string;
}

interface ReclaimableNativeBindingRow {
  readonly binding_key: string;
  readonly thread_id: string;
  readonly driver: string;
  readonly native_id: string;
  readonly storage_type: string;
  readonly canonical_root: string;
  readonly canonical_file: string;
}

interface MessageAttachmentRow {
  readonly message_id: string;
  readonly thread_id: string;
  readonly attachment_id: string | null;
}

interface AttachmentOwnerRow {
  readonly thread_id: string;
  readonly attachment_id: string;
}

interface NativeSessionOwnerRow {
  readonly thread_id: string;
  readonly driver: string;
  readonly native_id: string;
  readonly storage_type: string;
  readonly canonical_root: string;
  readonly canonical_file: string;
}

interface ProviderSessionOwnerRow {
  readonly provider_session_id: string;
  readonly thread_id: string | null;
  readonly owner_kind: "session" | "binding" | "provider_thread";
}

interface SubagentOwnershipRow {
  readonly subagent_id: string;
  readonly parent_thread_id: string;
  readonly child_thread_id: string;
}

interface Closure {
  readonly threadIds: ReadonlyArray<string>;
  readonly subagentRows: ReadonlyArray<SubagentOwnershipRow>;
  readonly contextTransfers: ReadonlyArray<InternalContextTransferRow>;
  readonly contextHandoffs: ReadonlyArray<InternalContextHandoffRow>;
  readonly messages: ReadonlyArray<ReclaimableMessageRow>;
  readonly nativeBindings: ReadonlyArray<ReclaimableNativeBindingRow>;
  readonly providerSessionIds: ReadonlyArray<string>;
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

  const findThreadsWithReclaimableData = Effect.fn(
    "ThreadDataReclamation.findThreadsWithReclaimableData",
  )(function* (threadIds: ReadonlyArray<string>) {
    const rows = yield* sql<{ readonly thread_id: string }>`
        WITH candidate_ids AS (
          SELECT thread_id
          FROM orchestration_v2_projection_threads
          WHERE thread_id IN ${sql.in(threadIds)}
        )
        SELECT thread_id FROM orchestration_v2_projection_context_handoffs
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT source_thread_id AS thread_id
          FROM orchestration_v2_projection_context_transfers
          WHERE source_thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT target_thread_id AS thread_id
          FROM orchestration_v2_projection_context_transfers
          WHERE target_thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_checkpoints
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_plans
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_messages
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_turn_item_positions
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_provider_turns
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_run_attempts
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_nodes
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_runs
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_subagents
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_native_session_bindings
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT thread_id FROM orchestration_v2_effect_outbox
          WHERE thread_id IN (SELECT thread_id FROM candidate_ids)
        UNION SELECT aggregate_id AS thread_id FROM orchestration_command_receipts AS receipt
          WHERE receipt.aggregate_kind = 'thread'
            AND receipt.command_type <> 'thread.delete'
            AND receipt.aggregate_id IN (SELECT thread_id FROM candidate_ids)
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_thread_deletions AS deletion
              WHERE deletion.command_id = receipt.command_id
            )
        UNION SELECT stream_id AS thread_id FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id IN (SELECT thread_id FROM candidate_ids)
            AND event_type NOT IN ('thread.created', 'thread.deleted')
      `;
    return new Set(rows.map((row) => row.thread_id));
  });

  const reclaimCandidateBatch = Effect.fn("ThreadDataReclamation.reclaimCandidateBatch")(
    function* (input: ThreadDataReclamationInput, candidates: ReadonlyArray<CandidateRow>) {
      const blockersByThreadId = new Map<string, Set<ThreadDataReclamationBlockerCode>>();
      const addBlocker = (threadId: string, blocker: ThreadDataReclamationBlockerCode) => {
        let blockers = blockersByThreadId.get(threadId);
        if (blockers === undefined) {
          blockers = new Set();
          blockersByThreadId.set(threadId, blockers);
        }
        blockers.add(blocker);
      };
      const candidateById = new Map(
        candidates.map((candidate) => [candidate.thread_id, candidate]),
      );
      const candidateIds = candidates.map((candidate) => candidate.thread_id);
      const candidateThreadsWithData = new Set<string>();
      for (const candidateIdChunk of chunksOf(candidateIds, THREAD_DATA_RECLAMATION_BATCH_SIZE)) {
        for (const threadId of yield* findThreadsWithReclaimableData(candidateIdChunk)) {
          candidateThreadsWithData.add(threadId);
        }
      }

      const directSubagentPairs = new Set<string>();
      const subagentRowsByPair = new Map<string, Array<SubagentOwnershipRow>>();
      for (const candidateIdChunk of chunksOf(candidateIds, THREAD_DATA_RECLAMATION_BATCH_SIZE)) {
        const ownershipRows = yield* sql<SubagentOwnershipRow>`
          SELECT subagent_id, thread_id AS parent_thread_id, child_thread_id
          FROM orchestration_v2_projection_subagents
          WHERE ${sql.in("thread_id", candidateIdChunk)} AND child_thread_id IS NOT NULL
          ORDER BY thread_id ASC, child_thread_id ASC, subagent_id ASC
        `;
        const incomingOwnershipRows = yield* sql<SubagentOwnershipRow>`
          SELECT subagent_id, thread_id AS parent_thread_id, child_thread_id
          FROM orchestration_v2_projection_subagents
          WHERE ${sql.in("child_thread_id", candidateIdChunk)}
          ORDER BY child_thread_id ASC, thread_id ASC, subagent_id ASC
        `;
        for (const ownership of incomingOwnershipRows) {
          if (!candidateById.has(ownership.parent_thread_id)) {
            addBlocker(ownership.child_thread_id, "unknown_dependency");
          }
        }
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
            const pair = encodeStringPair([ownership.parent_thread_id, ownership.child_thread_id]);
            directSubagentPairs.add(pair);
            const rows = subagentRowsByPair.get(pair) ?? [];
            rows.push(ownership);
            subagentRowsByPair.set(pair, rows);
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
            (!directSubagentPairs.has(encodeStringPair([parentThreadId, candidate.thread_id])) &&
              candidateThreadsWithData.has(candidate.thread_id))
          ) {
            addBlocker(candidate.thread_id, "unknown_dependency");
            if (parent !== undefined) addBlocker(parent.thread_id, "unknown_dependency");
          } else {
            // Previously completed chunks may have removed the ownership row; only
            // reconstruct that edge after all reclaimable data for the child is gone.
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
        const subagentRows = threadIds.flatMap((parentThreadId) =>
          (childrenByParentId.get(parentThreadId) ?? []).flatMap(
            (child) =>
              subagentRowsByPair.get(JSON.stringify([parentThreadId, child.thread_id])) ?? [],
          ),
        );
        closures.push({
          threadIds,
          subagentRows,
          contextTransfers: [],
          contextHandoffs: [],
          messages: [],
          nativeBindings: [],
          providerSessionIds: [],
        });
        for (const threadId of threadIds) closureRootByThreadId.set(threadId, root.thread_id);
      }
      for (const candidate of candidates) {
        if (visitedThreadIds.has(candidate.thread_id)) continue;
        addBlocker(candidate.thread_id, "unknown_dependency");
        visitedThreadIds.add(candidate.thread_id);
        closures.push({
          threadIds: [candidate.thread_id],
          subagentRows: [],
          contextTransfers: [],
          contextHandoffs: [],
          messages: [],
          nativeBindings: [],
          providerSessionIds: [],
        });
        closureRootByThreadId.set(candidate.thread_id, candidate.thread_id);
      }

      const contextTransfersByRoot = new Map<string, Map<string, InternalContextTransferRow>>();
      const contextHandoffsByRoot = new Map<string, Map<string, InternalContextHandoffRow>>();
      for (const candidateIdChunk of chunksOf(candidateIds, THREAD_DATA_RECLAMATION_BATCH_SIZE)) {
        const transferRows = yield* sql<
          InternalContextTransferRow & {
            readonly target_run_id: string | null;
            readonly target_run_thread_id: string | null;
          }
        >`
          SELECT
            transfer.context_transfer_id,
            transfer.source_thread_id,
            transfer.target_thread_id,
            transfer.target_run_id,
            target_run.thread_id AS target_run_thread_id
          FROM orchestration_v2_projection_context_transfers AS transfer
          LEFT JOIN orchestration_v2_projection_runs AS target_run
            ON target_run.run_id = transfer.target_run_id
          WHERE transfer.source_thread_id IN ${sql.in(candidateIdChunk)}
            OR transfer.target_thread_id IN ${sql.in(candidateIdChunk)}
          ORDER BY transfer.context_transfer_id ASC
        `;
        for (const transfer of transferRows) {
          const rootThreadId = closureRootByThreadId.get(transfer.source_thread_id);
          const targetRootThreadId = closureRootByThreadId.get(transfer.target_thread_id);
          const runIsInternal =
            transfer.target_run_id === null ||
            (transfer.target_run_thread_id !== null &&
              closureRootByThreadId.get(transfer.target_run_thread_id) === rootThreadId);
          if (rootThreadId !== undefined && rootThreadId === targetRootThreadId && runIsInternal) {
            const byId = contextTransfersByRoot.get(rootThreadId) ?? new Map();
            byId.set(transfer.context_transfer_id, {
              context_transfer_id: transfer.context_transfer_id,
              source_thread_id: transfer.source_thread_id,
              target_thread_id: transfer.target_thread_id,
            });
            contextTransfersByRoot.set(rootThreadId, byId);
          }
        }

        const handoffRows = yield* sql<
          InternalContextHandoffRow & {
            readonly target_run_thread_id: string | null;
            readonly target_provider_thread_id: string | null;
          }
        >`
          SELECT
            handoff.context_handoff_id,
            handoff.thread_id,
            target_run.thread_id AS target_run_thread_id,
            target_provider_thread.thread_id AS target_provider_thread_id
          FROM orchestration_v2_projection_context_handoffs AS handoff
          LEFT JOIN orchestration_v2_projection_runs AS target_run
            ON target_run.run_id = handoff.target_run_id
          LEFT JOIN orchestration_v2_projection_provider_threads AS target_provider_thread
            ON target_provider_thread.provider_thread_id = handoff.to_provider_thread_id
          WHERE handoff.thread_id IN ${sql.in(candidateIdChunk)}
          ORDER BY handoff.context_handoff_id ASC
        `;
        for (const handoff of handoffRows) {
          const rootThreadId = closureRootByThreadId.get(handoff.thread_id);
          if (
            rootThreadId !== undefined &&
            closureRootByThreadId.get(handoff.target_run_thread_id ?? "") === rootThreadId &&
            closureRootByThreadId.get(handoff.target_provider_thread_id ?? "") === rootThreadId
          ) {
            const byId = contextHandoffsByRoot.get(rootThreadId) ?? new Map();
            byId.set(handoff.context_handoff_id, {
              context_handoff_id: handoff.context_handoff_id,
              thread_id: handoff.thread_id,
            });
            contextHandoffsByRoot.set(rootThreadId, byId);
          }
        }
      }
      const providerSessionIdsByRoot = new Map<string, Set<string>>();
      for (const candidateIdChunk of chunksOf(candidateIds, THREAD_DATA_RECLAMATION_BATCH_SIZE)) {
        const owners = yield* sql<ProviderSessionOwnerRow>`
          SELECT provider_session_id, thread_id, 'session' AS owner_kind
          FROM orchestration_v2_projection_provider_sessions
          WHERE thread_id IN ${sql.in(candidateIdChunk)}
          UNION ALL
          SELECT provider_session_id, thread_id, 'binding' AS owner_kind
          FROM orchestration_v2_projection_provider_session_bindings
          WHERE thread_id IN ${sql.in(candidateIdChunk)}
          UNION ALL
          SELECT provider_session_id, thread_id, 'provider_thread' AS owner_kind
          FROM orchestration_v2_projection_provider_threads
          WHERE thread_id IN ${sql.in(candidateIdChunk)} AND provider_session_id IS NOT NULL
        `;
        for (const owner of owners) {
          const rootThreadId = closureRootByThreadId.get(owner.thread_id ?? "");
          if (rootThreadId === undefined) continue;
          const ids = providerSessionIdsByRoot.get(rootThreadId) ?? new Set<string>();
          ids.add(owner.provider_session_id);
          providerSessionIdsByRoot.set(rootThreadId, ids);
        }
      }
      const candidateProviderSessionIds = [
        ...new Set([...providerSessionIdsByRoot.values()].flatMap((ids) => [...ids])),
      ];
      const allProviderSessionOwnersById = new Map<string, Array<ProviderSessionOwnerRow>>();
      for (const providerSessionIdChunk of chunksOf(
        candidateProviderSessionIds,
        THREAD_DATA_RECLAMATION_BATCH_SIZE,
      )) {
        const owners = yield* sql<ProviderSessionOwnerRow>`
          SELECT provider_session_id, thread_id, 'session' AS owner_kind
          FROM orchestration_v2_projection_provider_sessions
          WHERE provider_session_id IN ${sql.in(providerSessionIdChunk)}
          UNION ALL
          SELECT provider_session_id, thread_id, 'binding' AS owner_kind
          FROM orchestration_v2_projection_provider_session_bindings
          WHERE provider_session_id IN ${sql.in(providerSessionIdChunk)}
          UNION ALL
          SELECT provider_session_id, thread_id, 'provider_thread' AS owner_kind
          FROM orchestration_v2_projection_provider_threads
          WHERE provider_session_id IN ${sql.in(providerSessionIdChunk)}
        `;
        for (const owner of owners) {
          const rows = allProviderSessionOwnersById.get(owner.provider_session_id) ?? [];
          rows.push(owner);
          allProviderSessionOwnersById.set(owner.provider_session_id, rows);
        }
      }
      const unsharedProviderSessionIdsByRoot = new Map<string, ReadonlyArray<string>>();
      for (const [rootThreadId, providerSessionIds] of providerSessionIdsByRoot) {
        const unsharedIds = [...providerSessionIds].filter((providerSessionId) =>
          (allProviderSessionOwnersById.get(providerSessionId) ?? []).every((owner) => {
            if (owner.thread_id === null) return owner.owner_kind === "session";
            return closureRootByThreadId.get(owner.thread_id) === rootThreadId;
          }),
        );
        unsharedProviderSessionIdsByRoot.set(rootThreadId, unsharedIds);
      }

      const candidateNativeBindingsByRoot = new Map<string, Array<ReclaimableNativeBindingRow>>();
      const candidateNativeIds = new Set<string>();
      for (const candidateIdChunk of chunksOf(candidateIds, THREAD_DATA_RECLAMATION_BATCH_SIZE)) {
        const rows = yield* sql<ReclaimableNativeBindingRow>`
          SELECT
            binding_key,
            thread_id,
            driver,
            native_id,
            storage_type,
            canonical_root,
            canonical_file
          FROM orchestration_v2_native_session_bindings
          WHERE thread_id IN ${sql.in(candidateIdChunk)} AND native_id IS NOT NULL
        `;
        for (const row of rows) {
          const rootThreadId = closureRootByThreadId.get(row.thread_id);
          if (rootThreadId === undefined) continue;
          const bindings = candidateNativeBindingsByRoot.get(rootThreadId) ?? [];
          bindings.push(row);
          candidateNativeBindingsByRoot.set(rootThreadId, bindings);
          candidateNativeIds.add(row.native_id);
        }
      }
      const nativeOwnersById = new Map<string, Array<NativeSessionOwnerRow>>();
      for (const nativeIdChunk of chunksOf(
        [...candidateNativeIds],
        THREAD_DATA_RECLAMATION_BATCH_SIZE,
      )) {
        const owners = yield* sql<NativeSessionOwnerRow>`
          SELECT thread_id, driver, native_id, storage_type, canonical_root, canonical_file
          FROM orchestration_v2_native_session_bindings
          WHERE native_id IN ${sql.in(nativeIdChunk)}
          UNION ALL
          SELECT thread_id, driver, native_id, storage_type, canonical_root, canonical_file
          FROM orchestration_v2_thread_deletion_sessions
          WHERE native_id IN ${sql.in(nativeIdChunk)}
        `;
        for (const owner of owners) {
          const rows = nativeOwnersById.get(owner.native_id) ?? [];
          rows.push(owner);
          nativeOwnersById.set(owner.native_id, rows);
        }
      }
      const sameNativeIdentity = (
        candidate: ReclaimableNativeBindingRow,
        owner: NativeSessionOwnerRow,
      ) =>
        candidate.driver === owner.driver &&
        candidate.native_id === owner.native_id &&
        (candidate.storage_type !== "resolved" ||
          owner.storage_type !== "resolved" ||
          (candidate.canonical_root === owner.canonical_root &&
            candidate.canonical_file === owner.canonical_file));
      const unsharedNativeBindingsByRoot = new Map<
        string,
        ReadonlyArray<ReclaimableNativeBindingRow>
      >();
      for (const [rootThreadId, bindings] of candidateNativeBindingsByRoot) {
        unsharedNativeBindingsByRoot.set(
          rootThreadId,
          bindings.filter(
            (candidate) =>
              !(nativeOwnersById.get(candidate.native_id) ?? []).some(
                (owner) =>
                  sameNativeIdentity(candidate, owner) &&
                  closureRootByThreadId.get(owner.thread_id) !== rootThreadId,
              ),
          ),
        );
      }

      const candidateMessagesByRoot = new Map<
        string,
        Map<
          string,
          { readonly message: ReclaimableMessageRow; readonly attachmentIds: Set<string> }
        >
      >();
      for (const candidateIdChunk of chunksOf(candidateIds, THREAD_DATA_RECLAMATION_BATCH_SIZE)) {
        const rows = yield* sql<MessageAttachmentRow>`
          SELECT
            message.message_id,
            message.thread_id,
            json_extract(attachment.value, '$.id') AS attachment_id
          FROM orchestration_v2_projection_messages AS message
          LEFT JOIN json_each(message.payload_json, '$.attachments') AS attachment ON TRUE
          WHERE message.thread_id IN ${sql.in(candidateIdChunk)}
        `;
        for (const row of rows) {
          const rootThreadId = closureRootByThreadId.get(row.thread_id);
          if (rootThreadId === undefined) continue;
          const messages = candidateMessagesByRoot.get(rootThreadId) ?? new Map();
          const message = messages.get(row.message_id) ?? {
            message: { message_id: row.message_id, thread_id: row.thread_id },
            attachmentIds: new Set<string>(),
          };
          if (row.attachment_id !== null) message.attachmentIds.add(row.attachment_id);
          messages.set(row.message_id, message);
          candidateMessagesByRoot.set(rootThreadId, messages);
        }
      }
      const attachmentRootsById = new Map<string, Set<string>>();
      for (const [rootThreadId, messages] of candidateMessagesByRoot) {
        for (const message of messages.values()) {
          for (const attachmentId of message.attachmentIds) {
            const rootsForAttachment = attachmentRootsById.get(attachmentId) ?? new Set<string>();
            rootsForAttachment.add(rootThreadId);
            attachmentRootsById.set(attachmentId, rootsForAttachment);
          }
        }
      }
      const externalAttachmentsByRoot = new Map<string, Set<string>>();
      const candidateAttachmentIds = [...attachmentRootsById.keys()];
      for (const attachmentIdChunk of chunksOf(
        candidateAttachmentIds,
        THREAD_DATA_RECLAMATION_BATCH_SIZE,
      )) {
        const owners = yield* sql<AttachmentOwnerRow>`
          SELECT
            message.thread_id,
            json_extract(attachment.value, '$.id') AS attachment_id
          FROM orchestration_v2_projection_messages AS message,
            json_each(message.payload_json, '$.attachments') AS attachment
          WHERE json_extract(attachment.value, '$.id') IN ${sql.in(attachmentIdChunk)}
        `;
        for (const owner of owners) {
          const ownerRootThreadId = closureRootByThreadId.get(owner.thread_id);
          for (const rootThreadId of attachmentRootsById.get(owner.attachment_id) ?? []) {
            if (ownerRootThreadId === rootThreadId) continue;
            const externalIds = externalAttachmentsByRoot.get(rootThreadId) ?? new Set<string>();
            externalIds.add(owner.attachment_id);
            externalAttachmentsByRoot.set(rootThreadId, externalIds);
          }
        }
      }
      const safeMessagesByRoot = new Map<string, ReadonlyArray<ReclaimableMessageRow>>();
      for (const [rootThreadId, messages] of candidateMessagesByRoot) {
        const externalIds = externalAttachmentsByRoot.get(rootThreadId) ?? new Set<string>();
        safeMessagesByRoot.set(
          rootThreadId,
          [...messages.values()]
            .filter((message) =>
              [...message.attachmentIds].every((attachmentId) => !externalIds.has(attachmentId)),
            )
            .map((message) => message.message),
        );
      }

      for (let index = 0; index < closures.length; index++) {
        const closure = closures[index]!;
        const rootThreadId = closureRootByThreadId.get(closure.threadIds[0]!);
        if (rootThreadId === undefined) continue;
        closures[index] = {
          ...closure,
          contextTransfers: [...(contextTransfersByRoot.get(rootThreadId)?.values() ?? [])],
          contextHandoffs: [...(contextHandoffsByRoot.get(rootThreadId)?.values() ?? [])],
          messages: safeMessagesByRoot.get(rootThreadId) ?? [],
          nativeBindings: unsharedNativeBindingsByRoot.get(rootThreadId) ?? [],
          providerSessionIds: unsharedProviderSessionIdsByRoot.get(rootThreadId) ?? [],
        };
      }

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
            AND (
              cleanup.status IN ('pending', 'running', 'failed')
              OR (
                cleanup.status = 'cancelled'
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_effect_outbox AS succeeded_cleanup
                  WHERE succeeded_cleanup.thread_id = cleanup.thread_id
                    AND succeeded_cleanup.status = 'succeeded'
                    AND succeeded_cleanup.effect_type = cleanup.effect_type
                    AND succeeded_cleanup.effect_type IN (
                      'provider-session.detach', 'terminal.cleanup', 'preview.cleanup',
                      'scheduled-tasks.cleanup', 'scheduled-tasks.suspend', 'attachment.cleanup'
                    )
                    AND json_type(succeeded_cleanup.payload_json, '$.lifecycle') IS 'object'
                    AND json_extract(succeeded_cleanup.payload_json, '$.lifecycle.rootThreadId') =
                      json_extract(cleanup.payload_json, '$.lifecycle.rootThreadId')
                    AND json_extract(succeeded_cleanup.payload_json, '$.lifecycle.revision') =
                      json_extract(cleanup.payload_json, '$.lifecycle.revision')
                )
              )
            )
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
                threadId !== null &&
                candidateById.has(threadId) &&
                candidateIdChunk.includes(threadId),
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

        const attachmentIdsJson = encodeStringArray(candidateAttachmentIds);
        const sharedAttachmentRows = yield* sql<{ readonly thread_id: string }>`
          WITH candidate_attachments AS (
            SELECT DISTINCT
              message.thread_id,
              json_extract(attachment.value, '$.id') AS attachment_id
            FROM orchestration_v2_projection_messages AS message,
              json_each(message.payload_json, '$.attachments') AS attachment
            WHERE message.thread_id IN ${sql.in(candidateIdChunk)}
              AND json_extract(attachment.value, '$.id') IS NOT NULL
          ),
          attachment_refs AS (
            SELECT
              message.thread_id,
              json_extract(attachment.value, '$.id') AS attachment_id
            FROM orchestration_v2_projection_messages AS message,
              json_each(message.payload_json, '$.attachments') AS attachment
            WHERE json_extract(attachment.value, '$.id') IS NOT NULL
            UNION ALL
            SELECT item.thread_id, candidate.value AS attachment_id
            FROM orchestration_v2_projection_turn_items AS item,
              json_each(${attachmentIdsJson}) AS candidate
            WHERE item.type = 'dynamic_tool'
              AND instr(item.payload_json, candidate.value) > 0
            UNION ALL
            SELECT item.thread_id, json_extract(attachment.value, '$.id') AS attachment_id
            FROM orchestration_v2_projection_turn_items AS item,
              json_each(item.payload_json, '$.questionAnswer.attachmentsByQuestionId') AS question,
              json_each(question.value) AS attachment
            WHERE item.type = 'user_input_request'
              AND json_extract(attachment.value, '$.id') IS NOT NULL
            UNION ALL
            SELECT thread.thread_id, json_extract(attachment.value, '$.id') AS attachment_id
            FROM orchestration_v2_projection_threads AS thread,
              json_each(thread.payload_json, '$.guestShare.messages') AS guest_message,
              json_each(guest_message.value, '$.attachments') AS attachment
            WHERE json_extract(guest_message.value, '$.status') = 'pending'
              AND json_extract(attachment.value, '$.id') IS NOT NULL
          )
          SELECT DISTINCT candidate.thread_id
          FROM candidate_attachments AS candidate
          INNER JOIN attachment_refs AS shared
            ON shared.attachment_id = candidate.attachment_id
            AND shared.thread_id <> candidate.thread_id
          INNER JOIN orchestration_v2_projection_threads AS live_thread
            ON live_thread.thread_id = shared.thread_id
            AND live_thread.deleted_at IS NULL
          ORDER BY candidate.thread_id ASC
        `;
        for (const row of sharedAttachmentRows) addBlocker(row.thread_id, "shared_attachment");
      }

      let reclaimedThreadCount = 0;
      const skippedThreads: Array<ThreadDataReclamationSummary["skippedThreads"][number]> = [];
      const reclaimableClosures: Array<Closure> = [];
      for (const closure of closures) {
        const closureBlockers = new Set<ThreadDataReclamationBlockerCode>();
        for (const threadId of closure.threadIds) {
          for (const blocker of blockersByThreadId.get(threadId) ?? [])
            closureBlockers.add(blocker);
        }
        if (closureBlockers.size === 0) {
          reclaimedThreadCount += closure.threadIds.length;
          reclaimableClosures.push(closure);
          continue;
        }
        const blockerCodes = blockerOrder.filter((blocker) => closureBlockers.has(blocker));
        for (const threadId of closure.threadIds) {
          skippedThreads.push({ threadId: ThreadId.make(threadId), blockerCodes });
        }
      }
      skippedThreads.sort((left, right) => left.threadId.localeCompare(right.threadId));

      // Closures are preflighted as a unit, then reclaimed in stable ascending-ID chunks.
      const deletionChunks = reclaimableClosures.flatMap((closure) =>
        chunksOf(closure.threadIds, THREAD_DATA_RECLAMATION_BATCH_SIZE).map((threadIds) => {
          const chunkThreadIds = new Set(threadIds);
          return {
            threadIds,
            subagentRows: closure.subagentRows.filter((row) =>
              chunkThreadIds.has(row.child_thread_id),
            ),
            contextTransfers: closure.contextTransfers.filter((row) =>
              chunkThreadIds.has(row.source_thread_id),
            ),
            contextHandoffs: closure.contextHandoffs.filter((row) =>
              chunkThreadIds.has(row.thread_id),
            ),
            messages: closure.messages.filter((row) => chunkThreadIds.has(row.thread_id)),
            nativeBindings: closure.nativeBindings.filter((row) =>
              chunkThreadIds.has(row.thread_id),
            ),
            providerSessionIds: closure.providerSessionIds,
          } satisfies Closure;
        }),
      );
      const batches: Array<Array<Closure>> = [];
      let currentBatch: Array<Closure> = [];
      let currentBatchThreadCount = 0;
      for (const chunk of deletionChunks) {
        if (
          currentBatchThreadCount > 0 &&
          currentBatchThreadCount + chunk.threadIds.length > THREAD_DATA_RECLAMATION_BATCH_SIZE
        ) {
          batches.push(currentBatch);
          currentBatch = [];
          currentBatchThreadCount = 0;
        }
        currentBatch.push(chunk);
        currentBatchThreadCount += chunk.threadIds.length;
        if (currentBatchThreadCount >= THREAD_DATA_RECLAMATION_BATCH_SIZE) {
          batches.push(currentBatch);
          currentBatch = [];
          currentBatchThreadCount = 0;
        }
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      const deleteClosure = Effect.fn("ThreadDataReclamation.deleteClosure")(function* (
        closure: Closure,
      ) {
        const threadIds = closure.threadIds;
        const counts = {
          deletedProjectionRowCount: 0,
          deletedTurnItemPositionCount: 0,
          deletedOutboxCount: 0,
          deletedReceiptCount: 0,
          deletedEventCount: 0,
        };

        for (const handoffIdChunk of chunksOf(
          closure.contextHandoffs.map((row) => row.context_handoff_id),
          THREAD_DATA_RECLAMATION_BATCH_SIZE,
        )) {
          const handoffs = yield* sql<{ readonly context_handoff_id: string }>`
              DELETE FROM orchestration_v2_projection_context_handoffs
              WHERE context_handoff_id IN ${sql.in(handoffIdChunk)}
              RETURNING context_handoff_id
            `;
          counts.deletedProjectionRowCount += handoffs.length;
        }

        for (const transferIdChunk of chunksOf(
          closure.contextTransfers.map((row) => row.context_transfer_id),
          THREAD_DATA_RECLAMATION_BATCH_SIZE,
        )) {
          const transfers = yield* sql<{ readonly context_transfer_id: string }>`
              DELETE FROM orchestration_v2_projection_context_transfers
              WHERE context_transfer_id IN ${sql.in(transferIdChunk)}
              RETURNING context_transfer_id
            `;
          counts.deletedProjectionRowCount += transfers.length;
        }

        const checkpoints = yield* sql<{ readonly checkpoint_id: string }>`
            DELETE FROM orchestration_v2_projection_checkpoints AS checkpoint
            WHERE checkpoint.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_checkpoints AS external_checkpoint
                WHERE external_checkpoint.parent_checkpoint_id = checkpoint.checkpoint_id
                  AND external_checkpoint.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING checkpoint_id
          `;
        counts.deletedProjectionRowCount += checkpoints.length;

        const checkpointScopes = yield* sql<{ readonly scope_id: string }>`
            DELETE FROM orchestration_v2_projection_checkpoint_scopes AS scope
            WHERE scope.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_checkpoint_scopes AS external_scope
                WHERE external_scope.parent_scope_id = scope.scope_id
                  AND external_scope.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_checkpoints AS external_checkpoint
                WHERE external_checkpoint.scope_id = scope.scope_id
                  AND external_checkpoint.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_node
                WHERE external_node.checkpoint_scope_id = scope.scope_id
                  AND external_node.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING scope_id
          `;
        counts.deletedProjectionRowCount += checkpointScopes.length;

        const runtimeRequests = yield* sql<{ readonly runtime_request_id: string }>`
            DELETE FROM orchestration_v2_projection_runtime_requests AS request
            WHERE request.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_node
                WHERE external_node.runtime_request_id = request.runtime_request_id
                  AND external_node.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING runtime_request_id
          `;
        counts.deletedProjectionRowCount += runtimeRequests.length;

        const plans = yield* sql<{ readonly plan_id: string }>`
            DELETE FROM orchestration_v2_projection_plans
            WHERE thread_id IN ${sql.in(threadIds)}
            RETURNING plan_id
          `;
        counts.deletedProjectionRowCount += plans.length;

        for (const messageIdChunk of chunksOf(
          closure.messages.map((row) => row.message_id),
          THREAD_DATA_RECLAMATION_BATCH_SIZE,
        )) {
          const messages = yield* sql<{ readonly message_id: string }>`
              DELETE FROM orchestration_v2_projection_messages
              WHERE message_id IN ${sql.in(messageIdChunk)}
              RETURNING message_id
            `;
          counts.deletedProjectionRowCount += messages.length;
        }

        const turnItems = yield* sql<{ readonly turn_item_id: string }>`
            DELETE FROM orchestration_v2_projection_turn_items AS item
            WHERE item.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_turn_items AS external_item
                WHERE external_item.parent_item_id = item.turn_item_id
                  AND external_item.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING turn_item_id
          `;
        counts.deletedProjectionRowCount += turnItems.length;

        const positions = yield* sql<{ readonly turn_item_id: string }>`
            DELETE FROM orchestration_v2_turn_item_positions AS position
            WHERE position.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_turn_items AS item
                WHERE item.thread_id = position.thread_id
                  AND item.turn_item_id = position.turn_item_id
              )
            RETURNING turn_item_id
          `;
        counts.deletedTurnItemPositionCount += positions.length;

        const providerTurns = yield* sql<{ readonly provider_turn_id: string }>`
            DELETE FROM orchestration_v2_projection_provider_turns AS provider_turn
            WHERE provider_turn.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_runtime_requests AS external_request
                WHERE external_request.provider_turn_id = provider_turn.provider_turn_id
                  AND external_request.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_node
                WHERE external_node.provider_turn_id = provider_turn.provider_turn_id
                  AND external_node.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_turn_items AS external_item
                WHERE external_item.provider_turn_id = provider_turn.provider_turn_id
                  AND external_item.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_run_attempts AS external_attempt
                WHERE external_attempt.provider_turn_id = provider_turn.provider_turn_id
                  AND external_attempt.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING provider_turn_id
          `;
        counts.deletedProjectionRowCount += providerTurns.length;

        const providerThreads = yield* sql<{ readonly provider_thread_id: string }>`
            DELETE FROM orchestration_v2_projection_provider_threads AS provider_thread
            WHERE provider_thread.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_threads AS external_thread
                WHERE external_thread.active_provider_thread_id = provider_thread.provider_thread_id
                  AND external_thread.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_runs AS external_run
                WHERE external_run.provider_thread_id = provider_thread.provider_thread_id
                  AND external_run.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_owner_node
                WHERE external_owner_node.node_id = provider_thread.owner_node_id
                  AND external_owner_node.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_run_attempts AS external_attempt
                WHERE external_attempt.provider_thread_id = provider_thread.provider_thread_id
                  AND external_attempt.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_node
                WHERE external_node.provider_thread_id = provider_thread.provider_thread_id
                  AND external_node.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_provider_turns AS external_turn
                WHERE external_turn.provider_thread_id = provider_thread.provider_thread_id
                  AND external_turn.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_turn_items AS external_item
                WHERE external_item.provider_thread_id = provider_thread.provider_thread_id
                  AND external_item.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_subagents AS external_subagent
                WHERE external_subagent.provider_thread_id = provider_thread.provider_thread_id
                  AND external_subagent.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_context_handoffs AS external_handoff
                WHERE external_handoff.to_provider_thread_id = provider_thread.provider_thread_id
                  AND external_handoff.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_native_session_bindings AS external_binding
                WHERE external_binding.provider_thread_id = provider_thread.provider_thread_id
                  AND external_binding.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_thread_deletion_sessions AS external_session
                WHERE external_session.provider_thread_id = provider_thread.provider_thread_id
                  AND external_session.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING provider_thread_id
          `;
        counts.deletedProjectionRowCount += providerThreads.length;

        const attempts = yield* sql<{ readonly attempt_id: string }>`
            DELETE FROM orchestration_v2_projection_run_attempts AS attempt
            WHERE attempt.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_provider_turns AS external_turn
                WHERE external_turn.run_attempt_id = attempt.attempt_id
                  AND external_turn.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING attempt_id
          `;
        counts.deletedProjectionRowCount += attempts.length;

        const nodes = yield* sql<{ readonly node_id: string }>`
            DELETE FROM orchestration_v2_projection_nodes AS node
            WHERE node.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_node
                WHERE external_node.parent_node_id = node.node_id
                  AND external_node.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_root_node
                WHERE external_root_node.root_node_id = node.node_id
                  AND external_root_node.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_run_attempts AS external_attempt
                WHERE external_attempt.root_node_id = node.node_id
                  AND external_attempt.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_runtime_requests AS external_request
                WHERE external_request.node_id = node.node_id
                  AND external_request.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_plans AS external_plan
                WHERE external_plan.node_id = node.node_id
                  AND external_plan.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_messages AS external_message
                WHERE external_message.node_id = node.node_id
                  AND external_message.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_turn_items AS external_item
                WHERE external_item.node_id = node.node_id
                  AND external_item.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_provider_turns AS external_turn
                WHERE external_turn.node_id = node.node_id
                  AND external_turn.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_subagents AS external_subagent
                WHERE external_subagent.parent_node_id = node.node_id
                  AND external_subagent.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_checkpoints AS external_checkpoint
                WHERE external_checkpoint.node_id = node.node_id
                  AND external_checkpoint.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_checkpoint_scopes AS external_scope
                WHERE external_scope.node_id = node.node_id
                  AND external_scope.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_provider_threads AS external_provider_thread
                WHERE external_provider_thread.owner_node_id = node.node_id
                  AND external_provider_thread.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING node_id
          `;
        counts.deletedProjectionRowCount += nodes.length;

        const runs = yield* sql<{ readonly run_id: string }>`
            DELETE FROM orchestration_v2_projection_runs AS run
            WHERE run.thread_id IN ${sql.in(threadIds)}
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_run_attempts AS external_attempt
                WHERE external_attempt.run_id = run.run_id
                  AND external_attempt.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_node
                WHERE external_node.run_id = run.run_id
                  AND external_node.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_messages AS external_message
                WHERE external_message.run_id = run.run_id
                  AND external_message.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_plans AS external_plan
                WHERE external_plan.run_id = run.run_id
                  AND external_plan.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_turn_items AS external_item
                WHERE external_item.run_id = run.run_id
                  AND external_item.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_checkpoints AS external_checkpoint
                WHERE external_checkpoint.run_id = run.run_id
                  AND external_checkpoint.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_checkpoint_scopes AS external_scope
                WHERE external_scope.run_id = run.run_id
                  AND external_scope.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_context_handoffs AS external_handoff
                WHERE external_handoff.target_run_id = run.run_id
                  AND external_handoff.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_subagents AS external_subagent
                WHERE external_subagent.run_id = run.run_id
                  AND external_subagent.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_context_transfers AS external_transfer
                WHERE external_transfer.target_run_id = run.run_id
                  AND (
                    external_transfer.source_thread_id NOT IN ${sql.in(threadIds)}
                    OR external_transfer.target_thread_id NOT IN ${sql.in(threadIds)}
                  )
              )
            RETURNING run_id
          `;
        counts.deletedProjectionRowCount += runs.length;

        const unownedSubagents = yield* sql<{ readonly subagent_id: string }>`
            DELETE FROM orchestration_v2_projection_subagents AS subagent
            WHERE subagent.thread_id IN ${sql.in(threadIds)}
              AND subagent.child_thread_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_nodes AS external_node
                WHERE external_node.node_id = subagent.parent_node_id
                  AND external_node.thread_id NOT IN ${sql.in(threadIds)}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_provider_threads AS external_provider_thread
                WHERE external_provider_thread.provider_thread_id = subagent.provider_thread_id
                  AND external_provider_thread.thread_id NOT IN ${sql.in(threadIds)}
              )
            RETURNING subagent_id
          `;
        counts.deletedProjectionRowCount += unownedSubagents.length;

        const threadsWithRemainingData = yield* findThreadsWithReclaimableData(threadIds);
        const cleanThreadIds = new Set(
          threadIds.filter((threadId) => !threadsWithRemainingData.has(threadId)),
        );
        const internallyRetainedSessionThreads = yield* sql<{ readonly thread_id: string }>`
            SELECT DISTINCT session.thread_id
            FROM orchestration_v2_projection_provider_sessions AS session
            WHERE session.thread_id IN ${sql.in(threadIds)}
              AND EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_provider_session_bindings AS binding
                WHERE binding.provider_session_id = session.provider_session_id
                  AND binding.thread_id NOT IN ${sql.in(threadIds)}
              )
          `;
        for (const row of internallyRetainedSessionThreads) cleanThreadIds.add(row.thread_id);
        const reclaimableSubagentIds = closure.subagentRows
          .filter((row) => cleanThreadIds.has(row.child_thread_id))
          .map((row) => row.subagent_id);
        for (const subagentIdChunk of chunksOf(
          reclaimableSubagentIds,
          THREAD_DATA_RECLAMATION_BATCH_SIZE,
        )) {
          const subagents = yield* sql<{ readonly subagent_id: string }>`
              DELETE FROM orchestration_v2_projection_subagents AS subagent
              WHERE subagent.subagent_id IN ${sql.in(subagentIdChunk)}
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_projection_nodes AS external_node
                  WHERE external_node.node_id = subagent.parent_node_id
                    AND external_node.thread_id NOT IN ${sql.in(threadIds)}
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_projection_provider_threads AS external_provider_thread
                  WHERE external_provider_thread.provider_thread_id = subagent.provider_thread_id
                    AND external_provider_thread.thread_id NOT IN ${sql.in(threadIds)}
                )
              RETURNING subagent_id
            `;
          counts.deletedProjectionRowCount += subagents.length;
        }

        for (const bindingKeyChunk of chunksOf(
          closure.nativeBindings.map((row) => row.binding_key),
          THREAD_DATA_RECLAMATION_BATCH_SIZE,
        )) {
          const nativeBindings = yield* sql<{ readonly binding_key: string }>`
              DELETE FROM orchestration_v2_native_session_bindings
              WHERE binding_key IN ${sql.in(bindingKeyChunk)}
              RETURNING binding_key
            `;
          counts.deletedProjectionRowCount += nativeBindings.length;
        }

        for (const providerSessionIdChunk of chunksOf(
          closure.providerSessionIds,
          THREAD_DATA_RECLAMATION_BATCH_SIZE,
        )) {
          const providerSessionBindings = yield* sql<{ readonly provider_session_id: string }>`
              DELETE FROM orchestration_v2_projection_provider_session_bindings
              WHERE thread_id IN ${sql.in(threadIds)}
                AND provider_session_id IN ${sql.in(providerSessionIdChunk)}
              RETURNING provider_session_id
            `;
          counts.deletedProjectionRowCount += providerSessionBindings.length;

          const providerSessions = yield* sql<{ readonly provider_session_id: string }>`
              DELETE FROM orchestration_v2_projection_provider_sessions AS session
              WHERE session.provider_session_id IN ${sql.in(providerSessionIdChunk)}
                AND (session.thread_id IS NULL OR session.thread_id IN ${sql.in(threadIds)})
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_projection_provider_session_bindings AS binding
                  WHERE binding.provider_session_id = session.provider_session_id
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM orchestration_v2_projection_provider_threads AS provider_thread
                  WHERE provider_thread.provider_session_id = session.provider_session_id
                )
              RETURNING provider_session_id
            `;
          counts.deletedProjectionRowCount += providerSessions.length;
        }

        const outbox = yield* sql<{ readonly effect_id: string }>`
            DELETE FROM orchestration_v2_effect_outbox AS cleanup
            WHERE cleanup.thread_id IN ${sql.in(threadIds)}
              AND cleanup.status IN ('succeeded', 'cancelled')
              AND NOT (
                cleanup.effect_type = 'provider-session.detach'
                AND (
                  json_type(cleanup.payload_json, '$.retirementRevision') IS NOT NULL
                  OR json_type(cleanup.payload_json, '$.lifecycle') IS 'object'
                )
              )
              AND NOT (
                cleanup.status = 'cancelled'
                AND json_type(cleanup.payload_json, '$.lifecycle') IS 'object'
              )
              AND NOT (
                (cleanup.status = 'cancelled' OR cleanup.effect_type = 'provider-session.detach')
                AND EXISTS (
                  SELECT 1
                  FROM orchestration_command_receipts AS receipt
                  WHERE receipt.command_id = cleanup.command_id
                    AND receipt.status = 'accepted'
                    AND receipt.command_type IN ('thread.archive', 'thread.delete', 'project.delete')
                )
              )
            RETURNING effect_id
          `;
        counts.deletedOutboxCount += outbox.length;

        const receipts = yield* sql<{ readonly command_id: string }>`
            DELETE FROM orchestration_command_receipts AS receipt
            WHERE receipt.aggregate_kind = 'thread'
              AND receipt.aggregate_id IN ${sql.in(threadIds)}
              AND receipt.rowid <= ${input.receiptThroughRowId}
              AND receipt.command_type <> 'thread.delete'
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_thread_deletions AS deletion
                WHERE deletion.command_id = receipt.command_id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM orchestration_v2_effect_outbox AS retained_outbox
                WHERE retained_outbox.command_id = receipt.command_id
              )
            RETURNING command_id
          `;
        counts.deletedReceiptCount += receipts.length;

        const events = yield* sql<{ readonly event_id: string }>`
            DELETE FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id IN ${sql.in(threadIds)}
              AND sequence <= ${input.eventThroughSequence}
              AND event_type NOT IN ('thread.created', 'thread.deleted')
            RETURNING event_id
          `;
        counts.deletedEventCount += events.length;

        return counts;
      });

      let deletedEventCount = 0;
      let deletedReceiptCount = 0;
      let deletedProjectionRowCount = 0;
      let deletedTurnItemPositionCount = 0;
      let deletedOutboxCount = 0;
      let sweepDeletedRowCount: number;
      do {
        sweepDeletedRowCount = 0;
        for (const batch of batches) {
          const batchCounts = yield* sql.withTransaction(
            Effect.forEach(batch, deleteClosure, { concurrency: 1 }),
          );
          for (const counts of batchCounts) {
            deletedEventCount += counts.deletedEventCount;
            deletedReceiptCount += counts.deletedReceiptCount;
            deletedProjectionRowCount += counts.deletedProjectionRowCount;
            deletedTurnItemPositionCount += counts.deletedTurnItemPositionCount;
            deletedOutboxCount += counts.deletedOutboxCount;
            sweepDeletedRowCount +=
              counts.deletedEventCount +
              counts.deletedReceiptCount +
              counts.deletedProjectionRowCount +
              counts.deletedTurnItemPositionCount +
              counts.deletedOutboxCount;
          }
        }
      } while (sweepDeletedRowCount > 0);

      return {
        reclaimedThreadCount,
        skippedThreads,
        deletedEventCount,
        deletedReceiptCount,
        deletedProjectionRowCount,
        deletedTurnItemPositionCount,
        deletedOutboxCount,
      } satisfies ThreadDataReclamationSummary;
    },
    (effect) =>
      Effect.mapError(
        effect,
        (cause) => new ThreadDataReclamationError({ operation: "reclaim", cause }),
      ),
  );

  const reclaimOperation = Effect.fn("ThreadDataReclamation.reclaimOperation")(function* (
    input: ThreadDataReclamationInput,
  ) {
    let lastOperationRootId = "";
    let reclaimedThreadCount = 0;
    const skippedThreads: Array<ThreadDataReclamationSummary["skippedThreads"][number]> = [];
    let deletedEventCount = 0;
    let deletedReceiptCount = 0;
    let deletedProjectionRowCount = 0;
    let deletedTurnItemPositionCount = 0;
    let deletedOutboxCount = 0;

    while (true) {
      const roots = yield* sql<{ readonly operation_root_thread_id: string }>`
        SELECT DISTINCT deletion.operation_root_thread_id
        FROM orchestration_v2_thread_deletions AS deletion
        INNER JOIN orchestration_v2_projection_threads AS shell
          ON shell.thread_id = deletion.thread_id
        WHERE deletion.scope = 't3_only'
          AND deletion.thread_id = deletion.operation_root_thread_id
          AND shell.deleted_at IS NOT NULL
          AND deletion.operation_root_thread_id > ${lastOperationRootId}
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
        ORDER BY deletion.operation_root_thread_id ASC
        LIMIT ${THREAD_DATA_RECLAMATION_BATCH_SIZE}
      `;
      if (roots.length === 0) break;

      const rootIds = roots.map((row) => row.operation_root_thread_id);
      const candidates = yield* sql<CandidateRow>`
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
          AND deletion.operation_root_thread_id IN ${sql.in(rootIds)}
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
        ORDER BY deletion.operation_root_thread_id ASC, deletion.thread_id ASC
      `;
      const summary = yield* reclaimCandidateBatch(input, candidates);
      reclaimedThreadCount += summary.reclaimedThreadCount;
      skippedThreads.push(...summary.skippedThreads);
      deletedEventCount += summary.deletedEventCount;
      deletedReceiptCount += summary.deletedReceiptCount;
      deletedProjectionRowCount += summary.deletedProjectionRowCount;
      deletedTurnItemPositionCount += summary.deletedTurnItemPositionCount;
      deletedOutboxCount += summary.deletedOutboxCount;
      lastOperationRootId = rootIds.at(-1)!;
      if (roots.length < THREAD_DATA_RECLAMATION_BATCH_SIZE) break;
    }

    skippedThreads.sort((left, right) => left.threadId.localeCompare(right.threadId));
    return {
      reclaimedThreadCount,
      skippedThreads,
      deletedEventCount,
      deletedReceiptCount,
      deletedProjectionRowCount,
      deletedTurnItemPositionCount,
      deletedOutboxCount,
    } satisfies ThreadDataReclamationSummary;
  });

  const reclaim = Effect.fn("ThreadDataReclamation.reclaim")((input: ThreadDataReclamationInput) =>
    reclaimOperation(input).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ThreadDataReclamationError"
          ? cause
          : new ThreadDataReclamationError({ operation: "reclaim", cause }),
      ),
    ),
  );

  return ThreadDataReclamation.of({ reclaim });
});

export const layer: Layer.Layer<ThreadDataReclamation, never, SqlClient.SqlClient> = Layer.effect(
  ThreadDataReclamation,
  make,
);
