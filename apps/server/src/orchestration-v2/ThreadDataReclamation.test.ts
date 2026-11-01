import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadDataReclamation from "./ThreadDataReclamation.ts";

const layerTest = ThreadDataReclamation.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerMaintenanceStores = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const layerMaintenanceTest = ProjectionMaintenance.layer.pipe(
  Layer.provideMerge(layerMaintenanceStores),
);

const at = "2026-10-31T12:00:00.000Z";

interface ThreadSeed {
  readonly threadId: string;
  readonly state?: "deleted" | "active" | "archived";
  readonly parentThreadId?: string | null;
  readonly relationshipToParent?: string | null;
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
}) {
  const sql = yield* SqlClient.SqlClient;
  const commandId = `delete:${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox (
      effect_id, command_id, thread_id, effect_type, payload_json, status,
      attempt_count, available_at, created_at, updated_at
    ) VALUES (
      ${`cleanup:${input.threadId}`}, ${commandId}, ${input.threadId}, 'attachment.cleanup',
      ${JSON.stringify({ lifecycle: { rootThreadId: input.threadId, revision: 1 } })},
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
    const sql = yield* SqlClient.SqlClient;
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
    assert.deepEqual(result.skippedThreads.map((entry) => entry.threadId), [
      "thread:busy",
      "thread:busy-provider-turn",
    ]);
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

    const receipts = yield* sql<{ readonly command_id: string; readonly aggregate_id: string }>`
      SELECT command_id, aggregate_id FROM orchestration_command_receipts
    `;
    assert.deepEqual(receipts, [{ command_id: commandId, aggregate_id: "thread:receipt-root" }]);

    const result = yield* reclaim();

    assert.equal(result.reclaimedThreadCount, 2);
    assert.deepEqual(result.skippedThreads, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaim blocks pending running failed and cancelled lifecycle cleanup", () =>
  Effect.gen(function* () {
    for (const status of ["pending", "running", "failed", "cancelled"] as const) {
      const threadId = `thread:cleanup:${status}`;
      yield* seedDeletedThread({ threadId });
      yield* seedLifecycleCleanup({ threadId, status });
    }

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    for (const status of ["pending", "running", "failed", "cancelled"] as const) {
      expectBlockers(result, `thread:cleanup:${status}`, ["lifecycle_cleanup"]);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "reclaim blocks a deleted source with a surviving fork or pending context transfer",
  () =>
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
          attachments: [{ id: "attachment:shared", type: "file", name: "shared.txt", mimeType: "text/plain", sizeBytes: 1 }],
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
    assert.deepEqual(after.outbox.map((row) => row.command_id), [commandId]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reclaims dependent rows while preserving deletion anchors and the thread shell", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:data";
    yield* seedDeletedThread({ threadId });
    yield* seedReclamationRows(threadId);

    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.equal(result.reclaimedThreadCount, 1);
    assert.deepEqual(result.skippedThreads, []);
    assert.equal(result.deletedEventCount, 1);
    assert.equal(result.deletedReceiptCount, 1);
    assert.equal(result.deletedProjectionRowCount, 17);
    assert.equal(result.deletedTurnItemPositionCount, 1);
    assert.equal(result.deletedOutboxCount, 1);
    assert.deepEqual(
      after.events.filter((row) => row.stream_id === threadId).map((row) => row.event_type).sort(),
      ["thread.created", "thread.deleted"],
    );
    assert.deepEqual(after.receipts.map((row) => row.command_type), ["thread.delete"]);
    assert.equal(after.threads.filter((row) => row.thread_id === threadId).length, 1);
    assert.equal(after.deletions.filter((row) => row.thread_id === threadId).length, 1);
    assert.equal(after.deletionSessions.filter((row) => row.thread_id === threadId).length, 1);
    assert.equal(after.contextTransfers.length, 0);
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
    assert.equal((yield* snapshotRows()).events.filter((row) => row.stream_id === threadId).length, 2);
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
    assert.deepEqual(afterFailure.map((row) => row.thread_id), ["thread:reclaim:batch:050"]);

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

it.effect("reclaims cancelled settled outbox rows but preserves lifecycle barriers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = "thread:reclaim:cancelled-outbox";
    const deletionCommandId = `delete:${threadId}`;
    yield* seedDeletedThread({ threadId });
    // Reclamation is permitted only because the success row matches both cancelled
    // lifecycle barriers' rootThreadId and revision.
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
    assert.equal(result.deletedOutboxCount, 1);
    const retained = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox ORDER BY effect_id
    `;
    assert.deepEqual(retained.map((row) => row.effect_id), [
      "cancelled:delete-barrier",
      "cancelled:lifecycle",
      "succeeded:detach-lifecycle",
    ]);

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
    assert.deepEqual(remainingMessages.map((row) => row.thread_id), [failedChildThreadId, rootThreadId]);
    const remainingOwnership = yield* sql<{ readonly child_thread_id: string }>`
      SELECT child_thread_id
      FROM orchestration_v2_projection_subagents
      WHERE thread_id = ${rootThreadId}
      ORDER BY child_thread_id
    `;
    assert.deepEqual(remainingOwnership.map((row) => row.child_thread_id), [failedChildThreadId]);
    const remainingSharedProviderBindings = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_projection_provider_session_bindings
      WHERE provider_session_id = ${sharedProviderSessionId}
      ORDER BY thread_id
    `;
    assert.deepEqual(remainingSharedProviderBindings.map((row) => row.thread_id), [failedChildThreadId]);
    const remainingSharedNativeBindings = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id
      FROM orchestration_v2_native_session_bindings
      WHERE native_id = 'native:large-closure-shared'
    `;
    assert.deepEqual(remainingSharedNativeBindings.map((row) => row.thread_id), [failedChildThreadId]);

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
    for (let index = 0; index < ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE + 1; index++) {
      yield* seedDeletedThread({ threadId: `thread:batch:${String(index).padStart(3, "0")}` });
    }

    const result = yield* reclaim();

    assert.equal(ThreadDataReclamation.THREAD_DATA_RECLAMATION_BATCH_SIZE, 50);
    assert.equal(result.reclaimedThreadCount, 51);
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

    yield* maintenance.compactEventStore;

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

    yield* maintenance.compactEventStore;
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
