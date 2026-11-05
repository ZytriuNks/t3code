import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ThreadLifecycleRecords from "./ForkMigrations/ThreadLifecycleRecords.ts";
import ThreadOwnershipIndex from "./ForkMigrations/ThreadOwnershipIndex.ts";

/**
 * Fork-only schema, recorded by name in `fork_sql_migrations` after upstream migrations run.
 * Upstream ids stay free for upstream, whose migrator skips every id below the highest recorded.
 * Append new entries; never rename or reorder existing ones.
 */
export const forkMigrationEntries = [
  ["ThreadOwnershipIndex", ThreadOwnershipIndex],
  ["ThreadLifecycleRecords", ThreadLifecycleRecords],
] as const;

// Fork builds before the v0.1.4 sync recorded these under upstream ids.
const LEGACY_FORK_IDS: ReadonlyMap<number, string> = new Map([
  [68, "ThreadOwnershipIndex"],
  [69, "ThreadLifecycleRecords"],
  [70, "LegacyCanonicalAssistantMessages"],
]);
const RETIRED_FORK_MIGRATIONS = new Set(["LegacyCanonicalAssistantMessages"]);

const ensureForkMigrationTable = Effect.fn("ensureForkMigrationTable")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_sql_migrations (
      name TEXT PRIMARY KEY,
      executed_at TEXT NOT NULL
    )
  `;
});

/** Moves fork rows off upstream ids 68-70 so upstream's own 68+ can run on old fork databases. */
export const reconcileLegacyForkMigrationIds = Effect.fn("reconcileLegacyForkMigrationIds")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return [];
        const later = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68
          ORDER BY migration_id
        `;
        const legacy = later.filter((row) => LEGACY_FORK_IDS.get(row.migration_id) === row.name);
        if (legacy.length === 0) return [];
        const contiguous = legacy.every((row, index) => row.migration_id === 68 + index);
        if (!contiguous || legacy.length !== later.length) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: `Cannot move fork migrations off upstream ids with this history: ${later
              .map((row) => `${row.migration_id}_${row.name}`)
              .join(", ")}.`,
          });
        }
        yield* ensureForkMigrationTable();
        const executedAt = DateTime.formatIso(yield* DateTime.now);
        for (const row of legacy) {
          if (RETIRED_FORK_MIGRATIONS.has(row.name)) continue;
          yield* sql`
            INSERT INTO fork_sql_migrations (name, executed_at) VALUES (${row.name}, ${executedAt})
            ON CONFLICT(name) DO NOTHING
          `;
        }
        // Its legacy V1 search path was replaced by upstream's message index.
        yield* sql`DROP TABLE IF EXISTS legacy_canonical_assistant_messages`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN ${sql.in(
          legacy.map((row) => row.migration_id),
        )}`;
        return legacy.map((row) => `${row.migration_id}_${row.name}`);
      }),
    );
  },
);

/** Runs pending fork migrations in order, each in its own transaction with its record. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureForkMigrationTable();
  const recorded = new Set(
    (yield* sql<{ readonly name: string }>`SELECT name FROM fork_sql_migrations`).map(
      (row) => row.name,
    ),
  );
  const executed: Array<string> = [];
  for (const [name, migration] of forkMigrationEntries) {
    if (recorded.has(name)) continue;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* migration;
        const executedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`INSERT INTO fork_sql_migrations (name, executed_at) VALUES (${name}, ${executedAt})`;
      }),
    );
    executed.push(name);
  }
  return executed;
});
