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

export class NativeSessionBindingError extends Schema.TaggedError<NativeSessionBindingError>()(
  "NativeSessionBindingError",
  {
    operation: Schema.Literals(["listForThreads", "applyProviderThread"]),
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
    readonly listForThreads: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<NativeSessionBinding>, NativeSessionBindingError>;
    readonly applyProviderThread: (
      event: Extract<OrchestrationV2DomainEvent, { type: "provider-thread.updated" }>,
    ) => Effect.Effect<void, NativeSessionBindingError>;
  }
>()("t3/orchestration-v2/NativeSessionBindings") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const encode = Schema.encodeEffect(Schema.fromJsonString(NativeSessionBinding));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(NativeSessionBinding));
  const encodeKey = Schema.encodeEffect(
    Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
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
  return NativeSessionBindings.of({ listForThreads, applyProviderThread });
});

export const layer = Layer.effect(NativeSessionBindings, make);
