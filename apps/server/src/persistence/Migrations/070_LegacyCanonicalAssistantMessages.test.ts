import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 69 });
  let eventNumber = 0;
  const event = (
    eventType: string,
    payload: Record<string, unknown>,
    threadId = "thread",
    applicationVersion = 1,
  ) => {
    const index = eventNumber++;
    return sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`event:${index}`}, 'thread', ${threadId}, ${index}, ${eventType}, '2026-10-28',
        'provider', ${JSON.stringify({ threadId, ...payload })}, '{}', ${applicationVersion}
      )
    `;
  };
  const message = (messageId: string, turnId = "turn", threadId = "thread") =>
    sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${messageId}, ${threadId}, ${turnId}, 'assistant', 'projection text', 0, '2026-10-28', '2026-10-28')
    `;
  const rows = sql`
    SELECT thread_id, turn_id, message_id FROM legacy_canonical_assistant_messages
    ORDER BY thread_id, turn_id
  `;
  return { sql, event, message, rows };
});

it.effect("registers 070 and recovers only the final structural canonical ID per thread/turn", () =>
  Effect.gen(function* () {
    const { sql, event, message, rows } = yield* seed;
    for (const id of ["commentary", "answer", "checkpoint"]) yield* message(id);
    yield* message("other-answer", "turn", "other");
    yield* event("thread.message-sent", {
      turnId: "turn",
      messageId: "commentary",
      role: "assistant",
      streaming: false,
    });
    yield* event("thread.message-sent", {
      turnId: "turn",
      messageId: "answer",
      role: "assistant",
      streaming: false,
    });
    yield* event("thread.turn-diff-completed", {
      turnId: "turn",
      assistantMessageId: "checkpoint",
      status: "ready",
      checkpointTurnCount: 1,
    });
    yield* event(
      "thread.message-sent",
      { turnId: "turn", messageId: "other-answer", role: "assistant", streaming: false },
      "other",
    );
    assert.deepEqual(
      (yield* runMigrations()).map(([id]) => id),
      [70],
    );
    assert.deepEqual(yield* rows, [
      { thread_id: "other", turn_id: "turn", message_id: "other-answer" },
      { thread_id: "thread", turn_id: "turn", message_id: "checkpoint" },
    ]);
    const columns = yield* sql<{
      readonly name: string;
      readonly pk: number;
    }>`PRAGMA table_info(legacy_canonical_assistant_messages)`;
    assert.deepEqual(
      columns.map((column) => column.name),
      ["thread_id", "turn_id", "message_id"],
    );
    assert.deepEqual(
      columns.map((column) => column.pk),
      [1, 2, 0],
    );
    assert.deepEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE name = 'projection_turns'`,
      [],
    );
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN SELECT 1 FROM legacy_canonical_assistant_messages
      WHERE thread_id = 'thread' AND turn_id = 'turn' AND message_id = 'checkpoint'
    `;
    assert.isTrue(
      plan.some((row) => row.detail.includes("SEARCH") && row.detail.includes("PRIMARY KEY")),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps unknown history unproven and ignores user, orphan and V2 events", () =>
  Effect.gen(function* () {
    const { event, message, rows } = yield* seed;
    yield* message("known");
    yield* message("unknown", "unknown");
    yield* message("missing-override", "missing");
    yield* message("null-override", "null");
    yield* event("thread.message-sent", {
      turnId: "turn",
      messageId: "known",
      role: "assistant",
      streaming: true,
    });
    yield* event("thread.message-sent", { turnId: "turn", messageId: "user", role: "user" });
    yield* event(
      "thread.message-sent",
      { turnId: "turn", messageId: "v2", role: "assistant" },
      "thread",
      2,
    );
    yield* event("thread.message-sent", { turnId: null, messageId: "orphan", role: "assistant" });
    yield* event("thread.message-sent", { messageId: "old-orphan", role: "assistant" });
    for (const [turnId, messageId, override] of [
      ["missing", "missing-override", {}],
      ["null", "null-override", { assistantMessageId: null }],
    ] as const) {
      yield* event("thread.message-sent", { turnId, messageId, role: "assistant" });
      yield* event("thread.turn-diff-completed", {
        turnId,
        status: "ready",
        checkpointTurnCount: 1,
        ...override,
      });
    }
    yield* runMigrations();
    assert.deepEqual(yield* rows, [{ thread_id: "thread", turn_id: "turn", message_id: "known" }]);
  }).pipe(Effect.provide(layer)),
);

it.effect("replays message events after a diff and resets a recreated thread", () =>
  Effect.gen(function* () {
    const { event, message, rows } = yield* seed;
    yield* message("before");
    yield* message("after");
    yield* message("stale", "stale", "recreated");
    yield* event("thread.turn-diff-completed", {
      turnId: "turn",
      assistantMessageId: "before",
      status: "ready",
      checkpointTurnCount: 1,
    });
    yield* event("thread.message-sent", { turnId: "turn", messageId: "after", role: "assistant" });
    yield* event(
      "thread.message-sent",
      { turnId: "stale", messageId: "stale", role: "assistant" },
      "recreated",
    );
    yield* event("thread.created", {}, "recreated");
    yield* runMigrations();
    assert.deepEqual(yield* rows, [{ thread_id: "thread", turn_id: "turn", message_id: "after" }]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "does not let placeholder diffs or reverted checkpoint conflicts select stale canonical IDs",
  () =>
    Effect.gen(function* () {
      const { event, message, rows } = yield* seed;
      yield* message("kept");
      yield* message("placeholder");
      yield* message("conflicted", "conflicted");
      yield* message("reverted", "reverted");
      yield* event("thread.turn-diff-completed", {
        turnId: "conflicted",
        assistantMessageId: "conflicted",
        status: "ready",
        checkpointTurnCount: 1,
      });
      yield* event("thread.turn-diff-completed", {
        turnId: "turn",
        assistantMessageId: "kept",
        status: "ready",
        checkpointTurnCount: 1,
      });
      yield* event("thread.turn-diff-completed", {
        turnId: "turn",
        assistantMessageId: "placeholder",
        status: "missing",
        checkpointTurnCount: 2,
      });
      yield* event("thread.turn-diff-completed", {
        turnId: "reverted",
        assistantMessageId: "reverted",
        status: "ready",
        checkpointTurnCount: 2,
      });
      yield* event("thread.reverted", { turnCount: 1 });
      yield* runMigrations();
      assert.deepEqual(yield* rows, [{ thread_id: "thread", turn_id: "turn", message_id: "kept" }]);
    }).pipe(Effect.provide(layer)),
);

it.effect("can rerun recovery without duplicates or retaining stale metadata", () =>
  Effect.gen(function* () {
    const { sql, event, message, rows } = yield* seed;
    yield* message("answer");
    yield* event("thread.message-sent", { turnId: "turn", messageId: "answer", role: "assistant" });
    yield* runMigrations();
    const recovered = yield* rows;
    assert.deepEqual(yield* runMigrations(), []);
    yield* sql`INSERT INTO legacy_canonical_assistant_messages VALUES ('stale', 'turn', 'stale')`;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 70`;
    assert.deepEqual(
      (yield* runMigrations()).map(([id]) => id),
      [70],
    );
    assert.deepEqual(yield* rows, recovered);
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves event order across recovery pages without reading message bodies", () =>
  Effect.gen(function* () {
    const { event, message, rows } = yield* seed;
    yield* message("last");
    for (let index = 0; index < 500; index++) {
      yield* event("thread.message-sent", {
        turnId: "turn",
        messageId: "earlier",
        role: "assistant",
        text: { deliberately: "not a decoded body" },
        updatedAt: "2099-01-01",
      });
    }
    yield* event("thread.turn-diff-completed", {
      turnId: "turn",
      assistantMessageId: "last",
      status: "ready",
      checkpointTurnCount: 1,
      completedAt: "2000-01-01",
    });
    yield* runMigrations();
    assert.deepEqual(yield* rows, [{ thread_id: "thread", turn_id: "turn", message_id: "last" }]);
  }).pipe(Effect.provide(layer)),
);
