import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.effect("upgrades a released auto-settle database through the V2 migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    const executed = yield* runMigrations();
    assert.deepStrictEqual(executed.slice(0, 2), [
      [55, "OrchestrationV2"],
      [56, "RemoveRedundantProjectionIndexes"],
    ]);
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(orchestration_events)`;
    assert.ok(columns.some(({ name }) => name === "application_event_version"));
    const released = yield* sql<{ readonly name: string }>`
      SELECT name FROM effect_sql_migrations WHERE migration_id = 54
    `;
    assert.deepStrictEqual(released, [{ name: "ProjectionThreadsAutoSettleDisabledAt" }]);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
