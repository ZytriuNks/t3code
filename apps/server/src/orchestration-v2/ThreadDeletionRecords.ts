import {
  NativeSessionBinding,
  OrchestrationV2ProviderThreadJson,
  ThreadDeletionRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ThreadDeletionRecordError extends Schema.TaggedError<ThreadDeletionRecordError>()(
  "ThreadDeletionRecordError",
  {
    operation: Schema.Literals(["get", "apply", "backfill"]),
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to access thread deletion records.";
  }
}

export class ThreadDeletionRecords extends Context.Service<
  ThreadDeletionRecords,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ThreadDeletionRecord>, ThreadDeletionRecordError>;
    readonly apply: (
      record: ThreadDeletionRecord,
    ) => Effect.Effect<void, ThreadDeletionRecordError>;
  }
>()("t3/orchestration-v2/ThreadDeletionRecords") {}

const isThreadDeletionRecordError = Schema.is(ThreadDeletionRecordError);
const isNativeSessionBinding = Schema.is(NativeSessionBinding);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(ThreadDeletionRecord));
const decodeRecordOption = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadDeletionRecord));
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(NativeSessionBinding));
const decodeSessionOption = Schema.decodeUnknownOption(Schema.fromJsonString(NativeSessionBinding));
const decodeProviderOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);

const sameIdentity = (left: NativeSessionBinding, right: NativeSessionBinding) =>
  left.threadId === right.threadId &&
  left.providerThreadId === right.providerThreadId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.driver === right.driver &&
  left.nativeId === right.nativeId &&
  (left.storage.type === "resolved" && right.storage.type === "resolved"
    ? left.storage.canonicalRoot === right.storage.canonicalRoot &&
      left.storage.canonicalFile === right.storage.canonicalFile
    : left.storage.type === "unresolved" &&
      right.storage.type === "unresolved" &&
      left.storage.reason === right.storage.reason);

const writeSessions = Effect.fn("ThreadDeletionRecords.writeSessions")(function* (
  record: ThreadDeletionRecord,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const [index, session] of record.sessions.entries()) {
    const sessionJson = yield* encodeSession(session);
    const storage = session.storage;
    yield* sql`
      INSERT INTO orchestration_v2_thread_deletion_sessions (
        thread_id, session_index, provider_thread_id, provider_instance_id, driver, native_id,
        storage_type, canonical_root, canonical_file, payload_json
      ) VALUES (
        ${record.threadId}, ${index}, ${session.providerThreadId}, ${session.providerInstanceId}, ${session.driver}, ${session.nativeId},
        ${storage.type}, ${storage.type === "resolved" ? storage.canonicalRoot : ""},
        ${storage.type === "resolved" && session.driver === "pi" ? (storage.canonicalFile ?? "") : ""}, ${sessionJson}
      ) ON CONFLICT(thread_id, session_index) DO NOTHING
    `;
  }
});

export const backfillRetainedSessions = Effect.fn("ThreadDeletionRecords.backfillRetainedSessions")(
  function* (threadIds: ReadonlyArray<ThreadId>) {
    if (threadIds.length === 0) return;
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.gen(function* () {
      for (const threadId of new Set(threadIds)) {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_thread_deletions
          WHERE thread_id = ${threadId} AND scope = 't3_only'
            AND json_extract(payload_json, '$.threadId') = thread_id
            AND json_extract(payload_json, '$.commandId') = command_id
            AND json_extract(payload_json, '$.deletedAt') = deleted_at
            AND json_extract(payload_json, '$.operationRootThreadId') = operation_root_thread_id
            AND json_extract(payload_json, '$.projectId') = project_id
            AND json_extract(payload_json, '$.parentThreadId') IS parent_thread_id
        `;
        const decoded = decodeRecordOption(rows[0]?.payload_json);
        if (Option.isNone(decoded)) continue;
        const first = decoded.value;
        if (first.sessions.some((session) => session.threadId !== threadId)) continue;
        const candidates: Array<NativeSessionBinding> = [];
        const bindings = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_native_session_bindings
          WHERE thread_id = ${threadId} AND driver = 'pi'
            AND json_extract(payload_json, '$.threadId') = thread_id
            AND json_extract(payload_json, '$.providerThreadId') = provider_thread_id
            AND json_extract(payload_json, '$.providerInstanceId') = provider_instance_id
            AND json_extract(payload_json, '$.driver') = driver
            AND json_extract(payload_json, '$.nativeId') IS native_id
            AND json_extract(payload_json, '$.storage.type') = storage_type
            AND COALESCE(json_extract(payload_json, '$.storage.canonicalRoot'), '') = canonical_root
            AND COALESCE(json_extract(payload_json, '$.storage.canonicalFile'), '') = canonical_file
            AND json_extract(payload_json, '$.boundAt') = bound_at
          ORDER BY bound_at, binding_key
        `;
        for (const row of bindings) {
          const binding = decodeSessionOption(row.payload_json);
          if (Option.isSome(binding)) candidates.push(binding.value);
        }
        const projections = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${threadId} AND driver = 'pi' AND status = 'closed'
            AND json_extract(payload_json, '$.appThreadId') = thread_id
            AND json_extract(payload_json, '$.id') = provider_thread_id
            AND json_extract(payload_json, '$.driver') = driver
            AND json_extract(payload_json, '$.providerInstanceId') = provider_instance_id
            AND json_extract(payload_json, '$.status') = status
            AND json_extract(payload_json, '$.updatedAt') = updated_at
          ORDER BY provider_thread_id
        `;
        for (const row of projections) {
          const decodedProvider = decodeProviderOption(row.payload_json);
          if (Option.isNone(decodedProvider)) continue;
          const provider = decodedProvider.value;
          if (
            provider.nativeThreadRef !== null &&
            provider.nativeThreadRef.driver !== provider.driver
          )
            continue;
          const binding = {
            threadId,
            providerThreadId: provider.id,
            providerInstanceId: provider.providerInstanceId,
            driver: provider.driver,
            nativeId: provider.nativeThreadRef?.nativeId ?? null,
            storage: provider.nativeStorage ?? {
              type: "unresolved" as const,
              reason: "legacy_missing_locator" as const,
            },
            boundAt: DateTime.formatIso(provider.createdAt),
          };
          if (isNativeSessionBinding(binding)) candidates.push(binding);
        }
        const sessions = [...first.sessions];
        for (const candidate of candidates) {
          // A retained source may fill a missing snapshot, never rewrite an established identity.
          if (sessions.some((session) => sameIdentity(session, candidate))) continue;
          if (
            first.sessions.some(
              (session) =>
                session.providerThreadId === candidate.providerThreadId &&
                !sameIdentity(session, candidate),
            )
          )
            continue;
          if (candidate.nativeId === null && candidate.storage.type !== "resolved") continue;
          sessions.push(candidate);
        }
        const completed = { ...first, sessions };
        yield* writeSessions(completed);
        if (sessions.length !== first.sessions.length) {
          const payloadJson = yield* encodeRecord(completed);
          yield* sql`UPDATE orchestration_v2_thread_deletions SET payload_json = ${payloadJson}
            WHERE thread_id = ${threadId}`;
        }
      }
    }).pipe(sql.withTransaction);
  },
  (effect, threadIds) =>
    Effect.mapError(
      effect,
      (cause) =>
        new ThreadDeletionRecordError({ operation: "backfill", threadId: threadIds[0]!, cause }),
    ),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encode = Schema.encodeEffect(Schema.fromJsonString(ThreadDeletionRecord));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadDeletionRecord));

  const get = Effect.fn("ThreadDeletionRecords.get")(
    function* (threadId: ThreadId) {
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_thread_deletions WHERE thread_id = ${threadId}
      `;
      return rows[0] === undefined
        ? Option.none()
        : Option.some(yield* decode(rows[0].payload_json));
    },
    (effect, threadId) =>
      Effect.mapError(
        effect,
        (cause) => new ThreadDeletionRecordError({ operation: "get", threadId, cause }),
      ),
  );
  const apply = Effect.fn("ThreadDeletionRecords.apply")(
    function* (record: ThreadDeletionRecord) {
      if (record.sessions.some((session) => session.threadId !== record.threadId))
        return yield* new ThreadDeletionRecordError({
          operation: "apply",
          threadId: record.threadId,
          cause: "Deletion sessions must belong to the deleted thread.",
        });
      const payloadJson = yield* encode(record);
      yield* sql`
        INSERT INTO orchestration_v2_thread_deletions (
          thread_id, project_id, parent_thread_id, operation_root_thread_id, deleted_at, command_id, scope, payload_json
        ) VALUES (
          ${record.threadId}, ${record.projectId}, ${record.parentThreadId}, ${record.operationRootThreadId},
          ${record.deletedAt}, ${record.commandId}, ${record.scope}, ${payloadJson}
        ) ON CONFLICT(thread_id) DO NOTHING
      `;
      // Derive rows from the first record, even when a later deletion is replayed.
      const first = Option.getOrThrow(yield* get(record.threadId));
      yield* writeSessions(first);
      yield* backfillRetainedSessions([record.threadId]);
    },
    sql.withTransaction,
    (effect) => Effect.provideService(effect, SqlClient.SqlClient, sql),
    (effect, record) =>
      Effect.mapError(effect, (cause) =>
        isThreadDeletionRecordError(cause)
          ? cause
          : new ThreadDeletionRecordError({ operation: "apply", threadId: record.threadId, cause }),
      ),
  );
  return ThreadDeletionRecords.of({ get, apply });
});

export const layer = Layer.effect(ThreadDeletionRecords, make);
