import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Deleted intermediates still own descendants for lifecycle deletion.
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_threads_subagent_parent_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.lineage.parentThreadId'))
    WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
  `;
});
