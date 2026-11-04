import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type NativeSessionStorage,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderThreadLifecycleService from "./ProviderThreadLifecycleService.ts";
import * as ThreadLifecycleGuard from "./ThreadLifecycleGuard.ts";

const root = ThreadId.make("pi-delete:root");
const child = ThreadId.make("pi-delete:child");
const outside = ThreadId.make("pi-delete:outside");
const instanceId = ProviderInstanceId.make("pi-original");
const providerThreadId = ProviderThreadId.make("pi-delete:provider");
const sessionId = ProviderSessionId.make("pi-delete:session");
const commandId = CommandId.make("pi-delete:command");
const now = DateTime.makeUnsafe("2026-11-03T00:00:00Z");
const timestamp = DateTime.formatIso(now);
const storage = {
  type: "resolved",
  canonicalRoot: "/isolated-pi/sessions",
  canonicalFile: "/isolated-pi/sessions/session.jsonl",
} as const;

function deletionEffect(
  overrides: Partial<
    Extract<EffectOutbox.OrchestrationEffectRequestV2, { type: "provider-thread.delete" }>
  > = {},
) {
  return {
    id: "pi-delete:effect",
    commandId,
    threadId: root,
    request: {
      type: "provider-thread.delete" as const,
      driver: "pi" as const,
      providerInstanceId: instanceId,
      providerThreadId,
      threadIds: [root],
      nativeId: "native-session",
      nativeStorage: storage,
      lifecycle: { commandId, rootThreadId: root, revision: 1 },
      ...overrides,
    },
    status: "running" as const,
    attemptCount: 1,
    availableAt: timestamp,
    leaseOwner: "test",
    leaseExpiresAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    lastError: null,
  };
}

function shell(revision = 1): OrchestrationV2ThreadShell {
  return {
    id: root,
    projectId: ProjectId.make("pi-delete:project"),
    title: "Deleted",
    createdBy: "user",
    creationSource: "web",
    lifecycleRevision: revision,
    providerInstanceId: ProviderInstanceId.make("current-model-is-not-pi"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("current-model-is-not-pi"),
      model: "other",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: root },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: null,
    activeRunId: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
    status: "idle",
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: now,
    settledAt: null,
    settledOverride: null,
  };
}

const seedThread = Effect.fn("test.seedDeletedPiThread")(function* (
  id: ThreadId = root,
  parent: ThreadId | null = null,
  deleted = true,
  relationship: "subagent" | "fork" | null = parent === null ? null : "subagent",
) {
  const sql = yield* SqlClient.SqlClient;
  const payload = JSON.stringify({
    lifecycleRevision: 1,
    lineage: { parentThreadId: parent, relationshipToParent: relationship },
  });
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at, payload_json)
    VALUES (${id}, 'pi-delete:project', 'fixture', 'pi', 'full-access', 'default',
      ${timestamp}, ${timestamp}, ${deleted ? timestamp : null}, ${payload})`;
  if (deleted)
    yield* sql`INSERT INTO orchestration_v2_thread_deletions
    (thread_id, project_id, parent_thread_id, operation_root_thread_id, deleted_at, command_id, scope, payload_json)
    VALUES (${id}, 'pi-delete:project', ${parent}, ${root}, ${timestamp}, ${commandId}, 't3_only', '{}')`;
});

const seedBinding = Effect.fn("test.seedPiBinding")(function* (
  input: {
    readonly threadId?: ThreadId;
    readonly providerThreadId?: ProviderThreadId;
    readonly storage?: NativeSessionStorage;
    readonly deletionSession?: boolean;
    readonly nativeId?: string | null;
    readonly instanceId?: ProviderInstanceId;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const locator = input.storage ?? storage;
  const data = {
    thread_id: input.threadId ?? root,
    provider_thread_id: input.providerThreadId ?? providerThreadId,
    provider_instance_id: input.instanceId ?? instanceId,
    driver: "pi",
    native_id: input.nativeId === undefined ? "native-session" : input.nativeId,
    storage_type: locator.type,
    canonical_root: locator.type === "resolved" ? locator.canonicalRoot : "",
    canonical_file: locator.type === "resolved" ? (locator.canonicalFile ?? "") : "",
    payload_json: "{}",
  };
  if (input.deletionSession) {
    yield* sql`INSERT INTO orchestration_v2_thread_deletion_sessions ${sql.insert({ ...data, session_index: 0 })}`;
  } else {
    yield* sql`INSERT INTO orchestration_v2_native_session_bindings ${sql.insert({
      ...data,
      binding_key: `${data.thread_id}:${data.provider_thread_id}`,
      bound_at: timestamp,
    })}`;
  }
});

const seedProvider = Effect.fn("test.seedPiProviderThread")(function* (
  owner: ThreadId | null = root,
  id = providerThreadId,
  nativeStorage: NativeSessionStorage | null = storage,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
    (provider_thread_id, thread_id, provider, driver, provider_instance_id, provider_session_id,
      status, updated_at, payload_json)
    VALUES (${id}, ${owner}, 'pi', 'pi', ${instanceId}, ${sessionId}, 'closed', ${timestamp},
      ${JSON.stringify({
        providerSessionId: sessionId,
        nativeStorage,
        nativeThreadRef: { driver: "pi", nativeId: "native-session", strength: "exact" },
      })})`;
});

function testLayer(
  input: {
    readonly revision?: number;
    readonly live?: boolean;
    readonly adapterFailure?: boolean;
    readonly missingAdapterMethod?: boolean;
    readonly staleGuard?: boolean;
    readonly sourceToken?: string;
    readonly adapterInstanceId?: ProviderInstanceId;
    readonly adapterDriver?: string;
    readonly missingInstance?: boolean;
  } = {},
) {
  const calls: Array<ProviderAdapter.ProviderAdapterV2DeleteNativeThreadInput> = [];
  const lookups: Array<ProviderInstanceId> = [];
  const checkedSessions: Array<ProviderSessionId> = [];
  const guardInputs: Array<
    Parameters<ThreadLifecycleGuard.ThreadLifecycleGuard["Service"]["check"]>[0]
  > = [];
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed(shell(input.revision)),
    }),
    Layer.mock(ThreadLifecycleGuard.ThreadLifecycleGuard)({
      check: (request) =>
        Effect.sync(() => {
          guardInputs.push(request);
          return input.staleGuard ? "stale" : "accept";
        }),
      resolveLifecycleSource: () =>
        Effect.succeed({
          threadId: root,
          lifecycleRevision: 1,
          sourceToken: input.sourceToken ?? "current-source",
          isLegacy: false,
        }),
    }),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      isLive: (id) =>
        Effect.sync(() => {
          checkedSessions.push(id);
          return input.live ?? false;
        }),
    }),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      get: (id) =>
        Effect.gen(function* () {
          lookups.push(id);
          if (input.missingInstance)
            return yield* new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({
              instanceId: id,
            });
          return ProviderAdapter.ProviderAdapterV2.of({
            instanceId: input.adapterInstanceId ?? instanceId,
            driver: ProviderDriverKind.make(input.adapterDriver ?? "pi"),
            getCapabilities: () => Effect.die("unused"),
            planSelectionTransition: () => Effect.die("unused"),
            openSession: () => Effect.die("runtime must not open"),
            ...(input.missingAdapterMethod
              ? {}
              : {
                  deleteNativeThread: (
                    request: ProviderAdapter.ProviderAdapterV2DeleteNativeThreadInput,
                  ) =>
                    Effect.gen(function* () {
                      calls.push(request);
                      if (input.adapterFailure)
                        return yield* new ProviderAdapter.ProviderAdapterNativeThreadDeleteError({
                          driver: ProviderDriverKind.make("pi"),
                          reason: "filesystem_failure",
                          cause: "private-path-and-config",
                        });
                    }),
                }),
          });
        }),
    }),
  );
  return {
    calls,
    lookups,
    checkedSessions,
    guardInputs,
    layer: ProviderThreadLifecycleService.layer.pipe(
      Layer.provide(dependencies),
      Layer.provideMerge(SqlitePersistence.layerMemory),
    ),
  };
}

it.effect(
  "deletes an exclusive persisted Pi identity through its original instance without opening a runtime",
  () => {
    const fixture = testLayer({ sourceToken: "captured-source" });
    return Effect.gen(function* () {
      yield* seedThread();
      yield* seedBinding();
      yield* seedProvider();
      const service = yield* ProviderThreadLifecycleService.ProviderThreadLifecycleService;
      yield* service.delete(
        deletionEffect({
          lifecycle: { commandId, rootThreadId: root, revision: 1, sourceToken: "captured-source" },
        }),
      );
      assert.deepEqual(fixture.guardInputs, [
        {
          purpose: "terminal_cleanup",
          guard: {
            threadId: root,
            lifecycleRevision: 1,
            sourceToken: "captured-source",
          },
        },
      ]);
      assert.deepEqual(fixture.lookups, [instanceId]);
      assert.deepEqual(fixture.checkedSessions, [sessionId]);
      assert.lengthOf(fixture.calls, 1);
      assert.deepEqual(fixture.calls[0]!.providerThread.nativeStorage, storage);
      assert.equal(fixture.calls[0]!.providerThread.nativeThreadRef?.nativeId, "native-session");
    }).pipe(Effect.provide(fixture.layer));
  },
);

for (const input of [{ revision: 2 }, { staleGuard: true }, { sourceToken: "changed-source" }]) {
  it.effect(
    `stale lifecycle ${JSON.stringify(input)} succeeds before identity or adapter access`,
    () => {
      const fixture = testLayer(input);
      return Effect.gen(function* () {
        const service = yield* ProviderThreadLifecycleService.ProviderThreadLifecycleService;
        yield* service.delete(
          deletionEffect({
            nativeStorage: { type: "unresolved", reason: "unavailable" },
            ...(input.sourceToken
              ? {
                  lifecycle: {
                    commandId,
                    rootThreadId: root,
                    revision: 1,
                    sourceToken: "captured-source",
                  },
                }
              : {}),
          }),
        );
        assert.deepEqual(fixture.calls, []);
        assert.deepEqual(fixture.lookups, []);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
}

const blockers = [
  "unresolved",
  "unknown",
  "live-runtime",
  "outside-binding",
  "outside-deletion-session",
  "outside-provider",
  "unknown-provider-owner",
  "unresolved-reference",
  "outside-session-binding",
  "pending-transfer",
  "live-target",
  "fork-target",
  "missing-capability",
  "adapter-failure",
  "session-only-runtime",
  "outside-session-projection",
  "unknown-session-peer",
  "pending-base-point",
  "pending-native-ref",
  "orphan-session-binding",
  "canonical-alias",
  "missing-instance",
  "wrong-instance",
  "wrong-driver",
] as const;
for (const blocker of blockers) {
  it.effect(`blocks Pi deletion for ${blocker} with a bounded observable error`, () => {
    const fixture = testLayer({
      live: ["live-runtime", "session-only-runtime"].includes(blocker),
      adapterFailure: blocker === "adapter-failure",
      missingAdapterMethod: blocker === "missing-capability",
      missingInstance: blocker === "missing-instance",
      ...(blocker === "wrong-instance"
        ? { adapterInstanceId: ProviderInstanceId.make("pi-different") }
        : {}),
      ...(blocker === "wrong-driver" ? { adapterDriver: "codex" } : {}),
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedThread();
      if (blocker !== "unknown") yield* seedBinding();
      if (blocker === "orphan-session-binding")
        yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id) VALUES (${sessionId}, ${root})`;
      if (blocker === "canonical-alias") {
        yield* seedThread(outside, null, false);
        yield* seedBinding({
          threadId: outside,
          providerThreadId: ProviderThreadId.make("outside-alias"),
          nativeId: "different-native-id",
          instanceId: ProviderInstanceId.make("pi-different"),
        });
      }
      if (["live-runtime", "outside-session-binding"].includes(blocker)) yield* seedProvider();
      if (["session-only-runtime", "outside-session-projection"].includes(blocker)) {
        yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
          (provider_session_id, thread_id, provider, driver, provider_instance_id, status, updated_at, payload_json)
          VALUES (${sessionId}, ${blocker === "outside-session-projection" ? outside : root}, 'pi', 'pi', ${instanceId}, 'stopped', ${timestamp}, '{}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
          (provider_session_id, thread_id) VALUES (${sessionId}, ${root})`;
      }
      if (blocker === "unknown-session-peer") {
        yield* seedProvider();
        yield* seedProvider(null, ProviderThreadId.make("unknown-peer"), {
          type: "resolved",
          canonicalRoot: "/other",
          canonicalFile: "/other/session.jsonl",
        });
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'
          WHERE provider_thread_id = 'unknown-peer'`;
      }
      if (
        [
          "outside-binding",
          "outside-deletion-session",
          "outside-provider",
          "outside-session-binding",
          "unresolved-reference",
        ].includes(blocker)
      ) {
        yield* seedThread(outside, null, blocker === "outside-deletion-session");
        if (blocker === "outside-provider")
          yield* seedProvider(outside, ProviderThreadId.make("outside-provider"));
        if (
          ["outside-binding", "outside-deletion-session", "unresolved-reference"].includes(blocker)
        )
          yield* seedBinding({
            threadId: outside,
            providerThreadId: ProviderThreadId.make("outside-binding"),
            deletionSession: blocker === "outside-deletion-session",
            ...(blocker === "unresolved-reference"
              ? { storage: { type: "unresolved", reason: "unavailable" } as const }
              : {}),
          });
        if (blocker === "outside-session-binding")
          yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
          (provider_session_id, thread_id) VALUES (${sessionId}, ${outside})`;
      }
      if (blocker === "unknown-provider-owner") yield* seedProvider(null);
      if (blocker === "live-target" || blocker === "fork-target")
        yield* seedThread(
          child,
          root,
          blocker !== "live-target",
          blocker === "fork-target" ? "fork" : "subagent",
        );
      if (["pending-transfer", "pending-base-point", "pending-native-ref"].includes(blocker))
        yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer', ${blocker === "pending-transfer" ? root : outside}, ${outside}, 'fork', 'pending', ${timestamp},
          ${JSON.stringify(
            blocker === "pending-base-point"
              ? { basePoint: { threadId: root } }
              : blocker === "pending-native-ref"
                ? {
                    sourcePoint: {
                      providerThreadRef: { driver: "pi", nativeId: "native-session" },
                    },
                  }
                : {},
          )})`;
      const service = yield* ProviderThreadLifecycleService.ProviderThreadLifecycleService;
      const result = yield* Effect.result(
        service.delete(
          deletionEffect({
            ...(blocker === "unresolved"
              ? { nativeStorage: { type: "unresolved", reason: "unavailable" } as const }
              : {}),
            ...(["live-target", "fork-target"].includes(blocker)
              ? { threadIds: [root, child] }
              : {}),
          }),
        ),
      );
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.equal(result.failure._tag, "ProviderThreadLifecycleError");
        assert.equal(
          result.failure.reason,
          blocker === "unresolved"
            ? "identity"
            : blocker === "unknown"
              ? "provenance"
              : ["live-target", "fork-target"].includes(blocker)
                ? "lifecycle"
                : ["live-runtime", "session-only-runtime"].includes(blocker)
                  ? "runtime"
                  : [
                        "missing-capability",
                        "adapter-failure",
                        "missing-instance",
                        "wrong-instance",
                        "wrong-driver",
                      ].includes(blocker)
                    ? "adapter"
                    : blocker === "orphan-session-binding"
                      ? "provenance"
                      : "reference",
        );
        assert.notInclude(result.failure.message, storage.canonicalRoot);
        assert.notInclude(result.failure.message, "private-path-and-config");
        if (blocker === "adapter-failure")
          assert.instanceOf(
            result.failure.cause,
            ProviderAdapter.ProviderAdapterNativeThreadDeleteError,
          );
      }
      assert.lengthOf(fixture.calls, blocker === "adapter-failure" ? 1 : 0);
    }).pipe(Effect.provide(fixture.layer));
  });
}

it.effect("a resolved Pi file with a null native id still has a durable exclusive identity", () => {
  const fixture = testLayer();
  return Effect.gen(function* () {
    yield* seedThread();
    yield* seedBinding({ nativeId: null });
    const service = yield* ProviderThreadLifecycleService.ProviderThreadLifecycleService;
    yield* service.delete(deletionEffect({ nativeId: null }));
    assert.lengthOf(fixture.calls, 1);
    assert.isNull(fixture.calls[0]!.providerThread.nativeThreadRef?.nativeId);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect(
  "deletes a shared canonical file once when every owner is a deleted subagent in the target closure",
  () => {
    const fixture = testLayer();
    return Effect.gen(function* () {
      yield* seedThread();
      yield* seedThread(child, root);
      yield* seedBinding();
      yield* seedBinding({ threadId: child });
      const service = yield* ProviderThreadLifecycleService.ProviderThreadLifecycleService;
      yield* service.delete(deletionEffect({ threadIds: [root, child] }));
      assert.lengthOf(fixture.calls, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.effect(
  "a different canonical root and file disambiguates an outside session with the same native id",
  () => {
    const fixture = testLayer();
    return Effect.gen(function* () {
      yield* seedThread();
      yield* seedThread(outside, null, false);
      yield* seedBinding();
      yield* seedBinding({
        threadId: outside,
        providerThreadId: ProviderThreadId.make("other-provider-thread"),
        storage: {
          type: "resolved",
          canonicalRoot: "/other",
          canonicalFile: "/other/session.jsonl",
        },
      });
      const service = yield* ProviderThreadLifecycleService.ProviderThreadLifecycleService;
      yield* service.delete(deletionEffect());
      assert.lengthOf(fixture.calls, 1);
    }).pipe(Effect.provide(fixture.layer));
  },
);
