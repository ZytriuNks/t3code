import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Each database belongs to one environment. Instance IDs describe provenance,
  // while driver and canonical storage locate the native session within it.
  yield* sql`
    CREATE TABLE orchestration_v2_native_session_bindings (
      binding_key TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      native_id TEXT,
      storage_type TEXT NOT NULL CHECK (storage_type IN ('resolved', 'unresolved')),
      canonical_root TEXT NOT NULL,
      canonical_file TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_native_session_bindings_thread_idx
    ON orchestration_v2_native_session_bindings(thread_id, bound_at, binding_key)`;
  yield* sql`CREATE INDEX orchestration_v2_native_session_bindings_storage_idx
    ON orchestration_v2_native_session_bindings(driver, canonical_root, native_id, canonical_file)
    WHERE storage_type = 'resolved'`;
  yield* sql`CREATE INDEX orchestration_v2_native_session_bindings_unresolved_idx
    ON orchestration_v2_native_session_bindings(driver, native_id)
    WHERE storage_type = 'unresolved'`;

  yield* sql`
    CREATE TABLE orchestration_v2_thread_deletions (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_thread_id TEXT,
      operation_root_thread_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL,
      command_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope = 't3_only'),
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE orchestration_v2_thread_deletion_sessions (
      thread_id TEXT NOT NULL REFERENCES orchestration_v2_thread_deletions(thread_id) ON DELETE CASCADE,
      session_index INTEGER NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      driver TEXT NOT NULL,
      native_id TEXT,
      storage_type TEXT NOT NULL CHECK (storage_type IN ('resolved', 'unresolved')),
      canonical_root TEXT NOT NULL,
      canonical_file TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, session_index)
    )
  `;
  yield* sql`CREATE INDEX orchestration_v2_thread_deletion_sessions_storage_idx
    ON orchestration_v2_thread_deletion_sessions(driver, canonical_root, native_id, canonical_file)
    WHERE storage_type = 'resolved'`;
  yield* sql`CREATE INDEX orchestration_v2_thread_deletion_sessions_unresolved_idx
    ON orchestration_v2_thread_deletion_sessions(driver, native_id)
    WHERE storage_type = 'unresolved'`;
});
