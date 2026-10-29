import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import ThreadOwnershipIndex from "./ThreadOwnershipIndex.ts";

it.effect("indexes direct subagent parents including deleted rows as a fork migration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    for (const [id, relationship, deleted] of [
      ["A", "subagent", true],
      ["B", "subagent", false],
      ["F", "fork", false],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, deleted_at, payload_json
        ) VALUES (
          ${id}, 'project', ${id}, 'codex', 'full-access', 'default',
          '2026-10-26', '2026-10-26', ${deleted ? "2026-10-26" : null},
          ${JSON.stringify({ lineage: { parentThreadId: "R", relationshipToParent: relationship } })}
        )
      `;
    }
    assert.deepEqual(
      (yield* sql<{
        readonly name: string;
      }>`SELECT name FROM fork_sql_migrations ORDER BY name`).map((row) => row.name),
      ["ThreadLifecycleRecords", "ThreadOwnershipIndex"],
    );
    yield* ThreadOwnershipIndex;
    const rows = yield* sql`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
        AND json_extract(payload_json, '$.lineage.parentThreadId') = 'R'
      ORDER BY thread_id
    `;
    assert.deepEqual(
      rows.map((row) => row.thread_id),
      ["A", "B"],
    );
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
        AND json_extract(payload_json, '$.lineage.parentThreadId') = 'R'
    `;
    assert.isTrue(
      plan.some(
        (row) =>
          row.detail.includes("SEARCH") &&
          row.detail.includes("orchestration_v2_projection_threads_subagent_parent_idx"),
      ),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
