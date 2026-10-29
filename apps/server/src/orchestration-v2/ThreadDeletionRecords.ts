import { NativeSessionBinding, ThreadDeletionRecord, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ThreadDeletionRecordError extends Schema.TaggedError<ThreadDeletionRecordError>()(
  "ThreadDeletionRecordError",
  {
    operation: Schema.Literals(["get", "apply"]),
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encode = Schema.encodeEffect(Schema.fromJsonString(ThreadDeletionRecord));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadDeletionRecord));
  const encodeSession = Schema.encodeEffect(Schema.fromJsonString(NativeSessionBinding));

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
      for (const [index, session] of first.sessions.entries()) {
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
    },
    sql.withTransaction,
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
