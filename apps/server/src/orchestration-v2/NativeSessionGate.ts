import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class NativeSessionGateError extends Schema.TaggedError<NativeSessionGateError>()(
  "NativeSessionGateError",
  {
    threadId: ThreadId,
    providerThreadId: Schema.optional(ProviderThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Native session creation requires a persisted gate.";
  }
}

const isNativeSessionGateError = Schema.is(NativeSessionGateError);

function hasNativeSessionIdentity(provider: OrchestrationV2ProviderThread): boolean {
  return (
    provider.providerSessionId !== null ||
    provider.firstRunOrdinal !== null ||
    provider.lastRunOrdinal !== null ||
    provider.nativeThreadRef !== null ||
    provider.nativeConversationHeadRef !== null ||
    provider.nativeStorage?.type === "resolved" ||
    provider.forkedFrom !== null ||
    provider.status !== "not_loaded"
  );
}

export function foldNativeSessionOrigin(
  current: OrchestrationV2ProviderThread | undefined,
  next: OrchestrationV2ProviderThread,
  hasPersistedGate = false,
): OrchestrationV2ProviderThread {
  // Creation provenance is immutable; an existing legacy row cannot acquire it later.
  const { nativeBindingOrigin: _bindingOrigin, ...nextProvider } = next;
  const bindingOrigin =
    current === undefined ? next.nativeBindingOrigin : current.nativeBindingOrigin;
  const withBindingOrigin =
    bindingOrigin === undefined
      ? nextProvider
      : { ...nextProvider, nativeBindingOrigin: bindingOrigin };
  if (
    next.driver !== "pi" &&
    current?.driver !== "pi" &&
    next.nativeSessionOrigin === undefined &&
    current?.nativeSessionOrigin === undefined
  )
    return withBindingOrigin;
  const invalidated =
    hasPersistedGate ||
    hasNativeSessionIdentity(next) ||
    (current !== undefined && hasNativeSessionIdentity(current)) ||
    current?.nativeSessionOrigin?.state === "may_exist" ||
    next.nativeSessionOrigin?.state === "may_exist" ||
    (current !== undefined &&
      (current.driver !== next.driver ||
        current.providerInstanceId !== next.providerInstanceId ||
        current.appThreadId !== next.appThreadId ||
        current.ownerNodeId !== next.ownerNodeId));
  const origin = invalidated
    ? { version: 1 as const, state: "may_exist" as const }
    : current === undefined
      ? next.nativeSessionOrigin
      : current.nativeSessionOrigin;
  const { nativeSessionOrigin: _origin, ...provider } = withBindingOrigin;
  return origin === undefined ? provider : { ...provider, nativeSessionOrigin: origin };
}

export function nativeSessionGateTarget(
  event: OrchestrationV2DomainEvent,
):
  | { readonly providerThreadId: ProviderThreadId }
  | { readonly providerSessionId: ProviderSessionId }
  | undefined {
  switch (event.type) {
    case "run.created":
    case "run.updated":
      if (
        event.payload.providerThreadId != null &&
        (event.payload.startedAt !== null ||
          ["preparing", "starting", "running", "waiting"].includes(event.payload.status))
      )
        return { providerThreadId: event.payload.providerThreadId };
      break;
    case "run-attempt.created":
    case "run-attempt.updated":
      if (
        event.payload.startedAt !== null ||
        event.payload.status === "running" ||
        event.payload.providerTurnId !== null ||
        (event.payload.nativeThreadId?.trim() ?? "") !== ""
      )
        return { providerThreadId: event.payload.providerThreadId };
      break;
    case "provider-turn.updated":
      return { providerThreadId: event.payload.providerThreadId };
    case "provider-session.attached":
    case "provider-session.updated":
      return { providerSessionId: event.payload.id };
    case "provider-session.detached":
      return { providerSessionId: event.payload.providerSessionId };
    case "node.updated":
    case "turn-item.updated":
      if (
        event.payload.providerThreadId != null &&
        (event.payload.providerTurnId !== null ||
          event.payload.nativeItemRef?.nativeId != null ||
          (event.type === "node.updated" &&
            event.payload.kind === "root_turn" &&
            event.payload.startedAt !== null))
      )
        return { providerThreadId: event.payload.providerThreadId };
      break;
  }
}

// Per-event folds already run inside the projection operation's span.
export const hasPersistedNativeSessionGate = Effect.fnUntraced(function* (
  providerThreadId: ProviderThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly present: number }>`
    SELECT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_provider_threads p
      WHERE p.provider_thread_id = ${providerThreadId} AND (
        p.provider_session_id IS NOT NULL OR p.first_run_ordinal IS NOT NULL OR p.last_run_ordinal IS NOT NULL
        OR p.status <> 'not_loaded' OR json_extract(p.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
        OR json_extract(p.payload_json, '$.nativeConversationHeadRef.nativeId') IS NOT NULL
        OR json_extract(p.payload_json, '$.nativeStorage.type') = 'resolved'
        OR json_type(p.payload_json, '$.forkedFrom') = 'object')
      UNION ALL SELECT 1 FROM orchestration_v2_native_session_bindings WHERE provider_thread_id = ${providerThreadId}
      UNION ALL SELECT 1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id = ${providerThreadId}
      UNION ALL SELECT 1 FROM orchestration_v2_projection_runs
        WHERE provider_thread_id = ${providerThreadId} AND (status IN ('preparing', 'starting', 'running', 'waiting')
          OR json_extract(payload_json, '$.startedAt') IS NOT NULL)
      UNION ALL SELECT 1 FROM orchestration_v2_projection_run_attempts
        WHERE provider_thread_id = ${providerThreadId} AND (status = 'running' OR provider_turn_id IS NOT NULL
          OR json_extract(payload_json, '$.startedAt') IS NOT NULL
          OR COALESCE(trim(json_extract(payload_json, '$.nativeThreadId')), '') <> '')
      UNION ALL SELECT 1 FROM orchestration_v2_projection_nodes
        WHERE provider_thread_id = ${providerThreadId} AND (provider_turn_id IS NOT NULL
          OR json_extract(payload_json, '$.nativeItemRef.nativeId') IS NOT NULL
          OR (kind = 'root_turn' AND started_at IS NOT NULL))
      UNION ALL SELECT 1 FROM orchestration_v2_projection_turn_items
        WHERE provider_thread_id = ${providerThreadId} AND (provider_turn_id IS NOT NULL
          OR json_extract(payload_json, '$.nativeItemRef.nativeId') IS NOT NULL)
    ) AS present
  `;
  return rows[0]?.present === 1;
});

export const assertNativeSessionGate = Effect.fn("NativeSessionGate.assert")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId?: ProviderSessionId;
    readonly providerThreadId?: ProviderThreadId;
    readonly providerInstanceId?: ProviderInstanceId;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly provider_thread_id: string;
      readonly driver: string;
      readonly matches: number;
      readonly origin_allows: number;
    }>`
    SELECT p.provider_thread_id, p.driver, CASE WHEN p.thread_id = ${input.threadId}
      AND ${input.providerInstanceId === undefined ? sql`1 = 1` : sql`p.provider_instance_id = ${input.providerInstanceId}`}
      AND (${
        input.providerSessionId === undefined
          ? sql`1 = 1`
          : sql`p.provider_session_id = ${input.providerSessionId} OR (
        p.provider_session_id IS NULL AND json_type(p.payload_json, '$.nativeSessionOrigin') IS NULL AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_provider_session_bindings b
          JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id = b.provider_session_id
          WHERE b.thread_id = ${input.threadId} AND b.provider_session_id = ${input.providerSessionId}
            AND s.driver = p.driver AND s.provider_instance_id = p.provider_instance_id
        ) AND EXISTS (SELECT 1 FROM orchestration_v2_native_session_bindings n
          WHERE n.provider_thread_id = p.provider_thread_id AND n.thread_id = ${input.threadId}
            AND n.provider_instance_id = p.provider_instance_id AND n.driver = p.driver))`
      })
      THEN 1 ELSE 0 END AS matches,
      CASE WHEN json_type(p.payload_json, '$.nativeSessionOrigin') IS NULL
      OR (json_extract(p.payload_json, '$.nativeSessionOrigin.version') = 1
        AND json_extract(p.payload_json, '$.nativeSessionOrigin.state') = 'may_exist') THEN 1 ELSE 0 END AS origin_allows
    FROM orchestration_v2_projection_provider_threads p
    WHERE ${
      input.providerThreadId !== undefined
        ? sql`p.provider_thread_id = ${input.providerThreadId}`
        : sql`p.provider_thread_id = (SELECT active_provider_thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${input.threadId})`
    }
  `;
    if (rows.length === 0)
      return yield* new NativeSessionGateError({
        threadId: input.threadId,
        ...(input.providerThreadId === undefined
          ? {}
          : { providerThreadId: input.providerThreadId }),
      });
    for (const row of rows) {
      const providerThreadId = ProviderThreadId.make(row.provider_thread_id);
      if (
        row.driver !== "pi" ||
        row.matches !== 1 ||
        row.origin_allows !== 1 ||
        !(yield* hasPersistedNativeSessionGate(providerThreadId))
      )
        return yield* new NativeSessionGateError({ threadId: input.threadId, providerThreadId });
    }
  },
  (effect, input) =>
    Effect.mapError(effect, (cause) =>
      isNativeSessionGateError(cause)
        ? cause
        : new NativeSessionGateError({
            threadId: input.threadId,
            ...(input.providerThreadId === undefined
              ? {}
              : { providerThreadId: input.providerThreadId }),
            cause,
          }),
    ),
);
