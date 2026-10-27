import {
  NativeSessionBinding,
  type OrchestrationV2DomainEvent,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { ThreadDeletionRecordError } from "./ThreadDeletionRecords.ts";

export class NativeSessionBindingError extends Schema.TaggedError<NativeSessionBindingError>()(
  "NativeSessionBindingError",
  {
    operation: Schema.Literals(["listForThreads", "applyProviderThread", "checkImport"]),
    providerThreadId: Schema.optional(ProviderThreadId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to access native session bindings.";
  }
}

export class NativeSessionBindings extends Context.Service<
  NativeSessionBindings,
  {
    readonly checkImport: (
      input: Pick<NativeSessionBinding, "driver" | "nativeId" | "storage" | "providerInstanceId">,
    ) => Effect.Effect<
      "unowned" | "owned" | "deleted" | "unresolved_conflict",
      NativeSessionBindingError | ThreadDeletionRecordError
    >;
    readonly listForThreads: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<NativeSessionBinding>, NativeSessionBindingError>;
    readonly applyProviderThread: (
      event: Extract<OrchestrationV2DomainEvent, { type: "provider-thread.updated" }>,
    ) => Effect.Effect<void, NativeSessionBindingError>;
  }
>()("t3/orchestration-v2/NativeSessionBindings") {}

const isNativeSessionBindingError = Schema.is(NativeSessionBindingError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encode = Schema.encodeEffect(Schema.fromJsonString(NativeSessionBinding));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeSessionBinding));
  const encodeKey = Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
  );

  const checkImport = Effect.fn("NativeSessionBindings.checkImport")(
    function* (input: Parameters<NativeSessionBindings["Service"]["checkImport"]>[0]) {
      if (input.nativeId === null || input.nativeId.trim() === "") {
        return yield* new NativeSessionBindingError({
          operation: "checkImport",
          cause: "A candidate requires a nonempty native id.",
        });
      }
      const file = input.storage.type === "resolved" ? (input.storage.canonicalFile ?? "") : "";
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly storage_type: string;
        readonly canonical_root: string;
        readonly canonical_file: string;
        readonly deleted: number;
      }>`
        SELECT b.thread_id, b.storage_type, b.canonical_root, b.canonical_file,
          CASE WHEN d.thread_id IS NOT NULL OR json_extract(t.payload_json, '$.deletedAt') IS NOT NULL THEN 1 ELSE 0 END AS deleted
        FROM orchestration_v2_native_session_bindings b
        LEFT JOIN orchestration_v2_thread_deletions d ON d.thread_id = b.thread_id
        LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = b.thread_id
        WHERE b.driver = ${input.driver} AND (b.native_id = ${input.nativeId}
          OR (${input.driver === "pi" && file !== "" ? 1 : 0} AND b.canonical_file = ${file}))
        UNION ALL
        SELECT s.thread_id, s.storage_type, s.canonical_root, s.canonical_file, 1 AS deleted
        FROM orchestration_v2_thread_deletion_sessions s
        WHERE s.driver = ${input.driver} AND (s.native_id = ${input.nativeId}
          OR (${input.driver === "pi" && file !== "" ? 1 : 0} AND s.canonical_file = ${file}))
        UNION ALL
        SELECT p.thread_id,
          COALESCE(json_extract(p.payload_json, '$.nativeStorage.type'), 'unresolved'),
          COALESCE(json_extract(p.payload_json, '$.nativeStorage.canonicalRoot'), ''),
          COALESCE(json_extract(p.payload_json, '$.nativeStorage.canonicalFile'), ''),
          CASE WHEN d.thread_id IS NOT NULL OR json_extract(t.payload_json, '$.deletedAt') IS NOT NULL THEN 1 ELSE 0 END
        FROM orchestration_v2_projection_provider_threads p
        LEFT JOIN orchestration_v2_thread_deletions d ON d.thread_id = p.thread_id
        LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
        WHERE p.thread_id IS NOT NULL AND p.driver = ${input.driver}
          AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') = ${input.nativeId}
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_native_session_bindings b WHERE b.provider_thread_id = p.provider_thread_id)
      `;
      let owned = false;
      let unresolved = false;
      for (const row of rows) {
        if (row.storage_type !== "resolved" || input.storage.type !== "resolved") {
          unresolved = true;
          continue;
        }
        if (
          row.canonical_root !== input.storage.canonicalRoot ||
          (input.driver === "pi" && row.canonical_file !== file)
        )
          continue;
        if (row.deleted === 1) return "deleted" as const;
        owned = true;
      }
      return unresolved
        ? ("unresolved_conflict" as const)
        : owned
          ? ("owned" as const)
          : ("unowned" as const);
    },
    Effect.mapError((cause) =>
      isNativeSessionBindingError(cause)
        ? cause
        : new NativeSessionBindingError({ operation: "checkImport", cause }),
    ),
  );

  const listForThreads = Effect.fn("NativeSessionBindings.listForThreads")(
    function* (threadIds: ReadonlyArray<ThreadId>) {
      if (threadIds.length === 0) return [];
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_native_session_bindings
        WHERE thread_id IN ${sql.in([...new Set(threadIds)])}
        ORDER BY thread_id, bound_at, binding_key
      `;
      return yield* Effect.forEach(rows, (row) => decode(row.payload_json));
    },
    Effect.mapError(
      (cause) => new NativeSessionBindingError({ operation: "listForThreads", cause }),
    ),
  );

  const applyProviderThread = Effect.fn("NativeSessionBindings.applyProviderThread")(
    function* (event: Extract<OrchestrationV2DomainEvent, { type: "provider-thread.updated" }>) {
      const thread = event.payload;
      if (thread.appThreadId === null) return;
      if (
        thread.status === "not_loaded" &&
        thread.firstRunOrdinal === null &&
        thread.nativeThreadRef === null &&
        thread.providerSessionId === null
      )
        return;
      const storage = thread.nativeStorage ?? {
        type: "unresolved" as const,
        reason: "legacy_missing_locator" as const,
      };
      const binding: NativeSessionBinding = {
        threadId: thread.appThreadId,
        providerThreadId: thread.id,
        providerInstanceId: thread.providerInstanceId,
        driver: thread.driver,
        nativeId: thread.nativeThreadRef?.nativeId ?? null,
        storage,
        boundAt: DateTime.formatIso(event.occurredAt),
      };
      const payloadJson = yield* encode(binding);
      const canonicalRoot = storage.type === "resolved" ? storage.canonicalRoot : "";
      const canonicalFile =
        storage.type === "resolved" && thread.driver === "pi" ? (storage.canonicalFile ?? "") : "";
      // Database scope is implicit; a later instance or event must not replace
      // an earlier confirmed storage/native identity for this binding.
      const key = yield* encodeKey([
        binding.threadId,
        thread.id,
        thread.driver,
        storage.type,
        canonicalRoot,
        canonicalFile,
        binding.nativeId,
      ]);
      yield* sql`
        INSERT INTO orchestration_v2_native_session_bindings (
          binding_key, thread_id, provider_thread_id, provider_instance_id, driver, native_id,
          storage_type, canonical_root, canonical_file, bound_at, payload_json
        ) VALUES (
          ${key}, ${binding.threadId}, ${thread.id}, ${thread.providerInstanceId}, ${thread.driver}, ${binding.nativeId},
          ${storage.type}, ${canonicalRoot}, ${canonicalFile}, ${binding.boundAt}, ${payloadJson}
        ) ON CONFLICT(binding_key) DO NOTHING
      `;
    },
    (effect, event) =>
      Effect.mapError(
        effect,
        (cause) =>
          new NativeSessionBindingError({
            operation: "applyProviderThread",
            providerThreadId: event.payload.id,
            cause,
          }),
      ),
  );
  return NativeSessionBindings.of({ checkImport, listForThreads, applyProviderThread });
});

export const layer = Layer.effect(NativeSessionBindings, make);
