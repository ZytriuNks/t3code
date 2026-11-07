import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as NativeSessionBindings from "./NativeSessionBindings.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadDataReclamation from "./ThreadDataReclamation.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ThreadDeletionRecords from "./ThreadDeletionRecords.ts";
import * as ThreadLifecyclePlan from "./ThreadLifecyclePlan.ts";
import * as ThreadOwnership from "./ThreadOwnership.ts";

const layerTest = ThreadDataReclamation.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerCertifiedTest = Layer.mergeAll(
  EventSink.layer,
  ThreadDataReclamation.layer,
  ThreadDeletionRecords.layer,
  EffectOutbox.layer,
  NativeSessionBindings.layer,
  IdAllocator.layer,
).pipe(
  Layer.provideMerge(ThreadOwnership.layer),
  Layer.provideMerge(Layer.mergeAll(EventStore.layer, ProjectionStore.layer)),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerMaintenanceStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerMaintenanceTest = ProjectionMaintenance.layer.pipe(
  Layer.provideMerge(layerMaintenanceStores),
);

const at = "2026-10-31T12:00:00.000Z";

const attachmentIdForThread = (threadId: string) =>
  `${threadId.replace(/[^a-z0-9_-]+/gi, "-")}-11111111-1111-1111-1111-111111111111`;

interface ThreadSeed {
  readonly threadId: string;
  readonly state?: "deleted" | "active" | "archived";
  readonly parentThreadId?: string | null;
  readonly relationshipToParent?: string | null;
  readonly sideChat?: boolean;
  readonly rootThreadId?: string;
  readonly forkedFrom?: unknown;
}

const seedThread = Effect.fn("test.seedThread")(function* (input: ThreadSeed) {
  const sql = yield* SqlClient.SqlClient;
  const state = input.state ?? "deleted";
  const parentThreadId = input.parentThreadId ?? null;
  const relationshipToParent = input.relationshipToParent ?? null;
  const threadId = input.threadId;
  const payloadJson = JSON.stringify({
    lineage: {
      parentThreadId,
      relationshipToParent,
      rootThreadId: input.rootThreadId ?? threadId,
      ...(input.sideChat ? { sideChat: true } : {}),
    },
    forkedFrom: input.forkedFrom ?? null,
  });
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${threadId}, 'project:reclamation', ${threadId}, 'codex', 'full-access', 'default',
      NULL, ${at}, ${at}, ${state === "archived" ? at : null}, ${state === "deleted" ? at : null},
      ${payloadJson}
    )
  `;
});

const seedDeletedThread = Effect.fn("test.seedDeletedThread")(function* (input: {
  readonly threadId: string;
  readonly parentThreadId?: string | null;
  readonly relationshipToParent?: string | null;
  readonly sideChat?: boolean;
  readonly rootThreadId?: string;
  readonly operationRootThreadId?: string;
  readonly commandId?: string;
  readonly insertReceipt?: boolean;
  readonly forkedFrom?: unknown;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* seedThread({ ...input, state: "deleted" });
  const commandId = input.commandId ?? `delete:${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_thread_deletions (
      thread_id, project_id, parent_thread_id, operation_root_thread_id,
      deleted_at, command_id, scope, payload_json
    ) VALUES (
      ${input.threadId}, 'project:reclamation', ${input.parentThreadId ?? null},
      ${input.operationRootThreadId ?? input.threadId}, ${at}, ${commandId}, 't3_only', '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, actor_kind, payload_json, metadata_json, application_event_version
    ) VALUES (
      ${`event:${input.threadId}:deleted`}, 'thread', ${input.threadId}, 1, 'thread.deleted', ${at},
      ${commandId}, 'server', '{}', '{}', 2
    )
  `;
  if (input.insertReceipt !== false) {
    yield* sql`
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
        status, error, command_type
      ) VALUES (
        ${commandId}, 'thread', ${input.operationRootThreadId ?? input.threadId},
        ${at}, 0, 'accepted', NULL, 'thread.delete'
      )
    `;
  }
});

const seedRun = Effect.fn("test.seedRun")(function* (input: {
  readonly threadId: string;
  readonly runId?: string;
  readonly status: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const runId = input.runId ?? `run:${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_thread_id, status,
      requested_at, completed_at, payload_json
    ) VALUES (
      ${runId}, ${input.threadId}, 1, 'codex', NULL, ${input.status}, ${at}, NULL, '{}'
    )
  `;
});

const seedProviderTurn = Effect.fn("test.seedProviderTurn")(function* (input: {
  readonly threadId: string;
  readonly providerTurnId: string;
  readonly status: "pending" | "running";
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_turns (
      provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id,
      ordinal, status, started_at, completed_at, payload_json
    ) VALUES (
      ${input.providerTurnId}, ${input.threadId}, 'provider-thread:active', 'node:active',
      NULL, 1, ${input.status}, ${at}, NULL, '{}'
    )
  `;
});

const seedSubagentOwnership = Effect.fn("test.seedSubagentOwnership")(function* (input: {
  readonly parentThreadId: string;
  readonly childThreadId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_subagents (
      subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id,
      child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json
    ) VALUES (
      ${`subagent:${input.childThreadId}`}, ${input.parentThreadId}, NULL, 'node:parent',
      'codex', NULL, ${input.childThreadId}, 'app', 'completed', ${at}, ${at}, ${at}, '{}'
    )
  `;
});

const seedLifecycleCleanup = Effect.fn("test.seedLifecycleCleanup")(function* (input: {
  readonly threadId: string;
  readonly status: "pending" | "running" | "failed" | "cancelled";
  readonly effectType?: "attachment.cleanup" | "provider-thread.delete" | "provider-session.detach";
}) {
  const sql = yield* SqlClient.SqlClient;
  const commandId = `${input.effectType === "provider-session.detach" ? "retire" : "delete"}:${input.threadId}`;
  const lifecycle = { commandId, rootThreadId: input.threadId, revision: 1 };
  const payload =
    input.effectType === "provider-thread.delete"
      ? {
          driver: "pi",
          providerInstanceId: "pi",
          providerThreadId: `provider-thread:${input.threadId}`,
          threadIds: [input.threadId],
          nativeId: `native:${input.threadId}`,
          nativeStorage: {
            type: "resolved",
            canonicalRoot: "/sessions",
            canonicalFile: `native:${input.threadId}.jsonl`,
          },
          lifecycle,
        }
      : input.effectType === "provider-session.detach"
        ? {
            providerSessionId: `provider-session:${input.threadId}`,
            retirementRevision: 1,
            retirementSourceToken: "source",
          }
        : { lifecycle };
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox (
      effect_id, command_id, thread_id, effect_type, payload_json, status,
      attempt_count, available_at, created_at, updated_at
    ) VALUES (
      ${`cleanup:${input.threadId}`}, ${commandId}, ${input.threadId}, ${input.effectType ?? "attachment.cleanup"},
      ${JSON.stringify(payload)},
      ${input.status}, 0, ${at}, ${at}, ${at}
    )
  `;
});

const bounds = Effect.fn("test.bounds")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly event_through_sequence: number;
    readonly receipt_through_row_id: number;
  }>`
    SELECT
      COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS event_through_sequence,
      COALESCE((SELECT MAX(rowid) FROM orchestration_command_receipts), 0) AS receipt_through_row_id
  `;
  return {
    eventThroughSequence: rows[0]?.event_through_sequence ?? 0,
    receiptThroughRowId: rows[0]?.receipt_through_row_id ?? 0,
  };
});

const snapshotRows = Effect.fn("test.snapshotRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [
    events,
    receipts,
    threads,
    deletions,
    deletionSessions,
    subagents,
    runs,
    attempts,
    nodes,
    runtimeRequests,
    providerSessions,
    providerSessionBindings,
    providerThreads,
    providerTurns,
    nativeBindings,
    outbox,
    transfers,
    handoffs,
    checkpoints,
    checkpointScopes,
    plans,
    messages,
    turnItems,
    positions,
    modelContexts,
    launchWorkflows,
  ] = yield* Effect.all(
    [
      sql`SELECT * FROM orchestration_events ORDER BY sequence`,
      sql`SELECT rowid, * FROM orchestration_command_receipts ORDER BY rowid`,
      sql`SELECT * FROM orchestration_v2_projection_threads ORDER BY thread_id`,
      sql`SELECT * FROM orchestration_v2_thread_deletions ORDER BY thread_id`,
      sql`SELECT * FROM orchestration_v2_thread_deletion_sessions ORDER BY thread_id, session_index`,
      sql`SELECT * FROM orchestration_v2_projection_subagents ORDER BY subagent_id`,
      sql`SELECT * FROM orchestration_v2_projection_runs ORDER BY run_id`,
      sql`SELECT * FROM orchestration_v2_projection_run_attempts ORDER BY attempt_id`,
      sql`SELECT * FROM orchestration_v2_projection_nodes ORDER BY node_id`,
      sql`SELECT * FROM orchestration_v2_projection_runtime_requests ORDER BY runtime_request_id`,
      sql`SELECT * FROM orchestration_v2_projection_provider_sessions ORDER BY provider_session_id`,
      sql`SELECT * FROM orchestration_v2_projection_provider_session_bindings ORDER BY provider_session_id, thread_id`,
      sql`SELECT * FROM orchestration_v2_projection_provider_threads ORDER BY provider_thread_id`,
      sql`SELECT * FROM orchestration_v2_projection_provider_turns ORDER BY provider_turn_id`,
      sql`SELECT * FROM orchestration_v2_native_session_bindings ORDER BY binding_key`,
      sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`,
      sql`SELECT * FROM orchestration_v2_projection_context_transfers ORDER BY context_transfer_id`,
      sql`SELECT * FROM orchestration_v2_projection_context_handoffs ORDER BY context_handoff_id`,
      sql`SELECT * FROM orchestration_v2_projection_checkpoints ORDER BY checkpoint_id`,
      sql`SELECT * FROM orchestration_v2_projection_checkpoint_scopes ORDER BY scope_id`,
      sql`SELECT * FROM orchestration_v2_projection_plans ORDER BY plan_id`,
      sql`SELECT * FROM orchestration_v2_projection_messages ORDER BY message_id`,
      sql`SELECT * FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id`,
      sql`SELECT * FROM orchestration_v2_turn_item_positions ORDER BY thread_id, turn_item_id`,
      sql`SELECT * FROM mcp_app_model_context ORDER BY thread_id, item_id`,
      sql`SELECT * FROM orchestration_v2_thread_launch_workflows ORDER BY command_id`,
    ],
    { concurrency: 1 },
  );
  return {
    events,
    receipts,
    threads,
    deletions,
    deletionSessions,
    subagents,
    runs,
    attempts,
    nodes,
    runtimeRequests,
    providerSessions,
    providerSessionBindings,
    providerThreads,
    providerTurns,
    nativeBindings,
    outbox,
    transfers,
    handoffs,
    checkpoints,
    checkpointScopes,
    plans,
    messages,
    turnItems,
    positions,
    modelContexts,
    launchWorkflows,
  };
});

const seedReclamationRows = Effect.fn("test.seedReclamationRows")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  const runId = `run:${threadId}`;
  const attemptId = `attempt:${threadId}`;
  const nodeId = `node:${threadId}`;
  const providerThreadId = `provider-thread:${threadId}`;
  const providerSessionId = `provider-session:${threadId}`;
  const providerTurnId = `provider-turn:${threadId}`;
  const runtimeRequestId = `runtime-request:${threadId}`;
  const checkpointScopeId = `checkpoint-scope:${threadId}`;
  const turnItemId = `turn-item:${threadId}`;
  const nativeId = `native:${threadId}`;
  const nativeCanonicalFile = `${nativeId}.jsonl`;
  const payloadJson = JSON.stringify({
    id: `message:${threadId}`,
    threadId,
    runId,
    nodeId,
    role: "user",
    text: "reclaim fixture",
    attachments: [
      {
        id: `attachment:${threadId}`,
        type: "file",
        name: "fixture.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      },
    ],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  });

  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, actor_kind, payload_json, metadata_json, application_event_version
    ) VALUES (
      ${`event:${threadId}:created`}, 'thread', ${threadId}, 0, 'thread.created', ${at},
      NULL, 'server', '{}', '{}', 2
    )
  `;
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      command_id, actor_kind, payload_json, metadata_json, application_event_version
    ) VALUES (
      ${`event:${threadId}:updated`}, 'thread', ${threadId}, 2, 'thread.updated', ${at},
      NULL, 'server', '{}', '{}', 2
    )
  `;
  yield* sql`
    INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
      status, error, command_type
    ) VALUES (
      ${`update:${threadId}`}, 'thread', ${threadId}, ${at}, 0,
      'accepted', NULL, 'thread.update'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_thread_id, status,
      requested_at, completed_at, payload_json
    ) VALUES (
      ${runId}, ${threadId}, 1, 'codex', ${providerThreadId}, 'completed', ${at}, ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_run_attempts (
      attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
      provider_thread_id, provider_turn_id, status, payload_json, provider_instance_id
    ) VALUES (
      ${attemptId}, ${threadId}, ${runId}, 1, ${nodeId}, 'codex',
      ${providerThreadId}, ${providerTurnId}, 'completed', '{}', 'codex'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_nodes (
      node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
      provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
      started_at, completed_at, payload_json
    ) VALUES (
      ${nodeId}, ${threadId}, ${runId}, NULL, ${nodeId}, 'agent', 'completed',
      ${providerThreadId}, ${providerTurnId}, ${runtimeRequestId}, ${checkpointScopeId},
      ${at}, ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_context_handoffs (
      context_handoff_id, thread_id, target_run_id, to_provider_thread_id,
      strategy, status, updated_at, payload_json
    ) VALUES (
      ${`handoff:${threadId}`}, ${threadId}, ${runId}, ${providerThreadId},
      'reuse', 'completed', ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_context_transfers (
      context_transfer_id, source_thread_id, target_thread_id, target_run_id,
      type, status, source_provider, target_provider, updated_at,
      source_provider_instance_id, target_provider_instance_id, payload_json
    ) VALUES (
      ${`transfer:${threadId}`}, ${threadId}, ${threadId}, ${runId},
      'fork', 'completed', 'codex', 'codex', ${at}, 'codex', 'codex', '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_checkpoint_scopes (
      scope_id, thread_id, run_id, node_id, parent_scope_id, provider_thread_id,
      kind, ordinal_within_parent, advances_app_run_count, created_at, payload_json
    ) VALUES (
      ${checkpointScopeId}, ${threadId}, ${runId}, ${nodeId}, NULL, ${providerThreadId},
      'run', 1, 1, ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_checkpoints (
      checkpoint_id, thread_id, scope_id, run_id, node_id, parent_checkpoint_id,
      ordinal_within_scope, app_run_ordinal, status, captured_at, payload_json
    ) VALUES (
      ${`checkpoint:${threadId}`}, ${threadId}, ${checkpointScopeId}, ${runId}, ${nodeId}, NULL,
      1, 1, 'completed', ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runtime_requests (
      runtime_request_id, thread_id, node_id, provider_turn_id, kind, status,
      created_at, resolved_at, payload_json
    ) VALUES (
      ${runtimeRequestId}, ${threadId}, ${nodeId}, ${providerTurnId}, 'approval',
      'resolved', ${at}, ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_plans (
      plan_id, thread_id, run_id, node_id, kind, status, payload_json
    ) VALUES (
      ${`plan:${threadId}`}, ${threadId}, ${runId}, ${nodeId}, 'execution', 'completed', '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_messages (
      message_id, thread_id, run_id, node_id, role, streaming,
      created_at, updated_at, payload_json
    ) VALUES (
      ${`message:${threadId}`}, ${threadId}, ${runId}, ${nodeId}, 'user', 0, ${at}, ${at}, ${payloadJson}
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_turn_items (
      turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
      parent_item_id, ordinal, type, status, updated_at, payload_json
    ) VALUES (
      ${turnItemId}, ${threadId}, ${runId}, ${nodeId}, ${providerThreadId}, ${providerTurnId},
      NULL, 1, 'assistant_message', 'completed', ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
    VALUES (${threadId}, ${turnItemId}, 1)
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_sessions (
      provider_session_id, thread_id, provider, status, model, updated_at,
      payload_json, driver, provider_instance_id
    ) VALUES (
      ${providerSessionId}, ${threadId}, 'codex', 'idle', NULL, ${at}, '{}', 'codex', 'codex'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_session_bindings (
      provider_session_id, thread_id
    ) VALUES (${providerSessionId}, ${threadId})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id, thread_id, owner_node_id, provider, provider_session_id,
      status, first_run_ordinal, last_run_ordinal, updated_at, payload_json,
      driver, provider_instance_id
    ) VALUES (
      ${providerThreadId}, ${threadId}, ${nodeId}, 'codex', ${providerSessionId},
      'completed', 1, 1, ${at}, '{}', 'codex', 'codex'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_turns (
      provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id,
      ordinal, status, started_at, completed_at, payload_json
    ) VALUES (
      ${providerTurnId}, ${threadId}, ${providerThreadId}, ${nodeId}, ${attemptId},
      1, 'completed', ${at}, ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_subagents (
      subagent_id, thread_id, run_id, parent_node_id, provider, provider_thread_id,
      child_thread_id, origin, status, started_at, completed_at, updated_at, payload_json
    ) VALUES (
      ${`subagent:${threadId}`}, ${threadId}, ${runId}, ${nodeId}, 'codex', ${providerThreadId},
      NULL, 'app', 'completed', ${at}, ${at}, ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_native_session_bindings (
      binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
      native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
    ) VALUES (
      ${`native-binding:${threadId}`}, ${threadId}, ${providerThreadId}, 'codex', 'codex',
      ${nativeId}, 'resolved', '/sessions', ${nativeCanonicalFile}, ${at}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_thread_deletion_sessions (
      thread_id, session_index, provider_thread_id, provider_instance_id, driver,
      native_id, storage_type, canonical_root, canonical_file, payload_json
    ) VALUES (
      ${threadId}, 0, ${providerThreadId}, 'codex', 'codex',
      ${nativeId}, 'resolved', '/sessions', ${nativeCanonicalFile}, '{}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox (
      effect_id, command_id, thread_id, effect_type, payload_json, status,
      attempt_count, available_at, created_at, updated_at, completed_at
    ) VALUES (
      ${`outbox:${threadId}`}, ${`settled:${threadId}`}, ${threadId}, 'preview.cleanup', '{}',
      'succeeded', 1, ${at}, ${at}, ${at}, ${at}
    )
  `;
});

const reclaim = Effect.fn("test.reclaim")(function* () {
  const service = yield* ThreadDataReclamation.ThreadDataReclamation;
  return yield* service.reclaim(yield* bounds());
});

const expectBlockers = (
  result: ThreadDataReclamation.ThreadDataReclamationSummary,
  threadId: string,
  blockerCodes: ReadonlyArray<ThreadDataReclamation.ThreadDataReclamationBlockerCode>,
) => {
  const skipped = result.skippedThreads.find((entry) => entry.threadId === threadId);
  assert.isDefined(skipped, `expected ${threadId} to be skipped`);
  assert.deepEqual(skipped.blockerCodes, blockerCodes);
};

it.effect("reclaim skips archived and active threads and considers only t3 deletion records", () =>
  Effect.gen(function* () {
    yield* seedThread({ threadId: "thread:active", state: "active" });
    yield* seedThread({ threadId: "thread:archived", state: "archived" });
    yield* seedDeletedThread({ threadId: "thread:eligible" });
    yield* seedDeletedThread({ threadId: "thread:busy" });
    yield* seedRun({ threadId: "thread:busy", status: "running" });
    yield* seedDeletedThread({ threadId: "thread:busy-provider-turn" });
    yield* seedProviderTurn({
      threadId: "thread:busy-provider-turn",
      providerTurnId: "provider-turn:busy",
      status: "running",
    });

    const result = yield* reclaim();

    assert.equal(result.reclaimedThreadCount, 1);
    expectBlockers(result, "thread:busy", ["active_work"]);
    expectBlockers(result, "thread:busy-provider-turn", ["active_work"]);
    assert.deepEqual(
      result.skippedThreads.map((entry) => entry.threadId),
      ["thread:busy", "thread:busy-provider-turn"],
    );
    assert.equal(result.deletedEventCount, 0);
    assert.equal(result.deletedReceiptCount, 0);
    assert.equal(result.deletedProjectionRowCount, 0);
    assert.equal(result.deletedTurnItemPositionCount, 0);
    assert.equal(result.deletedOutboxCount, 0);

    // The supplied high-water marks exclude deletion records committed afterward.
    const oldBounds = yield* bounds();
    yield* seedDeletedThread({ threadId: "thread:after-bounds" });
    const boundedService = yield* ThreadDataReclamation.ThreadDataReclamation;
    const bounded = yield* boundedService.reclaim(oldBounds);
    assert.equal(bounded.reclaimedThreadCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaim groups deleted subagent members into one eligible closure", () =>
  Effect.gen(function* () {
    const rootCommandId = "delete:thread:parent";
    yield* seedDeletedThread({ threadId: "thread:parent", commandId: rootCommandId });
    yield* seedDeletedThread({
      threadId: "thread:child",
      parentThreadId: "thread:parent",
      relationshipToParent: "subagent",
      rootThreadId: "thread:parent",
      operationRootThreadId: "thread:parent",
      commandId: rootCommandId,
      insertReceipt: false,
    });
    yield* seedSubagentOwnership({
      parentThreadId: "thread:parent",
      childThreadId: "thread:child",
    });

    const result = yield* reclaim();

    assert.equal(result.reclaimedThreadCount, 2);
    assert.deepEqual(result.skippedThreads, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaim matches descendant deletion records to the operation root receipt", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const commandId = "delete:cascade-root";
    yield* seedDeletedThread({ threadId: "thread:receipt-root", commandId });
    yield* seedDeletedThread({
      threadId: "thread:receipt-child",
      parentThreadId: "thread:receipt-root",
      relationshipToParent: "subagent",
      rootThreadId: "thread:receipt-root",
      operationRootThreadId: "thread:receipt-root",
      commandId,
      insertReceipt: false,
    });
    yield* seedSubagentOwnership({
      parentThreadId: "thread:receipt-root",
      childThreadId: "thread:receipt-child",
    });
    yield* seedDeletedThread({
      threadId: "thread:receipt-side-chat",
      parentThreadId: "thread:receipt-root",
      relationshipToParent: "fork",
      sideChat: true,
      rootThreadId: "thread:receipt-root",
      operationRootThreadId: "thread:receipt-root",
      commandId,
      insertReceipt: false,
      forkedFrom: { type: "run", threadId: "thread:receipt-root", runId: "run:receipt-root" },
    });
    yield* seedDeletedThread({
      threadId: "thread:receipt-side-chat-child",
      parentThreadId: "thread:receipt-side-chat",
      relationshipToParent: "subagent",
      rootThreadId: "thread:receipt-root",
      operationRootThreadId: "thread:receipt-root",
      commandId,
      insertReceipt: false,
    });
    yield* seedSubagentOwnership({
      parentThreadId: "thread:receipt-side-chat",
      childThreadId: "thread:receipt-side-chat-child",
    });

    const receipts = yield* sql<{ readonly command_id: string; readonly aggregate_id: string }>`
      SELECT command_id, aggregate_id FROM orchestration_command_receipts
    `;
    assert.deepEqual(receipts, [{ command_id: commandId, aggregate_id: "thread:receipt-root" }]);
    yield* seedRun({ threadId: "thread:receipt-side-chat", status: "completed" });
    yield* seedRun({ threadId: "thread:receipt-side-chat-child", status: "completed" });
    const before = yield* snapshotRows();

    const result = yield* reclaim();

    assert.equal(result.reclaimedThreadCount, 4);
    assert.deepEqual(result.skippedThreads, []);
    const after = yield* snapshotRows();
    assert.deepEqual(after.deletions, before.deletions);
    assert.deepEqual(after.receipts, before.receipts);
    assert.deepEqual(after.threads, before.threads);
    assert.lengthOf(after.runs, 0);
    assert.lengthOf(after.subagents, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "ordinary-fork",
  "self-rooted-fork",
  "other-command",
  "other-parent",
  "other-project",
] as const)("does not authorize a fork with a parent deletion receipt: %s", (mismatch) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const parentId = "thread:fork-receipt-parent";
    const forkId = "thread:fork-receipt-child";
    const parentCommandId = "delete:fork-receipt-parent";
    const commandId = mismatch === "other-command" ? "delete:fork-receipt-other" : parentCommandId;
    const lineageParentId = mismatch === "other-parent" ? "thread:unrelated-parent" : parentId;
    yield* seedDeletedThread({ threadId: parentId, commandId: parentCommandId });
    yield* seedDeletedThread({
      threadId: forkId,
      parentThreadId: lineageParentId,
      relationshipToParent: "fork",
      sideChat: mismatch !== "ordinary-fork" && mismatch !== "self-rooted-fork",
      rootThreadId: parentId,
      operationRootThreadId: mismatch === "self-rooted-fork" ? forkId : parentId,
      commandId,
      insertReceipt: false,
      forkedFrom: { type: "run", threadId: lineageParentId, runId: "run:fork-receipt-parent" },
    });
    yield* seedRun({ threadId: forkId, status: "completed" });
    if (mismatch === "other-command") {
      yield* sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
          status, error, command_type
        ) VALUES (${commandId}, 'thread', ${parentId}, ${at}, 0, 'accepted', NULL, 'thread.delete')
      `;
    }
    if (mismatch === "other-project") {
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET project_id = 'project:other' WHERE thread_id = ${forkId}
      `;
      yield* sql`
        UPDATE orchestration_v2_thread_deletions
        SET project_id = 'project:other' WHERE thread_id = ${forkId}
      `;
    }
    const before = yield* snapshotRows();

    const result = yield* reclaim();

    assert.deepEqual((yield* snapshotRows()).runs, before.runs);
    if (mismatch === "self-rooted-fork") {
      assert.equal(result.reclaimedThreadCount, 1);
    } else {
      assert.equal(result.reclaimedThreadCount, 0);
      expectBlockers(result, forkId, ["unknown_dependency"]);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["ordinary-fork", "side-chat", "malformed-side-chat"] as const)(
  "requires explicit side-chat lineage for a runless fork: %s",
  (shape) =>
    Effect.gen(function* () {
      const parentId = "thread:runless-fork-parent";
      const forkId = "thread:runless-fork-child";
      yield* seedThread({ threadId: parentId, state: "active" });
      yield* seedDeletedThread({
        threadId: forkId,
        parentThreadId: parentId,
        relationshipToParent: "fork",
        sideChat: shape !== "ordinary-fork",
        rootThreadId: parentId,
        forkedFrom: shape === "malformed-side-chat" ? {} : null,
      });
      yield* seedRun({ threadId: forkId, status: "completed" });
      const before = yield* snapshotRows();

      const result = yield* reclaim();

      const after = yield* snapshotRows();
      if (shape === "side-chat") {
        assert.equal(result.reclaimedThreadCount, 1);
        assert.deepEqual(result.skippedThreads, []);
        assert.lengthOf(after.runs, 0);
      } else {
        assert.equal(result.reclaimedThreadCount, 0);
        expectBlockers(result, forkId, ["unknown_dependency"]);
        assert.deepEqual(after, before);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaim blocks pending running failed and cancelled lifecycle cleanup", () =>
  Effect.gen(function* () {
    for (const effectType of [
      "attachment.cleanup",
      "provider-thread.delete",
      "provider-session.detach",
    ] as const) {
      for (const status of ["pending", "running", "failed", "cancelled"] as const) {
        const threadId = `thread:cleanup:${effectType}:${status}`;
        yield* seedDeletedThread({ threadId });
        yield* seedReclamationRows(threadId);
        yield* seedLifecycleCleanup({ threadId, status, effectType });
      }
    }

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    for (const effectType of [
      "attachment.cleanup",
      "provider-thread.delete",
      "provider-session.detach",
    ] as const) {
      for (const status of ["pending", "running", "failed", "cancelled"] as const) {
        expectBlockers(result, `thread:cleanup:${effectType}:${status}`, ["lifecycle_cleanup"]);
      }
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["missing", "different-file", "legacy-projection", "recorded"] as const)(
  "reclaims Pi identities only when their tombstone records the same file (%s)",
  (snapshot) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = `thread:reclaim:pi-identity:${snapshot}`;
      yield* seedDeletedThread({ threadId });
      yield* seedReclamationRows(threadId);
      yield* sql`UPDATE orchestration_v2_native_session_bindings SET driver = 'pi'
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_thread_deletion_sessions SET driver = 'pi'
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET driver = 'pi',
        payload_json = ${JSON.stringify({
          nativeThreadRef: { nativeId: `native:${threadId}` },
          nativeStorage: {
            type: "resolved",
            canonicalRoot: "/sessions",
            canonicalFile: `native:${threadId}.jsonl`,
          },
        })} WHERE thread_id = ${threadId}`;
      if (snapshot === "legacy-projection")
        yield* sql`DELETE FROM orchestration_v2_native_session_bindings WHERE thread_id = ${threadId}`;
      if (snapshot === "missing" || snapshot === "legacy-projection")
        yield* sql`DELETE FROM orchestration_v2_thread_deletion_sessions WHERE thread_id = ${threadId}`;
      if (snapshot === "different-file")
        yield* sql`UPDATE orchestration_v2_thread_deletion_sessions SET canonical_file = 'other.jsonl'
          WHERE thread_id = ${threadId}`;

      const before = yield* snapshotRows();
      const summary = yield* reclaim();
      if (snapshot !== "recorded") {
        assert.equal(summary.reclaimedThreadCount, 0);
        expectBlockers(summary, threadId, ["unknown_dependency"]);
        assert.deepEqual(yield* snapshotRows(), before);
      } else {
        assert.equal(summary.reclaimedThreadCount, 1);
        assert.isAbove(summary.deletedProjectionRowCount, 0);
        assert.isEmpty((yield* snapshotRows()).nativeBindings);
      }
      const bindings = yield* NativeSessionBindings.NativeSessionBindings;
      assert.equal(
        yield* bindings.checkImport({
          driver: ProviderDriverKind.make("pi"),
          providerInstanceId: ProviderInstanceId.make("pi"),
          nativeId: `native:${threadId}`,
          storage: {
            type: "resolved",
            canonicalRoot: "/sessions",
            canonicalFile: `native:${threadId}.jsonl`,
          },
        }),
        "deleted",
      );
    }).pipe(Effect.provide(NativeSessionBindings.layer.pipe(Layer.provideMerge(layerTest)))),
);

it.effect.each([
  "complete",
  "missing-file",
  "missing-root",
  "unresolved",
  "different-file",
  "shared-file",
  "shared-legacy-file",
] as const)(
  "reclaims a null-native-id Pi file only with exclusive complete identity (%s)",
  (identity) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = `thread:null-native:${identity}`;
      yield* seedDeletedThread({ threadId });
      yield* seedReclamationRows(threadId);
      const storage = {
        type: identity === "unresolved" ? "unresolved" : "resolved",
        canonicalRoot: identity === "missing-root" ? "" : "/sessions",
        canonicalFile: identity === "missing-file" ? "" : "null-native.jsonl",
      };
      yield* sql`UPDATE orchestration_v2_native_session_bindings
      SET driver = 'pi', native_id = NULL, storage_type = ${storage.type},
        canonical_root = ${storage.canonicalRoot}, canonical_file = ${storage.canonicalFile}
      WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_thread_deletion_sessions
      SET driver = 'pi', native_id = NULL, storage_type = ${storage.type},
        canonical_root = ${storage.canonicalRoot},
        canonical_file = ${identity === "different-file" ? "other.jsonl" : storage.canonicalFile}
      WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET driver = 'pi',
      payload_json = ${JSON.stringify({ nativeThreadRef: { nativeId: null }, nativeStorage: storage })}
      WHERE thread_id = ${threadId}`;
      yield* seedLifecycleCleanup({
        threadId,
        status: "failed",
        effectType: "provider-thread.delete",
      });
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded',
      payload_json = ${JSON.stringify({
        driver: "pi",
        providerInstanceId: "codex",
        providerThreadId: `provider-thread:${threadId}`,
        nativeId: null,
        nativeStorage: storage,
        threadIds: [threadId],
        lifecycle: { commandId: `delete:${threadId}`, rootThreadId: threadId, revision: 1 },
      })} WHERE effect_id = ${`cleanup:${threadId}`}`;
      if (identity === "shared-file") {
        yield* seedThread({ threadId: "thread:null-native:live", state: "active" });
        yield* sql`INSERT INTO orchestration_v2_native_session_bindings (
        binding_key, thread_id, provider_thread_id, provider_instance_id, driver, native_id,
        storage_type, canonical_root, canonical_file, bound_at, payload_json
      ) VALUES ('shared-null-native', 'thread:null-native:live', 'provider-thread:live', 'pi', 'pi',
        'another-native-id', 'resolved', '/sessions', 'null-native.jsonl', ${at}, '{}')`;
      }
      if (identity === "shared-legacy-file") {
        yield* seedThread({ threadId: "thread:null-native:legacy-live", state: "active" });
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (
          provider_thread_id, thread_id, owner_node_id, provider, provider_session_id,
          status, first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver, provider_instance_id
        ) VALUES ('provider-thread:legacy-live', 'thread:null-native:legacy-live', NULL, 'codex', NULL,
          'closed', NULL, NULL, ${at},
          ${JSON.stringify({ nativeThreadRef: { nativeId: null }, nativeStorage: storage })}, 'pi', 'pi')`;
      }
      const before = yield* snapshotRows();
      const result = yield* reclaim();
      if (identity === "complete") {
        assert.equal(result.reclaimedThreadCount, 1);
        assert.deepEqual(result.skippedThreads, []);
        assert.isEmpty((yield* snapshotRows()).nativeBindings);
        assert.isEmpty((yield* snapshotRows()).runs);
        const bindings = yield* NativeSessionBindings.NativeSessionBindings;
        assert.equal(
          yield* bindings.checkImport({
            driver: ProviderDriverKind.make("pi"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            nativeId: "reimport-native-id",
            storage: {
              type: "resolved",
              canonicalRoot: "/sessions",
              canonicalFile: "null-native.jsonl",
            },
          }),
          "deleted",
        );
      } else {
        assert.equal(result.reclaimedThreadCount, 0);
        expectBlockers(result, threadId, [
          identity.startsWith("shared-") ? "shared_native_session" : "unknown_dependency",
        ]);
        assert.deepEqual(yield* snapshotRows(), before);
      }
    }).pipe(Effect.provide(NativeSessionBindings.layer.pipe(Layer.provideMerge(layerTest)))),
);

it.effect.each([
  "binding",
  "projection",
  "late-binding",
  "late-projection",
  "unresolved-projection",
  "missing-locator-projection",
  "damaged-projection",
  "unresolved-native-ref-projection",
  "codex-projection",
  "codex-damaged-projection",
] as const)(
  "maintenance respects retained identity requirements for legacy tombstones (%s)",
  (source) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = `thread:legacy-t3-only:${source}`;
      const providerThreadId = `provider-thread:${threadId}`;
      const updatedAt = source.startsWith("late-") ? "2026-11-02T12:00:00.000Z" : at;
      const driver = source.startsWith("codex-") ? "codex" : "pi";
      const storage = {
        type: "resolved",
        canonicalRoot: "/sessions",
        canonicalFile: "/sessions/legacy.jsonl",
      };
      const deletion = {
        threadId,
        projectId: "project:reclamation",
        parentThreadId: null,
        operationRootThreadId: threadId,
        deletedAt: at,
        commandId: `delete:${threadId}`,
        scope: "t3_only",
        sessions: [],
      };
      yield* seedDeletedThread({ threadId });
      yield* seedRun({ threadId, status: "completed" });
      yield* sql`UPDATE orchestration_v2_thread_deletions SET payload_json = ${JSON.stringify(deletion)}
      WHERE thread_id = ${threadId}`;
      if (source.endsWith("binding")) {
        const binding = {
          threadId,
          providerThreadId,
          providerInstanceId: "pi-retained",
          driver: "pi",
          nativeId: "legacy-native",
          storage,
          boundAt: updatedAt,
        };
        yield* sql`INSERT INTO orchestration_v2_native_session_bindings (
        binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
        native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
      ) VALUES (${`binding:${threadId}`}, ${threadId}, ${providerThreadId}, 'pi-retained', 'pi',
        'legacy-native', 'resolved', '/sessions', '/sessions/legacy.jsonl', ${updatedAt}, ${JSON.stringify(binding)})`;
      } else {
        const provider = {
          id: providerThreadId,
          appThreadId: threadId,
          driver,
          providerInstanceId: "pi-retained",
          providerSessionId: null,
          ownerNodeId: null,
          status: "closed",
          nativeThreadRef:
            source === "unresolved-projection" ||
            source === "missing-locator-projection" ||
            source === "codex-projection"
              ? null
              : { driver, nativeId: "legacy-native", strength: "strong" },
          nativeStorage:
            source === "missing-locator-projection"
              ? null
              : source === "unresolved-projection" ||
                  source === "unresolved-native-ref-projection" ||
                  source === "codex-projection"
                ? { type: "unresolved", reason: "legacy_missing_locator" }
                : storage,
          nativeConversationHeadRef: null,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: at,
          updatedAt,
        };
        yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, owner_node_id, provider, provider_session_id,
        status, first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver, provider_instance_id
      ) VALUES (${providerThreadId}, ${threadId}, NULL, 'codex', NULL, 'closed', NULL, NULL,
        ${updatedAt}, ${source.includes("damaged") ? "{}" : JSON.stringify(provider)}, ${driver}, 'pi-retained')`;
      }
      const before = yield* snapshotRows();
      const result = yield* reclaim();
      if (
        source === "unresolved-projection" ||
        source === "missing-locator-projection" ||
        source === "damaged-projection" ||
        source === "unresolved-native-ref-projection"
      ) {
        assert.isEmpty(before.nativeBindings);
        assert.isEmpty(before.deletionSessions);
        assert.lengthOf(before.runs, 1);
        assert.lengthOf(before.providerThreads, 1);
        assert.equal(result.reclaimedThreadCount, 0);
        expectBlockers(result, threadId, ["unknown_dependency"]);
        const after = yield* snapshotRows();
        if (source === "unresolved-native-ref-projection") {
          assert.deepEqual(after.runs, before.runs);
          assert.deepEqual(after.providerThreads, before.providerThreads);
          assert.lengthOf(after.deletionSessions, 1);
          assert.equal(after.deletionSessions[0]!.storage_type, "unresolved");
        } else {
          assert.deepEqual(after, before);
        }
        return;
      }
      assert.equal(result.reclaimedThreadCount, 1);
      assert.deepEqual(result.skippedThreads, []);
      const after = yield* snapshotRows();
      assert.isEmpty(after.runs);
      assert.isEmpty(after.nativeBindings);
      assert.isEmpty(after.providerThreads);
      assert.isEmpty(after.outbox);
      const saved = JSON.parse(String(after.deletions[0]!.payload_json));
      assert.deepEqual({ ...saved, sessions: [] }, deletion);
      if (driver !== "pi") {
        assert.isEmpty(after.deletionSessions);
        assert.deepEqual(saved.sessions, []);
        return;
      }
      assert.lengthOf(after.deletionSessions, 1);
      assert.equal(saved.sessions[0].providerInstanceId, "pi-retained");
      assert.equal(saved.sessions[0].providerThreadId, providerThreadId);
      const bindings = yield* NativeSessionBindings.NativeSessionBindings;
      assert.equal(
        yield* bindings.checkImport({
          driver: ProviderDriverKind.make("pi"),
          providerInstanceId: ProviderInstanceId.make("pi-new"),
          nativeId: "legacy-native",
          storage: {
            type: "resolved",
            canonicalRoot: "/sessions",
            canonicalFile: "/sessions/legacy.jsonl",
          },
        }),
        "deleted",
      );
      const snapshots = after.deletionSessions;
      yield* reclaim();
      assert.deepEqual((yield* snapshotRows()).deletionSessions, snapshots);
    }).pipe(Effect.provide(NativeSessionBindings.layer.pipe(Layer.provideMerge(layerTest)))),
);

it.effect("reclaim blocks a deleted source with a surviving fork or pending context transfer", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedDeletedThread({ threadId: "thread:fork-source" });
    yield* seedThread({
      threadId: "thread:fork-reader",
      state: "active",
      parentThreadId: "thread:fork-source",
      relationshipToParent: "fork",
      forkedFrom: { type: "run", threadId: "thread:fork-source", runId: "run:source" },
    });

    yield* seedDeletedThread({ threadId: "thread:transfer-source" });
    yield* seedThread({ threadId: "thread:transfer-target", state: "active" });
    yield* sql`
        INSERT INTO orchestration_v2_projection_context_transfers (
          context_transfer_id, source_thread_id, target_thread_id, target_run_id,
          type, status, source_provider, target_provider, updated_at,
          source_provider_instance_id, target_provider_instance_id, payload_json
        ) VALUES (
          'transfer:pending', 'thread:transfer-source', 'thread:transfer-target', NULL,
          'fork', 'pending', 'codex', 'codex', ${at}, 'codex', 'codex', '{}'
        )
      `;

    // This unresolved parent edge cannot be treated as an owned subagent or a known fork.
    yield* seedThread({
      threadId: "thread:unknown-edge-reader",
      state: "active",
      parentThreadId: "thread:unknown-source",
      relationshipToParent: "unrecognized",
    });
    yield* seedDeletedThread({ threadId: "thread:unknown-source" });

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    expectBlockers(result, "thread:fork-source", ["surviving_fork"]);
    expectBlockers(result, "thread:transfer-source", ["pending_transfer"]);
    expectBlockers(result, "thread:unknown-source", ["unknown_dependency"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reclaim blocks shared provider sessions and attachments while allowing an exclusive deleted thread",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedDeletedThread({ threadId: "thread:shared-provider" });
      yield* seedThread({ threadId: "thread:live-provider", state: "active" });
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_sessions (
          provider_session_id, thread_id, provider, status, model, updated_at,
          payload_json, driver, provider_instance_id
        ) VALUES ('provider:shared', 'thread:shared-provider', 'codex', 'idle', NULL, ${at}, '{}', 'codex', 'codex')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_session_bindings (
          provider_session_id, thread_id
        ) VALUES ('provider:shared', 'thread:shared-provider'), ('provider:shared', 'thread:live-provider')
      `;

      yield* seedDeletedThread({ threadId: "thread:shared-native" });
      yield* seedThread({ threadId: "thread:live-native", state: "active" });
      const nativePayload = JSON.stringify({
        driver: "codex",
        providerInstanceId: "codex",
        nativeId: "native:shared",
        storage: { type: "resolved", canonicalRoot: "/sessions" },
      });
      for (const [bindingKey, threadId] of [
        ["native:deleted", "thread:shared-native"],
        ["native:live", "thread:live-native"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_native_session_bindings (
            binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
            native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
          ) VALUES (
            ${bindingKey}, ${threadId}, 'provider-thread:shared', 'codex', 'codex',
            'native:shared', 'resolved', '/sessions', '', ${at}, ${nativePayload}
          )
        `;
      }
      yield* sql`
        INSERT INTO orchestration_v2_thread_deletion_sessions (
          thread_id, session_index, provider_thread_id, provider_instance_id, driver,
          native_id, storage_type, canonical_root, canonical_file, payload_json
        ) VALUES (
          'thread:shared-native', 0, 'provider-thread:shared', 'codex', 'codex',
          'native:shared', 'resolved', '/sessions', '', ${nativePayload}
        )
      `;

      yield* seedDeletedThread({ threadId: "thread:shared-attachment" });
      yield* seedThread({ threadId: "thread:live-attachment", state: "active" });
      for (const [messageId, threadId] of [
        ["message:deleted-attachment", "thread:shared-attachment"],
        ["message:live-attachment", "thread:live-attachment"],
      ] as const) {
        const payloadJson = JSON.stringify({
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: "",
          attachments: [
            {
              id: "attachment:shared",
              type: "file",
              name: "shared.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, run_id, node_id, role, streaming,
            created_at, updated_at, payload_json
          ) VALUES (${messageId}, ${threadId}, NULL, NULL, 'user', 0, ${at}, ${at}, ${payloadJson})
        `;
      }

      yield* seedDeletedThread({ threadId: "thread:exclusive" });
      const before = yield* snapshotRows();
      const result = yield* reclaim();
      const after = yield* snapshotRows();

      assert.deepEqual(after, before);
      assert.equal(result.reclaimedThreadCount, 1);
      expectBlockers(result, "thread:shared-provider", ["shared_provider_session"]);
      expectBlockers(result, "thread:shared-native", ["shared_native_session"]);
      expectBlockers(result, "thread:shared-attachment", ["shared_attachment"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("blocks resources shared by different deleted operation roots", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const roots = ["thread:cross-root:a", "thread:cross-root:b"] as const;
    const attachmentId = "attachment:cross-root-shared";
    for (const threadId of roots) {
      yield* seedDeletedThread({ threadId });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json
        ) VALUES (
          ${`message:${threadId}`}, ${threadId}, NULL, NULL, 'user', 0,
          ${at}, ${at}, ${JSON.stringify({ attachments: [{ id: attachmentId }] })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_native_session_bindings (
          binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
          native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
        ) VALUES (
          ${`native-binding:${threadId}`}, ${threadId}, ${`provider-thread:${threadId}`},
          'codex', 'codex', 'native:cross-root-shared', 'resolved', '/sessions',
          'cross-root-shared.jsonl', ${at}, '{}'
        )
      `;
    }
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, status, model, updated_at,
        payload_json, driver, provider_instance_id
      ) VALUES (
        'provider-session:cross-root-shared', ${roots[0]}, 'codex', 'idle', NULL,
        ${at}, '{}', 'codex', 'codex'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_session_bindings (
        provider_session_id, thread_id
      ) VALUES
        ('provider-session:cross-root-shared', ${roots[0]}),
        ('provider-session:cross-root-shared', ${roots[1]})
    `;

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    for (const threadId of roots) {
      expectBlockers(result, threadId, [
        "shared_provider_session",
        "shared_native_session",
        "shared_attachment",
      ]);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves a detached provider session owned by a later failed chunk", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rootThreadId = "thread:reclaim:detached-session:root";
    const deleteCommandId = `delete:${rootThreadId}`;
    const childCount = ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE + 1;
    const childThreadIds: Array<string> = [];
    for (let index = 0; index < childCount; index++) {
      const childThreadId = `thread:reclaim:detached-session:${String(index).padStart(3, "0")}`;
      childThreadIds.push(childThreadId);
      yield* seedDeletedThread({
        threadId: childThreadId,
        parentThreadId: rootThreadId,
        relationshipToParent: "subagent",
        rootThreadId,
        operationRootThreadId: rootThreadId,
        commandId: deleteCommandId,
        insertReceipt: false,
      });
      yield* seedSubagentOwnership({ parentThreadId: rootThreadId, childThreadId });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json
        ) VALUES (
          ${`message:${childThreadId}`}, ${childThreadId}, NULL, NULL, 'user', 0,
          ${at}, ${at}, '{}'
        )
      `;
    }
    yield* seedDeletedThread({
      threadId: rootThreadId,
      commandId: deleteCommandId,
    });
    const failedChildThreadId = childThreadIds.at(-1)!;
    const detachedProviderSessionId = "provider-session:detached-later";
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, status, model, updated_at,
        payload_json, driver, provider_instance_id
      ) VALUES (
        ${detachedProviderSessionId}, ${failedChildThreadId}, 'codex', 'idle', NULL,
        ${at}, '{}', 'codex', 'codex'
      )
    `;
    yield* sql`
      CREATE TRIGGER reject_reclamation_detached_session_second_chunk
      BEFORE DELETE ON orchestration_v2_projection_messages
      WHEN OLD.thread_id = 'thread:reclaim:detached-session:050'
      BEGIN SELECT RAISE(ABORT, 'injected detached-session second-chunk failure'); END
    `;

    const failed = yield* Effect.exit(reclaim());
    assert.isTrue(Exit.isFailure(failed));
    const retainedSession = yield* sql<{ readonly provider_session_id: string }>`
      SELECT provider_session_id
      FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${detachedProviderSessionId}
    `;
    assert.deepEqual(retainedSession, [{ provider_session_id: detachedProviderSessionId }]);

    yield* sql`DROP TRIGGER reject_reclamation_detached_session_second_chunk`;
    const resumed = yield* reclaim();
    assert.equal(resumed.reclaimedThreadCount, childCount + 1);
    const removedSession = yield* sql`
      SELECT provider_session_id
      FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${detachedProviderSessionId}
    `;
    assert.deepEqual(removedSession, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves non-delete receipts referenced by retained outbox rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:receipt-outbox";
    const commandId = `update:${threadId}`;
    yield* seedDeletedThread({ threadId });
    yield* sql`
      INSERT INTO orchestration_command_receipts (
        command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
        status, error, command_type
      ) VALUES (
        ${commandId}, 'thread', ${threadId}, ${at}, 0,
        'accepted', NULL, 'thread.update'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox (
        effect_id, command_id, thread_id, effect_type, payload_json, status,
        attempt_count, available_at, created_at, updated_at
      ) VALUES (
        ${`outbox:${commandId}`}, ${commandId}, ${threadId}, 'preview.cleanup', '{}',
        'pending', 0, ${at}, ${at}, ${at}
      )
    `;

    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.equal(result.reclaimedThreadCount, 1);
    assert.equal(result.deletedReceiptCount, 0);
    assert.deepEqual(
      after.receipts.map((row) => ({ command_id: row.command_id, command_type: row.command_type })),
      [
        { command_id: `delete:${threadId}`, command_type: "thread.delete" },
        { command_id: commandId, command_type: "thread.update" },
      ],
    );
    assert.deepEqual(
      after.outbox.map((row) => row.command_id),
      [commandId],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaim blocks attachment references outside message attachments", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const cases = [
      ["dynamic", "attachment:shared-dynamic"],
      ["input", "attachment:shared-input"],
      ["guest", "attachment:shared-guest"],
    ] as const;

    for (const [kind, baseAttachmentId] of cases) {
      const deletedThreadId = `thread:attachment:${kind}:deleted`;
      const liveThreadId = `thread:attachment:${kind}:live`;
      const attachmentId =
        kind === "dynamic" ? attachmentIdForThread(liveThreadId) : baseAttachmentId;
      yield* seedDeletedThread({ threadId: deletedThreadId });
      yield* seedThread({ threadId: liveThreadId, state: "active" });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json
        ) VALUES (
          ${`message:${deletedThreadId}`}, ${deletedThreadId}, NULL, NULL, 'user', 0,
          ${at}, ${at}, ${JSON.stringify({ attachments: [{ id: attachmentId }] })}
        )
      `;

      if (kind === "dynamic") {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id,
            provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item:${liveThreadId}`}, ${liveThreadId}, NULL, NULL, NULL, NULL, NULL,
            1, 'dynamic_tool', 'completed', ${at}, ${JSON.stringify({
              toolName: "mcp__t3-code__html_render",
              output: [
                {
                  type: "text",
                  text: JSON.stringify({ htmlRender: { attachmentId, title: "HTML", height: 80 } }),
                },
              ],
            })}
          )
        `;
      } else if (kind === "input") {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id,
            provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item:${liveThreadId}`}, ${liveThreadId}, NULL, NULL, NULL, NULL, NULL,
            1, 'user_input_request', 'completed', ${at},
            ${JSON.stringify({ questionAnswer: { attachmentsByQuestionId: { question: [{ id: attachmentId }] } } })}
          )
        `;
      } else {
        yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = ${JSON.stringify({
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: liveThreadId,
            },
            forkedFrom: null,
            guestShare: { messages: [{ status: "pending", attachments: [{ id: attachmentId }] }] },
          })}
          WHERE thread_id = ${liveThreadId}
        `;
      }
    }

    const result = yield* reclaim();
    assert.equal(result.reclaimedThreadCount, 0);
    for (const [kind] of cases) {
      expectBlockers(result, `thread:attachment:${kind}:deleted`, ["shared_attachment"]);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reclaim blocks attachment references when the candidate uses non-message attachments",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cases = [
        ["dynamic", "attachment:candidate-dynamic"],
        ["input", "attachment:candidate-input"],
        ["guest", "attachment:candidate-guest"],
      ] as const;

      for (const [kind, baseAttachmentId] of cases) {
        const deletedThreadId = `thread:candidate-attachment:${kind}:deleted`;
        const liveThreadId = `thread:candidate-attachment:${kind}:live`;
        const attachmentId =
          kind === "dynamic" ? attachmentIdForThread(deletedThreadId) : baseAttachmentId;
        yield* seedDeletedThread({ threadId: deletedThreadId });
        yield* seedThread({ threadId: liveThreadId, state: "active" });

        if (kind === "dynamic") {
          yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id,
            provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item:${deletedThreadId}`}, ${deletedThreadId}, NULL, NULL, NULL, NULL, NULL,
            1, 'dynamic_tool', 'completed', ${at}, ${JSON.stringify({
              toolName: "mcp__t3-code__html_render",
              output: [
                {
                  type: "text",
                  text: JSON.stringify({ htmlRender: { attachmentId, title: "HTML", height: 80 } }),
                },
              ],
            })}
          )
        `;
        } else if (kind === "input") {
          yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id,
            provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${`item:${deletedThreadId}`}, ${deletedThreadId}, NULL, NULL, NULL, NULL, NULL,
            1, 'user_input_request', 'completed', ${at},
            ${JSON.stringify({ questionAnswer: { attachmentsByQuestionId: { question: [{ id: attachmentId }] } } })}
          )
        `;
        } else {
          yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = ${JSON.stringify({
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: deletedThreadId,
            },
            forkedFrom: null,
            guestShare: { messages: [{ status: "pending", attachments: [{ id: attachmentId }] }] },
          })}
          WHERE thread_id = ${deletedThreadId}
        `;
        }

        yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json
        ) VALUES (
          ${`message:${liveThreadId}`}, ${liveThreadId}, NULL, NULL, 'user', 0,
          ${at}, ${at}, ${JSON.stringify({ attachments: [{ id: attachmentId }] })}
        )
      `;
      }

      const result = yield* reclaim();
      assert.equal(result.reclaimedThreadCount, 0);
      for (const [kind] of cases) {
        expectBlockers(result, `thread:candidate-attachment:${kind}:deleted`, [
          "shared_attachment",
        ]);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaims thread-scoped orchestration metadata", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:metadata";
    yield* seedDeletedThread({ threadId });
    yield* sql`
      INSERT INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
      VALUES (${threadId}, 'turn-item:metadata', 'server', 'tool', 'context', ${at})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_thread_launch_workflows (
        command_id, thread_id, project_id, status, title, worktree_path, branch,
        setup_committed, thread_committed, message_committed, last_error, created_at, updated_at
      ) VALUES (
        'launch:metadata', ${threadId}, 'project:reclamation', 'completed', 'metadata', NULL, NULL,
        1, 1, 1, NULL, ${at}, ${at}
      )
    `;

    const result = yield* reclaim();

    assert.equal(result.reclaimedThreadCount, 1);
    assert.equal(result.deletedProjectionRowCount, 2);
    assert.deepEqual(
      yield* sql`SELECT thread_id FROM mcp_app_model_context WHERE thread_id = ${threadId}`,
      [],
    );
    assert.deepEqual(
      yield* sql`
        SELECT thread_id FROM orchestration_v2_thread_launch_workflows
        WHERE thread_id = ${threadId}
      `,
      [],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("blocks a candidate when its operation root has an ineligible deleted member", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rootThreadId = "thread:ineligible-root";
    const memberThreadId = "thread:ineligible-member";
    const commandId = `delete:${rootThreadId}`;
    const providerSessionId = "provider-session:ineligible";
    const providerThreadId = `provider-thread:${memberThreadId}`;
    const runId = `run:${memberThreadId}`;
    const sharedAttachmentId = "attachment:ineligible-shared";

    yield* seedDeletedThread({ threadId: rootThreadId, commandId });
    yield* seedDeletedThread({
      threadId: memberThreadId,
      operationRootThreadId: rootThreadId,
      commandId: `delete:${memberThreadId}`,
      insertReceipt: false,
    });
    yield* seedRun({ threadId: memberThreadId, runId, status: "running" });
    yield* seedLifecycleCleanup({ threadId: memberThreadId, status: "pending" });
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, status, model, updated_at,
        payload_json, driver, provider_instance_id
      ) VALUES (
        ${providerSessionId}, ${rootThreadId}, 'codex', 'idle', NULL, ${at}, '{}', 'codex', 'codex'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_session_bindings (
        provider_session_id, thread_id
      ) VALUES (${providerSessionId}, ${rootThreadId}), (${providerSessionId}, ${memberThreadId})
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, owner_node_id, provider, provider_session_id,
        status, first_run_ordinal, last_run_ordinal, updated_at, payload_json,
        driver, provider_instance_id
      ) VALUES (
        ${providerThreadId}, ${memberThreadId}, NULL, 'codex', ${providerSessionId},
        'completed', 1, 1, ${at}, '{}', 'codex', 'codex'
      )
    `;
    for (const [bindingKey, threadId, providerThreadIdForBinding] of [
      ["native:ineligible-root", rootThreadId, "provider-thread:root"],
      ["native:ineligible-member", memberThreadId, providerThreadId],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_native_session_bindings (
          binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
          native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
        ) VALUES (
          ${bindingKey}, ${threadId}, ${providerThreadIdForBinding}, 'codex', 'codex',
          'native:ineligible-shared', 'resolved', '/sessions', 'ineligible.jsonl', ${at}, '{}'
        )
      `;
    }
    for (const [messageId, threadId] of [
      [`message:${rootThreadId}`, rootThreadId],
      [`message:${memberThreadId}`, memberThreadId],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json
        ) VALUES (
          ${messageId}, ${threadId}, NULL, NULL, 'user', 0, ${at}, ${at},
          ${JSON.stringify({ attachments: [{ id: sharedAttachmentId }] })}
        )
      `;
    }
    yield* sql`
      INSERT INTO orchestration_v2_projection_context_transfers (
        context_transfer_id, source_thread_id, target_thread_id, target_run_id,
        type, status, source_provider, target_provider, updated_at,
        source_provider_instance_id, target_provider_instance_id, payload_json
      ) VALUES (
        'transfer:ineligible', ${rootThreadId}, ${memberThreadId}, ${runId},
        'fork', 'completed', 'codex', 'codex', ${at}, 'codex', 'codex', '{}'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_context_handoffs (
        context_handoff_id, thread_id, target_run_id, to_provider_thread_id,
        strategy, status, updated_at, payload_json
      ) VALUES (
        'handoff:ineligible', ${rootThreadId}, ${runId}, ${providerThreadId},
        'reuse', 'completed', ${at}, '{}'
      )
    `;

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    expectBlockers(result, rootThreadId, ["shared_attachment", "unknown_dependency"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recursively blocks a fork source through a deleted intermediate fork", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sourceThreadId = "thread:fork:recursive-source";
    const intermediateThreadId = "thread:fork:recursive-intermediate";
    const grandchildThreadId = "thread:fork:recursive-grandchild";

    yield* seedDeletedThread({ threadId: sourceThreadId });
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming,
        created_at, updated_at, payload_json
      ) VALUES (
        'message:fork:recursive-source', ${sourceThreadId}, NULL, NULL, 'user', 0,
        ${at}, ${at}, '{}'
      )
    `;
    yield* seedDeletedThread({
      threadId: intermediateThreadId,
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
      forkedFrom: { type: "run", threadId: sourceThreadId, runId: "run:recursive-source" },
    });
    yield* seedThread({
      threadId: grandchildThreadId,
      state: "active",
      parentThreadId: intermediateThreadId,
      relationshipToParent: "fork",
      forkedFrom: {
        type: "run",
        threadId: intermediateThreadId,
        runId: "run:recursive-intermediate",
      },
    });

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    expectBlockers(result, sourceThreadId, ["surviving_fork"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaims dependent rows while preserving deletion anchors and the thread shell", () =>
  Effect.gen(function* () {
    const threadId = "thread:reclaim:data";
    yield* seedDeletedThread({ threadId });
    yield* seedReclamationRows(threadId);

    const result = yield* reclaim();
    const after = yield* snapshotRows();
    assert.equal(result.deletedReceiptCount, 1);
    assert.equal(result.deletedProjectionRowCount, 17);
    assert.equal(result.deletedTurnItemPositionCount, 1);
    assert.equal(result.deletedOutboxCount, 1);
    assert.deepEqual(
      after.events
        .filter((row) => row.stream_id === threadId)
        .map((row) => row.event_type)
        .sort(),
      ["thread.created", "thread.deleted"],
    );
    assert.deepEqual(
      after.receipts.map((row) => row.command_type),
      ["thread.delete"],
    );
    assert.equal(after.threads.filter((row) => row.thread_id === threadId).length, 1);
    assert.equal(after.deletions.filter((row) => row.thread_id === threadId).length, 1);
    assert.equal(after.deletionSessions.filter((row) => row.thread_id === threadId).length, 1);
    assert.equal(after.transfers.length, 0);
    assert.equal(after.handoffs.length, 0);
    assert.equal(after.checkpoints.length, 0);
    assert.equal(after.checkpointScopes.length, 0);
    assert.equal(after.runtimeRequests.length, 0);
    assert.equal(after.plans.length, 0);
    assert.equal(after.messages.length, 0);
    assert.equal(after.turnItems.length, 0);
    assert.equal(after.positions.length, 0);
    assert.equal(after.providerTurns.length, 0);
    assert.equal(after.providerThreads.length, 0);
    assert.equal(after.attempts.length, 0);
    assert.equal(after.nodes.length, 0);
    assert.equal(after.runs.length, 0);
    assert.equal(after.subagents.length, 0);
    assert.equal(after.providerSessions.length, 0);
    assert.equal(after.providerSessionBindings.length, 0);
    assert.equal(after.nativeBindings.length, 0);
    assert.equal(after.outbox.length, 0);

    const second = yield* reclaim();
    assert.equal(second.reclaimedThreadCount, 1);
    assert.equal(second.deletedEventCount, 0);
    assert.equal(second.deletedReceiptCount, 0);
    assert.equal(second.deletedProjectionRowCount, 0);
    assert.equal(second.deletedTurnItemPositionCount, 0);
    assert.equal(second.deletedOutboxCount, 0);
    assert.equal(
      (yield* snapshotRows()).events.filter((row) => row.stream_id === threadId).length,
      2,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rolls back a failed deletion batch and resumes after the trigger is removed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:rollback";
    yield* seedDeletedThread({ threadId });
    yield* seedReclamationRows(threadId);
    const before = yield* snapshotRows();
    yield* sql`
      CREATE TRIGGER reject_reclamation_message_delete
      BEFORE DELETE ON orchestration_v2_projection_messages
      WHEN OLD.thread_id = 'thread:reclaim:rollback'
      BEGIN SELECT RAISE(ABORT, 'injected reclamation failure'); END
    `;

    const failed = yield* Effect.exit(reclaim());
    assert.isTrue(Exit.isFailure(failed));
    assert.deepEqual(yield* snapshotRows(), before);

    yield* sql`DROP TRIGGER reject_reclamation_message_delete`;
    const resumed = yield* reclaim();
    assert.equal(resumed.reclaimedThreadCount, 1);
    assert.equal(resumed.deletedProjectionRowCount, 17);
    assert.equal(resumed.deletedEventCount, 1);
    assert.equal(resumed.deletedReceiptCount, 1);
    assert.equal(resumed.deletedTurnItemPositionCount, 1);
    assert.equal(resumed.deletedOutboxCount, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("resumes after a later batch rolls back without restoring committed batches", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const count = ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE + 1;
    for (let index = 0; index < count; index++) {
      const threadId = `thread:reclaim:batch:${String(index).padStart(3, "0")}`;
      yield* seedDeletedThread({ threadId });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json
        ) VALUES (
          ${`message:${threadId}`}, ${threadId}, NULL, NULL, 'user', 0, ${at}, ${at}, '{}'
        )
      `;
    }
    yield* sql`
      CREATE TRIGGER reject_reclamation_second_batch
      BEFORE DELETE ON orchestration_v2_projection_messages
      WHEN OLD.thread_id = 'thread:reclaim:batch:050'
      BEGIN SELECT RAISE(ABORT, 'injected second-batch failure'); END
    `;

    const failed = yield* Effect.exit(reclaim());
    assert.isTrue(Exit.isFailure(failed));
    const afterFailure = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_messages
      WHERE thread_id LIKE 'thread:reclaim:batch:%'
      ORDER BY thread_id
    `;
    assert.deepEqual(
      afterFailure.map((row) => row.thread_id),
      ["thread:reclaim:batch:050"],
    );

    yield* sql`DROP TRIGGER reject_reclamation_second_batch`;
    const resumed = yield* reclaim();
    assert.equal(resumed.reclaimedThreadCount, count);
    assert.equal(resumed.deletedProjectionRowCount, 1);
    const afterResume = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_messages
      WHERE thread_id LIKE 'thread:reclaim:batch:%'
    `;
    assert.deepEqual(afterResume, []);
  }).pipe(Effect.provide(layerTest)),
);

const seedCertifiedSideChatRoot = Effect.fn("test.seedCertifiedSideChatRoot")(function* (
  forkRoot = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const count = ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE + 1;
  const threadIds = Array.from(
    { length: count },
    (_, index) => `thread:certified:${String(index).padStart(3, "0")}`,
  );
  const rootThreadId = threadIds[0]!;
  const commandId = `delete:${rootThreadId}`;
  if (forkRoot) {
    yield* seedThread({ threadId: "thread:certified:live-parent", state: "active" });
  }
  const proof = {
    providerThreadId: "provider-thread:certified:reclaimed",
    providerInstanceId: "pi",
    source: "queued_provider_origin",
    version: 1,
  };
  for (const threadId of threadIds) {
    yield* seedDeletedThread({
      threadId,
      rootThreadId,
      operationRootThreadId: rootThreadId,
      commandId,
      ...(threadId === rootThreadId
        ? forkRoot
          ? {
              parentThreadId: "thread:certified:live-parent",
              relationshipToParent: "fork",
              sideChat: true,
            }
          : {}
        : {
            parentThreadId: rootThreadId,
            relationshipToParent: "fork",
            sideChat: true,
            insertReceipt: false,
          }),
    });
    if (threadId === threadIds.at(-1)) {
      yield* seedReclamationRows(threadId);
      yield* sql`
        INSERT INTO mcp_app_model_context (thread_id, item_id, server, tool, text, updated_at)
        VALUES (${threadId}, 'certified:context', 'synthetic', 'tool', 'synthetic', ${at})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_thread_launch_workflows (
          command_id, thread_id, project_id, status, title, setup_committed, thread_committed,
          message_committed, created_at, updated_at
        ) VALUES ('certified:launch', ${threadId}, 'project:reclamation', 'completed', 'synthetic', 1, 1, 1, ${at}, ${at})
      `;
    } else {
      yield* seedRun({ threadId, status: "cancelled" });
    }
  }
  const source = {
    id: proof.providerThreadId,
    appThreadId: rootThreadId,
    driver: "pi",
    providerInstanceId: "pi",
    nativeSessionOrigin: { version: 1, state: "unstarted" },
    providerSessionId: null,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeStorage: { type: "unresolved", reason: "unavailable" },
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id, thread_id, owner_node_id, provider, provider_session_id,
      status, first_run_ordinal, last_run_ordinal, updated_at, payload_json, driver, provider_instance_id
    ) VALUES (${proof.providerThreadId}, ${rootThreadId}, NULL, 'pi', NULL, 'not_loaded',
      NULL, NULL, ${at}, ${JSON.stringify(source)}, 'pi', 'pi')
  `;
  // 此夹具固定 v1 肯定来源；首次发证由下方真实 EventSink 流程覆盖。
  yield* sql`
    UPDATE orchestration_v2_thread_deletions
    SET payload_json = ${JSON.stringify({
      threadId: rootThreadId,
      projectId: "project:reclamation",
      parentThreadId: forkRoot ? "thread:certified:live-parent" : null,
      operationRootThreadId: rootThreadId,
      deletedAt: at,
      commandId,
      scope: "t3_only",
      sessions: [],
      noNativeSessionProofs: [proof],
    })}
    WHERE thread_id = ${rootThreadId}
  `;
  return { rootThreadId, lastThreadId: threadIds.at(-1)!, threadIds, proof };
});

const seedCertifiedSubagents = Effect.fn("test.seedCertifiedSubagents")(function* (
  count: number,
  order: "parent-first" | "child-first" | "permuted",
  boundary: "internal" | "live-child" | "external-transfer" | "external-fork" = "internal",
) {
  const sql = yield* SqlClient.SqlClient;
  assert.isTrue(
    (yield* sql<{ file: string }>`PRAGMA database_list`).every((row) => row.file === ""),
  );
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const allocator = yield* IdAllocator.IdAllocatorV2;
  const now = DateTime.makeUnsafe(at);
  const instance = ProviderInstanceId.make("codex-synthetic");
  const rootId = ThreadId.make(
    `synthetic:${order === "parent-first" ? "000" : order === "child-first" ? "zzz" : "050"}:root`,
  );
  const memberIds = Array.from({ length: count - 1 }, (_, index) =>
    ThreadId.make(
      `synthetic:${String(order === "permuted" ? (index * 37) % count : index + 1).padStart(3, "0")}:child`,
    ),
  );
  const threadIds = [rootId, ...memberIds];
  const thread = (id: ThreadId, parent: ThreadId | null = null) => ({
    id,
    projectId: ProjectId.make("synthetic-project"),
    createdBy: "user" as const,
    creationSource: "web" as const,
    title: "synthetic",
    providerInstanceId: instance,
    modelSelection: { instanceId: instance, model: "unused" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent === null ? null : ("subagent" as const),
      rootThreadId: parent ?? id,
    },
    forkedFrom:
      parent === null ? null : { type: "node" as const, nodeId: NodeId.make(`original:${id}`) },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  });
  const write = (event: OrchestrationV2DomainEvent) => sink.write({ events: [event] });
  for (const id of threadIds) {
    yield* write({
      id: EventId.make(`thread:${id}`),
      type: "thread.created",
      threadId: id,
      occurredAt: now,
      payload: thread(id, id === rootId ? null : rootId),
    });
    const runId = RunId.make(`original-run:${id}`);
    const providerId = ProviderThreadId.make(`provider:${id}`);
    const rootNodeId = NodeId.make(`node:${id}`);
    const run = {
      id: runId,
      threadId: id,
      ordinal: 1,
      providerInstanceId: instance,
      modelSelection: { instanceId: instance, model: "unused" },
      providerThreadId: providerId,
      userMessageId: MessageId.make(`message:${id}`),
      rootNodeId,
      activeAttemptId: RunAttemptId.make(`attempt:${id}`),
      status: "completed" as const,
      queuePosition: null,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    // original run 没有 delegatedTaskId；当前对象与 task 展示实例不同，历史事件不作回收来源。
    const provider = {
      id: providerId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instance,
      providerSessionId: null,
      appThreadId: id,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: `native:${id}`,
        strength: "strong" as const,
      },
      nativeStorage: { type: "resolved" as const, canonicalRoot: `/synthetic/${id}` },
      nativeConversationHeadRef: null,
      status: "closed" as const,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    yield* sink.write({
      events: [
        {
          id: EventId.make(`provider:${id}`),
          type: "provider-thread.updated",
          threadId: id,
          occurredAt: now,
          payload: provider,
        },
        {
          id: EventId.make(`run:${id}`),
          type: "run.created",
          threadId: id,
          occurredAt: now,
          payload: run,
        },
        {
          id: EventId.make(`attempt:${id}`),
          type: "run-attempt.created",
          threadId: id,
          occurredAt: now,
          payload: {
            id: run.activeAttemptId,
            runId,
            attemptOrdinal: 1,
            rootNodeId,
            providerInstanceId: instance,
            providerThreadId: providerId,
            providerTurnId: null,
            reason: "initial",
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        {
          id: EventId.make(`node:${id}`),
          type: "node.updated",
          threadId: id,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId: id,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "completed",
            countsForRun: true,
            providerThreadId: providerId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: now,
          },
        },
      ],
    });
    if (id === rootId) continue;
    for (const [ordinal, taskKind] of ["original", "followup", "reused"].entries()) {
      if (taskKind !== "original") {
        const reusedInstance = ProviderInstanceId.make(`codex-${taskKind}`);
        const followup = {
          ...run,
          id: RunId.make(`${taskKind}-run:${id}`),
          ordinal: ordinal + 1,
          delegatedTaskId: NodeId.make(`${taskKind}:${id}`),
          providerInstanceId: reusedInstance,
          modelSelection: { instanceId: reusedInstance, model: "unused" },
          rootNodeId: NodeId.make(`${taskKind}-node:${id}`),
          activeAttemptId: RunAttemptId.make(`${taskKind}-attempt:${id}`),
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`${taskKind}-provider:${id}`),
              type: "provider-thread.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                ...provider,
                providerInstanceId: reusedInstance,
                lastRunOrdinal: ordinal + 1,
              },
            },
            {
              id: EventId.make(`${taskKind}-run:${id}`),
              type: "run.created",
              threadId: id,
              occurredAt: now,
              payload: followup,
            },
            {
              id: EventId.make(`${taskKind}-attempt:${id}`),
              type: "run-attempt.created",
              threadId: id,
              occurredAt: now,
              payload: {
                id: followup.activeAttemptId,
                runId: followup.id,
                attemptOrdinal: 1,
                rootNodeId: followup.rootNodeId,
                providerInstanceId: reusedInstance,
                providerThreadId: providerId,
                providerTurnId: null,
                reason: "initial",
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`${taskKind}-node:${id}`),
              type: "node.updated",
              threadId: id,
              occurredAt: now,
              payload: {
                id: followup.rootNodeId,
                threadId: id,
                runId: followup.id,
                parentNodeId: null,
                rootNodeId: followup.rootNodeId,
                kind: "root_turn",
                status: "completed",
                countsForRun: true,
                providerThreadId: providerId,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      yield* write({
        id: EventId.make(`${taskKind}:${id}`),
        type: "subagent.updated",
        threadId: rootId,
        occurredAt: now,
        payload: {
          id: NodeId.make(`${taskKind}:${id}`),
          threadId: rootId,
          runId: RunId.make(`original-run:${rootId}`),
          parentNodeId: NodeId.make(`node:${rootId}`),
          origin: "app_owned",
          createdBy: "user",
          driver: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("synthetic-old-instance"),
          providerThreadId: providerId,
          childThreadId: id,
          nativeTaskRef: null,
          prompt: "synthetic",
          title: "synthetic",
          model: "unused",
          completionDelivery: { state: "delivered", observedByRunId: null },
          status: "completed",
          result: boundary === "internal" ? null : "Synthetic retained result",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
    for (const type of ["subagent_spawn", "subagent_result"] as const) {
      const spawn = type === "subagent_spawn";
      const source = spawn ? rootId : id;
      const target = spawn ? id : rootId;
      yield* write({
        id: EventId.make(`${type}:${id}`),
        type: "context-transfer.created",
        threadId: target,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make(`${type}:${id}`),
          type,
          sourceThreadId: source,
          targetThreadId: target,
          sourcePoint: { threadId: source, runId: RunId.make(`original-run:${source}`) },
          basePoint: null,
          sourceProviderInstanceId: instance,
          targetProviderInstanceId: instance,
          targetRunId: RunId.make(`original-run:${target}`),
          status: "consumed",
          resolution: null,
          createdBy: "system",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: now,
        },
      });
    }
    // 只移除正常已被压缩的历史；保留所有投影、ownership 和删除所需锚点。
    yield* sql`DELETE FROM orchestration_events WHERE stream_id = ${id} AND event_type <> 'thread.created'`;
  }
  const piRunId = allocator.derive.run({ threadId: rootId, ordinal: 2 });
  const piId = allocator.derive.providerThread({
    driver: ProviderDriverKind.make("pi"),
    nativeThreadId: `pending:${piRunId}`,
  });
  const piInstance = ProviderInstanceId.make("pi-synthetic");
  const piNode = allocator.derive.rootNode({ runId: piRunId });
  const piAttempt = allocator.derive.runAttempt({ runId: piRunId, attemptOrdinal: 1 });
  yield* sink.write({
    events: [
      {
        id: EventId.make("pi:provider"),
        type: "provider-thread.updated",
        threadId: rootId,
        occurredAt: now,
        payload: {
          id: piId,
          driver: ProviderDriverKind.make("pi"),
          providerInstanceId: piInstance,
          nativeSessionOrigin: { version: 1, state: "unstarted" },
          providerSessionId: null,
          appThreadId: rootId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeStorage: { type: "unresolved", reason: "unavailable" },
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make("pi:run"),
        type: "run.created",
        threadId: rootId,
        occurredAt: now,
        payload: {
          id: piRunId,
          threadId: rootId,
          ordinal: 2,
          providerInstanceId: piInstance,
          modelSelection: { instanceId: piInstance, model: "unused" },
          providerThreadId: piId,
          userMessageId: MessageId.make("pi:message"),
          rootNodeId: piNode,
          activeAttemptId: piAttempt,
          status: "queued",
          queuePosition: 1,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make("pi:attempt"),
        type: "run-attempt.created",
        threadId: rootId,
        occurredAt: now,
        payload: {
          id: piAttempt,
          runId: piRunId,
          attemptOrdinal: 1,
          rootNodeId: piNode,
          providerInstanceId: piInstance,
          providerThreadId: piId,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        },
      },
      {
        id: EventId.make("pi:node"),
        type: "node.updated",
        threadId: rootId,
        occurredAt: now,
        payload: {
          id: piNode,
          threadId: rootId,
          runId: piRunId,
          parentNodeId: null,
          rootNodeId: piNode,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: piId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: null,
        },
      },
    ],
  });
  const childId = memberIds[0]!;
  if (boundary === "external-fork") {
    const externalId = ThreadId.make("external:fork");
    yield* write({
      id: EventId.make("external:fork"),
      type: "thread.created",
      threadId: externalId,
      occurredAt: now,
      payload: {
        ...thread(externalId),
        lineage: { parentThreadId: childId, relationshipToParent: "fork", rootThreadId: rootId },
        forkedFrom: {
          type: "run",
          threadId: childId,
          runId: RunId.make(`original-run:${childId}`),
        },
      },
    });
  } else if (boundary === "external-transfer") {
    yield* seedThread({ threadId: "external:target", state: "active" });
    yield* sql`
      INSERT INTO orchestration_v2_projection_context_transfers (
        context_transfer_id, source_thread_id, target_thread_id, target_run_id, type, status,
        source_provider, target_provider, updated_at, source_provider_instance_id, target_provider_instance_id, payload_json
      ) VALUES ('external:transfer', ${childId}, 'external:target', NULL, 'fork', 'pending',
        'codex', 'codex', ${at}, ${instance}, ${instance}, '{}')
    `;
  }
  const deletingIds = boundary === "live-child" ? [rootId] : threadIds;
  const commandId = CommandId.make("delete:synthetic");
  const plan = yield* ThreadLifecyclePlan.planThreadLifecycle({
    command: { type: "thread.delete", commandId, threadId: rootId },
    operationRootThreadId: rootId,
    members: yield* Effect.forEach(deletingIds, (id) =>
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
    bindings: [],
    attachmentIdsByThread: new Map(),
    now,
    idAllocator: allocator,
  });
  assert.isTrue(
    (yield* sink.commitCommand({
      ...plan,
      commandId,
      commandType: "thread.delete",
      threadId: rootId,
      acceptedAt: now,
    })).committed,
  );
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  for (const _ of plan.effects) {
    const claimed = Option.getOrThrow(yield* outbox.claimNext({ workerId: "synthetic" }));
    assert.isTrue(yield* outbox.succeed({ effectId: claimed.id, workerId: "synthetic" }));
  }
  const record = Option.getOrThrow(
    yield* (yield* ThreadDeletionRecords.ThreadDeletionRecords).get(rootId),
  );
  assert.equal(record.noNativeSessionProofs?.length, 1);
  return { threadIds, rootId, childId, piId };
});

it.effect.each([
  [51, "parent-first"],
  [51, "child-first"],
  [101, "parent-first"],
  [101, "child-first"],
  [101, "permuted"],
] as const)(
  "clears certified app-owned roots with original and reused providers: %s",
  ([count, order]) =>
    Effect.gen(function* () {
      yield* seedCertifiedSubagents(count, order);
      const result = yield* reclaim();
      assert.equal(result.reclaimedThreadCount, count);
      assert.isEmpty(result.skippedThreads);
      const rows = yield* snapshotRows();
      for (const [name, values] of Object.entries(rows)) {
        if (["threads", "deletions", "events", "receipts", "deletionSessions"].includes(name))
          continue;
        assert.isEmpty(values, name);
      }
      assert.lengthOf(rows.events, count * 2);
      assert.lengthOf(rows.receipts, 1);
      assert.lengthOf(rows.deletions, count);
      assert.equal((yield* reclaim()).deletedProjectionRowCount, 0);
    }).pipe(Effect.provide(layerCertifiedTest)),
);

it.effect.each(["live-child", "external-transfer", "external-fork"] as const)(
  "preserves all certified root data across a genuine external boundary: %s",
  (boundary) =>
    Effect.gen(function* () {
      yield* seedCertifiedSubagents(51, "parent-first", boundary);
      const before = yield* snapshotRows();
      const result = yield* reclaim();
      assert.equal(result.reclaimedThreadCount, 0);
      assert.isNotEmpty(result.skippedThreads);
      assert.deepEqual(yield* snapshotRows(), before);
    }).pipe(Effect.provide(layerCertifiedTest)),
);

it.effect.each(["missing-original", "missing-followup", "wrong-owner", "external-node"] as const)(
  "preserves certified root data when current ownership is invalid: %s",
  (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { rootId, childId } = yield* seedCertifiedSubagents(51, "parent-first");
      if (scenario === "missing-original" || scenario === "missing-followup") {
        yield* sql`DELETE FROM orchestration_v2_projection_subagents
          WHERE subagent_id = ${`${scenario === "missing-original" ? "original" : "followup"}:${childId}`}`;
      } else if (scenario === "wrong-owner") {
        yield* sql`UPDATE orchestration_v2_projection_subagents SET run_id = ${`original-run:${childId}`}
          WHERE subagent_id = ${`original:${childId}`}`;
      } else {
        yield* seedThread({ threadId: "external:node-reader", state: "active" });
        yield* sql`
          INSERT INTO orchestration_v2_projection_nodes (
            node_id, thread_id, run_id, root_node_id, kind, status, provider_thread_id, payload_json
          ) VALUES ('external:node', 'external:node-reader', 'external:run', 'external:node',
            'root_turn', 'completed', ${`provider:${rootId}`}, '{}')
        `;
      }
      const before = yield* snapshotRows();
      const result = yield* Effect.exit(reclaim());
      if (scenario === "external-node") assert.isTrue(Exit.isFailure(result));
      else {
        assert.isTrue(Exit.isSuccess(result));
        if (Exit.isSuccess(result)) {
          assert.equal(result.value.reclaimedThreadCount, 0);
          assert.lengthOf(result.value.skippedThreads, 51);
        }
      }
      assert.deepEqual(yield* snapshotRows(), before);
    }).pipe(Effect.provide(layerCertifiedTest)),
);

it.effect.each(["unknown-version", "fake-source", "malformed-record", "missing-origin"] as const)(
  "does not enable certified deletion from an invalid proof on a Codex root: %s",
  (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { rootThreadId, proof } = yield* seedCertifiedSideChatRoot();
      yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
      yield* sql`
        UPDATE orchestration_v2_thread_deletions SET payload_json = json_set(payload_json,
          '$.noNativeSessionProofs', json(${JSON.stringify([
            {
              ...proof,
              ...(scenario === "unknown-version" ? { version: 2 } : {}),
              ...(scenario === "fake-source" ? { source: "synthetic-fake" } : {}),
            },
          ])})) WHERE thread_id = ${rootThreadId}
      `;
      if (scenario === "malformed-record") {
        yield* sql`UPDATE orchestration_v2_thread_deletions
          SET payload_json = json_set(payload_json, '$.threadId', 'synthetic-wrong-thread')
          WHERE thread_id = ${rootThreadId}`;
      }
      const before = yield* snapshotRows();
      const result = yield* reclaim();
      assert.equal(result.reclaimedThreadCount, 0);
      assert.lengthOf(result.skippedThreads, 51);
      assert.deepEqual(yield* snapshotRows(), before);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([51, 101, 201])("counts SQL work for a certified synthetic root: %s", (count) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCertifiedSubagents(count, "parent-first");
    const input = yield* bounds();
    const calls = {
      total: 0,
      outsideTransaction: 0,
      preflight: 0,
      deletionAndVerification: 0,
      maxParameters: 0,
      rootTransactions: 0,
      rootCommits: 0,
    };
    let depth = 0;
    let deleting = false;
    const observe = (statement: ReturnType<typeof sql.unsafe>) => {
      const [query, params] = statement.compile();
      if (query.trimStart().startsWith("DELETE")) deleting = true;
      calls.total++;
      calls.maxParameters = Math.max(calls.maxParameters, params.length);
      if (depth === 0) calls.outsideTransaction++;
      else if (deleting) calls.deletionAndVerification++;
      else calls.preflight++;
      return statement;
    };
    const withTransaction: typeof sql.withTransaction = (effect) =>
      Effect.gen(function* () {
        const root = depth === 0;
        if (root) calls.rootTransactions++;
        depth++;
        try {
          const result = yield* sql.withTransaction(effect);
          if (root) calls.rootCommits++;
          return result;
        } finally {
          depth--;
        }
      });
    const intercepted = new Proxy(sql, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        return Array.isArray(args[0]) ? observe(result) : result;
      },
      get(target, key, receiver) {
        if (key === "withTransaction") return withTransaction;
        if (key === "unsafe") {
          return (...args: Parameters<typeof sql.unsafe>) => observe(target.unsafe(...args));
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const result = yield* Effect.gen(function* () {
      return yield* (yield* ThreadDataReclamation.ThreadDataReclamation).reclaim(input);
    }).pipe(
      Effect.provide(
        Layer.fresh(
          ThreadDataReclamation.layer.pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, intercepted)),
          ),
        ),
      ),
    );
    assert.equal(result.reclaimedThreadCount, count);
    assert.isEmpty(result.skippedThreads);
    assert.equal(calls.rootTransactions, 1);
    assert.equal(calls.rootCommits, 1);
    assert.isAtMost(calls.maxParameters, 999);
    assert.equal(
      calls.total,
      calls.outsideTransaction + calls.preflight + calls.deletionAndVerification,
    );
    const rows = yield* snapshotRows();
    assert.isEmpty(rows.runs);
    assert.isEmpty(rows.providerThreads);
    assert.isEmpty(rows.nodes);
    assert.isEmpty(rows.subagents);
    assert.isEmpty(rows.transfers);
    process.stdout.write(`RECLAIMER_SQL_COUNTS ${JSON.stringify({ members: count, ...calls })}\n`);
  }).pipe(Effect.provide(layerCertifiedTest)),
);

it.effect("keeps the existing uncertified cross-batch provider/task retention semantics", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { rootId, piId } = yield* seedCertifiedSubagents(51, "parent-first");
    yield* sql`UPDATE orchestration_v2_thread_deletions
      SET payload_json = json_remove(payload_json, '$.noNativeSessionProofs') WHERE thread_id = ${rootId}`;
    yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE provider_thread_id = ${piId}`;
    yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE provider_thread_id = ${piId}`;
    yield* sql`DELETE FROM orchestration_v2_projection_nodes WHERE provider_thread_id = ${piId}`;
    yield* sql`DELETE FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${piId}`;
    assert.equal((yield* reclaim()).reclaimedThreadCount, 51);
    const remaining = yield* snapshotRows();
    assert.lengthOf(remaining.providerThreads, 1);
    assert.lengthOf(remaining.subagents, 3);
    assert.isEmpty(remaining.runs);
    assert.isEmpty(remaining.transfers);
    // B1 保持独立归因；本轮不得借 certified 闭包修复普通 root 的残留。
    yield* reclaim();
    assert.deepEqual(yield* snapshotRows(), remaining);
  }).pipe(Effect.provide(layerCertifiedTest)),
);

it.effect.each(["root", "fork-with-live-parent"] as const)(
  "rolls back the entire certified root after a later SQLite failure and resumes (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { threadIds } = yield* seedCertifiedSideChatRoot(scenario === "fork-with-live-parent");
      const before = yield* snapshotRows();
      yield* sql`
      CREATE TRIGGER reject_certified_second_batch
      BEFORE DELETE ON orchestration_v2_projection_runs
      WHEN OLD.thread_id = 'thread:certified:050'
      BEGIN SELECT RAISE(ABORT, 'injected certified second-batch failure'); END
    `;

      const failed = yield* Effect.exit(reclaim());
      assert.isTrue(Exit.isFailure(failed));
      // 单根事务必须保留失败前的全部执行来源与删除锚点。
      assert.deepEqual(yield* snapshotRows(), before);

      yield* sql`DROP TRIGGER reject_certified_second_batch`;
      const resumed = yield* reclaim();
      assert.equal(resumed.reclaimedThreadCount, threadIds.length);
      assert.equal(resumed.deletedProjectionRowCount, threadIds.length + 19);
      assert.deepEqual(resumed.skippedThreads, []);
      assert.isEmpty(yield* sql`SELECT * FROM orchestration_v2_projection_runs`);
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_v2_thread_deletions`,
        threadIds.length,
      );
      assert.lengthOf(
        yield* sql`SELECT * FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL`,
        threadIds.length,
      );
      const repeated = yield* reclaim();
      assert.equal(repeated.deletedProjectionRowCount, 0);
      assert.deepEqual(repeated.skippedThreads, []);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "late-native-binding",
  "claimed-start",
  "cancelled-cleanup",
  "ineligible-member",
  "malformed-lineage",
] as const)(
  "checks late barriers inside the certified root transaction before deletion: %s",
  (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { rootThreadId, lastThreadId, threadIds, proof } = yield* seedCertifiedSideChatRoot();
      let transactionDepth = 0;
      let injected = false;
      const withTransaction: typeof sql.withTransaction = (effect) =>
        Effect.gen(function* () {
          if (transactionDepth === 0 && !injected) {
            injected = true;
            if (scenario === "late-native-binding") {
              yield* sql`
                INSERT INTO orchestration_v2_native_session_bindings (
                  binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
                  native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
                ) VALUES (
                  'late:certified', ${rootThreadId}, ${proof.providerThreadId}, 'pi', 'pi',
                  NULL, 'unresolved', '', '', ${at}, '{}'
                )
              `;
            } else if (scenario === "claimed-start") {
              yield* sql`
                UPDATE orchestration_v2_projection_runs SET provider_thread_id = ${proof.providerThreadId}
                WHERE thread_id = ${rootThreadId}
              `;
              yield* sql`
                INSERT INTO orchestration_v2_effect_outbox (
                  effect_id, command_id, thread_id, effect_type, payload_json,
                  status, attempt_count, available_at, created_at, updated_at
                ) VALUES (
                  'late:certified:start', 'start:certified', ${rootThreadId}, 'provider-turn.start',
                  ${JSON.stringify({ runId: `run:${rootThreadId}` })}, 'cancelled', 1, ${at}, ${at}, ${at}
                )
              `;
            } else if (scenario === "cancelled-cleanup") {
              yield* seedLifecycleCleanup({ threadId: rootThreadId, status: "cancelled" }).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
            } else if (scenario === "ineligible-member") {
              yield* sql`
                UPDATE orchestration_v2_thread_deletions SET command_id = 'delete:unmatched'
                WHERE thread_id = ${lastThreadId}
              `;
            } else {
              yield* sql`
                UPDATE orchestration_v2_projection_threads
                SET payload_json = json_set(payload_json, '$.lineage.sideChat', json('false'))
                WHERE thread_id = ${lastThreadId}
              `;
            }
          }
          transactionDepth++;
          try {
            return yield* sql.withTransaction(effect);
          } finally {
            transactionDepth--;
          }
        });
      const intercepted = new Proxy(sql, {
        get(target, key, receiver) {
          return key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver);
        },
      });
      const result = yield* reclaim().pipe(
        Effect.provide(
          Layer.fresh(
            ThreadDataReclamation.layer.pipe(
              Layer.provide(Layer.succeed(SqlClient.SqlClient, intercepted)),
            ),
          ),
        ),
      );

      assert.isTrue(injected);
      assert.equal(result.reclaimedThreadCount, 0);
      assert.equal(result.deletedProjectionRowCount, 0);
      assert.deepEqual(
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_runs ORDER BY thread_id`,
        threadIds.map((thread_id) => ({ thread_id })),
      );
      assert.isTrue(
        result.skippedThreads.some((thread) =>
          thread.blockerCodes.includes(
            scenario === "cancelled-cleanup" ? "lifecycle_cleanup" : "unknown_dependency",
          ),
        ),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "silent-delete",
  "silent-message",
  "silent-session",
  "silent-outbox",
  "silent-position",
  "silent-metadata",
  "silent-workflow",
  "late-identity",
  "late-event",
] as const)("rolls back a certified root when heavy data survives deletion: %s", (scenario) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCertifiedSideChatRoot();
    const before = yield* snapshotRows();
    if (scenario.startsWith("silent-")) {
      const table = {
        "silent-delete": "orchestration_v2_projection_runs",
        "silent-message": "orchestration_v2_projection_messages",
        "silent-session": "orchestration_v2_projection_provider_sessions",
        "silent-outbox": "orchestration_v2_effect_outbox",
        "silent-position": "orchestration_v2_turn_item_positions",
        "silent-metadata": "mcp_app_model_context",
        "silent-workflow": "orchestration_v2_thread_launch_workflows",
        "late-identity": "",
        "late-event": "",
      }[scenario];
      yield* sql`
          CREATE TRIGGER retain_certified_data
          BEFORE DELETE ON ${sql(table)}
          WHEN OLD.thread_id = 'thread:certified:050'
          BEGIN SELECT RAISE(IGNORE); END
        `;
    } else if (scenario === "late-identity") {
      yield* sql`
          CREATE TRIGGER retain_certified_data
          AFTER DELETE ON orchestration_v2_projection_runs
          WHEN OLD.thread_id = 'thread:certified:050'
          BEGIN
            INSERT INTO orchestration_v2_native_session_bindings (
              binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
              native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
            ) VALUES ('late:inside-root', 'thread:certified:000', 'provider-thread:certified:reclaimed', 'pi', 'pi',
              NULL, 'unresolved', '', '', '2026-10-31T12:00:00.000Z', '{}');
          END
        `;
    } else {
      yield* sql`
          CREATE TRIGGER retain_certified_data
          AFTER DELETE ON orchestration_v2_projection_runs
          WHEN OLD.thread_id = 'thread:certified:050'
          BEGIN
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              actor_kind, payload_json, metadata_json, application_event_version
            ) VALUES ('late:inside-root', 'thread', 'thread:certified:000', 99, 'thread.updated',
              '2026-10-31T12:00:00.000Z', 'server', '{}', '{}', 2);
          END
        `;
    }
    const result = yield* Effect.exit(reclaim());
    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(yield* snapshotRows(), before);
    yield* sql`DROP TRIGGER retain_certified_data`;
    const resumed = yield* reclaim();
    assert.equal(resumed.reclaimedThreadCount, 51);
    assert.isEmpty(resumed.skippedThreads);
    const rows = yield* snapshotRows();
    for (const [name, values] of Object.entries(rows)) {
      if (["threads", "deletions", "events", "receipts", "deletionSessions"].includes(name))
        continue;
      assert.isEmpty(values, name);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaims cancelled settled outbox rows but preserves lifecycle barriers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:cancelled-outbox";
    const deletionCommandId = `delete:${threadId}`;
    yield* seedDeletedThread({ threadId });
    // Reclamation is permitted only because each success row matches its cancelled
    // lifecycle barrier's rootThreadId, revision, and effect type.
    for (const [effectId, commandId, effectType, status, payloadJson] of [
      ["cancelled:generic", "other:generic", "preview.cleanup", "cancelled", "{}"],
      [
        "cancelled:lifecycle",
        "other:lifecycle",
        "attachment.cleanup",
        "cancelled",
        `{"lifecycle":{"rootThreadId":"${threadId}","revision":1}}`,
      ],
      [
        "cancelled:delete-barrier",
        deletionCommandId,
        "provider-session.detach",
        "cancelled",
        `{"lifecycle":{"rootThreadId":"${threadId}","revision":1}}`,
      ],
      [
        "succeeded:detach-lifecycle",
        "other:detach-lifecycle",
        "provider-session.detach",
        "succeeded",
        `{"lifecycle":{"rootThreadId":"${threadId}","revision":1}}`,
      ],
      [
        "succeeded:attachment-lifecycle",
        "other:attachment-lifecycle",
        "attachment.cleanup",
        "succeeded",
        `{"lifecycle":{"rootThreadId":"${threadId}","revision":1}}`,
      ],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at, completed_at
        ) VALUES (
          ${effectId}, ${commandId}, ${threadId}, ${effectType}, ${payloadJson}, ${status},
          0, ${at}, ${at}, ${at}, ${at}
        )
      `;
    }

    const result = yield* reclaim();
    assert.equal(result.reclaimedThreadCount, 1);
    assert.equal(result.deletedOutboxCount, 2);
    const retained = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox ORDER BY effect_id
    `;
    assert.deepEqual(
      retained.map((row) => row.effect_id),
      ["cancelled:delete-barrier", "cancelled:lifecycle", "succeeded:detach-lifecycle"],
    );

    const repeated = yield* reclaim();
    assert.equal(repeated.deletedOutboxCount, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("blocks cancelled lifecycle cleanup when only a different revision succeeded", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:cancelled-revision-mismatch";
    yield* seedDeletedThread({ threadId });
    for (const [effectId, status, revision] of [
      ["cancelled:lifecycle", "cancelled", 1],
      ["succeeded:lifecycle", "succeeded", 2],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at, completed_at
        ) VALUES (
          ${effectId}, ${`cleanup:${effectId}`}, ${threadId}, 'attachment.cleanup',
          ${JSON.stringify({ lifecycle: { rootThreadId: threadId, revision } })}, ${status},
          0, ${at}, ${at}, ${at}, ${at}
        )
      `;
    }

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    expectBlockers(result, threadId, ["lifecycle_cleanup"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "providerSessionId",
  "retirementRevision",
  "retirementSourceToken",
  "missing-source-token",
  "wrong-command",
  "matching",
] as const)("requires exact retirement provenance before reclamation (%s)", (mismatch) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = `thread:reclaim:retirement:${mismatch}`;
    yield* seedDeletedThread({ threadId });
    yield* seedReclamationRows(threadId);
    for (const status of ["cancelled", "succeeded"] as const) {
      const commandId = `retirement:${mismatch}:${status}`;
      const payload = {
        lifecycle: {
          commandId:
            status === "succeeded" && mismatch === "wrong-command" ? "other-command" : commandId,
          rootThreadId: threadId,
          revision: 1,
        },
        providerSessionId:
          status === "succeeded" && mismatch === "providerSessionId" ? "other-session" : "session",
        retirementRevision: status === "succeeded" && mismatch === "retirementRevision" ? 2 : 1,
        ...(mismatch === "missing-source-token"
          ? {}
          : {
              retirementSourceToken:
                status === "succeeded" && mismatch === "retirementSourceToken"
                  ? "other-source"
                  : "source",
            }),
      };
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at, completed_at
        ) VALUES (
          ${commandId}, ${commandId}, ${threadId}, 'provider-session.detach',
          ${JSON.stringify(payload)}, ${status}, 1, ${at}, ${at}, ${at}, ${at}
        )
      `;
    }

    const before = yield* snapshotRows();
    const summary = yield* reclaim();
    if (mismatch === "matching") {
      assert.equal(summary.reclaimedThreadCount, 1);
      assert.isAbove(summary.deletedProjectionRowCount, 0);
      assert.deepEqual(
        (yield* snapshotRows()).outbox,
        before.outbox.filter((row) => row.effect_type === "provider-session.detach"),
      );
    } else {
      assert.equal(summary.reclaimedThreadCount, 0);
      expectBlockers(summary, threadId, ["lifecycle_cleanup"]);
      assert.deepEqual(yield* snapshotRows(), before);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["matching", "other-file", "other-thread", "other-source"] as const)(
  "matches a cancelled Pi deletion to the exact succeeded request (%s)",
  (replacement) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = `thread:reclaim:pi-cancelled:${replacement}`;
      yield* seedDeletedThread({ threadId });
      yield* seedReclamationRows(threadId);
      for (const status of ["cancelled", "succeeded"] as const) {
        const changed = status === "succeeded";
        yield* sql`
          INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status,
            attempt_count, available_at, created_at, updated_at, completed_at
          ) VALUES (
            ${`pi:${status}:${replacement}`}, ${`delete:${threadId}`}, ${threadId}, 'provider-thread.delete',
            ${JSON.stringify({
              driver: "pi",
              providerInstanceId: "pi",
              providerThreadId: "provider-thread",
              nativeId: "native",
              threadIds: changed && replacement === "other-thread" ? ["other-thread"] : [threadId],
              nativeStorage: {
                type: "resolved",
                canonicalRoot: "/sessions",
                canonicalFile:
                  changed && replacement === "other-file" ? "other.jsonl" : "session.jsonl",
              },
              lifecycle: {
                rootThreadId: threadId,
                revision: 1,
                sourceToken: changed && replacement === "other-source" ? "other-source" : "source",
              },
            })},
            ${status}, 1, ${at}, ${at}, ${at}, ${at}
          )
        `;
      }

      const before = yield* snapshotRows();
      const summary = yield* reclaim();
      if (replacement === "matching") {
        assert.equal(summary.reclaimedThreadCount, 1);
        assert.isAbove(summary.deletedProjectionRowCount, 0);
        assert.isEmpty((yield* snapshotRows()).outbox);
        assert.equal(summary.deletedOutboxCount, before.outbox.length);
        const repeated = yield* reclaim();
        assert.equal(repeated.reclaimedThreadCount, 1);
        assert.equal(repeated.deletedOutboxCount, 0);
        assert.isEmpty((yield* snapshotRows()).outbox);
      } else {
        assert.equal(summary.reclaimedThreadCount, 0);
        expectBlockers(summary, threadId, ["lifecycle_cleanup"]);
        assert.deepEqual(yield* snapshotRows(), before);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("blocks cancelled lifecycle cleanup when only a different root thread succeeded", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:cancelled-root-mismatch";
    yield* seedDeletedThread({ threadId });
    for (const [effectId, status, rootThreadId] of [
      ["cancelled:lifecycle", "cancelled", threadId],
      ["succeeded:lifecycle", "succeeded", "thread:other-root"],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at, completed_at
        ) VALUES (
          ${effectId}, ${`cleanup:${effectId}`}, ${threadId}, 'attachment.cleanup',
          ${JSON.stringify({ lifecycle: { rootThreadId, revision: 1 } })}, ${status},
          0, ${at}, ${at}, ${at}, ${at}
        )
      `;
    }

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    expectBlockers(result, threadId, ["lifecycle_cleanup"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not let provider-session.detach replace cancelled attachment.cleanup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:cancelled-effect-mismatch";
    yield* seedDeletedThread({ threadId });
    for (const [effectId, status, effectType] of [
      ["cancelled:attachment", "cancelled", "attachment.cleanup"],
      ["succeeded:detach", "succeeded", "provider-session.detach"],
    ] as const) {
      yield* sql`
          INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status,
            attempt_count, available_at, created_at, updated_at, completed_at
          ) VALUES (
            ${effectId}, ${`cleanup:${effectId}`}, ${threadId}, ${effectType},
            ${JSON.stringify({ lifecycle: { rootThreadId: threadId, revision: 1 } })}, ${status},
            0, ${at}, ${at}, ${at}, ${at}
          )
        `;
    }

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    expectBlockers(result, threadId, ["lifecycle_cleanup"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "keeps a cancelled legacy deletion barrier without lifecycle payload when its receipt is accepted",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = "thread:reclaim:cancelled-legacy-delete-barrier";
      yield* seedDeletedThread({ threadId });
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at, completed_at
        ) VALUES (
          'cancelled:legacy-delete-barrier', ${`delete:${threadId}`}, ${threadId},
          'provider-session.detach', '{}', 'cancelled', 0, ${at}, ${at}, ${at}, ${at}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_effect_outbox (
          effect_id, command_id, thread_id, effect_type, payload_json, status,
          attempt_count, available_at, created_at, updated_at, completed_at
        ) VALUES (
          'succeeded:matching-lifecycle-detach', 'cleanup:succeeded-detach', ${threadId},
          'provider-session.detach',
          ${JSON.stringify({ lifecycle: { rootThreadId: threadId, revision: 1 } })},
          'succeeded', 0, ${at}, ${at}, ${at}, ${at}
        )
      `;

      const before = yield* snapshotRows();
      const result = yield* reclaim();
      const after = yield* snapshotRows();

      assert.deepEqual(after, before);
      assert.equal(result.reclaimedThreadCount, 0);
      expectBlockers(result, threadId, ["lifecycle_cleanup"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "recovers cross-batch transfers and handoffs after the target batch removes projections",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rootThreadId = "thread:cross-batch:root";
      const targetThreadId = "thread:cross-batch:000";
      const sourceThreadId = "thread:cross-batch:050";
      const deleteCommandId = `delete:${rootThreadId}`;
      const targetRunId = `run:${targetThreadId}`;
      const targetProviderThreadId = `provider-thread:${targetThreadId}`;
      const childCount = ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE + 1;

      for (let index = 0; index < childCount; index++) {
        const threadId = `thread:cross-batch:${String(index).padStart(3, "0")}`;
        yield* seedDeletedThread({
          threadId,
          parentThreadId: rootThreadId,
          relationshipToParent: "subagent",
          rootThreadId,
          operationRootThreadId: rootThreadId,
          commandId: deleteCommandId,
          insertReceipt: false,
        });
        yield* seedSubagentOwnership({ parentThreadId: rootThreadId, childThreadId: threadId });
      }
      yield* seedDeletedThread({ threadId: rootThreadId, commandId: deleteCommandId });
      yield* seedRun({ threadId: targetThreadId, runId: targetRunId, status: "completed" });
      yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, owner_node_id, provider, provider_session_id,
        status, first_run_ordinal, last_run_ordinal, updated_at, payload_json,
        driver, provider_instance_id
      ) VALUES (
        ${targetProviderThreadId}, ${targetThreadId}, NULL, 'codex', NULL,
        'completed', 1, 1, ${at}, '{}', 'codex', 'codex'
      )
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming,
        created_at, updated_at, payload_json
      ) VALUES (
        'message:cross-batch:target', ${targetThreadId}, NULL, NULL, 'user', 0,
        ${at}, ${at}, '{}'
      )
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_context_transfers (
        context_transfer_id, source_thread_id, target_thread_id, target_run_id,
        type, status, source_provider, target_provider, updated_at,
        source_provider_instance_id, target_provider_instance_id, payload_json
      ) VALUES (
        'transfer:cross-batch', ${sourceThreadId}, ${targetThreadId}, ${targetRunId},
        'fork', 'completed', 'codex', 'codex', ${at}, 'codex', 'codex', '{}'
      )
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_context_handoffs (
        context_handoff_id, thread_id, target_run_id, to_provider_thread_id,
        strategy, status, updated_at, payload_json
      ) VALUES (
        'handoff:cross-batch', ${sourceThreadId}, ${targetRunId}, ${targetProviderThreadId},
        'reuse', 'completed', ${at}, '{}'
      )
    `;
      yield* sql`
      CREATE TRIGGER remove_cross_batch_target_projections
      AFTER DELETE ON orchestration_v2_projection_messages
      WHEN OLD.thread_id = 'thread:cross-batch:000'
      BEGIN
        DELETE FROM orchestration_v2_projection_provider_threads WHERE thread_id = 'thread:cross-batch:000';
        DELETE FROM orchestration_v2_projection_runs WHERE thread_id = 'thread:cross-batch:000';
      END
    `;

      const result = yield* reclaim();

      assert.equal(result.reclaimedThreadCount, childCount + 1);
      assert.deepEqual(
        yield* sql`
        SELECT context_transfer_id FROM orchestration_v2_projection_context_transfers
        WHERE context_transfer_id = 'transfer:cross-batch'
      `,
        [],
      );
      assert.deepEqual(
        yield* sql`
        SELECT context_handoff_id FROM orchestration_v2_projection_context_handoffs
        WHERE context_handoff_id = 'handoff:cross-batch'
      `,
        [],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaims a large subagent closure in ordered bounded chunks and resumes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rootThreadId = "thread:reclaim:large:root";
    const deleteCommandId = `delete:${rootThreadId}`;
    const childCount = ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE + 1;
    const childThreadIds: Array<string> = [];
    for (let index = 0; index < childCount; index++) {
      const childThreadId = `thread:reclaim:large:${String(index).padStart(3, "0")}`;
      childThreadIds.push(childThreadId);
      yield* seedDeletedThread({
        threadId: childThreadId,
        parentThreadId: rootThreadId,
        relationshipToParent: "subagent",
        rootThreadId,
        operationRootThreadId: rootThreadId,
        commandId: deleteCommandId,
        insertReceipt: false,
      });
      yield* seedSubagentOwnership({
        parentThreadId: rootThreadId,
        childThreadId,
      });
      const payloadJson = JSON.stringify({
        attachments:
          index === 0 || index === childCount - 1
            ? [{ id: "attachment:large-closure-shared", type: "file", name: "shared.txt" }]
            : [],
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json
        ) VALUES (
          ${`message:${childThreadId}`}, ${childThreadId}, NULL, NULL, 'user', 0, ${at}, ${at}, ${payloadJson}
        )
      `;
    }
    yield* seedDeletedThread({ threadId: rootThreadId, commandId: deleteCommandId });
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming,
        created_at, updated_at, payload_json
      ) VALUES (
        ${`message:${rootThreadId}`}, ${rootThreadId}, NULL, NULL, 'user', 0, ${at}, ${at}, '{}'
      )
    `;
    const failedChildThreadId = childThreadIds.at(-1)!;
    const firstChildThreadId = childThreadIds[0]!;
    const sharedProviderSessionId = "provider-session:large-closure-shared";
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_sessions (
        provider_session_id, thread_id, provider, status, model, updated_at,
        payload_json, driver, provider_instance_id
      ) VALUES (
        ${sharedProviderSessionId}, ${firstChildThreadId}, 'codex', 'idle', NULL, ${at}, '{}', 'codex', 'codex'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_session_bindings (
        provider_session_id, thread_id
      ) VALUES
        (${sharedProviderSessionId}, ${firstChildThreadId}),
        (${sharedProviderSessionId}, ${failedChildThreadId})
    `;
    for (const threadId of [firstChildThreadId, failedChildThreadId]) {
      yield* sql`
        INSERT INTO orchestration_v2_native_session_bindings (
          binding_key, thread_id, provider_thread_id, provider_instance_id, driver,
          native_id, storage_type, canonical_root, canonical_file, bound_at, payload_json
        ) VALUES (
          ${`native-binding:${threadId}`}, ${threadId}, ${`provider-thread:${threadId}`},
          'codex', 'codex', 'native:large-closure-shared', 'resolved', '/sessions',
          'large-closure-shared.jsonl', ${at}, '{}'
        )
      `;
    }
    yield* sql`
      CREATE TRIGGER reject_reclamation_large_second_chunk
      BEFORE DELETE ON orchestration_v2_projection_messages
      WHEN OLD.thread_id = 'thread:reclaim:large:050'
      BEGIN SELECT RAISE(ABORT, 'injected large-closure second-chunk failure'); END
    `;

    const failed = yield* Effect.exit(reclaim());
    assert.isTrue(Exit.isFailure(failed));
    const remainingMessages = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_messages
      WHERE thread_id LIKE 'thread:reclaim:large:%'
      ORDER BY thread_id
    `;
    assert.deepEqual(
      remainingMessages.map((row) => row.thread_id),
      [failedChildThreadId, rootThreadId],
    );
    const remainingOwnership = yield* sql<{ readonly child_thread_id: string }>`
      SELECT child_thread_id
      FROM orchestration_v2_projection_subagents
      WHERE thread_id = ${rootThreadId}
      ORDER BY child_thread_id
    `;
    assert.deepEqual(
      remainingOwnership.map((row) => row.child_thread_id),
      [failedChildThreadId],
    );
    const remainingSharedProviderBindings = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_provider_session_bindings
      WHERE provider_session_id = ${sharedProviderSessionId}
      ORDER BY thread_id
    `;
    assert.deepEqual(
      remainingSharedProviderBindings.map((row) => row.thread_id),
      [failedChildThreadId],
    );
    const remainingSharedNativeBindings = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_native_session_bindings
      WHERE native_id = 'native:large-closure-shared'
    `;
    assert.deepEqual(
      remainingSharedNativeBindings.map((row) => row.thread_id),
      [failedChildThreadId],
    );

    yield* sql`DROP TRIGGER reject_reclamation_large_second_chunk`;
    const resumed = yield* reclaim();
    assert.equal(resumed.reclaimedThreadCount, childCount + 1);
    const finalMessages = yield* sql`SELECT * FROM orchestration_v2_projection_messages`;
    const finalOwnership = yield* sql`SELECT * FROM orchestration_v2_projection_subagents`;
    const finalSharedProviderSessions = yield* sql`
      SELECT * FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${sharedProviderSessionId}
    `;
    const finalSharedProviderBindings = yield* sql`
      SELECT * FROM orchestration_v2_projection_provider_session_bindings
      WHERE provider_session_id = ${sharedProviderSessionId}
    `;
    const finalSharedNativeRows = yield* sql`
      SELECT * FROM orchestration_v2_native_session_bindings
      WHERE native_id = 'native:large-closure-shared'
    `;
    assert.deepEqual(finalMessages, []);
    assert.deepEqual(finalOwnership, []);
    assert.deepEqual(finalSharedProviderSessions, []);
    assert.deepEqual(finalSharedProviderBindings, []);
    assert.deepEqual(finalSharedNativeRows, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaim scans candidates using the fixed deterministic batch size", () =>
  Effect.gen(function* () {
    const count = ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE * 3 + 1;
    for (let index = 0; index < count; index++) {
      yield* seedDeletedThread({ threadId: `thread:batch:${String(index).padStart(3, "0")}` });
    }

    const result = yield* reclaim();

    assert.equal(ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE, 50);
    assert.equal(result.reclaimedThreadCount, count);
    assert.deepEqual(result.skippedThreads, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("compactEventStore does not reclaim deleted thread projections", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const threadId = "thread:reclaim:online-compaction-boundary";
    yield* seedDeletedThread({ threadId });
    yield* seedReclamationRows(threadId);

    yield* maintenance.compactEventStore();

    const retainedMessage = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId}
    `;
    const retainedShell = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NOT NULL
    `;
    assert.equal(retainedMessage[0]?.count, 1);
    assert.equal(retainedShell[0]?.count, 1);
  }).pipe(Effect.provide(layerMaintenanceTest)),
);

it.effect("reclaimDeletedThreadData reclaims only after an explicit call", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const threadId = "thread:reclaim:explicit-maintenance-call";
    yield* seedDeletedThread({ threadId });
    yield* seedReclamationRows(threadId);

    yield* maintenance.compactEventStore();
    const beforeExplicitReclamation = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId}
    `;
    assert.equal(beforeExplicitReclamation[0]?.count, 1);

    const summary = yield* maintenance.reclaimDeletedThreadData;

    assert.equal(summary.reclaimedThreadCount, 1);
    const afterExplicitReclamation = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId}
    `;
    assert.equal(afterExplicitReclamation[0]?.count, 0);
  }).pipe(Effect.provide(layerMaintenanceTest)),
);
