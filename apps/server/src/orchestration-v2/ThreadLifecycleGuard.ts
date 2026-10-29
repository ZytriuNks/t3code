import {
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure synchronous hashing keeps persisted source identity independent of runtime services.
import * as NodeCrypto from "node:crypto";

export interface LifecycleSource {
  readonly threadId: ThreadId;
  readonly lifecycleRevision: number;
  readonly sourceToken: string;
  readonly isLegacy: boolean;
}

/** The caller supplies a validated root-to-target subagent ownership path. */
export const lifecycleSourceForPath = (
  path: readonly Pick<OrchestrationV2AppThread, "id" | "lifecycleRevision">[],
): LifecycleSource => {
  const target = path.at(-1)!;
  const hash = NodeCrypto.createHash("sha256");
  for (const member of path)
    hash.update(`${member.id.length}:${member.id}:${member.lifecycleRevision ?? 0};`);
  return {
    threadId: target.id,
    lifecycleRevision: target.lifecycleRevision ?? 0,
    sourceToken: hash.digest("hex"),
    isLegacy: path.every((member) => (member.lifecycleRevision ?? 0) === 0),
  };
};

export interface LifecycleWriteGuard {
  readonly threadId: ThreadId;
  readonly lifecycleRevision: number;
  readonly sourceToken?: string | undefined;
  readonly runId?: RunId;
  readonly attemptId?: RunAttemptId;
  readonly providerSessionId?: ProviderSessionId;
  /** Cross-thread side effects also retain the immutable initiating sources. */
  readonly prerequisites?: ReadonlyArray<Omit<LifecycleWriteGuard, "prerequisites">>;
}

export const guardForRun = (
  run: Pick<OrchestrationV2Run, "threadId" | "id" | "lifecycleRevision" | "lifecycleSourceToken">,
): LifecycleWriteGuard => ({
  threadId: run.threadId,
  lifecycleRevision: run.lifecycleRevision ?? 0,
  sourceToken: run.lifecycleSourceToken,
  runId: run.id,
});

// Internal intake context survives attachment I/O without exposing a client bypass.
export class DispatchLifecycleGuard extends Context.Reference<LifecycleWriteGuard | undefined>(
  "t3/orchestration-v2/DispatchLifecycleGuard",
  { defaultValue: () => undefined as LifecycleWriteGuard | undefined },
) {}

export class ThreadLifecycleGuardError extends Schema.TaggedError<ThreadLifecycleGuardError>()(
  "ThreadLifecycleGuardError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to check thread lifecycle ownership.";
  }
}

export class ThreadLifecycleGuard extends Context.Service<
  ThreadLifecycleGuard,
  {
    readonly resolveLifecycleSource: (
      threadId: ThreadId,
    ) => Effect.Effect<LifecycleSource, ThreadLifecycleGuardError>;
    readonly check: (input: {
      readonly guard: LifecycleWriteGuard;
      readonly purpose: "activity" | "terminal_cleanup";
    }) => Effect.Effect<"accept" | "stale", ThreadLifecycleGuardError>;
  }
>()("t3/orchestration-v2/ThreadLifecycleGuard") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readSource = Effect.fn("ThreadLifecycleGuard.readSource")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly parent_id: string | null;
      readonly relationship: string | null;
      readonly revision: number;
      readonly archived_at: string | null;
      readonly deleted_at: string | null;
      readonly tombstone: string | null;
    }>`
        WITH RECURSIVE path(thread_id) AS (
          SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
          UNION
          SELECT json_extract(t.payload_json, '$.lineage.parentThreadId')
          FROM path p JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
          WHERE json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
        )
        SELECT t.thread_id, t.project_id,
          json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_id,
          json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
          coalesce(json_extract(t.payload_json, '$.lifecycleRevision'), 0) AS revision,
          t.archived_at, t.deleted_at, d.thread_id AS tombstone
        FROM path p JOIN orchestration_v2_projection_threads t ON t.thread_id = p.thread_id
        LEFT JOIN orchestration_v2_thread_deletions d ON d.thread_id = t.thread_id
      `;
    const byId = new Map(rows.map((row) => [row.thread_id, row]));
    const target = byId.get(threadId);
    if (target === undefined) return undefined;
    const seen = new Set<string>();
    const path: Array<typeof target> = [];
    let current = target;
    while (true) {
      if (seen.has(current.thread_id)) return undefined;
      seen.add(current.thread_id);
      path.push(current);
      if (current.relationship !== "subagent") break;
      const parent = current.parent_id === null ? undefined : byId.get(current.parent_id);
      if (parent === undefined || parent.project_id !== current.project_id) return undefined;
      current = parent;
    }
    return {
      source: lifecycleSourceForPath(
        path.toReversed().map((member) => ({
          id: ThreadId.make(member.thread_id),
          lifecycleRevision: member.revision,
        })),
      ),
      active: path.every(
        (member) =>
          member.archived_at === null && member.deleted_at === null && member.tombstone === null,
      ),
    };
  });
  const resolveLifecycleSource = Effect.fn("ThreadLifecycleGuard.resolveLifecycleSource")(
    function* (threadId: ThreadId) {
      const current = yield* readSource(threadId);
      if (current === undefined)
        return yield* new ThreadLifecycleGuardError({
          threadId,
          cause: "Invalid ownership source.",
        });
      return current.source;
    },
    (effect, threadId) =>
      Effect.mapError(effect, (cause) => new ThreadLifecycleGuardError({ threadId, cause })),
  );
  const check: ThreadLifecycleGuard["Service"]["check"] = Effect.fn("ThreadLifecycleGuard.check")(
    function* ({ guard, purpose }: Parameters<ThreadLifecycleGuard["Service"]["check"]>[0]) {
      for (const prerequisite of guard.prerequisites ?? []) {
        if ((yield* check({ guard: prerequisite, purpose: "activity" })) === "stale")
          return "stale" as const;
      }
      const current = yield* readSource(guard.threadId);
      if (current === undefined) return "stale" as const;
      if (
        purpose === "activity" &&
        (!current.active ||
          current.source.lifecycleRevision !== guard.lifecycleRevision ||
          (guard.sourceToken === undefined
            ? !current.source.isLegacy
            : current.source.sourceToken !== guard.sourceToken))
      )
        return "stale" as const;
      if (guard.attemptId !== undefined && guard.runId === undefined) return "stale" as const;
      let providerThreadId: string | null = null;
      if (guard.runId !== undefined) {
        const runs = yield* sql<{
          readonly attempt_id: string | null;
          readonly revision: number;
          readonly source_token: string | null;
          readonly provider_thread_id: string | null;
        }>`
          SELECT json_extract(payload_json, '$.activeAttemptId') AS attempt_id,
            coalesce(json_extract(payload_json, '$.lifecycleRevision'), 0) AS revision,
            json_extract(payload_json, '$.lifecycleSourceToken') AS source_token, provider_thread_id
          FROM orchestration_v2_projection_runs
          WHERE thread_id = ${guard.threadId} AND run_id = ${guard.runId}
        `;
        if (
          runs[0] === undefined ||
          runs[0].revision !== guard.lifecycleRevision ||
          (runs[0].source_token !== null && runs[0].source_token !== guard.sourceToken) ||
          (purpose === "activity" && runs[0].source_token === null && !current.source.isLegacy) ||
          (guard.attemptId !== undefined && runs[0].attempt_id !== guard.attemptId)
        )
          return "stale" as const;
        providerThreadId = runs[0].provider_thread_id;
        if (guard.attemptId !== undefined) {
          const attempts = yield* sql`SELECT 1 FROM orchestration_v2_projection_run_attempts
            WHERE thread_id=${guard.threadId} AND attempt_id=${guard.attemptId} AND run_id=${guard.runId}`;
          if (attempts.length === 0) return "stale" as const;
        }
      }
      if (guard.providerSessionId !== undefined) {
        const bindings = yield* sql<{ readonly present: number }>`
          SELECT 1 AS present FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${guard.threadId}
            AND json_extract(payload_json, '$.providerSessionId') = ${guard.providerSessionId}
            AND (${providerThreadId} IS NULL OR provider_thread_id = ${providerThreadId})
          LIMIT 1
        `;
        if (bindings.length === 0) return "stale" as const;
      }
      return "accept" as const;
    },
    (effect, input) =>
      Effect.mapError(
        effect,
        (cause) => new ThreadLifecycleGuardError({ threadId: input.guard.threadId, cause }),
      ),
  );
  return ThreadLifecycleGuard.of({ check, resolveLifecycleSource });
});

export const layer = Layer.effect(ThreadLifecycleGuard, make);
