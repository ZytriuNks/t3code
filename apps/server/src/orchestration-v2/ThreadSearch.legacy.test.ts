import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layer = ThreadSearch.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = "2026-08-29T00:00:00.000Z";
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const search = yield* ThreadSearch.ThreadSearch;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('project:search', 'Search', '/tmp/search', '[]', ${now}, ${now})
  `;
  for (const id of ["active", "archived", "deleted", "assistant"]) {
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${"thread:" + id}, 'project:search', ${id}, '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 'default', ${now}, ${now})
    `;
  }
  yield* sql`
    INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
    VALUES
      ('message:active', 'thread:active', NULL, 'user', 'migration needle active', '[]', 0, ${now}, ${now}),
      ('message:archived', 'thread:archived', NULL, 'user', 'migration needle archived', '[]', 0, ${now}, ${now}),
      ('message:deleted', 'thread:deleted', NULL, 'user', 'migration needle deleted', '[]', 0, ${now}, ${now}),
      ('message:orphan', 'thread:assistant', NULL, 'assistant', 'migration needle orphan', '[]', 0, ${now}, ${now}),
      ('message:assistant', 'thread:assistant', 'turn:assistant', 'assistant', 'migration needle answer', '[]', 0, ${now}, ${now})
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode, interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
    VALUES
      ('thread:active', 'project:search', 'Active', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, NULL, NULL, '{}'),
      ('thread:archived', 'project:search', 'Archived', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, ${now}, NULL, '{}'),
      ('thread:deleted', 'project:search', 'Deleted', 'codex', 'codex', 'full-access', 'default', NULL, ${now}, ${now}, NULL, ${now}, '{}')
  `;
  return { sql, search };
});

it.effect(
  "excludes known legacy subagents before LIMIT and preserves forks and unknown lineage",
  () =>
    Effect.gen(function* () {
      const { sql, search } = yield* seed;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"lineage":{"relationshipToParent":"subagent"}}' WHERE thread_id = 'thread:active'`;
      assert.deepEqual(
        (yield* search.search({ query: "migration needle", limit: 1 })).matches.map(
          (match) => match.threadId,
        ),
        ["thread:assistant"],
      );
      assert.deepEqual(
        (yield* search.search({
          query: "migration needle",
          limit: 1,
          includeSubagents: true,
        })).matches.map((match) => match.threadId),
        ["thread:active"],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"lineage":{"relationshipToParent":"fork"}}' WHERE thread_id = 'thread:active'`;
      assert.deepEqual(
        (yield* search.search({ query: "migration needle", limit: 1 })).matches.map(
          (match) => match.threadId,
        ),
        ["thread:active"],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "searches unopened legacy transcripts using V2 visibility without orphan assistant messages",
  () =>
    Effect.gen(function* () {
      const { sql, search } = yield* seed;
      const result = yield* search.search({ query: "migration needle", limit: 20 });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.source, match.snippet]),
        [
          ["thread:active", "user", "migration needle active"],
          ["thread:assistant", "assistant", "migration needle answer"],
        ],
      );
      yield* sql`UPDATE projection_projects SET deleted_at = ${now} WHERE project_id = 'project:search'`;
      assert.deepEqual((yield* search.search({ query: "migration needle" })).matches, []);
    }).pipe(Effect.provide(layer)),
);

it.effect("prefers an imported message and never resurrects stale fully imported legacy text", () =>
  Effect.gen(function* () {
    const { sql, search } = yield* seed;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('message:active', 'thread:active', 'user', 0, ${now}, ${now}, '{"text":"current migration needle"}')
    `;
    let result = yield* search.search({ query: "migration needle", limit: 20 });
    assert.deepEqual(
      result.matches
        .filter((match) => match.threadId === "thread:active")
        .map((match) => match.snippet),
      ["current migration needle"],
    );
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{"text":"edited current text"}' WHERE message_id = 'message:active'`;
    yield* sql`
      INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
      VALUES ('thread:active', ${now}, ${now}, ${now})
    `;
    result = yield* search.search({ query: "migration needle", limit: 20 });
    assert.isFalse(result.matches.some((match) => match.threadId === "thread:active"));
  }).pipe(Effect.provide(layer)),
);
