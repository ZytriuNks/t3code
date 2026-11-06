import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RunJson,
  type ProviderThreadId,
  ThreadDeletionRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type Proof = NonNullable<ThreadDeletionRecord["noNativeSessionProofs"]>[number];
const decodeProvider = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeAttempt = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2RunAttemptJson),
);
const decodeNode = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJson),
);
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadDeletionRecord));

// 只在持有删除/回收事务时读取；queued -> starting 会先持久化 ordinal/session，再允许外部 open。
const readSource = Effect.fn("ThreadNativeAbsence.readSource")(function* (
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  phase: "queued" | "cancelled",
) {
  const sql = yield* SqlClient.SqlClient;
  const providers = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_provider_threads
    WHERE provider_thread_id = ${providerThreadId} AND thread_id = ${threadId} AND driver = 'pi'
      AND json_extract(payload_json, '$.id') = provider_thread_id
      AND json_extract(payload_json, '$.appThreadId') = thread_id
      AND json_extract(payload_json, '$.providerInstanceId') = provider_instance_id
      AND json_extract(payload_json, '$.driver') = driver
      AND json_extract(payload_json, '$.status') = status
      AND json_extract(payload_json, '$.providerSessionId') IS provider_session_id
      AND json_extract(payload_json, '$.firstRunOrdinal') IS first_run_ordinal
      AND json_extract(payload_json, '$.lastRunOrdinal') IS last_run_ordinal
  `;
  const decoded = decodeProvider(providers[0]?.payload_json);
  if (Option.isNone(decoded)) return;
  const provider = decoded.value;
  if (
    provider.status !== "not_loaded" ||
    provider.providerSessionId !== null ||
    provider.nativeThreadRef !== null ||
    provider.firstRunOrdinal !== null ||
    provider.lastRunOrdinal !== null ||
    provider.ownerNodeId !== null ||
    provider.nativeConversationHeadRef !== null ||
    provider.nativeStorage?.type !== "unresolved" ||
    provider.forkedFrom !== null ||
    provider.handoffIds.length !== 0 ||
    (provider.pendingBackgroundTasks?.length ?? 0) !== 0
  )
    return;
  const identities = yield* sql`
    SELECT 1 FROM orchestration_v2_native_session_bindings WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_thread_deletion_sessions WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_sessions
      WHERE thread_id = ${threadId} AND provider_instance_id = ${provider.providerInstanceId}
  `;
  if (identities.length !== 0) return;
  const runRows = yield* sql<{
    readonly run_id: string;
    readonly thread_id: string;
    readonly provider_thread_id: string | null;
    readonly status: string;
    readonly payload_json: string;
  }>`
    SELECT run_id, thread_id, provider_thread_id, status, payload_json FROM orchestration_v2_projection_runs
    WHERE provider_thread_id = ${providerThreadId} OR json_extract(payload_json, '$.providerThreadId') = ${providerThreadId}
    ORDER BY ordinal, run_id
  `;
  const runs: Array<OrchestrationV2RunJson> = [];
  for (const row of runRows) {
    const decoded = decodeRun(row.payload_json);
    if (Option.isNone(decoded)) return;
    const run = decoded.value;
    if (
      run.id !== row.run_id ||
      row.thread_id !== threadId ||
      run.threadId !== threadId ||
      row.provider_thread_id !== providerThreadId ||
      run.providerThreadId !== providerThreadId ||
      row.status !== run.status ||
      !(run.status === "cancelled" || (phase === "queued" && run.status === "queued")) ||
      run.startedAt !== null ||
      run.providerInstanceId !== provider.providerInstanceId ||
      run.rootNodeId === null ||
      run.activeAttemptId === null ||
      (run.status === "queued" ? run.completedAt !== null : run.completedAt === null)
    )
      return;
    runs.push(run);
  }
  if (
    runs.length === 0 ||
    !runs.some(
      (run) =>
        derive.providerThread({ driver: provider.driver, nativeThreadId: `pending:${run.id}` }) ===
        providerThreadId,
    )
  )
    return;
  const runIds = runs.map((run) => run.id);
  if (phase === "queued") {
    // 取消命令的回执和 run 事件在压缩后仍保留；不依赖可被后续元数据覆盖的 thread.archived。
    for (const run of runs.filter((run) => run.status === "cancelled")) {
      const cancellation = yield* sql`
        SELECT 1 FROM orchestration_events AS created
        INNER JOIN orchestration_events AS cancelled ON cancelled.stream_id = created.stream_id
        INNER JOIN orchestration_command_receipts AS receipt ON receipt.command_id = cancelled.command_id
          AND receipt.aggregate_kind = 'thread'
          AND receipt.status = 'accepted'
        WHERE created.stream_id = ${threadId} AND created.aggregate_kind = 'thread'
          AND created.application_event_version = 2 AND created.event_type = 'run.created'
          AND json_extract(created.payload_json, '$.id') = ${run.id}
          AND json_extract(created.payload_json, '$.providerThreadId') = ${providerThreadId}
          AND json_extract(created.payload_json, '$.status') = 'queued'
          AND json_type(created.payload_json, '$.startedAt') = 'null'
          AND cancelled.aggregate_kind = 'thread' AND cancelled.application_event_version = 2
          AND cancelled.event_type = 'run.updated'
          AND json_extract(cancelled.payload_json, '$.id') = ${run.id}
          AND json_extract(cancelled.payload_json, '$.providerThreadId') = ${providerThreadId}
          AND json_extract(cancelled.payload_json, '$.status') = 'cancelled'
          AND json_type(cancelled.payload_json, '$.startedAt') = 'null'
          AND cancelled.sequence > created.sequence
          AND NOT EXISTS (SELECT 1 FROM orchestration_events AS history
            WHERE history.stream_id = ${threadId} AND history.aggregate_kind = 'thread'
              AND history.application_event_version = 2 AND history.event_type IN ('run.created', 'run.updated')
              AND json_extract(history.payload_json, '$.id') = ${run.id}
              AND (json_extract(history.payload_json, '$.status') NOT IN ('queued', 'cancelled')
                OR json_type(history.payload_json, '$.startedAt') IS NOT 'null'))
        LIMIT 1
      `;
      if (cancellation.length === 0) return;
    }
  }
  const attemptRows = yield* sql<{
    readonly attempt_id: string;
    readonly thread_id: string;
    readonly run_id: string;
    readonly provider_thread_id: string | null;
    readonly status: string;
    readonly payload_json: string;
  }>`
    SELECT attempt_id, thread_id, run_id, provider_thread_id, status, payload_json FROM orchestration_v2_projection_run_attempts
    WHERE provider_thread_id = ${providerThreadId} OR run_id IN ${sql.in(runIds)}
    ORDER BY run_id, attempt_id
  `;
  const attempts: Array<OrchestrationV2RunAttemptJson> = [];
  for (const row of attemptRows) {
    const decoded = decodeAttempt(row.payload_json);
    if (Option.isNone(decoded)) return;
    const attempt = decoded.value;
    const run = runs.find((run) => run.id === attempt.runId);
    if (
      run === undefined ||
      row.thread_id !== threadId ||
      row.run_id !== run.id ||
      row.attempt_id !== attempt.id ||
      row.provider_thread_id !== providerThreadId ||
      attempt.providerThreadId !== providerThreadId ||
      attempt.providerInstanceId !== provider.providerInstanceId ||
      attempt.id !== run.activeAttemptId ||
      attempt.id !== derive.runAttempt({ runId: run.id, attemptOrdinal: 1 }) ||
      attempt.rootNodeId !== run.rootNodeId ||
      attempt.attemptOrdinal !== 1 ||
      attempt.reason !== "initial" ||
      attempt.providerTurnId !== null ||
      attempt.startedAt !== null ||
      attempt.status !== (run.status === "queued" ? "pending" : "cancelled") ||
      row.status !== attempt.status ||
      (attempt.status === "pending" ? attempt.completedAt !== null : attempt.completedAt === null)
    )
      return;
    attempts.push(attempt);
  }
  if (attempts.length !== runs.length) return;
  const nodes = yield* sql<{
    readonly node_id: string;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly status: string;
    readonly provider_thread_id: string | null;
    readonly payload_json: string;
  }>`
    SELECT node_id, thread_id, run_id, status, provider_thread_id, payload_json FROM orchestration_v2_projection_nodes
    WHERE provider_thread_id = ${providerThreadId} OR run_id IN ${sql.in(runIds)}
  `;
  if (nodes.length !== runs.length) return;
  for (const row of nodes) {
    const decoded = decodeNode(row.payload_json);
    if (Option.isNone(decoded)) return;
    const node = decoded.value;
    const run = runs.find((run) => run.id === node.runId);
    if (
      run === undefined ||
      row.thread_id !== threadId ||
      node.threadId !== threadId ||
      row.run_id !== run.id ||
      row.node_id !== node.id ||
      node.id !== run.rootNodeId ||
      node.rootNodeId !== node.id ||
      node.parentNodeId !== null ||
      node.kind !== "root_turn" ||
      node.providerThreadId !== providerThreadId ||
      row.provider_thread_id !== providerThreadId ||
      node.providerTurnId !== null ||
      node.nativeItemRef !== null ||
      node.startedAt !== null ||
      node.status !== (run.status === "queued" ? "pending" : "cancelled") ||
      row.status !== node.status ||
      (node.status === "pending" ? node.completedAt !== null : node.completedAt === null)
    )
      return;
  }
  const starts = yield* sql<{
    readonly effect_id: string;
    readonly attempt_count: number;
    readonly status: string;
  }>`
    SELECT effect.effect_id, effect.attempt_count, effect.status
    FROM orchestration_v2_effect_outbox AS effect
    LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = json_extract(effect.payload_json, '$.runId')
    WHERE effect.thread_id = ${threadId} AND effect.effect_type = 'provider-turn.start'
      AND (run.provider_thread_id = ${providerThreadId} OR run.run_id IS NULL)
    ORDER BY effect.effect_id
  `;
  if (starts.some((start) => start.attempt_count !== 0 || start.status !== "cancelled")) return;
  return {
    proof: {
      providerThreadId,
      providerInstanceId: provider.providerInstanceId,
      source: "cancelled_queued_runs",
      runIds: [runs[0]!.id, ...runIds.slice(1)],
      attemptIds: [attempts[0]!.id, ...attempts.slice(1).map((attempt) => attempt.id)],
      cancelledStartEffectIds: starts.map((start) => start.effect_id),
    } satisfies Proof,
    runs,
    attempts,
  };
});

// 调用方必须在同一事务内先取消 outbox，再追加事件并应用首次 tombstone。
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
      const proofs: Array<Proof> = [];
      const live =
        yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId} AND deleted_at IS NULL`;
      if (existing.length === 0 && live.length === 1) {
        const providers = yield* sql<{ readonly provider_thread_id: ProviderThreadId }>`
        SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
        WHERE thread_id = ${event.threadId} AND driver = 'pi' ORDER BY provider_thread_id
      `;
        for (const provider of providers) {
          if (
            record.sessions.some(
              (session) => session.providerThreadId === provider.provider_thread_id,
            )
          )
            continue;
          const source = yield* readSource(event.threadId, provider.provider_thread_id, "queued");
          if (source === undefined) continue;
          if (
            events.some(
              (candidate) =>
                candidate.type === "provider-thread.updated" &&
                candidate.payload.id === provider.provider_thread_id,
            )
          )
            continue;
          if (
            !source.runs
              .filter((run) => run.status === "queued")
              .every((run) =>
                events.some(
                  (candidate) =>
                    candidate.type === "run.updated" &&
                    candidate.threadId === event.threadId &&
                    candidate.payload.id === run.id &&
                    candidate.payload.status === "cancelled" &&
                    candidate.payload.startedAt === null,
                ),
              )
          )
            continue;
          if (
            !source.attempts
              .filter((attempt) => attempt.status === "pending")
              .every((attempt) =>
                events.some(
                  (candidate) =>
                    candidate.type === "run-attempt.updated" &&
                    candidate.threadId === event.threadId &&
                    candidate.payload.id === attempt.id &&
                    candidate.payload.status === "cancelled" &&
                    candidate.payload.startedAt === null,
                ),
              )
          )
            continue;
          if (
            !source.runs
              .filter((run) => run.status === "queued")
              .every((run) =>
                events.some(
                  (candidate) =>
                    candidate.type === "node.updated" &&
                    candidate.threadId === event.threadId &&
                    candidate.payload.id === run.rootNodeId &&
                    candidate.payload.status === "cancelled" &&
                    candidate.payload.startedAt === null,
                ),
              )
          )
            continue;
          proofs.push(source.proof);
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
    if (Option.isNone(decoded) || decoded.value.threadId !== row.thread_id) continue;
    for (const proof of decoded.value.noNativeSessionProofs ?? []) {
      const source = yield* readSource(row.thread_id, proof.providerThreadId, "cancelled");
      if (source === undefined) {
        // 已完成回收的证明不再依赖被删的来源行；任何重新出现的身份/工作仍构成矛盾。
        const remaining = yield* sql`
          SELECT 1 FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_native_session_bindings WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_thread_deletion_sessions WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id = ${proof.providerThreadId}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_runs
            WHERE provider_thread_id = ${proof.providerThreadId} OR run_id IN ${sql.in(proof.runIds)}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_run_attempts
            WHERE provider_thread_id = ${proof.providerThreadId} OR attempt_id IN ${sql.in(proof.attemptIds)}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_nodes
            WHERE provider_thread_id = ${proof.providerThreadId} OR run_id IN ${sql.in(proof.runIds)}
          UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_sessions
            WHERE thread_id = ${row.thread_id} AND provider_instance_id = ${proof.providerInstanceId}
          UNION ALL SELECT 1 FROM orchestration_v2_effect_outbox
            WHERE thread_id = ${row.thread_id} AND effect_type = 'provider-turn.start'
              AND json_extract(payload_json, '$.runId') IN ${sql.in(proof.runIds)}
              AND (attempt_count <> 0 OR status <> 'cancelled')
          LIMIT 1
        `;
        if (remaining.length === 0) continue;
      }
      if (
        source === undefined ||
        source.proof.providerInstanceId !== proof.providerInstanceId ||
        source.proof.runIds.length !== proof.runIds.length ||
        !source.proof.runIds.every((id) => proof.runIds.includes(id)) ||
        source.proof.attemptIds.length !== proof.attemptIds.length ||
        !source.proof.attemptIds.every((id) => proof.attemptIds.includes(id))
      ) {
        contradicted.add(row.thread_id);
      } else confirmed.add(proof.providerThreadId);
    }
  }
  return { confirmed, contradicted };
});
