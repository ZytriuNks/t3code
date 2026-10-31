import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadDataReclamation from "./ThreadDataReclamation.ts";

const layerTest = ThreadDataReclamation.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
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
  readonly forkedFrom?: unknown;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* seedThread({ ...input, state: "deleted" });
  const commandId = `delete:${input.threadId}`;
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
  yield* sql`
    INSERT INTO orchestration_command_receipts (
      command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
      status, error, command_type
    ) VALUES (
      ${commandId}, 'thread', ${input.threadId}, ${at}, 0, 'accepted', NULL, 'thread.delete'
    )
  `;
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
  readonly status: "pending" | "running" | "failed";
}) {
  const sql = yield* SqlClient.SqlClient;
  const commandId = `delete:${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_effect_outbox (
      effect_id, command_id, thread_id, effect_type, payload_json, status,
      attempt_count, available_at, created_at, updated_at
    ) VALUES (
      ${`cleanup:${input.threadId}`}, ${commandId}, ${input.threadId}, 'attachment.cleanup',
      '{"lifecycle":{"revision":1}}', ${input.status}, 0, ${at}, ${at}, ${at}
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
    messages,
    turnItems,
    positions,
  };
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
    yield* seedDeletedThread({ threadId: "thread:parent" });
    yield* seedDeletedThread({
      threadId: "thread:child",
      parentThreadId: "thread:parent",
      relationshipToParent: "subagent",
      rootThreadId: "thread:parent",
      operationRootThreadId: "thread:parent",
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

it.effect("reclaim blocks pending running and failed lifecycle cleanup", () =>
  Effect.gen(function* () {
    for (const status of ["pending", "running", "failed"] as const) {
      const threadId = `thread:cleanup:${status}`;
      yield* seedDeletedThread({ threadId });
      yield* seedLifecycleCleanup({ threadId, status });
    }

    const before = yield* snapshotRows();
    const result = yield* reclaim();
    const after = yield* snapshotRows();

    assert.deepEqual(after, before);
    assert.equal(result.reclaimedThreadCount, 0);
    for (const status of ["pending", "running", "failed"] as const) {
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
