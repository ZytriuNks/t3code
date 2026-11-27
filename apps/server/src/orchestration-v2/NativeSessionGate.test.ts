import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { assertNativeSessionGate } from "./NativeSessionGate.ts";

it.effect.each([
  ["unstarted", false],
  ["marker-only", false],
  ["missing", false],
  ["wrong-session", false],
  ["wrong-thread", false],
  ["null-thread", false],
  ["wrong-instance", false],
  ["corrupt-origin", false],
  ["unstarted-other-legacy", false],
  ["legacy-empty", false],
  ["legacy-session", true],
  ["legacy-binding", true],
  ["legacy-wrong-binding", false],
  ["legacy-binding-wrong-instance", false],
  ["legacy-binding-wrong-thread", false],
  ["new-binding-only", false],
  ["new-session", true],
  ["fork-target", true],
  ["fork-missing-target", false],
  ["fork-active-unstarted", false],
  ["non-pi", false],
] as const)("native gate validates the exact persisted target: %s", ([scenario, allowed]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:gate");
    const providerThreadId = ProviderThreadId.make("provider:gate");
    const providerInstanceId = ProviderInstanceId.make("pi-gate");
    const providerSessionId = ProviderSessionId.make("session:gate");
    const legacy = scenario.startsWith("legacy");
    const binding = scenario.includes("binding");
    const origin = legacy
      ? {}
      : {
          nativeSessionOrigin: {
            version: scenario === "corrupt-origin" ? 2 : 1,
            state:
              scenario === "unstarted" ||
              scenario === "unstarted-other-legacy" ||
              scenario === "fork-active-unstarted"
                ? "unstarted"
                : "may_exist",
          },
        };
    const session =
      binding ||
      ["unstarted", "marker-only", "unstarted-other-legacy", "legacy-empty"].includes(scenario)
        ? null
        : scenario === "wrong-session"
          ? "session:other"
          : providerSessionId;
    if (scenario !== "missing" && scenario !== "fork-missing-target")
      yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
         provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json)
      VALUES (${providerThreadId}, ${scenario === "null-thread" ? null : scenario === "wrong-thread" ? "thread:other" : threadId},
        NULL, ${providerInstanceId}, ${scenario === "non-pi" ? "codex" : "pi"},
        ${scenario === "wrong-instance" ? "other-pi" : providerInstanceId}, ${session}, 'not_loaded', NULL, NULL,
        '2026-11-06', ${JSON.stringify(origin)})`;
    if (binding) {
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, driver, provider_instance_id, status, updated_at, payload_json)
        VALUES (${providerSessionId}, ${threadId}, ${providerInstanceId}, 'pi', ${providerInstanceId}, 'ready', '2026-11-06', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings (provider_session_id, thread_id)
        VALUES (${providerSessionId}, ${threadId})`;
      yield* sql`INSERT INTO orchestration_v2_native_session_bindings
        (binding_key, thread_id, provider_thread_id, provider_instance_id, driver, native_id, storage_type,
         canonical_root, canonical_file, bound_at, payload_json)
        VALUES ('gate-binding', ${scenario === "legacy-binding-wrong-thread" ? "thread:other" : threadId},
          ${scenario === "legacy-wrong-binding" ? "provider:other" : providerThreadId},
          ${scenario === "legacy-binding-wrong-instance" ? "other-pi" : providerInstanceId}, 'pi', 'native',
          'resolved', '/fake', '/fake/session.jsonl', '2026-11-06', '{}')`;
    }
    if (scenario === "unstarted-other-legacy")
      yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
         provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json)
      VALUES ('provider:other', ${threadId}, NULL, ${providerInstanceId}, 'pi', ${providerInstanceId},
        ${providerSessionId}, 'active', 1, 1, '2026-11-06', '{}')`;
    if (scenario.startsWith("fork-")) {
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         active_provider_thread_id, created_at, updated_at, payload_json)
        VALUES (${threadId}, 'project:gate', 'fake', ${providerInstanceId}, 'full-access', 'default',
          ${providerThreadId}, '2026-11-06', '2026-11-06', '{}')`;
      if (scenario === "fork-active-unstarted")
        yield* sql`
        INSERT INTO orchestration_v2_projection_provider_threads
          (provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
           provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json)
        VALUES ('provider:legacy-fork', ${threadId}, NULL, ${providerInstanceId}, 'pi', ${providerInstanceId},
          ${providerSessionId}, 'active', 1, 1, '2026-11-06', '{}')`;
    }
    const result = yield* Effect.result(
      assertNativeSessionGate({
        threadId,
        providerInstanceId,
        providerSessionId,
        ...(scenario.startsWith("fork-") ? {} : { providerThreadId }),
      }),
    );
    assert.equal(result._tag, allowed ? "Success" : "Failure");
    if (result._tag === "Failure") assert.equal(result.failure._tag, "NativeSessionGateError");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
