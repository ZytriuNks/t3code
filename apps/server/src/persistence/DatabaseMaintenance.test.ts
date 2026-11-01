import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

it.layer(
  DatabaseMaintenance.layer.pipe(
    Layer.provideMerge(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(HostProcess.Platform, HostProcess.Platform.defaultValue()),
      ),
    ),
  ),
)("DatabaseMaintenance", (it) => {
  it.effect("reports an unreadable database as an inspection failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const dbPath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "t3-inspect-" }),
        "statev2.sqlite",
      );
      yield* fs.writeFileString(dbPath, "not a database");
      const failure = yield* Effect.flip(maintenance.inspect(dbPath));
      assert.equal(failure._tag, "DatabaseInspectError");
    }).pipe(Effect.scoped),
  );

  it.effect("reports and deletes only the database from before 0.1.0", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "t3-legacy-" });
      const dbPath = path.join(userdata, "statev2.sqlite");
      const legacy = path.join(userdata, "state.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE retained_data (value TEXT)`;
        yield* sql`INSERT INTO retained_data VALUES ('keep-v2')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);

      const openLegacy = NodeSqliteClient.layer({ filename: legacy });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE v1_data (value TEXT)`;
        yield* sql`INSERT INTO v1_data VALUES ('keep-while-in-use')`;
      }).pipe(Effect.provide(openLegacy));
      assert.isAbove((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes ?? 0, 0);

      // A version before 0.1.0 still running against it keeps it.
      const refused = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT value FROM v1_data`, [{ value: "keep-while-in-use" }]);
        return yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
      }).pipe(Effect.provide(openLegacy));
      assert.equal(refused._tag, "DatabaseInUseError");
      assert.isTrue(yield* fs.exists(legacy));

      yield* maintenance.removeLegacyDatabase(dbPath);
      assert.isFalse(yield* fs.exists(legacy));
      assert.isFalse(yield* fs.exists(`${legacy}-wal`));
      assert.isTrue(yield* fs.exists(dbPath));
      assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep-v2" }]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
    }).pipe(Effect.scoped),
  );

  it.effect("reclaims deleted thread data only after the database is exclusively available", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-compact-" });
      const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
      const at = "2026-10-31T12:00:00.000Z";
      const now = DateTime.makeUnsafe(at);
      const providerInstanceId = ProviderInstanceId.make("codex");
      const projectId = ProjectId.make("project:database-maintenance");
      const makeThread = (
        id: ThreadId,
        overrides: Partial<OrchestrationV2AppThread> = {},
      ): OrchestrationV2AppThread => ({
        createdBy: "user",
        creationSource: "web",
        id,
        projectId,
        title: id,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        ...overrides,
      });
      const eligibleThread = makeThread(ThreadId.make("thread:maintenance:eligible"));
      const archivedThread = makeThread(ThreadId.make("thread:maintenance:archived"));
      const blockedThread = makeThread(ThreadId.make("thread:maintenance:blocked"));

      const maintenanceLayer = ProjectionMaintenance.layer.pipe(
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
      );
      yield* Effect.gen(function* () {
        const events = yield* EventStore.EventStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const messageEvent = (threadId: ThreadId, id: string, text: string) => ({
          id: EventId.make(`event:${id}`),
          type: "message.updated" as const,
          threadId,
          runId: null,
          occurredAt: now,
          payload: {
            id: MessageId.make(id),
            threadId,
            runId: null,
            nodeId: null,
            role: "user" as const,
            text,
            attachments: [],
            streaming: false,
            createdBy: "user" as const,
            creationSource: "web" as const,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* sql`PRAGMA auto_vacuum = NONE`;
        yield* sql`VACUUM`;
        yield* sql`CREATE TABLE retained_data (value TEXT)`;
        yield* sql`INSERT INTO retained_data VALUES ('keep')`;
        yield* sql`CREATE TABLE discarded_data (value BLOB)`;
        yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
        yield* sql`DROP TABLE discarded_data`;

        yield* events.append({
          events: [
            {
              id: EventId.make("event:maintenance:eligible-created"),
              type: "thread.created",
              threadId: eligibleThread.id,
              occurredAt: now,
              payload: eligibleThread,
            },
            {
              id: EventId.make("event:maintenance:archived-created"),
              type: "thread.created",
              threadId: archivedThread.id,
              occurredAt: now,
              payload: archivedThread,
            },
            {
              id: EventId.make("event:maintenance:blocked-created"),
              type: "thread.created",
              threadId: blockedThread.id,
              occurredAt: now,
              payload: blockedThread,
            },
            messageEvent(
              eligibleThread.id,
              "message:maintenance:eligible",
              "x".repeat(4 * 1024 * 1024),
            ),
            messageEvent(blockedThread.id, "message:maintenance:blocked", "keep blocked data"),
            {
              id: EventId.make("event:maintenance:archived"),
              type: "thread.archived",
              threadId: archivedThread.id,
              occurredAt: now,
              payload: { ...archivedThread, archivedAt: now },
            },
          ],
        });

        const addDeletion = (thread: OrchestrationV2AppThread) =>
          Effect.gen(function* () {
            const commandId = CommandId.make(`delete:${thread.id}`);
            const deletedAt = DateTime.formatIso(now);
            const record = {
              threadId: thread.id,
              projectId: thread.projectId,
              parentThreadId: null,
              operationRootThreadId: thread.id,
              deletedAt,
              commandId,
              scope: "t3_only" as const,
              sessions: [],
            };
            const [stored] = yield* events.append({
              commandId,
              events: [
                {
                  id: EventId.make(`event:${thread.id}:deleted`),
                  type: "thread.deleted",
                  threadId: thread.id,
                  occurredAt: now,
                  payload: { ...thread, deletedAt: now },
                  deletionRecord: record,
                },
              ],
            });
            yield* sql`
              INSERT INTO orchestration_v2_thread_deletions (
                thread_id, project_id, parent_thread_id, operation_root_thread_id,
                deleted_at, command_id, scope, payload_json
              ) VALUES (
                ${thread.id}, ${thread.projectId}, NULL, ${thread.id}, ${deletedAt},
                ${commandId}, 't3_only', ${JSON.stringify(record)}
              )
            `;
            yield* sql`
              INSERT INTO orchestration_command_receipts (
                command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
                status, error, command_type
              ) VALUES (
                ${commandId}, 'thread', ${thread.id}, ${deletedAt}, ${stored!.sequence},
                'accepted', NULL, 'thread.delete'
              )
            `;
          });
        yield* addDeletion(eligibleThread);
        yield* addDeletion(blockedThread);
        yield* sql`
          INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status,
            attempt_count, available_at, created_at, updated_at
          ) VALUES (
            'cleanup:maintenance:blocked', 'cleanup:maintenance:blocked', ${blockedThread.id},
            'attachment.cleanup', '{"lifecycle":{"revision":1}}', 'pending',
            0, ${at}, ${at}, ${at}
          )
        `;
        const projections = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        yield* projections.rebuild;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
      }).pipe(Effect.provide(maintenanceLayer));

      // A server that merely has the database open, like an idle one, is enough to refuse.
      const sizeBefore = (yield* fs.stat(dbPath)).size;
      const refused = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages
          WHERE thread_id = 'thread:maintenance:eligible'
        `;
        assert.equal(before[0]?.count, 1);
        const refused = yield* maintenance.compact(dbPath).pipe(Effect.flip);
        const after = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages
          WHERE thread_id = 'thread:maintenance:eligible'
        `;
        assert.equal(after[0]?.count, before[0]?.count);
        return refused;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
      assert.equal(refused._tag, "DatabaseInUseError");
      assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

      const result = yield* maintenance.compact(dbPath);
      assert.equal(result.deletedEventCount, 0);
      assert.equal(result.deletedReceiptCount, 0);
      assert.equal(result.reclamation.reclaimedThreadCount, 1);
      assert.deepEqual(result.reclamation.skippedThreads, [
        { threadId: blockedThread.id, blockerCodes: ["lifecycle_cleanup"] },
      ]);
      assert.equal(result.reclamation.deletedEventCount, 1);
      assert.equal(result.reclamation.deletedReceiptCount, 0);
      assert.equal(result.reclamation.deletedProjectionRowCount, 1);
      // The 4 MiB discarded page plus deleted thread history is returned to the filesystem.
      assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
      const afterCompact = yield* maintenance.inspect(dbPath);
      assert.equal(afterCompact.reclaimableBytes, 0);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
        assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
        const threads = yield* sql<{
          readonly thread_id: string;
          readonly archived_at: string | null;
          readonly deleted_at: string | null;
        }>`
          SELECT thread_id, archived_at, deleted_at
          FROM orchestration_v2_projection_threads
          ORDER BY thread_id
        `;
        assert.deepEqual(
          threads.map(({ thread_id, archived_at, deleted_at }) => ({
            thread_id,
            archived: archived_at !== null,
            deleted: deleted_at !== null,
          })),
          [
            { thread_id: "thread:maintenance:archived", archived: true, deleted: false },
            { thread_id: "thread:maintenance:blocked", archived: false, deleted: true },
            { thread_id: "thread:maintenance:eligible", archived: false, deleted: true },
          ],
        );
        const messages = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_messages ORDER BY thread_id
        `;
        assert.deepEqual(messages.map((row) => row.thread_id), ["thread:maintenance:blocked"]);
        const pendingCleanup = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
          WHERE thread_id = 'thread:maintenance:blocked' AND status = 'pending'
        `;
        assert.equal(pendingCleanup[0]?.count, 1);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));

      const repeated = yield* maintenance.compact(dbPath);
      assert.equal(repeated.deletedEventCount, 0);
      assert.equal(repeated.deletedReceiptCount, 0);
      assert.equal(repeated.reclamation.deletedEventCount, 0);
      assert.equal(repeated.reclamation.deletedReceiptCount, 0);
      assert.equal(repeated.reclamation.deletedProjectionRowCount, 0);
      assert.equal(repeated.reclamation.deletedTurnItemPositionCount, 0);
      assert.equal(repeated.reclamation.deletedOutboxCount, 0);
    }).pipe(Effect.scoped),
  );
});
