import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

const layer = ThreadSearch.layer.pipe(
  Layer.provideMerge(
    Layer.effectDiscard(runMigrations({ toMigrationInclusive: 69 })).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
);
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
  let eventNumber = 0;
  const event = (type: string, payload: Record<string, unknown>, threadId = "thread:assistant") => {
    const index = eventNumber++;
    return sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`legacy:${index}`}, 'thread', ${threadId}, ${index}, ${type}, ${now},
        'provider', ${JSON.stringify({ threadId, ...payload })}, '{}', 1
      )
    `;
  };
  yield* event("thread.message-sent", {
    turnId: "turn:assistant",
    messageId: "message:assistant",
    role: "assistant",
    streaming: false,
  });
  return { sql, search, event };
});

it.effect(
  "excludes known legacy subagents before LIMIT and preserves forks and unknown lineage",
  () =>
    Effect.gen(function* () {
      const { sql, search } = yield* seed;
      yield* runMigrations();
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
      yield* runMigrations();
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
    yield* runMigrations();
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

it.effect(
  "matches only the event-selected canonical assistant among messages in the same turn",
  () =>
    Effect.gen(function* () {
      const { sql, search, event } = yield* seed;
      yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('message:commentary', 'thread:assistant', 'turn:assistant', 'assistant', 'noncanonical commentary token', 0, ${now}, ${now})
    `;
      yield* event("thread.message-sent", {
        turnId: "turn:assistant",
        messageId: "message:commentary",
        role: "assistant",
        streaming: false,
      });
      yield* event("thread.message-sent", {
        turnId: "turn:assistant",
        messageId: "message:assistant",
        role: "assistant",
        streaming: false,
      });
      yield* runMigrations();
      assert.deepEqual(
        (yield* search.search({ query: "noncanonical commentary token" })).matches,
        [],
      );
      assert.deepEqual(
        (yield* search.search({ query: "migration needle answer" })).matches.map(
          (match) => match.threadId,
        ),
        ["thread:assistant"],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "uses the explicit turn-diff override and leaves unknown assistant history unmatched",
  () =>
    Effect.gen(function* () {
      const { sql, search, event } = yield* seed;
      yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES
        ('message:checkpoint', 'thread:assistant', 'turn:assistant', 'assistant', 'canonical checkpoint token', 0, ${now}, ${now}),
        ('message:unknown', 'thread:active', 'turn:unknown', 'assistant', 'unknown history token', 0, ${now}, ${now})
    `;
      yield* event("thread.turn-diff-completed", {
        turnId: "turn:assistant",
        assistantMessageId: "message:checkpoint",
        status: "ready",
        checkpointTurnCount: 1,
      });
      yield* runMigrations();
      assert.deepEqual((yield* search.search({ query: "migration needle answer" })).matches, []);
      assert.deepEqual(
        (yield* search.search({ query: "canonical checkpoint token" })).matches.map(
          (match) => match.threadId,
        ),
        ["thread:assistant"],
      );
      assert.deepEqual((yield* search.search({ query: "unknown history token" })).matches, []);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "does not infer canonical IDs for missing events, missing overrides or a different turn",
  () =>
    Effect.gen(function* () {
      const { sql, search, event } = yield* seed;
      yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES
        ('message:unknown', 'thread:active', 'turn:unknown', 'assistant', 'unknown canonical token', 0, ${now}, ${now}),
        ('message:missing', 'thread:assistant', 'turn:missing', 'assistant', 'missing canonical token', 0, ${now}, ${now}),
        ('message:mismatched', 'thread:assistant', 'turn:actual', 'assistant', 'mismatched canonical token', 0, ${now}, ${now})
    `;
      yield* event("thread.message-sent", {
        turnId: "turn:missing",
        messageId: "message:missing",
        role: "assistant",
      });
      yield* event("thread.turn-diff-completed", {
        turnId: "turn:missing",
        status: "ready",
        checkpointTurnCount: 1,
      });
      yield* event("thread.message-sent", {
        turnId: "turn:wrong",
        messageId: "message:mismatched",
        role: "assistant",
      });
      yield* runMigrations();
      for (const query of [
        "unknown canonical token",
        "missing canonical token",
        "mismatched canonical token",
      ]) {
        assert.deepEqual((yield* search.search({ query })).matches, []);
      }
      yield* sql`DROP TABLE orchestration_events`;
      assert.deepEqual(
        (yield* search.search({ query: "migration needle answer" })).matches.map(
          (match) => match.threadId,
        ),
        ["thread:assistant"],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("deduplicates canonical imports without filtering the V2 assistant search branch", () =>
  Effect.gen(function* () {
    const { sql, search } = yield* seed;
    yield* runMigrations();
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread:assistant', 'project:search', 'Assistant', 'codex', 'full-access', 'default', ${now}, ${now}, '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('message:assistant', 'thread:assistant', 'assistant', 0, ${now}, ${now}, '{"text":"imported canonical token"}')
    `;
    assert.deepEqual((yield* search.search({ query: "migration needle answer" })).matches, []);
    assert.deepEqual(
      (yield* search.search({ query: "imported canonical token" })).matches.map(
        (match) => match.snippet,
      ),
      ["imported canonical token"],
    );
    yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 1 WHERE message_id = 'message:assistant'`;
    assert.deepEqual((yield* search.search({ query: "imported canonical token" })).matches, []);
    assert.deepEqual((yield* search.search({ query: "migration needle answer" })).matches, []);
    yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'message:assistant'`;
    yield* sql`
      INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
      VALUES ('thread:assistant', ${now}, ${now}, ${now})
    `;
    assert.deepEqual((yield* search.search({ query: "migration needle answer" })).matches, []);
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('message:v2-only', 'thread:assistant', 'assistant', 0, ${now}, ${now}, '{"text":"V2 unmatched metadata token"}')
    `;
    assert.deepEqual(
      (yield* search.search({ query: "V2 unmatched metadata token" })).matches.map(
        (match) => match.threadId,
      ),
      ["thread:assistant"],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "filters recovered canonical subagents before LIMIT while retaining a canonical fork",
  () =>
    Effect.gen(function* () {
      const { sql, search, event } = yield* seed;
      yield* sql`UPDATE projection_thread_messages SET text = 'canonical visibility token' WHERE message_id = 'message:assistant'`;
      yield* sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('message:fork', 'thread:active', 'turn:assistant', 'assistant', 'canonical visibility token', 0, ${now}, ${now})
    `;
      yield* event(
        "thread.message-sent",
        { turnId: "turn:assistant", messageId: "message:fork", role: "assistant" },
        "thread:active",
      );
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES ('thread:assistant', 'project:search', 'Child', 'codex', 'full-access', 'default', ${now}, '2026-10-28T00:00:00.000Z', '{"lineage":{"relationshipToParent":"subagent"}}')
    `;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"lineage":{"relationshipToParent":"fork"}}' WHERE thread_id = 'thread:active'`;
      yield* runMigrations();
      assert.deepEqual(
        (yield* search.search({ query: "canonical visibility token", limit: 1 })).matches.map(
          (match) => match.threadId,
        ),
        ["thread:active"],
      );
      assert.deepEqual(
        (yield* search.search({
          query: "canonical visibility token",
          limit: 1,
          includeSubagents: true,
        })).matches.map((match) => match.threadId),
        ["thread:assistant"],
      );
    }).pipe(Effect.provide(layer)),
);
