import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProviderThreadId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type NativeSessionStorage,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as NativeSessionBindings from "../orchestration-v2/NativeSessionBindings.ts";
import * as ThreadDeletionRecords from "../orchestration-v2/ThreadDeletionRecords.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  NativeSessionBindings.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  ThreadDeletionRecords.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: "codex" | "claudeAgent" = "codex",
  nativeStorage: NativeSessionStorage = {
    type: "resolved",
    canonicalRoot: `/stores/${modelSelection.instanceId}`,
  },
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    nativeStorage,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

function importId(source: ReturnType<typeof candidate>) {
  return IdAllocator.derive.threadFromProviderThread({
    driver: ProviderDriverKind.make(source.source.provider),
    providerInstanceId: source.source.providerInstanceId,
    nativeThreadId: source.source.providerSessionId,
    storageScope: IdAllocator.nativeStorageScope({
      driver: ProviderDriverKind.make(source.source.provider),
      nativeId: source.source.providerSessionId,
      storage: source.nativeStorage,
    })!,
  });
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({
      driver,
      nativeThreadId: providerSessionId,
    }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: providerSessionId, strength: "strong" },
    nativeStorage: source.nativeStorage,
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          NativeSessionBindings.layer.pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, importSql)),
          ),
          Layer.succeed(SqlClient.SqlClient, importSql),
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({
            recentThreads: () => Stream.fromIterable(candidates),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeed(
                Option.some({
                  id: projectId,
                  title: "Project",
                  workspaceRoot: "/workspace/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                  deletedAt: null,
                }),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return { run: importer.importRecentAgentThreads({ projectId }), published };
});

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      const importer = yield* makeImporter([active, archived, deleted, otherInstance, unowned]);

      expect(yield* importer.run).toEqual({ importedCount: 2, skippedCount: 0 });
      for (const source of [active, archived, deleted]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned)]));
      for (const source of [otherInstance, unowned]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(
          source.source.providerSessionId,
        );
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "codex"
              ? { threadId: source.source.providerSessionId }
              : { threadId, resume: source.source.providerSessionId },
          runtimePayload: { importedTranscripts: [source.source] },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("storage aliases cannot reimport a deleted owner's native session", () =>
  Effect.gen(function* () {
    const original = candidate(CODEX_MODEL_SELECTION, "alias-deleted");
    yield* seedOwner(original, "deleted");
    const alias = candidate(
      { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-alias") },
      original.source.providerSessionId,
      "codex",
      original.nativeStorage,
    );
    const importer = yield* makeImporter([alias]);
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(importer.published).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("storage roots distinguish the same instance's same native session id", () =>
  Effect.gen(function* () {
    const first = candidate(CODEX_MODEL_SELECTION, "same-native", "codex", {
      type: "resolved",
      canonicalRoot: "/stores/X",
    });
    const second = candidate(CODEX_MODEL_SELECTION, "same-native", "codex", {
      type: "resolved",
      canonicalRoot: "/stores/Y",
    });
    const importer = yield* makeImporter([first, second]);
    expect(yield* importer.run).toEqual({ importedCount: 2, skippedCount: 0 });
    expect(
      new Set(
        importer.published.flatMap((stored) => ("event" in stored ? [stored.event.threadId] : [])),
      ).size,
    ).toBe(2);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

const recordDeletion = Effect.fn("AgentSessionImporter.test.recordDeletion")(function* (
  source: ReturnType<typeof candidate>,
  threadId = ThreadId.make("deleted-native-owner"),
) {
  const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
  const bindings = yield* NativeSessionBindings.NativeSessionBindings;
  const sessions = yield* bindings.listForThreads([threadId]);
  yield* records.apply({
    threadId,
    projectId,
    parentThreadId: null,
    operationRootThreadId: threadId,
    deletedAt: timestamp,
    commandId: CommandId.make(`delete:${threadId}`),
    scope: "t3_only",
    sessions:
      sessions.length > 0
        ? sessions
        : [
            {
              threadId,
              providerThreadId: ProviderThreadId.make(`deleted:${source.source.providerSessionId}`),
              providerInstanceId: source.source.providerInstanceId,
              driver: ProviderDriverKind.make(source.source.provider),
              nativeId: source.source.providerSessionId,
              storage: source.nativeStorage,
              boundAt: timestamp,
            },
          ],
  });
});

it.effect(
  "storage checks use independent deletion evidence and retain X when an instance moves to Y",
  () =>
    Effect.gen(function* () {
      const bindings = yield* NativeSessionBindings.NativeSessionBindings;
      const records = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const x = candidate(CODEX_MODEL_SELECTION, "moved", "codex", {
        type: "resolved",
        canonicalRoot: "/stores/X",
      });
      const owner = yield* seedOwner(x);
      yield* recordDeletion(x, owner);
      const before = yield* records.get(owner);
      const identity = {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "moved",
        providerInstanceId: ProviderInstanceId.make("alias"),
        storage: x.nativeStorage,
      };
      expect(yield* bindings.checkImport(identity)).toBe("deleted");
      expect(
        yield* bindings.checkImport({
          ...identity,
          storage: { type: "resolved", canonicalRoot: "/stores/Y" },
        }),
      ).toBe("unowned");
      const y = candidate(CODEX_MODEL_SELECTION, "moved", "codex", {
        type: "resolved",
        canonicalRoot: "/stores/Y",
      });
      expect(yield* (yield* makeImporter([y])).run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* records.get(owner)).toEqual(before);
      expect((yield* bindings.listForThreads([owner]))[0]?.storage).toEqual(x.nativeStorage);
      // The deletion index continues to guard imports after the live projections disappear.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_native_session_bindings WHERE thread_id = ${owner}`;
      yield* sql`DELETE FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${owner}`;
      expect(yield* bindings.checkImport(identity)).toBe("deleted");
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "storage conflicts with unknown legacy locations but null native ids do not block candidates",
  () =>
    Effect.gen(function* () {
      const bindings = yield* NativeSessionBindings.NativeSessionBindings;
      const source = candidate(CODEX_MODEL_SELECTION, "legacy", "codex", {
        type: "unresolved",
        reason: "legacy_missing_locator",
      });
      yield* seedOwner(source);
      const identity = {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "legacy",
        providerInstanceId: ProviderInstanceId.make("alias"),
        storage: { type: "resolved" as const, canonicalRoot: "/stores/Y" },
      };
      expect(yield* bindings.checkImport(identity)).toBe("unresolved_conflict");
      const logs: Array<unknown> = [];
      const resolved = candidate(CODEX_MODEL_SELECTION, "legacy", "codex", identity.storage);
      const importer = yield* makeImporter([resolved]);
      expect(
        yield* importer.run.pipe(
          Effect.provide(Logger.layer([Logger.make(({ message }) => logs.push(message))])),
        ),
      ).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(logs).toEqual([["Native session import skipped", { reason: "unresolved_conflict" }]]);
      expect(importer.published).toEqual([]);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_native_session_bindings SET native_id = NULL`;
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = json_set(payload_json, '$.nativeThreadRef', NULL)`;
      expect(yield* bindings.checkImport(identity)).toBe("unowned");
      expect(
        yield* bindings.checkImport({ ...identity, nativeId: "" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "NativeSessionBindingError" });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("storage deletion between scan and commit prevents alias reimport", () =>
  Effect.gen(function* () {
    const entering = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "deleted-after-scan");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(entering, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(entering);
    yield* recordDeletion({
      ...source,
      source: { ...source.source, providerInstanceId: ProviderInstanceId.make("old-alias") },
    });
    yield* Deferred.succeed(proceed, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(importer.published).toEqual([]);
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* runtimes.list()).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect.each(["AlreadyImported", "Duplicate"] as const)(
  "storage deletion guards the %s fast path at its transaction",
  (tag) =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, `fast-${tag}`);
      expect(yield* (yield* makeImporter([source])).run).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      const entering = yield* Deferred.make<void>();
      const proceed = yield* Deferred.make<void>();
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const before = yield* runtimes.list();
      const importer = yield* makeImporter(
        [
          {
            _tag: tag,
            source: { ...source.source, filePath: "/extra-transcript.jsonl" },
            nativeStorage: source.nativeStorage,
          },
        ],
        Deferred.succeed(entering, undefined).pipe(Effect.andThen(Deferred.await(proceed))),
      );
      const pending = yield* Effect.forkScoped(importer.run);
      yield* Deferred.await(entering);
      yield* recordDeletion(source, importId(source));
      yield* Deferred.succeed(proceed, undefined);
      expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
      expect(yield* runtimes.list()).toEqual(before);
      expect(importer.published).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("storage preserves already persisted import ids when the confirmed locator matches", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "legacy-id");
    const sql = yield* SqlClient.SqlClient;
    const first = yield* makeImporter([source]);
    yield* first.run;
    const scopedId = importId(source);
    const legacyId = ThreadId.make(
      `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
    );
    // Simulate a persisted pre-scope import without replaying or renaming it in production.
    for (const table of [
      "orchestration_v2_projection_threads",
      "orchestration_v2_projection_provider_threads",
      "orchestration_v2_native_session_bindings",
    ] as const) {
      yield* sql`UPDATE ${sql(table)} SET thread_id = ${legacyId}, payload_json = replace(payload_json, ${scopedId}, ${legacyId}) WHERE thread_id = ${scopedId}`;
    }
    const importer = yield* makeImporter([source]);
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    expect(importer.published).toEqual([]);
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(Option.isSome(yield* runtimes.getByThreadId({ threadId: legacyId }))).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);
