import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  NativeSessionBinding,
  NativeSessionStorage,
  ThreadDeletionRecord,
} from "./threadLifecycle.ts";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RpcSchemas,
  OrchestrationV2RunJson,
} from "./orchestrationV2.ts";

const at = "2026-10-26T00:00:00.000Z";
const decodeStorage = Schema.decodeUnknownSync(NativeSessionStorage);
const decodeRecord = Schema.decodeUnknownSync(ThreadDeletionRecord);
const thread = {
  id: "R",
  projectId: "project",
  title: "Root",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "R" },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  deletedAt: null,
};
const binding = {
  threadId: "R",
  providerThreadId: "pt",
  providerInstanceId: "codex",
  driver: "codex",
  nativeId: "session",
  storage: { type: "resolved", canonicalRoot: "C:/sessions" },
  boundAt: at,
};
const record = {
  threadId: "R",
  projectId: "project",
  parentThreadId: null,
  operationRootThreadId: "R",
  deletedAt: at,
  commandId: "delete",
  scope: "t3_only",
  sessions: [binding],
};

describe("thread lifecycle contracts", () => {
  it("reads legacy thread, run and provider payloads and defaults the thread revision", () => {
    const decodeThread = Schema.decodeUnknownSync(OrchestrationV2AppThreadJson);
    expect(decodeThread(thread).lifecycleRevision).toBe(0);
    expect(decodeThread({ ...thread, lifecycleRevision: 3 }).lifecycleRevision).toBe(3);
    const decodeRun = Schema.decodeUnknownSync(OrchestrationV2RunJson);
    const run = {
      id: "run",
      threadId: "R",
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: thread.modelSelection,
      providerThreadId: null,
      userMessageId: "message",
      rootNodeId: null,
      activeAttemptId: null,
      status: "queued",
      requestedAt: at,
      startedAt: null,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    expect(decodeRun(run).id).toBe("run");
    expect(decodeRun({ ...run, lifecycleRevision: 3 }).lifecycleRevision).toBe(3);
    for (const lifecycleRevision of [-1, 1.5, "3"]) {
      expect(() => decodeThread({ ...thread, lifecycleRevision })).toThrow();
      expect(() => decodeRun({ ...run, lifecycleRevision })).toThrow();
    }
    const decodeProvider = Schema.decodeUnknownSync(OrchestrationV2ProviderThreadJson);
    const provider = {
      id: "pt",
      driver: "pi",
      providerInstanceId: "pi",
      providerSessionId: null,
      appThreadId: "R",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
    };
    expect(decodeProvider(provider).nativeStorage).toEqual({
      type: "unresolved",
      reason: "legacy_missing_locator",
    });
    expect(() => decodeProvider({ ...provider, nativeStorage: binding.storage })).toThrow();
    expect(
      decodeProvider({
        ...provider,
        nativeStorage: { ...binding.storage, canonicalFile: "C:/sessions/pi.jsonl" },
      }).nativeStorage?.type,
    ).toBe("resolved");
  });

  it("rejects malformed storage, bindings and deletion scopes", () => {
    for (const storage of [
      { type: "resolved" },
      { type: "resolved", canonicalRoot: 1 },
      { type: "unresolved", reason: "unknown" },
    ]) {
      expect(() => decodeStorage(storage)).toThrow();
    }
    const decodeBinding = Schema.decodeUnknownSync(NativeSessionBinding);
    expect(decodeBinding(binding).nativeId).toBe("session");
    expect(() => decodeBinding({ ...binding, driver: "pi" })).toThrow();
    expect(() => decodeBinding({ ...binding, nativeId: 1 })).toThrow();
    expect(() => decodeBinding({ ...binding, boundAt: 1 })).toThrow();
    expect(decodeRecord(record).scope).toBe("t3_only");
    expect(() => decodeRecord({ ...record, scope: "native" })).toThrow();
  });

  it("round trips legacy and recorded deletions through persisted and forward-compatible wire codecs", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2DomainEventJson);
    const encode = Schema.encodeSync(OrchestrationV2DomainEventJson);
    const decodeWire = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeThread.output),
    );
    for (const deletionRecord of [undefined, record]) {
      const event = {
        id: "event",
        type: "thread.deleted",
        threadId: "R",
        occurredAt: at,
        payload: { ...thread, lifecycleRevision: 4 },
        ...(deletionRecord ? { deletionRecord } : {}),
      };
      expect(encode(decode(event))).toMatchObject(event);
      const decoded = decodeWire({ kind: "event", sequence: 1, event });
      expect(decoded.kind).toBe("event");
      if (decoded.kind !== "event") throw new Error("Expected a known deletion event");
      expect(decoded.event.type).toBe("thread.deleted");
      if (decoded.event.type !== "thread.deleted") throw new Error("Expected a deletion event");
      expect(decoded.event.deletionRecord).toEqual(deletionRecord);
      expect(decoded.event.payload.lifecycleRevision).toBe(4);
    }
    expect(() =>
      decode({
        id: "event",
        type: "thread.deleted",
        threadId: "R",
        occurredAt: at,
        payload: thread,
        deletionRecord: { ...record, scope: "native" },
      }),
    ).toThrow();
  });
});
