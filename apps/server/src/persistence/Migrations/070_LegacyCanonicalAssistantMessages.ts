import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS legacy_canonical_assistant_messages (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    ) WITHOUT ROWID
  `;
  yield* sql`DELETE FROM legacy_canonical_assistant_messages`;

  // 063 removed the canonical pointer. Recover only IDs from retained V1 events;
  // neither message timestamps nor completed/streaming flags identify that pointer.
  const threads = yield* sql<{ readonly thread_id: string }>`
    SELECT DISTINCT thread_id FROM projection_thread_messages WHERE role = 'assistant'
  `;
  for (const { thread_id: threadId } of threads) {
    const turns = new Map<
      string,
      { messageId: string | null; checkpoint: number | null; status: string | null }
    >();
    const checkpointOwners = new Map<number, string>();
    let afterSequence = 0;
    const pageSize = 500;
    while (true) {
      const events = yield* sql<{
        readonly sequence: number;
        readonly event_type: string;
        readonly thread_id: string | null;
        readonly turn_id: string | null;
        readonly role: string | null;
        readonly message_id: string | null;
        readonly checkpoint: number | null;
        readonly status: string | null;
        readonly turn_count: number | null;
      }>`
        SELECT sequence, event_type,
          CASE WHEN json_type(payload_json, '$.threadId') = 'text'
            THEN json_extract(payload_json, '$.threadId') END AS thread_id,
          CASE WHEN json_type(payload_json, '$.turnId') = 'text'
            THEN json_extract(payload_json, '$.turnId') END AS turn_id,
          json_extract(payload_json, '$.role') AS role,
          CASE WHEN event_type = 'thread.message-sent' THEN
            CASE WHEN json_type(payload_json, '$.messageId') = 'text'
              THEN json_extract(payload_json, '$.messageId') END
          ELSE
            CASE WHEN json_type(payload_json, '$.assistantMessageId') = 'text'
              THEN json_extract(payload_json, '$.assistantMessageId') END
          END AS message_id,
          CASE WHEN json_type(payload_json, '$.checkpointTurnCount') = 'integer'
            THEN json_extract(payload_json, '$.checkpointTurnCount') END AS checkpoint,
          json_extract(payload_json, '$.status') AS status,
          CASE WHEN json_type(payload_json, '$.turnCount') = 'integer'
            THEN json_extract(payload_json, '$.turnCount') END AS turn_count
        FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND application_event_version = 1 AND sequence > ${afterSequence}
          AND event_type IN ('thread.created', 'thread.message-sent', 'thread.turn-diff-completed', 'thread.reverted')
        ORDER BY sequence LIMIT ${pageSize}
      `;
      for (const event of events) {
        if (event.thread_id !== threadId) continue;
        if (event.event_type === "thread.created") {
          turns.clear();
          checkpointOwners.clear();
          continue;
        }
        if (event.event_type === "thread.reverted") {
          for (const [turnId, turn] of turns) {
            if (
              turn.checkpoint === null ||
              event.turn_count === null ||
              turn.checkpoint > event.turn_count
            ) {
              turns.delete(turnId);
              if (turn.checkpoint !== null) checkpointOwners.delete(turn.checkpoint);
            }
          }
          continue;
        }
        if (!event.turn_id) continue;
        const existing = turns.get(event.turn_id);
        if (event.event_type === "thread.message-sent") {
          if (event.role === "assistant") {
            turns.set(event.turn_id, {
              messageId: event.message_id || null,
              checkpoint: existing?.checkpoint ?? null,
              status: existing?.status ?? null,
            });
          }
          continue;
        }
        // The old projector ignored placeholder diffs after a captured checkpoint.
        // Checkpoint counts also determine which canonical pointers survive a revert.
        if (existing?.status != null && existing.status !== "missing" && event.status === "missing")
          continue;
        if (existing?.checkpoint != null) checkpointOwners.delete(existing.checkpoint);
        if (event.checkpoint !== null) {
          const conflictId = checkpointOwners.get(event.checkpoint);
          const conflict = conflictId === undefined ? undefined : turns.get(conflictId);
          if (conflict) {
            conflict.checkpoint = null;
            conflict.status = null;
          }
          checkpointOwners.set(event.checkpoint, event.turn_id);
        }
        turns.set(event.turn_id, {
          messageId: event.message_id || null,
          checkpoint: event.checkpoint,
          status: event.status,
        });
      }
      if (events.length < pageSize) break;
      afterSequence = events[events.length - 1]!.sequence;
    }
    const rows = [...turns].flatMap(([turnId, turn]) =>
      turn.messageId === null
        ? []
        : [{ thread_id: threadId, turn_id: turnId, message_id: turn.messageId }],
    );
    for (let offset = 0; offset < rows.length; offset += pageSize) {
      yield* sql`INSERT INTO legacy_canonical_assistant_messages ${sql.insert(rows.slice(offset, offset + pageSize))}`;
    }
  }
});
