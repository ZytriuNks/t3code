import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as NativeSessionBindings from "./NativeSessionBindings.ts";

const layerTest = NativeSessionBindings.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const R = ThreadId.make("R");
const at = DateTime.makeUnsafe("2026-10-26T00:00:00.000Z");
const event = (
  driver: string,
  nativeId: string | null,
  root?: string,
): Extract<OrchestrationV2DomainEvent, { type: "provider-thread.updated" }> => ({
  id: EventId.make(`${driver}:${nativeId}:${root}`),
  type: "provider-thread.updated",
  threadId: R,
  occurredAt: at,
  payload: {
    id: ProviderThreadId.make(`pt:${driver}`),
    driver: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(driver),
    providerSessionId: null,
    appThreadId: R,
    ownerNodeId: null,
    nativeThreadRef: { driver: ProviderDriverKind.make(driver), nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    ...(root === undefined ? {} : { nativeStorage: { type: "resolved", canonicalRoot: root } }),
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
  },
});

it.effect(
  "keeps all historical provider and storage identities and applies duplicate events once",
  () =>
    Effect.gen(function* () {
      const bindings = yield* NativeSessionBindings.NativeSessionBindings;
      const claude = event("claude", "claude-session", "C:/claude");
      const codex = event("codex", "codex-session", "C:/codex");
      yield* bindings.applyProviderThread(claude);
      yield* bindings.applyProviderThread(codex);
      yield* bindings.applyProviderThread({
        ...codex,
        occurredAt: DateTime.makeUnsafe("2026-10-27T00:00:00.000Z"),
      });
      const firstBindings = yield* bindings.listForThreads([R]);
      expect(firstBindings.map((b) => b.nativeId).sort()).toEqual([
        "claude-session",
        "codex-session",
      ]);
      expect(firstBindings.every((b) => b.boundAt === "2026-10-26T00:00:00.000Z")).toBe(true);
      yield* bindings.applyProviderThread({
        ...codex,
        payload: { ...codex.payload, providerInstanceId: ProviderInstanceId.make("other") },
      });
      expect(yield* bindings.listForThreads([R])).toHaveLength(2);
      yield* bindings.applyProviderThread(event("codex", "codex-session", "C:/other-home"));
      yield* bindings.applyProviderThread(event("codex", "another-session", "C:/codex"));
      expect((yield* bindings.listForThreads([R])).map((b) => [b.nativeId, b.storage])).toEqual(
        expect.arrayContaining([
          ["codex-session", { type: "resolved", canonicalRoot: "C:/codex" }],
          ["codex-session", { type: "resolved", canonicalRoot: "C:/other-home" }],
          ["another-session", { type: "resolved", canonicalRoot: "C:/codex" }],
        ]),
      );
      expect(yield* bindings.listForThreads([])).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "records legacy locators, preserves confirmed history and never owns fork sources or unattached references",
  () =>
    Effect.gen(function* () {
      const bindings = yield* NativeSessionBindings.NativeSessionBindings;
      const legacy = event("codex", "legacy");
      yield* bindings.applyProviderThread(legacy);
      yield* bindings.applyProviderThread(event("codex", "legacy", "C:/codex"));
      yield* bindings.applyProviderThread(legacy);
      yield* bindings.applyProviderThread({
        ...event("claude", "unattached"),
        payload: { ...event("claude", "unattached").payload, appThreadId: null },
      });
      const placeholder = event("codex", null);
      yield* bindings.applyProviderThread({
        ...placeholder,
        payload: { ...placeholder.payload, nativeThreadRef: null, status: "not_loaded" },
      });
      const fork = event("claude", "owned-fork", "C:/claude");
      yield* bindings.applyProviderThread({
        ...fork,
        payload: {
          ...fork.payload,
          forkedFrom: { providerThreadId: ProviderThreadId.make("source") },
        },
      });
      const rows = yield* bindings.listForThreads([R, R]);
      expect(rows).toHaveLength(3);
      expect(rows.map((b) => b.nativeId).sort()).toEqual(["legacy", "legacy", "owned-fork"]);
      expect(rows.find((b) => b.storage.type === "unresolved")?.storage).toEqual({
        type: "unresolved",
        reason: "legacy_missing_locator",
      });
      expect(rows.every((b) => b.providerThreadId !== "source")).toBe(true);
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM orchestration_v2_native_session_bindings`).toHaveLength(3);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("includes Pi file locators and null native IDs in idempotent identities", () =>
  Effect.gen(function* () {
    const bindings = yield* NativeSessionBindings.NativeSessionBindings;
    const pi = event("pi", null, "C:/pi");
    for (const canonicalFile of ["C:/pi/a.jsonl", "C:/pi/b.jsonl", "C:/pi/a.jsonl"]) {
      yield* bindings.applyProviderThread({
        ...pi,
        payload: {
          ...pi.payload,
          nativeStorage: { type: "resolved", canonicalRoot: "C:/pi", canonicalFile },
        },
      });
    }
    expect(yield* bindings.listForThreads([R])).toHaveLength(2);
  }).pipe(Effect.provide(layerTest)),
);
