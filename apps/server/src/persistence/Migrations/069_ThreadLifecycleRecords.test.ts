import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect(
  "registers migration 069 with three independent lifecycle tables and storage lookup indexes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      expect((yield* runMigrations()).map(([id]) => id)).toEqual([69]);
      const invalidScope = yield* Effect.flip(
        sql`INSERT INTO orchestration_v2_thread_deletions (thread_id, project_id, operation_root_thread_id, deleted_at, command_id, scope, payload_json) VALUES ('R', 'project', 'R', '2026-10-26', 'delete', 'native', '{}')`,
      );
      expect(invalidScope._tag).toBe("SqlError");
      const tables = [
        "orchestration_v2_native_session_bindings",
        "orchestration_v2_thread_deletions",
        "orchestration_v2_thread_deletion_sessions",
      ];
      for (const table of tables) {
        expect(
          yield* sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ${table}`,
        ).toHaveLength(1);
        const foreignKeys = yield* sql.unsafe<{ readonly table: string }>(
          `PRAGMA foreign_key_list(${table})`,
        );
        expect(foreignKeys.every((key) => key.table === "orchestration_v2_thread_deletions")).toBe(
          true,
        );
      }
      for (const table of [tables[0]!, tables[2]!]) {
        const confirmed = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN SELECT thread_id FROM ${table} WHERE storage_type = 'resolved' AND driver = 'codex' AND canonical_root = 'C:/codex' AND native_id = 'native' AND canonical_file = ''`,
        );
        const unknown = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN SELECT thread_id FROM ${table} WHERE storage_type = 'unresolved' AND driver = 'codex' AND native_id = 'native'`,
        );
        expect(
          confirmed.some(
            (row) => row.detail.includes("SEARCH") && row.detail.includes("storage_idx"),
          ),
        ).toBe(true);
        expect(
          unknown.some(
            (row) => row.detail.includes("SEARCH") && row.detail.includes("unresolved_idx"),
          ),
        ).toBe(true);
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
