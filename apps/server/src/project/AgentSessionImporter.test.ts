import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  AgentSessionImportProjectChangedError,
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  EventSinkV2,
  EventSinkWriteError,
  layer as eventSinkLayer,
} from "../orchestration-v2/EventSink.ts";
import { layer as eventStoreLayer } from "../orchestration-v2/EventStore.ts";
import { layer as idAllocatorLayer } from "../orchestration-v2/IdAllocator.ts";
import { OrchestratorProjectionError, OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  ProjectionStoreV2,
  layer as projectionStoreLayer,
} from "../orchestration-v2/ProjectionStore.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ProviderSessionRuntimeRepository,
  layer as runtimeLayer,
} from "../persistence/ProviderSessionRuntime.ts";
import { AgentSessionImporter, layer } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { ProjectService } from "./ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const projectId = ProjectId.make("agent-session-import-project");
const providerInstanceId = ProviderInstanceId.make("codex");
const providerSessionId = "native-codex-thread";
const threadId = ThreadId.make(`import:${providerInstanceId}:${providerSessionId}`);

const CLAUDE_SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const WORKSPACE_ROOT = "/workspace/project";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeThread = (source: "codex" | "claudeAgent"): AgentSessionScanner.AgentSessionThread => ({
  source,
  providerInstanceId: ProviderInstanceId.make(source),
  providerSessionId: source === "codex" ? "codex-session" : CLAUDE_SESSION_ID,
  title: `Imported ${source} thread`,
  model: null,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:01:00.000Z",
  messages: [
    { role: "user", text: "Fix the bug", createdAt: "2026-08-24T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-08-24T10:01:00.000Z" },
  ],
});

const makeThreadOutcome = (thread: AgentSessionScanner.AgentSessionThread) =>
  ({
    _tag: "Importable",
    thread,
    source: {
      provider: thread.source,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: thread.providerSessionId,
      filePath: `/tmp/transcripts/${thread.providerInstanceId}/${thread.providerSessionId}.jsonl`,
      size: 0,
      mtimeMs: 0,
      device: 0,
      inode: 0,
      birthtimeMs: 0,
    },
  }) satisfies AgentSessionScanner.AgentSessionRecentThread;

it.effect("imports messages once and preserves the provider native resume binding", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const upserts: Array<unknown> = [];
  const recorded: Array<unknown> = [];
  let imported = false;
  const scanner = AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () =>
      Stream.succeed({
        _tag: "Importable",
        source: {
          provider: "codex",
          providerInstanceId,
          providerSessionId,
          filePath: "/tmp/native-codex-thread.jsonl",
          size: 100,
          mtimeMs: 2,
          device: 3,
          inode: 4,
          birthtimeMs: 1,
        },
        thread: {
          source: "codex",
          providerInstanceId,
          providerSessionId,
          title: "Imported thread",
          model: "gpt-5.4",
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:01:00.000Z",
          messages: [
            { role: "user", text: "Fix it", createdAt: "2026-09-01T10:00:00.000Z" },
            { role: "assistant", text: "Fixed", createdAt: "2026-09-01T10:01:00.000Z" },
          ],
        },
      }),
  });
  const testLayer = layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: "/workspace/project" } as never),
            ),
        }),
        Layer.mock(OrchestratorV2)({
          getThreadRecords: () =>
            imported
              ? Effect.succeed({
                  thread: { id: threadId, projectId, historyOrigin: "v1_import" },
                } as never)
              : Effect.fail(new OrchestratorProjectionError({ threadId })),
        }),
        Layer.mock(EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              writes.push(input.events);
              imported = true;
              return [];
            }),
        }),
        Layer.mock(ProviderSessionRuntimeRepository)({
          list: () => Effect.succeed([]),
          upsert: (input) => Effect.sync(() => void upserts.push(input)),
          recordImportedTranscript: (input) => Effect.sync(() => void recorded.push(input)),
        }),
        idAllocatorLayer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const importer = yield* AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.map((event) => event.type)).toEqual([
      "thread.created",
      "message.updated",
      "turn-item.updated",
      "message.updated",
      "turn-item.updated",
      "provider-thread.updated",
    ]);
    const created = writes[0]?.find((event) => event.type === "thread.created");
    const providerThread = writes[0]?.find((event) => event.type === "provider-thread.updated");
    expect(created?.payload).toMatchObject({
      id: threadId,
      activeProviderThreadId: providerThread?.payload.id,
      historyOrigin: "v1_import",
    });
    expect(providerThread?.payload).toMatchObject({
      appThreadId: threadId,
      nativeThreadRef: {
        driver: "codex",
        nativeId: providerSessionId,
        strength: "strong",
      },
    });
    expect(
      writes[0]
        ?.filter((event) => event.type === "message.updated")
        .map((event) => event.payload.text),
    ).toEqual(["Fix it", "Fixed"]);
    expect(upserts).toEqual([
      expect.objectContaining({
        threadId,
        providerInstanceId,
        resumeCursor: { threadId: providerSessionId },
      }),
    ]);
    expect(recorded).toHaveLength(2);
  }).pipe(Effect.provide(testLayer));
});

const storesLayer = Layer.mergeAll(eventStoreLayer, projectionStoreLayer, runtimeLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const persistenceLayer = eventSinkLayer.pipe(Layer.provideMerge(storesLayer));
const readLayer = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    return Layer.mock(OrchestratorV2)({
      getThreadRecords: (id, fields, filter) =>
        projections
          .getThreadRecords(id, fields, filter)
          .pipe(
            Effect.mapError((cause) => new OrchestratorProjectionError({ threadId: id, cause })),
          ),
    });
  }),
).pipe(Layer.provide(persistenceLayer));
const integrationLayer = Layer.mergeAll(
  persistenceLayer,
  readLayer,
  idAllocatorLayer,
  NodeServices.layer,
);

const makeImportLayer = (
  scanner: AgentSessionScanner.AgentSessionScanner["Service"],
  workspaceRoot = WORKSPACE_ROOT,
) =>
  layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(AgentSessionScanner.AgentSessionScanner, scanner),
        Layer.mock(ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "Project",
              workspaceRoot,
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-08-24T09:00:00.000Z",
              updatedAt: "2026-08-24T09:00:00.000Z",
              deletedAt: null,
            }),
        }),
      ),
    ),
  );

const scannerFor = (...outcomes: ReadonlyArray<AgentSessionScanner.AgentSessionRecentThread>) =>
  AgentSessionScanner.AgentSessionScanner.of({
    scan: Effect.die("unused"),
    recentThreads: () => Stream.fromIterable(outcomes),
  });

it.effect(
  "retries a bounded import after scanner restart without rereading completed transcripts",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const eventSink = yield* EventSinkV2;
      const repository = yield* ProviderSessionRuntimeRepository;
      const projections = yield* ProjectionStoreV2;
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-import-retry-" });
      const workspaceRoot = path.join(fixtureDir, "workspace");
      const claudeHomePath = path.join(fixtureDir, "claude");
      const codexHomePath = path.join(fixtureDir, "codex");
      const sessionsDir = path.join(codexHomePath, "sessions", "2026", "08", "24");
      yield* fileSystem.makeDirectory(workspaceRoot);
      yield* fileSystem.makeDirectory(claudeHomePath);
      yield* fileSystem.makeDirectory(sessionsDir, { recursive: true });
      const transcripts = Array.from({ length: 101 }, (_, index) => {
        const providerSessionId = `bounded-session-${String(index).padStart(3, "0")}`;
        return {
          providerSessionId,
          threadId: ThreadId.make(`import:codex:${providerSessionId}`),
          filePath: path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`),
        };
      });
      for (const [index, transcript] of transcripts.entries()) {
        yield* fileSystem.writeFileString(
          transcript.filePath,
          [
            encodeJson({
              type: "session_meta",
              payload: { id: transcript.providerSessionId, cwd: workspaceRoot },
            }),
            encodeJson({
              type: "event_msg",
              payload: { type: "user_message", message: `Prompt ${transcript.providerSessionId}` },
            }),
          ].join("\n"),
        );
        const seconds = nowMs / 1_000 - index;
        yield* fileSystem.utimes(transcript.filePath, seconds, seconds);
      }
      const failed = transcripts[1]!;
      const remaining = transcripts[100]!;
      let failHistory = true;
      const importerSink = {
        ...eventSink,
        write: (input: Parameters<typeof eventSink.write>[0]) =>
          Effect.suspend(() => {
            if (failHistory && input.events[0]?.threadId === failed.threadId) {
              failHistory = false;
              return Effect.fail(new EventSinkWriteError({ eventCount: input.events.length }));
            }
            return eventSink.write(input);
          }),
      };
      const transcriptPaths = new Set(transcripts.map((entry) => entry.filePath));
      const runAttempt = Effect.fn("runBoundedV2ImportAttempt")(function* (
        completedPaths: ReadonlySet<string>,
      ) {
        const openCounts = new Map<string, number>();
        const fullReads: string[] = [];
        const observedFileSystem = FileSystem.FileSystem.of({
          ...fileSystem,
          open: (filePath, options) =>
            Effect.suspend(() => {
              if (transcriptPaths.has(filePath)) {
                const count = (openCounts.get(filePath) ?? 0) + 1;
                openCounts.set(filePath, count);
                if (count > 1) {
                  fullReads.push(filePath);
                  if (completedPaths.has(filePath)) {
                    return Effect.die(new Error(`Completed transcript reopened: ${filePath}`));
                  }
                }
              }
              return fileSystem.open(filePath, options);
            }),
        });
        const scanner = yield* AgentSessionScanner.AgentSessionScanner.pipe(
          Effect.provide(
            Layer.fresh(AgentSessionScanner.layer).pipe(
              Layer.provide(
                Layer.mergeAll(
                  ServerSettingsService.layerTest({
                    providers: {
                      claudeAgent: { homePath: claudeHomePath },
                      codex: { homePath: codexHomePath },
                    },
                  }),
                  ServerConfig.layerTest(fixtureDir, { prefix: "t3-import-retry-config-" }),
                  Layer.mock(ProjectionSnapshotQuery)({}),
                  Layer.succeed(FileSystem.FileSystem, observedFileSystem),
                ),
              ),
            ),
          ),
        );
        const result = yield* Effect.gen(function* () {
          const importer = yield* AgentSessionImporter;
          return yield* importer.importRecentAgentThreads({ projectId });
        }).pipe(
          Effect.provide(makeImportLayer(scanner, workspaceRoot)),
          Effect.provideService(EventSinkV2, importerSink),
        );
        return { result, fullReads };
      });
      const first = yield* runAttempt(new Set());
      expect(first.result).toEqual({ importedCount: 99, skippedCount: 2 });
      expect(failHistory).toBe(false);
      expect(first.fullReads).toEqual(transcripts.slice(0, 100).map((entry) => entry.filePath));
      const completedPaths = new Set(
        transcripts
          .slice(0, 100)
          .filter((entry) => entry !== failed)
          .map((entry) => entry.filePath),
      );
      const second = yield* runAttempt(completedPaths);
      expect(second.result).toEqual({ importedCount: 101, skippedCount: 0 });
      expect(second.fullReads).toEqual([failed.filePath, remaining.filePath]);
      expect(yield* repository.list()).toHaveLength(101);
      for (const transcript of [failed, remaining]) {
        const records = yield* projections.getThreadRecords(transcript.threadId, ["messages"]);
        expect(records.messages.map((message) => message.text)).toEqual([
          `Prompt ${transcript.providerSessionId}`,
        ]);
      }
    }).pipe(Effect.provide(integrationLayer)),
);

it.effect("uses the project root and stores provider-specific resume cursors", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntimeRepository;
    const projections = yield* ProjectionStoreV2;
    const recentThreads = vi.fn(() =>
      Stream.fromIterable([
        makeThreadOutcome(makeThread("codex")),
        makeThreadOutcome(makeThread("claudeAgent")),
      ]),
    );
    const result = yield* Effect.gen(function* () {
      const importer = yield* AgentSessionImporter;
      return yield* importer.importRecentAgentThreads({
        projectId,
        expectedWorkspaceRoot: `${WORKSPACE_ROOT}/`,
      });
    }).pipe(Effect.provide(makeImportLayer({ scan: Effect.die("unused"), recentThreads })));

    expect(result).toEqual({ importedCount: 2, skippedCount: 0 });
    expect(recentThreads).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ROOT, []);
    for (const source of ["codex", "claudeAgent"] as const) {
      const sourceThread = makeThread(source);
      const id = ThreadId.make(`import:${source}:${sourceThread.providerSessionId}`);
      const binding = Option.getOrThrow(yield* repository.getByThreadId({ threadId: id }));
      expect(binding).toMatchObject({
        providerName: source,
        providerInstanceId: source,
        status: "stopped",
        resumeCursor:
          source === "codex"
            ? { threadId: sourceThread.providerSessionId }
            : { threadId: id, resume: sourceThread.providerSessionId },
        runtimePayload: { cwd: WORKSPACE_ROOT },
      });
      const records = yield* projections.getThreadRecords(id, [
        "messages",
        "runs",
        "providerThreads",
      ]);
      expect(records.messages.map((message) => message.text)).toEqual(["Fix the bug", "Fixed"]);
      expect(records.runs).toEqual([]);
      expect(records.providerThreads[0]).toMatchObject({
        status: "idle",
        nativeThreadRef: { nativeId: sourceThread.providerSessionId },
      });
    }
  }).pipe(Effect.provide(integrationLayer)),
);

it.effect("rejects a changed project root before scanning or writing", () =>
  Effect.gen(function* () {
    const recentThreads = vi.fn(() => Stream.empty);
    const error = yield* Effect.gen(function* () {
      const importer = yield* AgentSessionImporter;
      return yield* importer.importRecentAgentThreads({
        projectId,
        expectedWorkspaceRoot: WORKSPACE_ROOT,
      });
    }).pipe(
      Effect.provide(
        makeImportLayer({ scan: Effect.die("unused"), recentThreads }, "/workspace/moved"),
      ),
      Effect.flip,
    );
    expect(error).toEqual(new AgentSessionImportProjectChangedError({ projectId }));
    expect(recentThreads).not.toHaveBeenCalled();
    const eventSink = yield* EventSinkV2;
    expect(yield* eventSink.latestSequence()).toBe(0);
  }).pipe(Effect.provide(integrationLayer)),
);

it.effect("counts scanner skips without writing a thread or binding", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    const repository = yield* ProviderSessionRuntimeRepository;
    const eventSink = yield* EventSinkV2;
    expect(yield* repository.list()).toEqual([]);
    expect(yield* eventSink.latestSequence()).toBe(0);
  }).pipe(
    Effect.provide(makeImportLayer(scannerFor({ _tag: "Skipped" }))),
    Effect.provide(integrationLayer),
  ),
);

it.effect("recovers after a failed binding write and a rejected V2 history write", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntimeRepository;
    const eventSink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    let failBinding = true;
    let failHistory = true;
    const importerLayer = makeImportLayer(scannerFor(makeThreadOutcome(makeThread("codex")))).pipe(
      Layer.provide(
        Layer.succeed(ProviderSessionRuntimeRepository, {
          ...repository,
          upsert: (runtime, options) =>
            Effect.suspend(() => {
              if (failBinding) {
                failBinding = false;
                return Effect.fail(new PersistenceSqlError({ operation: "upsert" }));
              }
              return repository.upsert(runtime, options);
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(EventSinkV2, {
          ...eventSink,
          write: (input) =>
            Effect.suspend(() => {
              if (failHistory) {
                failHistory = false;
                return Effect.fail(new EventSinkWriteError({ eventCount: input.events.length }));
              }
              return eventSink.write(input);
            }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const importer = yield* AgentSessionImporter;
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 0,
        skippedCount: 1,
      });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 0,
        skippedCount: 1,
      });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      const sequence = yield* eventSink.latestSequence();
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 1,
        skippedCount: 0,
      });
      expect(yield* eventSink.latestSequence()).toBe(sequence);
    }).pipe(Effect.provide(importerLayer));
    const records = yield* projections.getThreadRecords(
      ThreadId.make("import:codex:codex-session"),
      ["messages"],
    );
    expect(records.messages.map((message) => message.text)).toEqual(["Fix the bug", "Fixed"]);
    expect(yield* repository.list()).toHaveLength(1);
  }).pipe(Effect.provide(integrationLayer)),
);

it.effect("does not replace completed history or an active binding on retry", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter;
    const repository = yield* ProviderSessionRuntimeRepository;
    const eventSink = yield* EventSinkV2;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    const id = ThreadId.make("import:codex:codex-session");
    const binding = Option.getOrThrow(yield* repository.getByThreadId({ threadId: id }));
    yield* repository.upsert({
      ...binding,
      status: "running",
      resumeCursor: { threadId: "newer-session" },
    });
    const sequence = yield* eventSink.latestSequence();
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* eventSink.latestSequence()).toBe(sequence);
    expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId: id }))).toMatchObject({
      status: "running",
      resumeCursor: { threadId: "newer-session" },
    });
  }).pipe(
    Effect.provide(makeImportLayer(scannerFor(makeThreadOutcome(makeThread("codex"))))),
    Effect.provide(integrationLayer),
  ),
);

it.effect("skips malformed Claude ids and wrong-project thread collisions", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const eventSink = yield* EventSinkV2;
    const importer = yield* AgentSessionImporter;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 1,
    });
    const id = ThreadId.make("import:codex:codex-session");
    const thread = yield* projections.getThread(id);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("move-import-to-other-project"),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: thread.updatedAt,
          payload: { ...thread, projectId: ProjectId.make("other-project") },
        },
      ],
    });
    const sequence = yield* eventSink.latestSequence();
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 2,
    });
    expect(yield* eventSink.latestSequence()).toBe(sequence);
  }).pipe(
    Effect.provide(
      makeImportLayer(
        scannerFor(
          makeThreadOutcome({ ...makeThread("claudeAgent"), providerSessionId: "not-a-uuid" }),
          makeThreadOutcome(makeThread("codex")),
        ),
      ),
    ),
    Effect.provide(integrationLayer),
  ),
);

it.effect("imports once after a rejected receipt has been persisted", () =>
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const importer = yield* AgentSessionImporter;
    const projections = yield* ProjectionStoreV2;
    const id = ThreadId.make("import:codex:codex-session");
    yield* eventSink.commitRejectedCommand({
      commandId: CommandId.make(`agent-session:history:${id}`),
      threadId: id,
      commandType: "thread.history.import",
      rejectedAt: DateTime.makeUnsafe("2026-08-24T10:00:00.000Z"),
      error: "History was rejected before import",
    });
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    const sequence = yield* eventSink.latestSequence();
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    expect(yield* eventSink.latestSequence()).toBe(sequence);
    const records = yield* projections.getThreadRecords(id, ["messages", "turnItems"]);
    expect(records.messages.map((message) => message.text)).toEqual(["Fix the bug", "Fixed"]);
    expect(records.thread.settledOverride).toBe("settled");
    expect(records.turnItems.map((item) => item.runId)).toEqual([null, null]);
  }).pipe(
    Effect.provide(makeImportLayer(scannerFor(makeThreadOutcome(makeThread("codex"))))),
    Effect.provide(integrationLayer),
  ),
);

it.effect("persists the resume cursor before publishing a new imported thread", () =>
  Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntimeRepository;
    const projections = yield* ProjectionStoreV2;
    const eventSink = yield* EventSinkV2;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const importerLayer = makeImportLayer(scannerFor(makeThreadOutcome(makeThread("codex")))).pipe(
      Layer.provide(
        Layer.succeed(ProviderSessionRuntimeRepository, {
          ...repository,
          upsert: (runtime, options) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(repository.upsert(runtime, options)),
            ),
        }),
      ),
    );
    const fiber = yield* Effect.gen(function* () {
      const importer = yield* AgentSessionImporter;
      return yield* importer.importRecentAgentThreads({ projectId });
    }).pipe(Effect.provide(importerLayer), Effect.forkChild);
    yield* Deferred.await(entered);
    expect(yield* eventSink.latestSequence()).toBe(0);
    const id = ThreadId.make("import:codex:codex-session");
    yield* repository.upsert({
      threadId: id,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      adapterKey: "codex",
      runtimeMode: "full-access",
      status: "running",
      lastSeenAt: "2026-08-24T10:02:00.000Z",
      resumeCursor: { threadId: "active-client-session" },
      runtimePayload: { cwd: WORKSPACE_ROOT, activeTurnId: "turn-active" },
    });
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(fiber)).toEqual({ importedCount: 1, skippedCount: 0 });
    expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId: id }))).toMatchObject({
      status: "running",
      resumeCursor: { threadId: "active-client-session" },
      runtimePayload: { cwd: WORKSPACE_ROOT, activeTurnId: "turn-active" },
    });
    expect(
      (yield* projections.getThreadRecords(id, ["messages"])).messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Fix the bug", "Fixed"]);
  }).pipe(Effect.provide(integrationLayer)),
);

it.effect("does not import history over a partial thread with non-imported activity", () =>
  Effect.gen(function* () {
    const importer = yield* AgentSessionImporter;
    const eventSink = yield* EventSinkV2;
    const projections = yield* ProjectionStoreV2;
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });
    const id = ThreadId.make("import:codex:codex-session");
    const { historyOrigin: _, ...thread } = yield* projections.getThread(id);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("partial-native-thread"),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: thread.updatedAt,
          payload: { ...thread, settledOverride: null },
        },
      ],
    });
    const sequence = yield* eventSink.latestSequence();
    expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(yield* eventSink.latestSequence()).toBe(sequence);
  }).pipe(
    Effect.provide(makeImportLayer(scannerFor(makeThreadOutcome(makeThread("codex"))))),
    Effect.provide(integrationLayer),
  ),
);
