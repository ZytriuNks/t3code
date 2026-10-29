import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ThreadLifecycleRecords from "./ForkMigrations/ThreadLifecycleRecords.ts";
import ThreadOwnershipIndex from "./ForkMigrations/ThreadOwnershipIndex.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const forkHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<{ readonly name: string }>`
    SELECT name FROM fork_sql_migrations ORDER BY name
  `).map((row) => row.name);
});

// What a fork build before the v0.1.4 sync left behind.
const writeLegacyForkDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 67 });
  yield* ThreadOwnershipIndex;
  yield* ThreadLifecycleRecords;
  yield* sql`CREATE TABLE legacy_canonical_assistant_messages (thread_id TEXT NOT NULL)`;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name) VALUES
      (68, 'ThreadOwnershipIndex'),
      (69, 'ThreadLifecycleRecords'),
      (70, 'LegacyCanonicalAssistantMessages')
  `;
});

it.effect("records fork migrations by name without taking upstream ids", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    assert.deepStrictEqual(yield* history, migrationManifest);
    assert.deepStrictEqual(yield* forkHistory, ["ThreadLifecycleRecords", "ThreadOwnershipIndex"]);
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* forkHistory, ["ThreadLifecycleRecords", "ThreadOwnershipIndex"]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("moves fork rows off upstream ids and then runs upstream 068+", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* writeLegacyForkDatabase;
    yield* sql`
      INSERT INTO orchestration_v2_thread_deletions (
        thread_id, project_id, operation_root_thread_id, deleted_at, command_id, scope, payload_json
      ) VALUES ('kept', 'project', 'kept', '2026-10-27', 'delete', 't3_only', '{}')
    `;

    const executed = yield* runMigrations();

    assert.deepStrictEqual(
      executed.map(([id]) => id),
      migrationManifest.filter(([id]) => id >= 68).map(([id]) => id),
    );
    assert.deepStrictEqual(yield* history, migrationManifest);
    assert.deepStrictEqual(yield* forkHistory, ["ThreadLifecycleRecords", "ThreadOwnershipIndex"]);
    assert.lengthOf(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'legacy_canonical_assistant_messages'`,
      0,
    );
    // Existing lifecycle records survive because their migration is not run again.
    assert.lengthOf(yield* sql`SELECT thread_id FROM orchestration_v2_thread_deletions`, 1);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses to move fork rows mixed with upstream rows on the same ids", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 67 });
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name) VALUES
        (68, 'ThreadOwnershipIndex'),
        (69, 'ThreadMessageSearch')
    `;
    const exit = yield* Effect.exit(runMigrations());
    assert.isTrue(exit._tag === "Failure");
    assert.deepStrictEqual(
      (yield* history).filter(([id]) => id >= 68),
      [
        [68, "ThreadOwnershipIndex"],
        [69, "ThreadMessageSearch"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
