import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type ThreadDeletionRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadDeletionRecords from "./ThreadDeletionRecords.ts";

const layerTest = ThreadDeletionRecords.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
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
        sessions: [],
      });
      yield* sql`DELETE FROM orchestration_v2_projection_provider_threads`;
      yield* sql`DELETE FROM orchestration_v2_projection_threads`;
      expect(Option.getOrThrow(yield* deletions.get(R))).toEqual(record);
      expect(Option.getOrThrow(yield* deletions.get(R)).deletedAt).toBe("2026-10-26T00:00:00.000Z");
      expect(Option.getOrThrow(yield* deletions.get(R)).scope).toBe("t3_only");
      expect(yield* sql`SELECT * FROM orchestration_v2_thread_deletion_sessions`).toHaveLength(1);
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
