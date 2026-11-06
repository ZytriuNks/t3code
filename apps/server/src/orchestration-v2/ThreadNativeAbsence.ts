import {
  type OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RunJson,
  type NodeId,
  type ProviderThreadId,
  ThreadDeletionRecord,
  type ThreadId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
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

const isUnstartedPlaceholder = (provider: OrchestrationV2ProviderThreadJson) =>
  provider.status === "not_loaded" &&
  provider.providerSessionId === null &&
  provider.nativeThreadRef === null &&
  provider.firstRunOrdinal === null &&
  provider.lastRunOrdinal === null &&
  provider.ownerNodeId === null &&
  provider.nativeConversationHeadRef === null &&
  provider.nativeStorage?.type === "unresolved" &&
  provider.forkedFrom === null &&
  provider.handoffIds.length === 0 &&
  (provider.pendingBackgroundTasks?.length ?? 0) === 0;

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
  if (!isUnstartedPlaceholder(provider)) return;
  const identities = yield* sql`
    SELECT 1 FROM orchestration_v2_native_session_bindings WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_thread_deletion_sessions WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id = ${providerThreadId}
    UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_sessions
      WHERE thread_id = ${threadId} AND provider_instance_id = ${provider.providerInstanceId}
  `;
  if (identities.length !== 0) return;
  const providerHistory = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_events
    WHERE stream_id = ${threadId} AND aggregate_kind = 'thread' AND application_event_version = 2
      AND event_type = 'provider-thread.updated' AND json_extract(payload_json, '$.id') = ${providerThreadId}
    ORDER BY sequence
  `;
  if (providerHistory.length === 0) return;
  for (const row of providerHistory) {
    const decoded = decodeProvider(row.payload_json);
    if (
      Option.isNone(decoded) ||
      !isUnstartedPlaceholder(decoded.value) ||
      decoded.value.appThreadId !== threadId ||
      decoded.value.driver !== provider.driver ||
      decoded.value.providerInstanceId !== provider.providerInstanceId
    )
      return;
  }
  const origins = yield* sql<{ readonly run_id: string }>`
    SELECT json_extract(payload_json, '$.id') AS run_id FROM orchestration_events
    WHERE stream_id = ${threadId} AND aggregate_kind = 'thread' AND application_event_version = 2
      AND event_type = 'run.created' AND json_extract(payload_json, '$.providerThreadId') = ${providerThreadId}
  `;
  const originIds = origins.map((row) => row.run_id);
  const runRows = yield* sql<{
    readonly run_id: string;
    readonly thread_id: string;
    readonly provider_thread_id: string | null;
    readonly status: string;
    readonly payload_json: string;
  }>`
    SELECT run_id, thread_id, provider_thread_id, status, payload_json FROM orchestration_v2_projection_runs
    WHERE provider_thread_id = ${providerThreadId} OR json_extract(payload_json, '$.providerThreadId') = ${providerThreadId}
      OR run_id IN ${sql.in(originIds)}
    ORDER BY ordinal, run_id
  `;
  const runs: Array<OrchestrationV2RunJson> = [];
  for (const row of runRows) {
    const decoded = decodeRun(row.payload_json);
    if (Option.isNone(decoded)) return;
    const run = decoded.value;
    const local = run.providerThreadId === providerThreadId;
    if (
      run.id !== row.run_id ||
      row.thread_id !== threadId ||
      run.threadId !== threadId ||
      row.provider_thread_id !== run.providerThreadId ||
      run.providerThreadId === null ||
      row.status !== run.status ||
      (local &&
        (!(
          run.status === "failed" ||
          run.status === "cancelled" ||
          (phase === "queued" && run.status === "queued")
        ) ||
          run.startedAt !== null ||
          run.providerInstanceId !== provider.providerInstanceId)) ||
      (local &&
        (run.rootNodeId !== derive.rootNode({ runId: run.id }) ||
          run.activeAttemptId !== derive.runAttempt({ runId: run.id, attemptOrdinal: 1 }))) ||
      (local && (run.status === "queued" ? run.completedAt !== null : run.completedAt === null))
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
  if (originIds.length !== runs.length || !runIds.every((id) => originIds.includes(id))) return;
  // run/attempt 历史不被普通压缩删除；统一证明 queued 起源和整个启动前轨迹，而不是用终态猜测。
  for (const run of runs) {
    const history = yield* sql<{
      readonly event_type: string;
      readonly payload_json: string;
      readonly command_id: string | null;
      readonly accepted: number;
    }>`
      SELECT event.event_type, event.payload_json, event.command_id,
        EXISTS (SELECT 1 FROM orchestration_command_receipts AS receipt
          WHERE receipt.command_id = event.command_id AND receipt.aggregate_kind = 'thread'
            AND receipt.status = 'accepted') AS accepted
      FROM orchestration_events AS event
      WHERE event.stream_id = ${threadId} AND event.aggregate_kind = 'thread'
        AND event.application_event_version = 2 AND event.event_type IN ('run.created', 'run.updated')
        AND json_extract(event.payload_json, '$.id') = ${run.id}
      ORDER BY event.sequence
    `;
    let terminal: string | undefined;
    let moved = false;
    for (const [index, event] of history.entries()) {
      const decoded = decodeRun(event.payload_json);
      if (Option.isNone(decoded)) return;
      const source = decoded.value;
      if (
        event.event_type !== (index === 0 ? "run.created" : "run.updated") ||
        (index === 0 && source.status !== "queued") ||
        source.threadId !== threadId ||
        source.providerThreadId === null ||
        (index === 0 && source.providerThreadId !== providerThreadId)
      )
        return;
      if (source.providerThreadId !== providerThreadId) {
        if (terminal !== undefined) return;
        moved = true;
        continue;
      }
      if (
        moved ||
        source.providerInstanceId !== provider.providerInstanceId ||
        source.rootNodeId !== derive.rootNode({ runId: run.id }) ||
        source.activeAttemptId !== derive.runAttempt({ runId: run.id, attemptOrdinal: 1 }) ||
        source.startedAt !== null ||
        !["queued", "cancelled", "failed"].includes(source.status) ||
        (terminal !== undefined && source.status !== terminal) ||
        (source.status === "queued" ? source.completedAt !== null : source.completedAt === null) ||
        (source.status === "cancelled" && event.accepted !== 1) ||
        (source.status === "failed" && event.command_id !== null)
      )
        return;
      if (source.status !== "queued") terminal = source.status;
    }
    const latest = decodeRun(history.at(-1)?.payload_json);
    if (
      Option.isNone(latest) ||
      latest.value.status !== run.status ||
      latest.value.providerThreadId !== run.providerThreadId ||
      latest.value.providerInstanceId !== run.providerInstanceId ||
      !Equal.equals(latest.value.startedAt, run.startedAt)
    )
      return;
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
    WHERE provider_thread_id = ${providerThreadId}
      OR attempt_id IN ${sql.in(runIds.map((runId) => derive.runAttempt({ runId, attemptOrdinal: 1 })))}
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
      row.provider_thread_id !== attempt.providerThreadId ||
      attempt.providerThreadId === null ||
      (attempt.providerThreadId === providerThreadId) !==
        (run.providerThreadId === providerThreadId) ||
      (run.providerThreadId === providerThreadId &&
        attempt.providerInstanceId !== provider.providerInstanceId) ||
      (run.providerThreadId === providerThreadId && attempt.id !== run.activeAttemptId) ||
      attempt.id !== derive.runAttempt({ runId: run.id, attemptOrdinal: 1 }) ||
      attempt.rootNodeId !== derive.rootNode({ runId: run.id }) ||
      attempt.attemptOrdinal !== 1 ||
      attempt.reason !== "initial" ||
      (run.providerThreadId === providerThreadId &&
        (attempt.providerTurnId !== null ||
          attempt.startedAt !== null ||
          attempt.status !== (run.status === "queued" ? "pending" : run.status))) ||
      row.status !== attempt.status ||
      (run.providerThreadId === providerThreadId &&
        (attempt.status === "pending"
          ? attempt.completedAt !== null
          : attempt.completedAt === null))
    )
      return;
    attempts.push(attempt);
    const history = yield* sql<{ readonly event_type: string; readonly payload_json: string }>`
      SELECT event_type, payload_json FROM orchestration_events
      WHERE stream_id = ${threadId} AND aggregate_kind = 'thread' AND application_event_version = 2
        AND event_type IN ('run-attempt.created', 'run-attempt.updated')
        AND json_extract(payload_json, '$.id') = ${attempt.id}
      ORDER BY sequence
    `;
    let moved = false;
    for (const [index, event] of history.entries()) {
      const decoded = decodeAttempt(event.payload_json);
      if (Option.isNone(decoded)) return;
      const source = decoded.value;
      if (
        event.event_type !== (index === 0 ? "run-attempt.created" : "run-attempt.updated") ||
        (index === 0 && source.status !== "pending") ||
        source.runId !== run.id ||
        source.rootNodeId !== attempt.rootNodeId ||
        source.reason !== "initial" ||
        source.attemptOrdinal !== 1 ||
        (index === 0 && source.providerThreadId !== providerThreadId)
      )
        return;
      if (source.providerThreadId !== providerThreadId) {
        moved = true;
        continue;
      }
      if (
        moved ||
        source.providerInstanceId !== provider.providerInstanceId ||
        source.startedAt !== null ||
        source.providerTurnId !== null ||
        !["pending", "cancelled", "failed"].includes(source.status)
      )
        return;
    }
    const latest = decodeAttempt(history.at(-1)?.payload_json);
    if (
      Option.isNone(latest) ||
      latest.value.status !== attempt.status ||
      latest.value.providerThreadId !== attempt.providerThreadId ||
      latest.value.providerInstanceId !== attempt.providerInstanceId ||
      !Equal.equals(latest.value.startedAt, attempt.startedAt)
    )
      return;
  }
  if (attempts.length !== runs.length) return;
  const rootNodeIds = runIds.map((runId) => derive.rootNode({ runId }));
  const nodes = yield* sql<{
    readonly node_id: NodeId;
    readonly thread_id: string;
    readonly run_id: string | null;
    readonly status: string;
    readonly provider_thread_id: string | null;
    readonly payload_json: string;
  }>`
    SELECT node_id, thread_id, run_id, status, provider_thread_id, payload_json FROM orchestration_v2_projection_nodes
    WHERE provider_thread_id = ${providerThreadId}
      OR json_extract(payload_json, '$.providerThreadId') = ${providerThreadId}
      OR node_id IN ${sql.in(rootNodeIds)}
  `;
  if (nodes.filter((row) => rootNodeIds.includes(row.node_id)).length !== runs.length) return;
  for (const row of nodes) {
    const decoded = decodeNode(row.payload_json);
    if (Option.isNone(decoded)) return;
    const node = decoded.value;
    if (!rootNodeIds.includes(row.node_id)) {
      if (
        row.node_id !== node.id ||
        row.thread_id !== node.threadId ||
        row.run_id !== node.runId ||
        row.status !== node.status ||
        row.provider_thread_id !== node.providerThreadId ||
        node.providerThreadId !== providerThreadId ||
        node.threadId === threadId ||
        node.runId === null ||
        node.kind !== "subagent" ||
        node.countsForRun ||
        node.parentNodeId !== node.rootNodeId ||
        node.providerTurnId !== null ||
        node.nativeItemRef !== null ||
        node.runtimeRequestId !== null ||
        node.checkpointScopeId !== null
      )
        return;
      // app-owned follow-up 的 startedAt 是父级跟踪时间；真实执行仍由子 run/root 证明。
      // 首次发证早于同批删除事件落库；回收器另行核对父子均属于同一删除闭包。
      const references = yield* sql`
        SELECT 1 FROM orchestration_v2_projection_subagents AS task
        JOIN orchestration_v2_projection_threads AS child ON child.thread_id = ${threadId}
        JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = task.thread_id
        JOIN orchestration_v2_projection_runs AS owner ON owner.run_id = task.run_id AND owner.thread_id = parent.thread_id
        JOIN orchestration_v2_projection_nodes AS owner_root
          ON owner_root.node_id = ${node.rootNodeId} AND owner_root.thread_id = parent.thread_id
          AND owner_root.run_id = owner.run_id AND owner_root.root_node_id = owner_root.node_id
          AND owner_root.parent_node_id IS NULL AND owner_root.kind = 'root_turn'
        JOIN orchestration_v2_projection_runs AS child_run ON child_run.thread_id = child.thread_id
          AND child_run.run_id IN ${sql.in(runIds)}
          AND json_extract(child_run.payload_json, '$.delegatedTaskId') = task.subagent_id
        JOIN orchestration_v2_projection_subagents AS original
          ON original.subagent_id = json_extract(child.payload_json, '$.forkedFrom.nodeId')
          AND original.thread_id = parent.thread_id AND original.child_thread_id = child.thread_id
        WHERE task.subagent_id = ${node.id} AND task.thread_id = ${node.threadId}
          AND task.run_id = ${node.runId} AND task.parent_node_id = ${node.rootNodeId}
          AND task.child_thread_id = child.thread_id AND task.origin = 'app_owned'
          AND task.driver = 'pi' AND task.provider_instance_id = ${provider.providerInstanceId}
          AND task.provider_thread_id = ${providerThreadId} AND task.status = ${node.status}
          AND json_extract(task.payload_json, '$.id') = task.subagent_id
          AND json_extract(task.payload_json, '$.threadId') = task.thread_id
          AND json_extract(task.payload_json, '$.runId') = task.run_id
          AND json_extract(task.payload_json, '$.parentNodeId') = task.parent_node_id
          AND json_extract(task.payload_json, '$.childThreadId') = task.child_thread_id
          AND json_extract(task.payload_json, '$.origin') = task.origin
          AND json_extract(task.payload_json, '$.driver') = task.driver
          AND json_extract(task.payload_json, '$.providerInstanceId') = task.provider_instance_id
          AND json_extract(task.payload_json, '$.providerThreadId') = task.provider_thread_id
          AND json_extract(task.payload_json, '$.status') = task.status
          AND json_type(task.payload_json, '$.nativeTaskRef') = 'null'
          AND json_extract(task.payload_json, '$.startedAt') IS json_extract(${row.payload_json}, '$.startedAt')
          AND json_extract(task.payload_json, '$.completedAt') IS json_extract(${row.payload_json}, '$.completedAt')
          AND json_extract(owner.payload_json, '$.id') = owner.run_id
          AND json_extract(owner.payload_json, '$.threadId') = owner.thread_id
          AND json_extract(owner_root.payload_json, '$.id') = owner_root.node_id
          AND json_extract(owner_root.payload_json, '$.threadId') = owner_root.thread_id
          AND json_extract(owner_root.payload_json, '$.runId') = owner_root.run_id
          AND json_extract(owner_root.payload_json, '$.rootNodeId') = owner_root.node_id
          AND json_type(owner_root.payload_json, '$.parentNodeId') = 'null'
          AND json_extract(owner_root.payload_json, '$.kind') = owner_root.kind
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_run_attempts AS owner_attempt
            JOIN orchestration_events AS created
              ON created.stream_id = parent.thread_id AND created.aggregate_kind = 'thread'
              AND created.application_event_version = 2 AND created.event_type = 'run-attempt.created'
              AND json_extract(created.payload_json, '$.id') = owner_attempt.attempt_id
              AND json_extract(created.payload_json, '$.runId') = owner.run_id
              AND json_extract(created.payload_json, '$.rootNodeId') = owner_root.node_id
            WHERE owner_attempt.thread_id = parent.thread_id AND owner_attempt.run_id = owner.run_id
              AND owner_attempt.root_node_id = owner_root.node_id
              AND json_extract(owner_attempt.payload_json, '$.id') = owner_attempt.attempt_id
              AND json_extract(owner_attempt.payload_json, '$.runId') = owner.run_id
              AND json_extract(owner_attempt.payload_json, '$.rootNodeId') = owner_root.node_id
          )
          AND EXISTS (
            SELECT 1 FROM orchestration_events AS root_history
            WHERE root_history.stream_id = parent.thread_id AND root_history.aggregate_kind = 'thread'
              AND root_history.application_event_version = 2 AND root_history.event_type = 'node.updated'
              AND json_extract(root_history.payload_json, '$.id') = owner_root.node_id
              AND json_extract(root_history.payload_json, '$.runId') = owner.run_id
              AND json_extract(root_history.payload_json, '$.rootNodeId') = owner_root.node_id
              AND json_extract(root_history.payload_json, '$.kind') = 'root_turn'
              AND json_type(root_history.payload_json, '$.parentNodeId') = 'null'
          )
          AND json_extract(child.payload_json, '$.id') = child.thread_id
          AND json_extract(parent.payload_json, '$.id') = parent.thread_id
          AND child.project_id = parent.project_id
          AND json_extract(child.payload_json, '$.projectId') = child.project_id
          AND json_extract(parent.payload_json, '$.projectId') = parent.project_id
          AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND json_extract(child.payload_json, '$.lineage.parentThreadId') = parent.thread_id
          AND json_extract(child.payload_json, '$.lineage.rootThreadId') = json_extract(parent.payload_json, '$.lineage.rootThreadId')
          AND json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
          AND original.origin = 'app_owned'
          AND json_extract(original.payload_json, '$.id') = original.subagent_id
          AND json_extract(original.payload_json, '$.threadId') = original.thread_id
          AND json_extract(original.payload_json, '$.childThreadId') = original.child_thread_id
          AND json_extract(original.payload_json, '$.origin') = original.origin
          AND json_type(original.payload_json, '$.result') = 'text'
      `;
      if (references.length !== 1) return;
      continue;
    }
    const run = runs.find((run) => run.id === node.runId);
    if (
      run === undefined ||
      row.thread_id !== threadId ||
      node.threadId !== threadId ||
      row.run_id !== run.id ||
      row.node_id !== node.id ||
      node.id !== derive.rootNode({ runId: run.id }) ||
      node.rootNodeId !== node.id ||
      node.parentNodeId !== null ||
      node.kind !== "root_turn" ||
      row.provider_thread_id !== node.providerThreadId ||
      node.providerThreadId === null ||
      (node.providerThreadId === providerThreadId) !==
        (run.providerThreadId === providerThreadId) ||
      (run.providerThreadId === providerThreadId &&
        (node.providerTurnId !== null ||
          node.nativeItemRef !== null ||
          node.startedAt !== null ||
          node.status !== (run.status === "queued" ? "pending" : run.status))) ||
      row.status !== node.status ||
      (run.providerThreadId === providerThreadId &&
        (node.status === "pending" ? node.completedAt !== null : node.completedAt === null))
    )
      return;
    const history = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_events
      WHERE stream_id = ${threadId} AND aggregate_kind = 'thread' AND application_event_version = 2
        AND event_type = 'node.updated' AND json_extract(payload_json, '$.id') = ${node.id}
      ORDER BY sequence
    `;
    let moved = false;
    for (const [index, event] of history.entries()) {
      const decoded = decodeNode(event.payload_json);
      if (Option.isNone(decoded)) return;
      const source = decoded.value;
      if (
        source.threadId !== threadId ||
        source.runId !== run.id ||
        source.rootNodeId !== node.id ||
        source.parentNodeId !== null ||
        source.kind !== "root_turn" ||
        (index === 0 &&
          (source.providerThreadId !== providerThreadId || source.status !== "pending"))
      )
        return;
      if (source.providerThreadId !== providerThreadId) {
        moved = true;
        continue;
      }
      if (
        moved ||
        source.startedAt !== null ||
        source.providerTurnId !== null ||
        source.nativeItemRef !== null ||
        !["pending", "cancelled", "failed"].includes(source.status)
      )
        return;
    }
    const latest = decodeNode(history.at(-1)?.payload_json);
    if (
      Option.isNone(latest) ||
      latest.value.status !== node.status ||
      latest.value.providerThreadId !== node.providerThreadId ||
      !Equal.equals(latest.value.startedAt, node.startedAt)
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
              .filter(
                (run) =>
                  run.providerThreadId === provider.provider_thread_id && run.status === "queued",
              )
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
              .filter(
                (attempt) =>
                  attempt.providerThreadId === provider.provider_thread_id &&
                  attempt.status === "pending",
              )
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
              .filter(
                (run) =>
                  run.providerThreadId === provider.provider_thread_id && run.status === "queued",
              )
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
