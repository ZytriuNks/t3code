import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThreadJson,
  type ProviderThreadId,
  ThreadDeletionRecord,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type Proof = NonNullable<ThreadDeletionRecord["noNativeSessionProofs"]>[number];
const decodeProvider = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadDeletionRecord));

// Creation and the monotone gate are persisted by the provider projection, never inferred from execution history.
const readSource = Effect.fn("ThreadNativeAbsence.readSource")(function* (
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_provider_threads
    WHERE provider_thread_id = ${providerThreadId} AND thread_id = ${threadId} AND driver = 'pi'
      AND json_extract(payload_json, '$.id') = provider_thread_id
      AND json_extract(payload_json, '$.appThreadId') = thread_id
      AND json_extract(payload_json, '$.driver') = driver
      AND json_extract(payload_json, '$.providerInstanceId') = provider_instance_id
      AND json_extract(payload_json, '$.status') = status
      AND json_extract(payload_json, '$.providerSessionId') IS provider_session_id
      AND json_extract(payload_json, '$.firstRunOrdinal') IS first_run_ordinal
      AND json_extract(payload_json, '$.lastRunOrdinal') IS last_run_ordinal
  `;
  const decoded = decodeProvider(rows[0]?.payload_json);
  if (Option.isNone(decoded)) return;
  const provider = decoded.value;
  if (
    provider.nativeSessionOrigin?.version !== 1 ||
    provider.nativeSessionOrigin.state !== "unstarted" ||
    provider.providerSessionId !== null ||
    provider.nativeThreadRef !== null ||
    provider.firstRunOrdinal !== null ||
    provider.lastRunOrdinal !== null ||
    provider.nativeStorage?.type !== "unresolved" ||
    provider.nativeConversationHeadRef !== null ||
    provider.forkedFrom !== null ||
    provider.handoffIds.length !== 0 ||
    (provider.pendingBackgroundTasks?.length ?? 0) !== 0
  )
    return;
  const contradictions = yield* sql`
    SELECT 1 FROM orchestration_v2_native_session_bindings WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_thread_deletion_sessions WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_projection_runs WHERE provider_thread_id = ${providerThreadId}
      AND (status NOT IN ('queued', 'cancelled', 'failed') OR json_type(payload_json, '$.startedAt') <> 'null')
    UNION ALL SELECT 1 FROM orchestration_v2_projection_run_attempts WHERE provider_thread_id = ${providerThreadId}
      AND (status NOT IN ('pending', 'cancelled', 'failed') OR provider_turn_id IS NOT NULL
        OR json_type(payload_json, '$.startedAt') <> 'null')
    UNION ALL SELECT 1 FROM orchestration_v2_effect_outbox AS start
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = json_extract(start.payload_json, '$.runId')
      WHERE run.provider_thread_id = ${providerThreadId} AND start.effect_type = 'provider-turn.start'
        AND (start.status <> 'cancelled' OR start.attempt_count <> 0)
    LIMIT 1
  `;
  if (contradictions.length !== 0) return;
  return provider;
});

// The caller holds the deletion transaction and cancels starts before producing the first tombstone.
export const certifyCancelledQueuedSessions = Effect.fn(
  "ThreadNativeAbsence.certifyCancelledQueuedSessions",
)(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.forEach(events, (event) =>
    Effect.gen(function* () {
      if (event.type !== "thread.deleted" || event.deletionRecord === undefined) return event;
      const { noNativeSessionProofs: _untrusted, ...record } = event.deletionRecord;
      const existing =
        yield* sql`SELECT 1 FROM orchestration_v2_thread_deletions WHERE thread_id = ${event.threadId}`;
      const live =
        yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId} AND deleted_at IS NULL`;
      const proofs: Array<Proof> = [];
      if (existing.length === 0 && live.length === 1) {
        const providers = yield* sql<{ readonly provider_thread_id: ProviderThreadId }>`
        SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
        WHERE thread_id = ${event.threadId} AND driver = 'pi'
      `;
        for (const row of providers) {
          if (
            record.sessions.some((session) => session.providerThreadId === row.provider_thread_id)
          )
            continue;
          const provider = yield* readSource(event.threadId, row.provider_thread_id);
          if (
            provider === undefined ||
            events.some(
              (candidate) =>
                candidate.type === "provider-thread.updated" &&
                candidate.payload.id === provider.id,
            )
          )
            continue;
          const queued = yield* sql<{ readonly run_id: string }>`
          SELECT run_id FROM orchestration_v2_projection_runs
          WHERE provider_thread_id = ${provider.id} AND status = 'queued'
        `;
          if (
            !queued.every((run) =>
              events.some(
                (candidate) =>
                  candidate.type === "run.updated" &&
                  candidate.payload.id === run.run_id &&
                  candidate.payload.status === "cancelled" &&
                  candidate.payload.startedAt === null,
              ),
            )
          )
            continue;
          proofs.push({
            providerThreadId: provider.id,
            providerInstanceId: provider.providerInstanceId,
            source: "queued_provider_origin",
            version: 1,
          });
        }
      }
      return {
        ...event,
        deletionRecord: {
          ...record,
          ...(proofs.length === 0 ? {} : { noNativeSessionProofs: proofs }),
        },
      };
    }),
  );
});

export const checkNoNativeSessionProofs = Effect.fn(
  "ThreadNativeAbsence.checkNoNativeSessionProofs",
)(function* (threadIds: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  const confirmed = new Set<string>();
  const contradicted = new Set<string>();
  const rows = yield* sql<{ readonly thread_id: ThreadId; readonly payload_json: string }>`
      SELECT thread_id, payload_json FROM orchestration_v2_thread_deletions WHERE thread_id IN ${sql.in(threadIds)}
    `;
  for (const row of rows) {
    const decoded = decodeRecord(row.payload_json);
    if (Option.isNone(decoded) || decoded.value.threadId !== row.thread_id) {
      contradicted.add(row.thread_id);
      continue;
    }
    for (const proof of decoded.value.noNativeSessionProofs ?? []) {
      const source = yield* readSource(row.thread_id, proof.providerThreadId);
      if (source?.providerInstanceId === proof.providerInstanceId) {
        confirmed.add(proof.providerThreadId);
        continue;
      }
      const remaining = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_native_session_bindings WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_thread_deletion_sessions WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_runs WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_run_attempts WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_nodes WHERE provider_thread_id = ${proof.providerThreadId}
          LIMIT 1
        `;
      if (remaining.length !== 0) contradicted.add(row.thread_id);
    }
  }
  return { confirmed, contradicted };
});
