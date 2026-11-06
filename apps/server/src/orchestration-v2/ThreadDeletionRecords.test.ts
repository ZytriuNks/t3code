import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type ThreadDeletionRecord,
  type OrchestrationV2ProviderThread,
  type NativeSessionBinding,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadDeletionRecords from "./ThreadDeletionRecords.ts";
import * as NativeSessionBindings from "./NativeSessionBindings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layerTest = Layer.mergeAll(
  ThreadDeletionRecords.layer,
  NativeSessionBindings.layer,
  ProjectionStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const R = ThreadId.make("R");
const record: ThreadDeletionRecord = {
  threadId: R,
  projectId: ProjectId.make("project"),
  parentThreadId: null,
  operationRootThreadId: R,
  deletedAt: "2026-10-26T00:00:00.000Z",
  commandId: CommandId.make("delete"),
  scope: "t3_only",
  sessions: [
    {
      threadId: R,
      providerThreadId: ProviderThreadId.make("pt"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      nativeId: "session",
      storage: { type: "resolved", canonicalRoot: "C:/codex" },
      boundAt: "2026-10-26T00:00:00.000Z",
    },
  ],
};

const piSession: NativeSessionBinding = {
  threadId: R,
  providerThreadId: ProviderThreadId.make("pi-thread"),
  providerInstanceId: ProviderInstanceId.make("pi-saved"),
  driver: ProviderDriverKind.make("pi"),
  nativeId: "pi-native",
  storage: { type: "resolved", canonicalRoot: "/i2/pi", canonicalFile: "/i2/pi/session.jsonl" },
  boundAt: "2026-10-25T00:00:00.000Z",
};

const seedRetainedSession = Effect.fn("test.seedRetainedSession")(function* (
  source: "binding" | "projection",
  overrides: Partial<OrchestrationV2ProviderThread> = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const at = DateTime.makeUnsafe(piSession.boundAt);
  yield* store.apply({
    id: EventId.make("i2:provider"),
    type: "provider-thread.updated",
    threadId: R,
    occurredAt: at,
    payload: {
      id: piSession.providerThreadId,
      driver: piSession.driver,
      providerInstanceId: piSession.providerInstanceId,
      providerSessionId: null,
      appThreadId: R,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: piSession.driver,
        nativeId: piSession.nativeId,
        strength: "strong",
      },
      nativeStorage: piSession.storage,
      nativeConversationHeadRef: null,
      status: "closed",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      ...overrides,
    },
  });
  if (source === "binding") yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
  else yield* sql`DELETE FROM orchestration_v2_native_session_bindings`;
});

it.effect(
  "keeps the first deletion and its sessions independently of provider and thread projections",
  () =>
    Effect.gen(function* () {
      const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const sql = yield* SqlClient.SqlClient;
      expect(Option.isNone(yield* deletions.get(R))).toBe(true);
      yield* deletions.apply(record);
      yield* deletions.apply({
        ...record,
        deletedAt: "2026-10-27T00:00:00.000Z",
        commandId: CommandId.make("repeat"),
        operationRootThreadId: ThreadId.make("later-root"),
        sessions: [piSession],
      });
      yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads`;
      expect(Option.getOrThrow(yield* deletions.get(R))).toEqual(record);
      expect(Option.getOrThrow(yield* deletions.get(R)).deletedAt).toBe("2026-10-26T00:00:00.000Z");
      expect(Option.getOrThrow(yield* deletions.get(R)).scope).toBe("t3_only");
      expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["binding", "projection"] as const)(
  "backfills an old empty tombstone from a retained %s without trusting a later deletion",
  (source) =>
    Effect.gen(function* () {
      const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const sql = yield* SqlClient.SqlClient;
      const first = { ...record, sessions: [] };
      yield* deletions.apply(first);
      yield* seedRetainedSession(source);
      yield* deletions.apply({
        ...record,
        commandId: CommandId.make("later"),
        deletedAt: "2026-10-27T00:00:00.000Z",
        operationRootThreadId: ThreadId.make("later-root"),
        sessions: [{ ...piSession, nativeId: "untrusted-later-native" }],
      });
      const expected = { ...first, sessions: [piSession] };
      expect(Option.getOrThrow(yield* deletions.get(R))).toEqual(expected);
      const before = yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`;
      expect(before).toHaveLength(1);
      yield* ThreadDeletionRecords.backfillRetainedSessions([R, R]);
      expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`).toEqual(before);
      yield* sql`DELETE FROM orchestration_v2_native_session_bindings`;
      yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
      expect(
        yield* (yield* NativeSessionBindings.NativeSessionBindings).checkImport(piSession),
      ).toBe("deleted");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("limits legacy snapshot backfill to Pi identities", () =>
  Effect.gen(function* () {
    const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
    const sql = yield* SqlClient.SqlClient;
    const first = { ...record, sessions: [] };
    yield* deletions.apply(first);
    yield* seedRetainedSession("projection", {
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      nativeThreadRef: null,
      nativeStorage: { type: "resolved", canonicalRoot: "/codex" },
    });
    yield* ThreadDeletionRecords.backfillRetainedSessions([R]);
    expect(Option.getOrThrow(yield* deletions.get(R))).toEqual(first);
    expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`).toHaveLength(0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves every known snapshot while filling a missing historical provider thread", () =>
  Effect.gen(function* () {
    const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
    const sql = yield* SqlClient.SqlClient;
    yield* deletions.apply(record);
    yield* seedRetainedSession("binding");
    yield* ThreadDeletionRecords.backfillRetainedSessions([R]);
    expect(Option.getOrThrow(yield* deletions.get(R))).toEqual({
      ...record,
      sessions: [...record.sessions, piSession],
    });
    yield* sql`DELETE FROM orchestration_v2_native_session_bindings`;
    const bindings = yield* NativeSessionBindings.NativeSessionBindings;
    for (const session of [...record.sessions, piSession])
      expect(yield* bindings.checkImport(session)).toBe("deleted");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a foreign session before creating its tombstone or snapshot", () =>
  Effect.gen(function* () {
    const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
    const sql = yield* SqlClient.SqlClient;
    expect(
      (yield* Effect.flip(
        deletions.apply({
          ...record,
          sessions: [{ ...piSession, threadId: ThreadId.make("foreign") }],
        }),
      ))._tag,
    ).toBe("ThreadDeletionRecordError");
    expect(Option.isNone(yield* deletions.get(R))).toBe(true);
    expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`).toHaveLength(0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "foreign-thread",
  "driver",
  "instance",
  "provider-thread",
  "native",
  "file",
  "projection-native-driver",
  "open-projection",
  "malformed-projection",
  "malformed-tombstone",
] as const)("rejects an unreliable retained identity (%s)", (mismatch) =>
  Effect.gen(function* () {
    const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
    const sql = yield* SqlClient.SqlClient;
    yield* deletions.apply({ ...record, sessions: [piSession] });
    yield* seedRetainedSession(mismatch.includes("projection") ? "projection" : "binding");
    switch (mismatch) {
      case "foreign-thread":
        yield* sql`UPDATE orchestration_v2_native_session_bindings
          SET payload_json = json_set(payload_json, '$.threadId', 'foreign')`;
        break;
      case "driver":
      case "instance":
      case "provider-thread": {
        const [column, field] =
          mismatch === "driver"
            ? ["driver", "driver"]
            : mismatch === "instance"
              ? ["provider_instance_id", "providerInstanceId"]
              : ["provider_thread_id", "providerThreadId"];
        yield* sql`UPDATE orchestration_v2_native_session_bindings
          SET ${sql(column)} = 'other', payload_json = json_set(payload_json, ${`$.${field}`}, ${mismatch === "provider-thread" ? piSession.providerThreadId : "other"})`;
        break;
      }
      case "native":
        yield* sql`UPDATE orchestration_v2_native_session_bindings
          SET native_id = 'other', payload_json = json_set(payload_json, '$.nativeId', 'other')`;
        break;
      case "file":
        yield* sql`UPDATE orchestration_v2_native_session_bindings SET canonical_file = '/i2/pi/other.jsonl',
          payload_json = json_set(payload_json, '$.storage.canonicalFile', '/i2/pi/other.jsonl')`;
        break;
      case "projection-native-driver":
        yield* sql`UPDATE orchestration_v2_projection_provider_threads
          SET payload_json = json_set(payload_json, '$.nativeThreadRef.driver', 'codex')`;
        break;
      case "open-projection":
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET status = 'idle',
          payload_json = json_set(payload_json, '$.status', 'idle')`;
        break;
      case "malformed-projection":
        yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'`;
        break;
      case "malformed-tombstone":
        yield* sql`UPDATE orchestration_v2_thread_deletions SET payload_json = '{}'`;
        break;
    }
    const beforeRecord = yield* sql`SELECT * FROM orchestration_v2_thread_deletions`;
    const beforeSessions = yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`;
    yield* ThreadDeletionRecords.backfillRetainedSessions([R]);
    expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletions`).toEqual(beforeRecord);
    expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`).toEqual(
      beforeSessions,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["binding", "projection"] as const)(
  "accepts a reliable retained %s after a late close without changing the first deletion",
  (source) =>
    Effect.gen(function* () {
      const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const sql = yield* SqlClient.SqlClient;
      yield* deletions.apply({ ...record, sessions: [] });
      const later = "2026-10-27T00:00:00.000Z";
      yield* seedRetainedSession(source, { updatedAt: DateTime.makeUnsafe(later) });
      if (source === "binding")
        yield* sql`UPDATE orchestration_v2_native_session_bindings SET bound_at = ${later},
          payload_json = json_set(payload_json, '$.boundAt', ${later})`;
      yield* ThreadDeletionRecords.backfillRetainedSessions([R]);
      expect(Option.getOrThrow(yield* deletions.get(R))).toEqual({
        ...record,
        sessions: [{ ...piSession, boundAt: source === "binding" ? later : piSession.boundAt }],
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "rolls back both snapshot indexes and tombstone payload when a backfill write fails",
  () =>
    Effect.gen(function* () {
      const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
      const sql = yield* SqlClient.SqlClient;
      const first = { ...record, sessions: [] };
      yield* deletions.apply(first);
      yield* seedRetainedSession("binding");
      yield* sql`CREATE TRIGGER reject_i2_snapshot BEFORE INSERT ON orchestration_v2_thread_deletion_sessions
      BEGIN SELECT RAISE(ABORT, 'i2 snapshot failure'); END`;
      expect((yield* Effect.flip(ThreadDeletionRecords.backfillRetainedSessions([R])))._tag).toBe(
        "ThreadDeletionRecordError",
      );
      expect(Option.getOrThrow(yield* deletions.get(R))).toEqual(first);
      expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`).toHaveLength(0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects invalid scopes before persisting any record", () =>
  Effect.gen(function* () {
    const deletions = yield* ThreadDeletionRecords.ThreadDeletionRecords;
    const invalid = { ...record, scope: "native" } as unknown as ThreadDeletionRecord;
    expect((yield* Effect.flip(deletions.apply(invalid)))._tag).toBe("ThreadDeletionRecordError");
    expect(Option.isNone(yield* deletions.get(R))).toBe(true);
  }).pipe(Effect.provide(layerTest)),
);
